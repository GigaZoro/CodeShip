const { hostname } = require("node:os");

const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";
const QUEUE_REFRESH_MS = 60_000;
const QUEUE_STALE_MS = 3 * 60_000;
// A listing longer than this prunes more stale entries per poll.
const QUEUE_MAX_ENTRIES = 200;
const QUEUE_PRUNE_MAX = 10;
const QUEUE_PRUNE_MAX_OVER = 50;
// Entry commits fetched per poll. Until every fresh entry is read, an unread one may be the first.
const QUEUE_FETCH_MAX = 100;
// Names of its own entry a waiter leaves on origin when origin will not delete the old ones; then it renews the newest
// in place.
const OWN_NAMES_MAX = 3;

function waitingSince(message) {
  let entry;
  try {
    entry = JSON.parse(message.split("\n")[0]);
  } catch {
    return null;
  }
  if (
    entry?.kind !== "land" ||
    typeof entry.host !== "string" ||
    !entry.host ||
    typeof entry.run_id !== "string" ||
    !entry.run_id ||
    typeof entry.waiting_since !== "string"
  ) {
    return null;
  }
  const time = Date.parse(entry.waiting_since);
  return Number.isFinite(time) ? time : null;
}

// Each heartbeat moves the entry's commit to a new name, or renews the newest in place while origin keeps old names.
// Readers age a name on their own monotonic clocks while its commit stays. A ticket comes after every entry its waiter
// read, so clock skew only orders arrivals that did not see each other. The queue orders attempts; the lease's
// compare-and-swap still grants ownership.
function createQueueWaiter({
  remote,
  runId,
  arrivedAt,
  clock,
  remoteGit,
  readMessage,
  makeCommit,
  warn,
}) {
  const ownRef = `${QUEUE_PREFIX}${runId}.`;
  const isOwn = (ref) => ref.startsWith(ownRef);
  const sequenceOf = ({ ref }) => Number(ref.slice(ownRef.length));
  const times = new Map();
  const warned = new Set();
  let seen = new Map();
  // The latest listing: its fresh entries, own names included, and the own names alone.
  let fresh = [];
  let ownListed = [];
  // Entry commits this poll may still fetch.
  let budget = 0;
  // The commits of the entries listed when the waiter first tried to join; it joins once it has read them all.
  let admission = null;
  // Its entry's data and the commit that now carries it.
  let ownEntry = null;
  let commit;
  let sequence = 0;
  let refreshedAt = null;
  let pruneFrom = 0;

  // The first diagnostic stands for the rest: git's text differs with each batch of names.
  function warnOnce(key, message = key) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  }

  function list(pattern) {
    return remoteGit(["ls-remote", "--refs", remote, pattern])
      .split("\n")
      .map((row) => row.split("\t"))
      .filter(([sha, ref]) => ref?.startsWith(QUEUE_PREFIX) && !/^0+$/.test(sha))
      .map(([sha, ref]) => ({ sha, ref }));
  }

  // Without --atomic, origin deletes every name it can even when it refuses another.
  function remove(entries) {
    if (entries.length === 0) return;
    remoteGit([
      "push",
      "--quiet",
      ...entries.map(({ ref, sha }) => `--force-with-lease=${ref}:${sha}`),
      remote,
      ...entries.map(({ ref }) => `:${ref}`),
    ]);
  }

  /** False when origin did not delete them all; a later poll tries again. */
  function removeOrWarn(entries, what) {
    try {
      remove(entries);
      return true;
    } catch (error) {
      warnOnce(what, `could not remove ${what}: ${error.message}`);
      return false;
    }
  }

  // Reads the queue, then fetches unread entry commits within this poll's budget, the admission's first.
  function observe() {
    const listed = list(`${QUEUE_PREFIX}*`);
    const observedAt = clock();
    const before = seen;
    seen = new Map();
    fresh = [];
    ownListed = [];
    const stale = [];
    for (const entry of listed) {
      const { ref, sha } = entry;
      const previous = before.get(ref);
      const firstSeen = previous?.sha === sha ? previous.firstSeen : observedAt;
      seen.set(ref, { sha, firstSeen });
      if (isOwn(ref)) ownListed.push(entry);
      if (!isOwn(ref) && observedAt - firstSeen >= QUEUE_STALE_MS) stale.push(entry);
      else fresh.push(entry);
    }
    prune(stale, listed.length > QUEUE_MAX_ENTRIES ? QUEUE_PRUNE_MAX_OVER : QUEUE_PRUNE_MAX);

    const freshShas = new Set(fresh.map(({ sha }) => sha));
    for (const sha of times.keys()) if (sha !== commit && !freshShas.has(sha)) times.delete(sha);
    const unread = [...freshShas].filter((sha) => !times.has(sha));
    const admitting = (sha) => admission?.has(sha) === true;
    const missing = [...unread.filter(admitting), ...unread.filter((sha) => !admitting(sha))].slice(
      0,
      budget,
    );
    if (missing.length === 0) return;
    budget -= missing.length;
    remoteGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...missing]);
    for (const sha of missing) times.set(sha, waitingSince(readMessage(sha)));
  }

  // A stale name is never reused. Checking its SHA still protects a ref someone moved since this listing. Stale
  // entries no longer count, and a batch origin refused moves the next poll on to others, so none blocks anyone.
  function prune(stale, max) {
    if (stale.length === 0) return;
    const from = pruneFrom % stale.length;
    const batch = [...stale.slice(from), ...stale.slice(0, from)].slice(0, max);
    if (!removeOrWarn(batch, "stale queue entries")) pruneFrom = from + batch.length;
  }

  /** True when the latest listing is read whole and no entry in it comes before this waiter's. */
  function first() {
    if (fresh.some(({ sha }) => !times.has(sha))) return false;
    const [head] = fresh
      .map(({ ref, sha }) => ({ ref, since: times.get(sha) }))
      .filter(({ since }) => since !== null)
      .sort((a, b) => a.since - b.since || (a.ref < b.ref ? -1 : 1));
    return head === undefined || isOwn(head.ref);
  }

  /** Starts a poll with a new fetch budget. True when this waiter may take the turn. */
  function poll() {
    budget = QUEUE_FETCH_MAX;
    observe();
    return first();
  }

  /** Reads the queue again just before a take, within what is left of the poll's budget. */
  function stillFirst() {
    observe();
    return first();
  }

  // After every entry of the latest listing it has read, once it has read the admission's entries still listed.
  // Entries that joined since and are still unread could not see this waiter either.
  function ticket() {
    admission ??= new Set(fresh.map(({ sha }) => sha));
    if (fresh.some(({ sha }) => admission.has(sha) && !times.has(sha))) return null;
    let latest = -Infinity;
    for (const { sha } of fresh) latest = Math.max(latest, times.get(sha) ?? -Infinity);
    return Math.max(arrivedAt, latest + 1);
  }

  /** Joins the queue from the latest listing, then renews its entry every QUEUE_REFRESH_MS. */
  function refresh() {
    if (refreshedAt !== null && clock() - refreshedAt < QUEUE_REFRESH_MS) return;
    // No name of it on origin, as after a first push origin refused, so its entry is out of the queue: it joins again,
    // after the entries it read meanwhile.
    if (commit && ownListed.length === 0) {
      times.delete(commit);
      commit = undefined;
      ownEntry = null;
    }
    if (!commit) {
      const since = ticket();
      if (since === null) return;
      ownEntry = {
        kind: "land",
        host: hostname(),
        run_id: runId,
        waiting_since: new Date(since).toISOString(),
      };
      commit = makeCommit(ownEntry);
      times.set(commit, since);
    }
    // A push can apply although its answer was lost, so the names come from origin. The old ones go first, and the
    // newest after the new name is in place, so the entry keeps a name throughout.
    const [newest, ...older] = [...ownListed].sort((a, b) => sequenceOf(b) - sequenceOf(a));
    const kept =
      older.length === 0 || removeOrWarn(older, "old names of its queue entry")
        ? ownListed.length - older.length
        : list(`${ownRef}*`).filter(({ ref }) => isOwn(ref)).length;
    if (kept >= OWN_NAMES_MAX && newest) {
      // A child commit is a fast-forward, which needs no right to delete or force. Readers see the commit change.
      const parent = times.has(newest.sha) ? newest.sha : commit;
      const renewed = makeCommit(ownEntry, parent);
      remoteGit([
        "push",
        "--quiet",
        `--force-with-lease=${newest.ref}:${newest.sha}`,
        remote,
        `${renewed}:${newest.ref}`,
      ]);
      times.set(renewed, times.get(commit));
      commit = renewed;
      refreshedAt = clock();
      warnOnce("origin keeps the old names of its queue entry, so it renews the newest in place.");
      return;
    }
    remoteGit(["push", "--quiet", remote, `${commit}:${ownRef}${++sequence}`]);
    refreshedAt = clock();
    if (newest) removeOrWarn([newest], "old names of its queue entry");
  }

  return {
    poll,
    stillFirst,
    refresh,
    leave: () => {
      if (sequence > 0) remove(list(`${ownRef}*`).filter(({ ref }) => isOwn(ref)));
    },
  };
}

module.exports = { createQueueWaiter };
