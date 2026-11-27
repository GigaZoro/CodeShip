// One JSON line per landing, in the clone's Git folder, so landing speed and failures can be measured. A line holds
// no message, file name, path or machine name.
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = 1;
// The current file and the one it replaced hold the newest 2,000 lines at most.
const FILE_MAX_LINES = 1000;
// A rotation takes milliseconds, so a lock this old was left by a lander that died in one.
const STALE_LOCK_MS = 60 * 1000;

function warn(error) {
  const [reason] = String(error?.message ?? error).split("\n");
  process.stderr.write(`landing turn: could not record the landing: ${reason}\n`);
}

function isFull(file) {
  return fs.readFileSync(file, "utf8").split("\n").length > FILE_MAX_LINES;
}

/**
 * Renames a full `file` over the one before it. A rewrite could drop a line another lander appends meanwhile; a rename
 * keeps it. The lock keeps a second rotation from replacing the full file with the new one.
 */
function rotate(file) {
  if (!isFull(file)) return;
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Cleared for the next landing; this one's line is written already.
    const held = fs.statSync(lock, { throwIfNoEntry: false });
    if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lock);
    return;
  }
  try {
    if (isFull(file)) fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
  } finally {
    fs.rmdirSync(lock);
  }
}

function parseCarried(carried) {
  try {
    return JSON.parse(carried ?? "null");
  } catch (error) {
    warn(error);
    return null;
  }
}

/**
 * Collects one landing's record. `now` stamps its start and the monotonic `clock` times it. `carried` is `carry()` of
 * the process that rebased before the wait and started this one, so the two write one line.
 */
function startLandingRecord({ now, clock, carried }) {
  const started = clock();
  const earlier = parseCarried(carried);
  const startedAt = earlier?.startedAt ?? new Date(now()).toISOString();
  const phases = { ...earlier?.phases };
  const open = new Set();
  const elapsed = () => (earlier?.elapsedMs ?? 0) + clock() - started;
  const fields = { branch: null, base: null, head: null, stage: "before-wait" };

  /** Starts timing the phase `name`; the function it returns ends it. A phase that runs twice adds up. */
  const begin = (name) => {
    const from = clock();
    const end = () => {
      if (open.delete(end)) phases[name] = (phases[name] ?? 0) + clock() - from;
    };
    open.add(end);
    return end;
  };

  return {
    begin,
    async time(name, run) {
      const end = begin(name);
      try {
        return await run();
      } finally {
        end();
      }
    },
    /** `branch`, `base`, `head` or `stage`: "before-wait", "waiting" or "under-turn". */
    note: (values) => Object.assign(fields, values),
    carry: () => JSON.stringify({ startedAt, elapsedMs: elapsed(), phases }),
    /**
     * Appends the line to `<gitDir()>/t3-landing/landings.jsonl`. One short append, so two landers' lines do not mix.
     * It never throws: a record must not change how a landing ends.
     */
    write(gitDir, status) {
      try {
        for (const end of open) end();
        const { branch, base, head, stage } = fields;
        const record = {
          schema: SCHEMA,
          startedAt,
          branch,
          base,
          head,
          status,
          stage,
          durationMs: Math.round(elapsed()),
          phases: Object.fromEntries(
            Object.entries(phases).map(([name, ms]) => [name, Math.round(ms)]),
          ),
        };
        const file = path.join(gitDir(), "t3-landing", "landings.jsonl");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
        rotate(file);
      } catch (error) {
        warn(error);
      }
    },
  };
}

module.exports = { startLandingRecord };
