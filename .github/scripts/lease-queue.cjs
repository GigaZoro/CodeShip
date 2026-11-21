const { hostname } = require("node:os");

const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";
const QUEUE_REFRESH_MS = 60_000;
const QUEUE_STALE_MS = 3 * 60_000;
const QUEUE_MAX_ENTRIES = 200;
const QUEUE_PRUNE_MAX = 10;
const QUEUE_PRUNE_MAX_OVER = 50;

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
// their own monotonic clocks to age unchanged names, so clock skew only affects ordering between close arrivals.
// The queue orders attempts, while the lease's compare-and-swap still grants ownership.
function createQueueWaiter({
  remote,
  runId,
  arrivedAt,
  clock,
  remoteGit,
  readMessage,
  makeCommit,
}) {
  const ownRef = `${QUEUE_PREFIX}${runId}.`;
  const isOwn = (ref) => ref.startsWith(ownRef);
  const times = new Map();
  let seen = new Map();
  let commit;
  let sequence = 0;
  let refreshedAt = null;

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

  function canTake() {
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
    // A stale name is never reused. Checking its SHA still protects a ref someone moved since this listing.
    const overLimit = listed.length > QUEUE_MAX_ENTRIES;
    remove(stale.slice(0, overLimit ? QUEUE_PRUNE_MAX_OVER : QUEUE_PRUNE_MAX));
    if (overLimit) return false;

    if (times.size > 2 * QUEUE_MAX_ENTRIES) times.clear();
    const missing = [...new Set(fresh.map(({ sha }) => sha).filter((sha) => !times.has(sha)))];
    if (missing.length) {
      remoteGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...missing]);
      for (const sha of missing) times.set(sha, waitingSince(readMessage(sha)));
    }
    let first;
    for (const { ref, sha } of fresh) {
      const since = times.get(sha);
      if (since === null) continue;
      if (!first || since < first.since || (since === first.since && ref < first.ref)) {
        first = { ref, since };
      }
    }
    return !first || isOwn(first.ref);
  }

  const ownEntries = () => list(`${ownRef}*`).filter(({ ref }) => isOwn(ref));
  function refresh() {
    if (refreshedAt !== null && clock() - refreshedAt < QUEUE_REFRESH_MS) return;
    if (!commit) {
      commit = makeCommit({
        kind: "land",
        host: hostname(),
        run_id: runId,
        waiting_since: new Date(arrivedAt).toISOString(),
      });
      times.set(commit, arrivedAt);
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
