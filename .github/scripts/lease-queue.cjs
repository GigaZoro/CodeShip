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

// Each heartbeat publishes the same commit at a new name before deleting the previous name. Readers use
// their own monotonic clocks to age unchanged names. A waiter's ticket comes after every entry it saw before
// joining, so clock skew only affects ordering between arrivals that did not see each other. The queue orders
// attempts, while the lease's compare-and-swap still grants ownership.
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
  const times = new Map();
  let seen = new Map();
  let commit;
  let sequence = 0;
  let refreshedAt = null;
  // The latest ticket among the fresh entries seen so far; null until a listing has been read.
  let latestSeen = null;
  let pruneFailure = null;

  function list(pattern) {
    return remoteGit(["ls-remote", "--refs", remote, pattern])
      .split("\n")
      .map((row) => row.split("\t"))
      .filter(([sha, ref]) => ref?.startsWith(QUEUE_PREFIX) && !/^0+$/.test(sha))
      .map(([sha, ref]) => ({ sha, ref }));
  }

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

  // Reads the queue. Returns its fresh entries by ticket, or null while some fresh entry is still unread.
  function observe() {
    const listed = list(`${QUEUE_PREFIX}*`);
    const observedAt = clock();
    const before = seen;
    seen = new Map();
    const fresh = [];
    const stale = [];
    for (const entry of listed) {
      const { ref, sha } = entry;
      const previous = before.get(ref);
      const firstSeen = previous?.sha === sha ? previous.firstSeen : observedAt;
      seen.set(ref, { sha, firstSeen });
      if (!isOwn(ref) && observedAt - firstSeen >= QUEUE_STALE_MS) stale.push(entry);
      else fresh.push(entry);
    }
    prune(
      stale.slice(0, listed.length > QUEUE_MAX_ENTRIES ? QUEUE_PRUNE_MAX_OVER : QUEUE_PRUNE_MAX),
    );

    const listedShas = new Set(fresh.map(({ sha }) => sha));
    for (const sha of times.keys()) if (sha !== commit && !listedShas.has(sha)) times.delete(sha);
    const missing = [...listedShas].filter((sha) => !times.has(sha)).slice(0, QUEUE_FETCH_MAX);
    if (missing.length) {
      remoteGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...missing]);
      for (const sha of missing) times.set(sha, waitingSince(readMessage(sha)));
    }
    if (fresh.some(({ sha }) => !times.has(sha))) return null;
    const ordered = fresh
      .map(({ ref, sha }) => ({ ref, since: times.get(sha) }))
      .filter(({ since }) => since !== null)
      .sort((a, b) => a.since - b.since || (a.ref < b.ref ? -1 : 1));
    for (const { since } of ordered) latestSeen = Math.max(latestSeen ?? since, since);
    latestSeen ??= -Infinity;
    return ordered;
  }

  // A stale name is never reused. Checking its SHA still protects a ref someone moved since this listing. Stale
  // entries no longer count, so one origin will not delete blocks no one; the next poll tries it again.
  function prune(entries) {
    try {
      remove(entries);
      pruneFailure = null;
    } catch (error) {
      if (error.message !== pruneFailure)
        warn(`could not remove stale queue entries: ${error.message}`);
      pruneFailure = error.message;
    }
  }

  function canTake() {
    const ordered = observe();
    return ordered !== null && (ordered.length === 0 || isOwn(ordered[0].ref));
  }

  const ownEntries = () => list(`${ownRef}*`).filter(({ ref }) => isOwn(ref));
  function refresh() {
    if (refreshedAt !== null && clock() - refreshedAt < QUEUE_REFRESH_MS) return;
    if (!commit) {
      // The ticket comes after every entry seen, so the waiter joins once it has read the whole queue.
      if (latestSeen === null && observe() === null) return;
      const ticket = Math.max(arrivedAt, latestSeen + 1);
      commit = makeCommit({
        kind: "land",
        host: hostname(),
        run_id: runId,
        waiting_since: new Date(ticket).toISOString(),
      });
      times.set(commit, ticket);
    }
    // A push can apply even if its reply was lost. Reconcile the names before adding another, so a partial
    // refresh keeps a place in the queue and can leave at most two names.
    const [keep, ...older] = ownEntries().sort(
      (a, b) => Number(b.ref.slice(ownRef.length)) - Number(a.ref.slice(ownRef.length)),
    );
    remove(older);
    remoteGit(["push", "--quiet", remote, `${commit}:${ownRef}${++sequence}`]);
    if (keep) remove([keep]);
    refreshedAt = clock();
  }

  return {
    canTake,
    refresh,
    leave: () => {
      if (sequence > 0) remove(ownEntries());
    },
  };
}

module.exports = { createQueueWaiter };
