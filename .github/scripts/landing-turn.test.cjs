const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  BOOT_ID,
  LEASE_REF,
  LEASE_RENEW_MS,
  LEASE_RESERVE_MS,
  LEASE_TTL_MS,
  MAX_WAIT_MS,
  TURN_ENV,
  TURN_MAX_MS,
  checkBudgetSeconds,
  keepAwake,
  macAwakeMs,
  land,
  overlappingWorktrees,
  main,
  pushChecked,
  processHost,
  testing: { acquire, release, runCheck, tryAcquire },
  verifyPush,
  withTurn,
} = require("./landing-turn.cjs");
const { QUEUE_STALE_MS, createQueueWaiter } = require("./lease-queue.cjs");
const { probeProcess } = require("../../packages/shared/src/processProbe.ts");
const { isWindowsHost } = require("../../packages/shared/src/testing/hostPlatform.ts");

const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";
const QUEUE_REFRESH_MS = 60_000;
const QUEUE_FETCH_MAX = 100;
// One lease or queue call's limit in landing-turn.cjs.
const LEASE_CALL_MS = 60_000;
// What a lease names a machine other than the one the tests run on. A holder there sleeps when the waiter does not.
const ELSEWHERE = "another machine";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// What the pre-push hook hears of a push `land` makes: main moves, and the lease is deleted.
const ZERO = "0".repeat(40);
const LANDING_UPDATES = [
  { localSha: "1".repeat(40), remoteRef: "refs/heads/main" },
  { localSha: ZERO, remoteRef: LEASE_REF },
];

// `land` runs git itself, so its rebase needs an identity on a runner without one. A hook exports GIT_DIR
// and GIT_INDEX_FILE. Git for Windows opens /dev/null, not os.devNull (\\.\nul).
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function setup() {
  // `.native` also writes out a Windows short name (RUNNER~1), as git does in the paths it prints.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", origin);
  const clone = (name) => {
    const dir = path.join(root, name);
    git(root, "clone", "-q", origin, dir);
    return dir;
  };
  const seed = clone("seed");
  fs.copyFileSync(path.join(__dirname, "../../.gitattributes"), path.join(seed, ".gitattributes"));
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const commit = (dir, file) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", file);
  };
  const entryMessage = (runId, waitingSince) =>
    JSON.stringify({
      kind: "land",
      host: "fixture",
      run_id: runId,
      waiting_since: new Date(waitingSince).toISOString(),
    });
  // A queue entry's commit as another lander writes it.
  const entryCommit = (dir, runId, waitingSince) =>
    git(dir, "commit-tree", EMPTY_TREE, "-m", entryMessage(runId, waitingSince));
  const updateRefs = (lines) =>
    execFileSync("git", ["-C", origin, "update-ref", "--stdin"], { input: lines.join("") });
  // The entries of many other landers, `[runId, waitingSince]` each, put on origin in a few git calls.
  const seedEntries = (entries) => {
    const folder = fs.mkdtempSync(path.join(root, "entries-"));
    const files = entries.map(([runId, waitingSince], index) => {
      const file = path.join(folder, String(index));
      const author = "Fixture <fixture@example.invalid> 1767225600 +0000";
      fs.writeFileSync(
        file,
        `tree ${EMPTY_TREE}\nauthor ${author}\ncommitter ${author}\n\n${entryMessage(runId, waitingSince)}\n`,
      );
      return file;
    });
    execFileSync("git", ["-C", origin, "hash-object", "-t", "tree", "-w", "--stdin"], {
      input: "",
    });
    const shas = execFileSync(
      "git",
      ["-C", origin, "hash-object", "-t", "commit", "-w", "--stdin-paths"],
      { input: `${files.join("\n")}\n`, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    fs.rmSync(folder, { recursive: true });
    updateRefs(
      entries.map(([runId], index) => `create ${QUEUE_PREFIX}${runId}.1 ${shas[index]}\n`),
    );
    return shas;
  };
  const dropEntries = (runIds) =>
    updateRefs(runIds.map((runId) => `delete ${QUEUE_PREFIX}${runId}.1\n`));
  // The tickets of the queue entries on origin whose names `own` picks.
  const ticketsOn = (own) =>
    git(origin, "for-each-ref", "--format=%(refname) %(objectname)", QUEUE_PREFIX)
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split(" "))
      .filter(([ref]) => own(ref.slice(QUEUE_PREFIX.length)))
      .map(([, sha]) =>
        Date.parse(
          JSON.parse(git(origin, "show", "-s", "--format=%B", sha).split("\n")[0]).waiting_since,
        ),
      );
  return { root, origin, git, clone, commit, entryCommit, seedEntries, dropEntries, ticketsOn };
}

// A lander in its own process. It reports each pause it begins on fd 3, as "released" once the RELEASED file exists.
// With GO, its first pause lasts until that file exists.
const LANDER_SCRIPT = `
const fs = require("node:fs");
const { acquire } = require(process.env.LANDING_TURN).testing;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const released = () => process.env.RELEASED && fs.existsSync(process.env.RELEASED);
process.stdout.write(
  acquire({
    cwd: process.env.LANDER,
    remote: process.env.ORIGIN,
    pollMs: 50,
    maxWaitMs: 60000,
    sleep: (ms) => {
      fs.writeSync(3, released() ? "released\\n" : "pause\\n");
      while (process.env.GO && !fs.existsSync(process.env.GO)) pause(50);
      pause(ms);
    },
  }),
);
`;

function startLander({ name, cwd, origin, go = "", released = "" }) {
  const child = spawn(process.execPath, ["-e", LANDER_SCRIPT], {
    env: {
      ...process.env,
      LANDING_TURN: require.resolve("./landing-turn.cjs"),
      LANDER: cwd,
      ORIGIN: origin,
      GO: go,
      RELEASED: released,
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const begun = { pause: 0, released: 0 };
  let partial = "";
  const waiters = new Set();
  child.stdio[3].on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) begun[line] += 1;
    for (const waiter of waiters) {
      if (waiter.count(begun) < waiter.target) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  });
  const until = (count, target) =>
    count(begun) >= target
      ? Promise.resolve()
      : new Promise((resolve) => waiters.add({ count, target, resolve }));
  const lander = {
    name,
    result: null,
    /** Settles once the lander has begun `count` pauses. */
    paused: (count) => until(({ pause, released }) => pause + released, count),
    /** Settles once `count` pauses began after RELEASED existed; from the second, a whole poll began after it. */
    pausedSinceRelease: (count) => until(({ released }) => released, count),
    closed: new Promise((resolve) =>
      child.on("close", (code) => resolve((lander.result = { code, stdout, stderr }))),
    ),
    stop: () => child.kill(),
  };
  return lander;
}

/** Waits for `milestone`, failing at once when a lander in `running` ends first. */
async function reach(milestone, message, running) {
  const ended = await Promise.race([
    milestone.then(() => null),
    ...running.map((lander) => lander.closed.then(() => lander)),
  ]);
  if (ended) assert.fail(`${message}: the ${ended.name} lander ended: ${ended.result.stderr}`);
}

/** Apply one real lease push before reporting transport failure, optionally making the next read fail too. */
function loseNextAnswer(lander, origin, git, disconnect = false) {
  const marker = path.join(origin, "drop-ack");
  fs.writeFileSync(marker, "");
  git(
    lander,
    "config",
    "remote.origin.receivepack",
    [
      "receive() {",
      '  git-receive-pack "$1" || return $?',
      '  if [ -f "$1/drop-ack" ] && git -C "$1" show-ref --verify --quiet refs/heads/landing-lease/main; then',
      '    rm "$1/drop-ack" || return 1',
      disconnect ? '    mv "$1/HEAD" "$1/HEAD-away" || return 1' : "",
      "    return 1",
      "  fi",
      "  return 0",
      "}; receive",
    ].join("\n"),
  );
  return {
    marker,
    reconnect: () => fs.renameSync(path.join(origin, "HEAD-away"), path.join(origin, "HEAD")),
  };
}

/**
 * A local socket the fixture's git hooks and wrappers report to. `command(name)` is a shell command that says `name`
 * and waits for an answer: it exits 0 once answered, 1 when the socket closes or after 20 s. `onSignal(name, answer)`
 * hears each, so a test acts at that moment and answers when the waiting git call may go on.
 */
async function signalServer(root, onSignal) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (data) => onSignal(String(data).trim(), () => socket.end("go\n")));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const script = path.join(root, "signal.js");
  fs.writeFileSync(
    script,
    [
      'const net = require("node:net");',
      "const [port, name] = process.argv.slice(2);",
      'const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(name + "\\n"));',
      "setTimeout(() => process.exit(1), 20000).unref();",
      'socket.on("data", () => process.exit(0));',
      'socket.on("close", () => process.exit(1));',
      'socket.on("error", () => process.exit(1));',
    ].join("\n"),
  );
  const { port } = server.address();
  return {
    command: (name) => `"${process.execPath}" "${script}" ${port} ${name}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Logs each ref transaction origin commits; the function it returns reads them, as `{ oldSha, newSha, ref }` lists. */
function logTransactions(origin) {
  const log = path.join(origin, "transactions.log").replaceAll("\\", "/");
  fs.writeFileSync(
    path.join(origin, "hooks", "reference-transaction"),
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\n{ cat; echo; } >> "${log}"\n`,
    { mode: 0o755 },
  );
  return () =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "")
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [oldSha, newSha, ref] = line.split(" ");
            return { oldSha, newSha, ref };
          }),
      )
      .filter((updates) => updates.length > 0);
}

/** The transaction that moved origin's main, as `logTransactions` read it. */
function landingTransaction(transactions) {
  const landing = transactions().find((updates) =>
    updates.some(({ ref }) => ref === "refs/heads/main"),
  );
  // HEAD names main in origin, so it appears beside main for its reflog alone.
  return landing?.filter(({ ref }) => ref !== "HEAD");
}

/** Writes the scripts `files` maps to their lines into `root`, beside forever.js; returns the command running check.js. */
function writeScripts(root, files) {
  fs.writeFileSync(path.join(root, "forever.js"), "setInterval(() => {}, 1000);");
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), [...SCRIPT_START, ...lines].join("\n"));
  }
  return `"${process.execPath}" "${path.join(root, "check.js")}"`;
}

const SCRIPT_START = [
  'const { spawn } = require("node:child_process");',
  'const path = require("node:path");',
  "const start = (name, options) => spawn(process.execPath, [path.join(__dirname, name)], options);",
];

/** Calls `listener` with the whole lines `stream` printed so far, each time it prints. */
function onLines(stream, listener) {
  let printed = "";
  stream.on("data", (chunk) => {
    printed += chunk;
    listener(printed.split("\n").slice(0, -1));
  });
}

/** Collects what the lander writes to stderr while `run` runs. */
function stderrOf(run) {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk)) > 0;
  try {
    return { result: run(), written };
  } finally {
    process.stderr.write = write;
  }
}

// Only Linux's /proc tells a lander's kernel boot and PID namespace, so only there does a waiter take a lease over.
const TAKES_OVER = processHost() !== null;

// Takes the lease in a process of its own, which exits without giving it back.
function takeAndExit(cwd, remote) {
  const taken = spawnSync(
    process.execPath,
    [
      "-e",
      "const [script, cwd, remote] = process.argv.slice(1);" +
        'process.stdout.write(require(script).testing.tryAcquire({ cwd, remote, runId: "gone" }) ?? "");',
      path.join(__dirname, "landing-turn.cjs"),
      cwd,
      remote,
    ],
    { encoding: "utf8" },
  );
  assert.equal(taken.status, 0, taken.stderr);
  return taken.stdout;
}

/** Copies the lander's record when origin receives its push to main, which is what a waiter reads then. */
function watchPushRecord(git, origin, lander) {
  const hooks = path.join(origin, "hooks");
  const seen = path.join(origin, "seen-record");
  const records = path.join(lander, ".git", "landing-turn");
  fs.mkdirSync(hooks, { recursive: true });
  git(origin, "config", "core.hooksPath", hooks);
  fs.writeFileSync(
    path.join(hooks, "pre-receive"),
    "#!/bin/sh\nwhile read old new ref; do\n" +
      `  [ "$ref" = refs/heads/main ] && cat "${records.replaceAll("\\", "/")}"/* > "${seen.replaceAll("\\", "/")}"\n` +
      "done\nexit 0\n",
    { mode: 0o755 },
  );
  return () => JSON.parse(fs.readFileSync(seen, "utf8"));
}

test("a second lander cannot push to main while the first holds the turn, and the first checks under it only against a main that moved during its wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const first = clone("first");
    const second = clone("second");
    commit(first, "first.txt");
    commit(second, "second.txt");
    // Main moved after both started, so landing has to rebase and the earlier clone's checks would be stale.
    const mover = clone("mover");
    commit(mover, "mover.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");

    // Main from the named remote, as the CLI fetches it, also updates origin/main. A fetch that fails on that leaves
    // no turn ref behind, before the wait and in the turn, which it gives back.
    const lock = path.join(first, ".git/refs/remotes/origin/main.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const noTurnRefs = () =>
      assert.deepEqual(
        [
          git(first, "for-each-ref", "refs/worktree"),
          git(origin, "for-each-ref", "refs/heads/landing-lease"),
        ],
        ["", ""],
      );
    fs.writeFileSync(lock, "");
    await assert.rejects(
      () => land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
      /git fetch failed/,
    );
    noTurnRefs();
    fs.rmSync(lock);

    // The lander rebases before it waits, and lands again from the rebased tree.
    const rebases = async () => {
      assert.deepEqual(
        await land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
        {
          status: "rebased",
          base: git(mover, "rev-parse", "HEAD"),
          head: git(first, "rev-parse", "HEAD"),
        },
      );
      noTurnRefs();
      git(first, "merge-base", "--is-ancestor", git(mover, "rev-parse", "HEAD"), "HEAD");
    };
    await rebases();

    // Main moves while it waits behind the second lander's turn.
    const held = tryAcquire({ cwd: second, remote: origin, runId: "second" });
    await assert.rejects(
      () =>
        land({
          cwd: first,
          remote: "origin",
          check: (turn) => turn === null || assert.fail("checked under the turn"),
          sleep: () => {
            commit(mover, "moved.txt");
            git(mover, "push", "-q", "origin", "HEAD:main");
            fs.writeFileSync(lock, "");
            release({ cwd: second, remote: origin }, held);
          },
        }),
      /git fetch failed/,
    );
    noTurnRefs();
    fs.rmSync(lock);
    await rebases();

    // Checked before the wait against the main it rebased onto, and under the turn against the one main moved to.
    const rebasedOnto = git(mover, "rev-parse", "HEAD");
    const now = () => Date.UTC(2026, 0, 1);
    const again = tryAcquire({ cwd: second, remote: origin, runId: "second", now });
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    const checks = [];
    const result = await land({
      cwd: first,
      remote: "origin",
      now,
      turnClock: () => ticks.shift(),
      sleep: () => {
        commit(mover, "during.txt");
        git(mover, "push", "-q", "origin", "HEAD:main");
        release({ cwd: second, remote: origin }, again);
      },
      check: (turn, base, seconds) => {
        checks.push([base, seconds]);
        if (turn === null) return true;
        assert.equal(tryAcquire({ cwd: second, remote: origin, runId: "second", now }), null);
        assert.throws(
          () => verifyPush({ cwd: second, remote: origin, env: {}, updates: LANDING_UPDATES, now }),
          /landing turn/,
        );
        assert.throws(
          () =>
            verifyPush({
              cwd: second,
              remote: origin,
              env: { [TURN_ENV]: "0".repeat(40) },
              updates: LANDING_UPDATES,
              now,
            }),
          /landing turn/,
        );
        verifyPush({
          cwd: first,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now,
        });
        // A push of main that keeps the lease could move main after the lease ran out, so the holder too is refused.
        assert.throws(
          () =>
            verifyPush({
              cwd: first,
              remote: origin,
              env: { [TURN_ENV]: turn },
              updates: LANDING_UPDATES.slice(0, 1),
              now,
            }),
          /gives back its lease/,
        );
        return true;
      },
    });

    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [
      [rebasedOnto, undefined],
      [git(mover, "rev-parse", "HEAD"), checkBudgetSeconds(TURN_MAX_MS, 10 * 60 * 1000)],
    ]);
    assert.equal(git(origin, "rev-parse", "main"), git(first, "rev-parse", "HEAD"));
    assert.equal(git(first, "merge-base", "--is-ancestor", "origin/main", "HEAD") === "", true);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    // Main came through the turn's own ref, which is gone; FETCH_HEAD is left to the checkout's other fetches.
    assert.deepEqual(
      [
        fs.existsSync(path.join(first, ".git/FETCH_HEAD")),
        git(first, "for-each-ref", "refs/worktree"),
      ],
      [false, ""],
    );
    assert.ok(tryAcquire({ cwd: second, remote: origin, runId: "second" }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander's release notes go among the ones main gained meanwhile by date, with no merge config set up", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const entry = (date, title) => `## ${date} — ${title}\n\n- ${title}.`;
    const shipped = entry("2026-11-18", "Shipped");
    const mine = entry("2026-11-18", "Mine");
    const newer = entry("2026-11-19", "Newer");
    const notesOf = (dir) => path.join(dir, "docs/release-notes.md");
    const ship = (dir, ...entries) => {
      fs.writeFileSync(notesOf(dir), `${entries.join("\n\n")}\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "notes");
    };
    const seed = path.join(root, "seed");
    fs.mkdirSync(path.join(seed, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(seed, "docs"));
    for (const file of ["release-notes.cjs", "git-history.cjs"]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(seed, ".github/scripts", file));
    }
    ship(seed, shipped);
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    ship(lander, mine, shipped);
    const mover = clone("mover");
    ship(mover, newer, shipped);
    git(mover, "push", "-q", "origin", "HEAD:main");
    // A local attribute outranks .gitattributes. The lander refuses before it waits behind another one's turn.
    const local = path.join(lander, ".git/info/attributes");
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const held = tryAcquire({ cwd: mover, remote: origin, runId: "mover" });
    const waited = () => assert.fail("waited for the turn");
    for (const rule of ["merge=union", "!merge"]) {
      fs.writeFileSync(local, `docs/release-notes.md ${rule}\n`);
      await assert.rejects(
        () => land({ cwd: lander, remote: origin, check: () => true, sleep: waited }),
        /instead of its driver/,
      );
    }
    release({ cwd: mover, remote: origin }, held);
    fs.rmSync(local);

    // From a subdirectory too: the attribute is the notes' own, not one of a path below it.
    const landFromDocs = () =>
      land({ cwd: path.join(lander, "docs"), remote: origin, check: () => true });
    assert.equal((await landFromDocs()).status, "rebased");
    const result = await landFromDocs();

    assert.equal(result.status, "landed");
    assert.equal(
      fs.readFileSync(notesOf(lander), "utf8"),
      `${[newer, mine, shipped].join("\n\n")}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander adds its tool text bytes to the ones main gained meanwhile, with no merge config set up", async () => {
  const { root, git, clone } = setup();
  try {
    const file = "apps/server/src/provider/agentContextBudget.json";
    const ship = (dir, claude, mcp) => {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `${JSON.stringify({ claude, mcp }, null, 2)}\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "budget");
    };
    const seed = path.join(root, "seed");
    // The whole folder, so the copied lander finds every script it comes to require.
    fs.cpSync(__dirname, path.join(seed, ".github/scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../../.gitattributes"),
      path.join(seed, ".gitattributes"),
    );
    ship(seed, 100, 1000);
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    ship(lander, 100, 1430);
    const mover = clone("mover");
    ship(mover, 105, 1050);
    git(mover, "push", "-q", "origin", "HEAD:main");

    const remote = git(lander, "remote", "get-url", "origin");
    assert.equal((await land({ cwd: lander, remote, check: () => true })).status, "rebased");

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lander, file), "utf8")), {
      claude: 105,
      mcp: 1480,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing keeps a Mac awake until it exits, and starts nothing elsewhere", () => {
  const started = [];
  const run = (command, args) => {
    started.push([command, ...args]);
    return { on: () => {}, unref: () => {} };
  };
  for (const platform of ["linux", "win32", "darwin"]) keepAwake({ platform, pid: 42, run });
  assert.deepEqual(started, [["/usr/bin/caffeinate", "-i", "-w", "42"]]);
});

test("a lander with uncommitted files, failing checks or a conflict with main does not push and holds no turn afterwards", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const before = git(origin, "rev-parse", "main");

    // Status lists each file, which takes these past spawnSync's 1 MiB default.
    const scratch = Array.from(
      { length: 8000 },
      (_, index) => `scratch-${String(index).padStart(4, "0")}-${"x".repeat(140)}.txt`,
    );
    for (const file of scratch) fs.writeFileSync(path.join(dir, file), "scratch\n");
    const uncommitted = await land({
      cwd: dir,
      remote: origin,
      check: () => assert.fail("checked a tree it cannot push"),
    });
    assert.equal(uncommitted.status, "uncommitted");
    assert.deepEqual(
      uncommitted.files,
      scratch.map((file) => `?? ${file}`),
    );
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    for (const file of scratch) fs.rmSync(path.join(dir, file));

    // Before it waits behind another lander's turn.
    const holder = clone("holder");
    const holding = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const result = await land({
      cwd: dir,
      remote: origin,
      check: () => false,
      sleep: () => assert.fail("waited for the turn"),
    });

    assert.equal(result.status, "check-failed");
    assert.equal(git(origin, "rev-parse", "main"), before);
    release({ cwd: holder, remote: origin }, holding);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // A branch that moves during the wait is not what the checks passed for.
    const waiting = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const moved = await land({
      cwd: dir,
      remote: origin,
      check: () => true,
      sleep: () => {
        commit(dir, "later.txt");
        release({ cwd: holder, remote: origin }, waiting);
      },
    });
    assert.equal(moved.status, "head-moved");
    assert.equal(git(origin, "rev-parse", "main"), before);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    git(dir, "reset", "-q", "--hard", "HEAD~1");

    // Before it waits behind another lander's turn.
    const mover = clone("mover");
    fs.writeFileSync(path.join(mover, "change.txt"), "main's change\n");
    git(mover, "add", ".");
    git(mover, "commit", "-qm", "main's change");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const held = tryAcquire({ cwd: mover, remote: origin, runId: "mover" });
    await assert.rejects(
      () =>
        land({
          cwd: dir,
          remote: origin,
          check: () => assert.fail("checked"),
          sleep: () => assert.fail("waited for the turn"),
        }),
      /git rebase failed/,
    );
    assert.equal(git(origin, "rev-parse", "landing-lease/main"), held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI continues with main's copy of the script after it rebases before the wait, and refuses an earlier copy's relaunch", () => {
  const { root, git, clone, commit } = setup();
  try {
    const seed = path.join(root, "seed");
    const scripts = path.join(seed, ".github/scripts");
    fs.mkdirSync(scripts, { recursive: true });
    for (const file of [
      "landing-turn.cjs",
      "bounded-git.cjs",
      "lease-queue.cjs",
      "process-tree.cjs",
      "git-history.cjs",
      "release-notes.cjs",
    ]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    }
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "scripts");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    commit(lander, "change.txt");
    fs.writeFileSync(
      path.join(scripts, "landing-turn.cjs"),
      'console.log(`main\'s copy: ${process.argv.slice(2).join(" ")}`);\n',
    );
    git(seed, "commit", "-qam", "main's script");
    git(seed, "push", "-q", "origin", "HEAD:main");

    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(lander, ".github/scripts/landing-turn.cjs"), ...args],
        {
          cwd: lander,
          encoding: "utf8",
        },
      );
    // An earlier copy relaunched with `land --base --head`, before it listed the overlaps: refused, not continued.
    const before = git(lander, "rev-parse", "HEAD");
    const earlier = cli("land", "--base", git(seed, "rev-parse", "HEAD"), "--head", before);
    assert.deepEqual([earlier.status, earlier.stdout], [2, ""], earlier.stderr);
    assert.equal(git(lander, "rev-parse", "HEAD"), before);

    const run = cli("land");

    assert.deepEqual(
      [run.status, run.stdout],
      [
        0,
        `main's copy: land-rebased --base ${git(seed, "rev-parse", "HEAD")} --head ${git(lander, "rev-parse", "HEAD")}\n`,
      ],
      run.stderr,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting lander takes the turn over from a holder whose lease expired, and gives up after its wait", () => {
  const { root, origin, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const past = Date.parse("2026-01-01T00:00:00Z");
    assert.ok(
      tryAcquire({
        cwd: holder,
        remote: origin,
        runId: "holder",
        now: () => past,
        machine: ELSEWHERE,
      }),
    );

    assert.ok(acquire({ cwd: waiter, remote: origin, maxWaitMs: 0 }));
    // A poll every few seconds leaves FETCH_HEAD to the checkout's other fetches.
    assert.equal(fs.existsSync(path.join(waiter, ".git/FETCH_HEAD")), false);
    assert.throws(
      () => acquire({ cwd: holder, remote: origin, maxWaitMs: 0, sleep: () => {} }),
      /still holds/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the turn is held only for a callback in one process: the module exports no way to take it or give it back", () => {
  const exported = require("./landing-turn.cjs");
  assert.deepEqual(
    ["acquire", "tryAcquire", "release"].filter((name) => name in exported),
    [],
  );
});

const SKEWS = [
  [0, "runs with the holder's"],
  [11 * 60_000, "runs 11 minutes ahead"],
  [-11 * 60_000, "runs 11 minutes behind"],
];
for (const [skew, clockRuns] of SKEWS) {
  test(`a holder keeps the turn while it renews its lease, and a waiter whose clock ${clockRuns} takes it LEASE_TTL_MS after renewals stop`, async () => {
    const { root, origin, git, clone } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      const epoch = Date.parse("2026-01-01T00:00:00Z");
      let wall = epoch;
      const pushes = (turn) =>
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
      const renewals = [];
      let taken;
      let comeBack;
      await withTurn(
        {
          cwd: holder,
          remote: origin,
          now: () => wall,
          every: (ms, renew) => {
            renewals.push({ ms, renew });
            return () => renewals.splice(0);
          },
        },
        async (turn, signal) => {
          const [{ ms, renew }] = renewals;
          assert.equal(ms, LEASE_RENEW_MS);
          // The waiter polls once per renewal. Renewals keep the turn past LEASE_TTL_MS after the take, and the push
          // gate traces each one back to it. Then the holder stops renewing, as when its process dies.
          let renewing = 4;
          let time = 0;
          let stoppedAt = 0;
          taken = acquire({
            cwd: waiter,
            remote: origin,
            clock: () => time,
            awakeClock: () => time,
            now: () => wall + skew,
            pollMs: LEASE_RENEW_MS,
            sleep: (pause) => {
              time += pause;
              wall += pause;
              if (renewing > 0) {
                renewing -= 1;
                renew();
                pushes(turn);
                stoppedAt = time;
              }
              assert.ok(time - stoppedAt <= LEASE_TTL_MS, "kept waiting after the lease ran out");
            },
          });
          assert.equal(time - stoppedAt, LEASE_TTL_MS, "took the lease before it ran out");
          assert.ok(wall - epoch > LEASE_TTL_MS);
          assert.throws(() => pushes(turn), /landing turn/);
          // A holder that comes back finds the turn gone.
          const { written } = stderrOf(renew);
          comeBack = { aborted: signal.aborted, written: written.join("") };
        },
      );

      assert.equal(comeBack.aborted, true);
      assert.match(comeBack.written, /lost main's landing turn: another lander took the lease/);
      assert.deepEqual(renewals, [], "renewals went on after the turn");
      assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a waiter on its holder's machine leaves the lease alone through a sleep they share, and takes it once renewals stop for a lease of awake time", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    let wall = Date.parse("2026-01-01T00:00:00Z");
    const renewals = [];
    let taken;
    let comeBack;
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, renew) => {
          renewals.push(renew);
          return () => renewals.splice(0);
        },
      },
      async (_turn, signal) => {
        const [renew] = renewals;
        // On a Mac the monotonic clock counts sleep, as the wall clock does; the awake clock does not.
        let time = 0;
        let awake = 0;
        let awakeReads = 0;
        let renewedAt = null;
        const pass = (ms, asleepMs = 0) => {
          time += asleepMs + ms;
          wall += asleepMs + ms;
          awake += ms;
        };
        const steps = [
          // The machine sleeps half an hour, holder and waiter alike: three leases of wall time with no renewal.
          (pause) => pass(pause, 30 * 60_000),
          // The holder wakes after the waiter has polled once, and renews; then it renews no more.
          (pause) => {
            pass(pause);
            renew();
            renewedAt = awake;
          },
        ];
        taken = acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => {
            awakeReads += 1;
            return awake;
          },
          now: () => wall,
          pollMs: LEASE_RENEW_MS,
          sleep: (pause) => {
            (steps.shift() ?? pass)(pause);
            assert.ok(
              renewedAt === null || awake - renewedAt <= LEASE_TTL_MS,
              "kept waiting after the lease ran out",
            );
          },
        });
        assert.equal(steps.length, 0, "took the lease of a holder that slept with it");
        assert.equal(awake - renewedAt, LEASE_TTL_MS, "took the lease before it ran out awake");
        // A Mac reads its awake clock through osascript: as each lease commit first shows, and once a lease of the
        // monotonic clock passed since, not at every poll.
        assert.equal(awakeReads, 4);
        const { written } = stderrOf(renew);
        comeBack = { aborted: signal.aborted, written: written.join("") };
      },
    );

    assert.equal(comeBack.aborted, true);
    assert.match(comeBack.written, /lost main's landing turn: another lander took the lease/);
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lease names the machine and process that renew it, and when they last did", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    const leaseOf = (ref) =>
      JSON.parse(git(origin, "show", "-s", "--format=%B", ref).split("\n")[0]);
    const leases = [];
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn) => {
        leases.push(leaseOf(turn));
        wall += LEASE_RENEW_MS;
        renew();
        leases.push(leaseOf(LEASE_REF));
      },
    );

    // Origin is public, so the lease names its machine by a hash of the machine's name.
    const tag = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12);
    const at = (ms) => new Date(ms).toISOString();
    assert.deepEqual(
      leases.map(({ host, pid, acquired_at, renewed_at, expires_at }) => ({
        host,
        pid,
        acquired_at,
        renewed_at,
        expires_at,
      })),
      [
        {
          host: tag,
          pid: process.pid,
          acquired_at: at(epoch),
          renewed_at: at(epoch),
          expires_at: at(epoch + LEASE_TTL_MS),
        },
        {
          host: tag,
          pid: process.pid,
          acquired_at: at(epoch),
          renewed_at: at(epoch + LEASE_RENEW_MS),
          expires_at: at(epoch + LEASE_RENEW_MS + LEASE_TTL_MS),
        },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter whose clock runs 11 minutes ahead leaves a lease that renews alone, also once the turn's end cuts it short", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    const taken = [];
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (_turn, signal) => {
        // The last renewal before the turn ends lasts 30 seconds, then a waiter comes that never saw the lease.
        wall = epoch + TURN_MAX_MS - 30_000;
        renew();
        const lease = JSON.parse(
          git(origin, "show", "-s", "--format=%B", LEASE_REF).split("\n")[0],
        );
        assert.equal(Date.parse(lease.expires_at), epoch + TURN_MAX_MS);
        const ahead = () => wall + 11 * 60_000;
        taken.push(tryAcquire({ cwd: waiter, remote: origin, runId: "waiter", now: ahead }));
        assert.equal(signal.aborted, false);
      },
    );

    assert.deepEqual(taken, [null], "a waiter took a lease its holder had just renewed");
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renewals end with the turn: the last lasts only until the turn ends, and the next loses the turn", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    let lost;
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (_turn, signal) => {
        wall = epoch + TURN_MAX_MS - LEASE_RENEW_MS;
        renew();
        const lease = git(origin, "show", "-s", "--format=%B", LEASE_REF).split("\n")[0];
        assert.equal(Date.parse(JSON.parse(lease).expires_at), epoch + TURN_MAX_MS);
        wall = epoch + TURN_MAX_MS;
        const { written } = stderrOf(renew);
        lost = { aborted: signal.aborted, written: written.join("") };
      },
    );

    assert.equal(lost.aborted, true);
    assert.match(lost.written, /lost main's landing turn: the turn reached its end/);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a renewal whose answer was lost keeps the turn, and the turn gives back the lease origin took", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    // Origin takes a renewal, but neither its answer nor the next read of the lease gets back.
    const renewUnheard = () => {
      const { reconnect } = loseNextAnswer(holder, origin, git, true);
      const before = git(origin, "rev-parse", LEASE_REF);
      wall += LEASE_RENEW_MS;
      stderrOf(renew);
      reconnect();
      assert.notEqual(git(origin, "rev-parse", LEASE_REF), before, "origin did not take it");
    };
    await withTurn(
      {
        cwd: holder,
        remote: "origin",
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn, signal) => {
        renewUnheard();
        wall += LEASE_RENEW_MS;
        renew();
        assert.equal(signal.aborted, false, "lost the turn to its own renewal");
        assert.equal(git(origin, "rev-list", "--count", LEASE_REF), "3");
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
        renewUnheard();
      },
    );

    assert.equal(
      git(origin, "for-each-ref", LEASE_REF),
      "",
      "kept the lease of the unheard renewal",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose turn another lander took during its check pushes nothing", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const mover = clone("mover");
    commit(lander, "mine.txt");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    let taken;
    const result = await land({
      cwd: lander,
      remote: origin,
      now: () => wall,
      every: (_ms, tick) => ((renew = tick), () => {}),
      check: async (turn, _base, _seconds, _directory, signal) => {
        if (turn === null) {
          // Main moves after the check before the wait, so the lander checks again under the turn.
          commit(mover, "mover.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
          return true;
        }
        // The lander's machine sleeps through its renewals, and a lander on another machine takes the lease that ran out.
        wall += 2 * LEASE_TTL_MS;
        taken = acquire({
          cwd: other,
          remote: origin,
          now: () => wall,
          machine: ELSEWHERE,
          maxWaitMs: 0,
        });
        stderrOf(renew);
        assert.equal(signal.aborted, true, "the check was not told the turn was lost");
        return true;
      },
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease after it ran out.",
    });
    assert.equal(git(origin, "rev-parse", "main"), git(mover, "rev-parse", "HEAD"));
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander that slept between its check and its push learns at the push's renewal that it lost the turn, and pushes nothing", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let taken;
    const result = await land({
      cwd: lander,
      remote: origin,
      now: () => wall,
      every: () => () => {},
      check: () => true,
      // Main stays still, so the check before the wait is the only one. Under the turn, its renewals never run, as when
      // its machine sleeps before the push, and a lander on another machine takes the lease.
      turnClock: () => {
        wall += 2 * LEASE_TTL_MS;
        taken = acquire({
          cwd: other,
          remote: origin,
          now: () => wall,
          machine: ELSEWHERE,
          maxWaitMs: 0,
        });
        return 0;
      },
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease after it ran out.",
    });
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose lease another lander takes while its push is under way pushes nothing: main moves only with its lease", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const othersLease = tryAcquire({ cwd: other, remote: origin, runId: "other" });
    release({ cwd: other, remote: origin }, othersLease);
    // Origin has the push to main in hand when the other lander takes the lease, after the push's renewal.
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        'grep -q " refs/heads/main$" || exit 0',
        "unset GIT_QUARANTINE_PATH",
        `git update-ref ${LEASE_REF} ${othersLease}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = await land({
      cwd: lander,
      remote: origin,
      every: () => () => {},
      check: () => true,
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease before the push.",
    });
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "rev-parse", LEASE_REF), othersLease);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost has landed, even once another lander holds the lease it gave back", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    // The lease commit of another lander, which takes the lease the push gave back.
    const othersLease = tryAcquire({ cwd: other, remote: origin, runId: "other" });
    release({ cwd: other, remote: origin }, othersLease);
    // Origin applies the push to main, the other lander takes the lease, and the push's answer never comes.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        `  git -C "$1" update-ref ${LEASE_REF} ${othersLease} || return 1`,
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    const result = await land({
      cwd: lander,
      remote: "origin",
      every: () => () => {},
      // Stopped once origin applied it, as when its limit runs out.
      after: (_ms, stop) => ((stopPush = stop), () => {}),
      mainCallMs: 5000,
      check: () => true,
    });

    const head = git(lander, "rev-parse", "HEAD");
    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(
      git(origin, "rev-parse", LEASE_REF),
      othersLease,
      "gave back the other lander's lease",
    );
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost has landed when main holds it, though another landing moved main on", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    // Origin applies the push to main, another landing moves main on top of it, and the push's answer never comes.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        '  next=$(git -C "$1" commit-tree -p refs/heads/main -m next "refs/heads/main^{tree}") || return 1',
        '  git -C "$1" update-ref refs/heads/main "$next" || return 1',
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    const result = await land({
      cwd: lander,
      remote: "origin",
      every: () => () => {},
      after: (_ms, stop) => ((stopPush = stop), () => {}),
      mainCallMs: 5000,
      check: () => true,
    });

    const head = git(lander, "rev-parse", "HEAD");
    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main^"), head);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost, where origin then cannot be read, says whether it landed is unknown", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const unreadable = JSON.stringify(path.join(root, "unreadable"));
    // Origin applies the push to main, then answers no read, and the push's answer never comes. The turn's release
    // after it pushes nothing.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        `  [ -f ${unreadable} ] && return 0`,
        `  : > ${unreadable} || return 1`,
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    git(
      lander,
      "config",
      "remote.origin.uploadpack",
      [
        "upload() {",
        `  [ -f ${unreadable} ] && { echo "origin cannot be read" >&2; return 1; }`,
        '  git-upload-pack "$1"',
        "}; upload",
      ].join("\n"),
    );
    await assert.rejects(
      land({
        cwd: lander,
        remote: "origin",
        every: () => () => {},
        after: (_ms, stop) => ((stopPush = stop), () => {}),
        mainCallMs: 5000,
        // The release after it retries no read of origin, which stays unreadable.
        failingMs: 0,
        check: () => true,
      }),
      /git push failed, and whether it landed is unknown: [\s\S]*origin cannot be read/,
    );

    assert.equal(git(origin, "rev-parse", "main"), git(lander, "rev-parse", "HEAD"));
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PUSH_LIMITS = [
  ["while the turn has long to go", LEASE_RENEW_MS, LEASE_TTL_MS],
  ["near the turn's end", TURN_MAX_MS - 2 * 60_000, 2 * 60_000],
];
for (const [when, pushAt, limit] of PUSH_LIMITS) {
  test(`a push ${when} gives back a lease renewed for it, and is stopped before that lease runs out`, async () => {
    const { root, origin, git, clone, commit } = setup();
    try {
      const lander = clone("lander");
      commit(lander, "mine.txt");
      const transactions = logTransactions(origin);
      const epoch = Date.parse("2026-01-01T00:00:00Z");
      let wall = epoch;
      const limits = [];
      const result = await land({
        cwd: lander,
        remote: "origin",
        now: () => wall,
        every: () => () => {},
        mainCallMs: 3 * LEASE_TTL_MS,
        after: (ms) => (limits.push(ms), () => {}),
        check: () => true,
        // The turn, taken at the epoch, comes to its push at `pushAt`.
        turnClock: () => {
          wall = epoch + pushAt;
          return 0;
        },
      });

      assert.equal(result.status, "landed");
      // Each fetch of main, before the wait and under the turn, may take the whole limit of a call to main; the push
      // only what the lease renewed for it lasts.
      assert.deepEqual(limits, [3 * LEASE_TTL_MS, 3 * LEASE_TTL_MS, limit]);
      const givenBack = landingTransaction(transactions).find(({ ref }) => ref === LEASE_REF);
      assert.equal(givenBack.newSha, ZERO);
      const lease = git(origin, "show", "-s", "--format=%B", givenBack.oldSha).split("\n")[0];
      assert.equal(JSON.parse(lease).renewed_at, new Date(epoch + pushAt).toISOString());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a landing and a push of a commit checked elsewhere each move main and give the turn back in one push", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    const transactions = logTransactions(origin);
    commit(dir, "landed.txt");
    assert.equal((await land({ cwd: dir, remote: origin, check: () => true })).status, "landed");
    const landed = git(dir, "rev-parse", "HEAD");
    commit(dir, "synced.txt");
    const synced = git(dir, "rev-parse", "HEAD");
    await pushChecked({ cwd: dir, remote: origin, head: synced });

    assert.equal(git(origin, "rev-parse", "main"), synced);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    // One transaction each: origin never holds the new main beside the lease, nor drops the lease while main stays.
    // HEAD names main in origin, so it appears beside main for its reflog alone.
    assert.deepEqual(
      transactions()
        .filter((updates) => updates.some(({ ref }) => ref === "refs/heads/main"))
        .map((updates) =>
          updates
            .filter(({ ref }) => ref !== "HEAD")
            .map(({ newSha, ref }) => [ref, newSha])
            .sort(),
        ),
      [landed, synced].map((head) => [
        [LEASE_REF, ZERO],
        ["refs/heads/main", head],
      ]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing's git calls leave the event loop free, so its renewals run while it rebases", async () => {
  const { root, origin, git, clone, commit } = setup();
  let renew;
  let renewed = null;
  // The rebase waits in its pre-rebase hook until the test renewed the lease.
  const signals = await signalServer(root, (name, answer) => {
    if (name !== "rebasing") return;
    const before = git(origin, "rev-parse", LEASE_REF);
    renew();
    renewed = git(origin, "rev-parse", `${LEASE_REF}^`) === before;
    answer();
  });
  try {
    const dir = clone("lander");
    commit(dir, "mine.txt");
    const mover = clone("mover");
    const hooks = path.join(root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "pre-rebase"),
      `#!/bin/sh\n${signals.command("rebasing")}\n`,
      {
        mode: 0o755,
      },
    );
    git(dir, "config", "core.hooksPath", hooks);
    const result = await land({
      cwd: dir,
      remote: origin,
      every: (_ms, tick) => ((renew = tick), () => {}),
      check: (turn) => {
        // Main moves after the check before the wait, so the lander rebases under the turn.
        if (turn === null) {
          commit(mover, "mover.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
        }
        return true;
      },
    });
    assert.equal(result.status, "landed");
    assert.equal(renewed, true, "the lease was not renewed while the rebase ran");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lost turn stops its check with every process the check started before the landing goes on", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
  let step;
  try {
    // The check starts a process of its own, as vp starts each step, and prints its pid.
    const script = path.join(root, "check.js");
    fs.writeFileSync(
      script,
      [
        'const { spawn } = require("node:child_process");',
        'const step = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'process.stdout.write(step.pid + "\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const lost = new AbortController();
    const passed = await runCheck(root, "turn", "base", 60, lost.signal, {
      command: `"${process.execPath}" "${script}"`,
      stdio: ["ignore", "pipe", "inherit"],
      onSpawn: (child) => {
        let printed = "";
        child.stdout.on("data", (chunk) => {
          printed += chunk;
          if (!printed.includes("\n") || lost.signal.aborted) return;
          step = Number(printed.trim());
          lost.abort(new Error("lost"));
        });
      },
    });

    assert.equal(passed, false);
    assert.ok(step > 0, "the check never started its step");
    assert.equal(probeProcess(step).state, "gone", "the check's step outlived it");
  } finally {
    if (step > 0 && probeProcess(step).state === "alive") process.kill(step, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a lost turn stops what its check started, also once the process between them exited",
  { skip: isWindowsHost },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
    let worker;
    try {
      const command = writeScripts(root, {
        // The middle process starts the worker and exits, so the worker's parent is init by the stop.
        "check.js": [
          'const middle = start("middle.js", { stdio: ["ignore", "pipe", "inherit"] });',
          "middle.stdout.pipe(process.stdout, { end: false });",
          'middle.on("exit", () => process.stdout.write("middle exited\\n"));',
          "setInterval(() => {}, 1000);",
        ],
        "middle.js": [
          'const worker = start("forever.js", { stdio: "ignore" });',
          'process.stdout.write(worker.pid + "\\n");',
          "worker.unref();",
        ],
      });
      const lost = new AbortController();
      const passed = await runCheck(root, "turn", "base", 60, lost.signal, {
        command,
        stdio: ["ignore", "pipe", "inherit"],
        onSpawn: (child) =>
          onLines(child.stdout, (lines) => {
            const pid = lines.find((line) => /^\d+$/.test(line));
            if (!pid || !lines.includes("middle exited") || lost.signal.aborted) return;
            worker = Number(pid);
            lost.abort(new Error("lost"));
          }),
      });

      assert.equal(passed, false);
      assert.ok(worker > 0, "the middle process never started the worker");
      assert.equal(probeProcess(worker).state, "gone", "the worker outlived the check");
    } finally {
      if (worker > 0 && probeProcess(worker).state === "alive") process.kill(worker, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a lost turn stops a process its check started in a process group of its own",
  { skip: isWindowsHost },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
    let worker;
    try {
      const command = writeScripts(root, {
        "check.js": [
          'const worker = start("forever.js", { detached: true, stdio: "ignore" });',
          'process.stdout.write(worker.pid + "\\n");',
          "setInterval(() => {}, 1000);",
        ],
      });
      const lost = new AbortController();
      const passed = await runCheck(root, "turn", "base", 60, lost.signal, {
        command,
        stdio: ["ignore", "pipe", "inherit"],
        onSpawn: (child) =>
          onLines(child.stdout, ([pid]) => {
            if (!pid || lost.signal.aborted) return;
            worker = Number(pid);
            lost.abort(new Error("lost"));
          }),
      });

      assert.equal(passed, false);
      assert.ok(worker > 0, "the check never started the worker");
      assert.equal(
        probeProcess(worker).state,
        "gone",
        "the worker in its own group outlived the check",
      );
    } finally {
      if (worker > 0 && probeProcess(worker).state === "alive") process.kill(worker, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a check that exits ends with what it left running, which would keep its output open",
  { skip: isWindowsHost },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
    let worker;
    try {
      const command = writeScripts(root, {
        "check.js": [
          'const worker = start("forever.js", { stdio: ["ignore", "inherit", "inherit"] });',
          'process.stdout.write(worker.pid + "\\n");',
          "worker.unref();",
        ],
      });
      const passed = await runCheck(root, "turn", "base", 60, new AbortController().signal, {
        command,
        stdio: ["ignore", "pipe", "inherit"],
        onSpawn: (child) => onLines(child.stdout, ([pid]) => (worker ??= Number(pid))),
      });

      assert.equal(passed, true);
      assert.ok(worker > 0, "the check never started the worker");
      assert.equal(probeProcess(worker).state, "gone", "the worker outlived the check");
    } finally {
      if (worker > 0 && probeProcess(worker).state === "alive") process.kill(worker, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a stop that cannot list the check's processes still ends them, and fails at once",
  { skip: isWindowsHost },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
    const searchPath = process.env.PATH;
    let worker;
    try {
      const command = writeScripts(root, {
        "check.js": [
          'const worker = start("forever.js", { stdio: "ignore" });',
          'process.stdout.write(worker.pid + "\\n");',
          "setInterval(() => {}, 1000);",
        ],
      });
      const fake = path.join(root, "bin");
      fs.mkdirSync(fake);
      fs.writeFileSync(path.join(fake, "ps"), "#!/bin/sh\necho 'no process table' >&2\nexit 1\n", {
        mode: 0o755,
      });
      const lost = new AbortController();
      await assert.rejects(
        runCheck(root, "turn", "base", 60, lost.signal, {
          command,
          stdio: ["ignore", "pipe", "inherit"],
          onSpawn: (child) =>
            onLines(child.stdout, ([pid]) => {
              if (!pid || lost.signal.aborted) return;
              worker = Number(pid);
              // The stop's listing finds this ps first.
              process.env.PATH = `${fake}${path.delimiter}${searchPath}`;
              lost.abort(new Error("lost"));
            }),
        }),
        /ps failed: no process table/,
      );
      assert.ok(worker > 0, "the check never started the worker");
      assert.equal(probeProcess(worker).state, "gone", "the worker outlived the failed stop");
    } finally {
      process.env.PATH = searchPath;
      if (worker > 0 && probeProcess(worker).state === "alive") process.kill(worker, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// A lander in its own process that runs a check, which prints what it prints.
const CHECKING_LANDER_SCRIPT = `
const { runCheck } = require(process.env.LANDING_TURN).testing;
runCheck(process.cwd(), "turn", "base", 60, new AbortController().signal, { command: process.env.CHECK });
`;

test(
  "a check outlives no lander: once the lander dies, the check ends with every process it started",
  { skip: isWindowsHost },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
    let worker;
    try {
      const command = writeScripts(root, {
        "check.js": [
          'const worker = start("forever.js", { stdio: "inherit" });',
          'process.stdout.write(worker.pid + "\\n");',
          "setInterval(() => {}, 1000);",
        ],
      });
      const lander = spawn(process.execPath, ["-e", CHECKING_LANDER_SCRIPT], {
        cwd: root,
        env: {
          ...process.env,
          LANDING_TURN: require.resolve("./landing-turn.cjs"),
          CHECK: command,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      // The lander, the check and the worker all hold this output, so it ends once every one of them is gone.
      const ended = new Promise((resolve) => lander.stdout.on("end", resolve));
      onLines(lander.stdout, ([pid]) => {
        if (!pid || worker) return;
        worker = Number(pid);
        lander.kill("SIGKILL");
      });
      await ended;
      assert.ok(worker > 0, "the check never started the worker");
    } finally {
      if (worker > 0 && probeProcess(worker).state === "alive") process.kill(worker, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a fetch of main that stops answering ends the landing at its limit, with every process it started and the lease", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopFetch = () => {};
  let awake = 0;
  const signals = await signalServer(root, (name) => name === "fetching" && stopFetch());
  try {
    const dir = clone("lander");
    commit(dir, "mine.txt");
    const marker = path.join(origin, "hang-fetch");
    // Origin's first upload once the turn is held never answers; main's fetch before the wait and the lease's reads
    // before and after it go through.
    git(
      dir,
      "config",
      "remote.origin.uploadpack",
      [
        "upload() {",
        '  if [ -f "$1/hang-fetch" ]; then',
        '    rm "$1/hang-fetch" || return 1',
        `    ${signals.command("fetching")}`,
        "    return 1",
        "  fi",
        '  git-upload-pack "$1"',
        "}; upload",
      ].join("\n"),
    );
    await assert.rejects(
      land({
        cwd: dir,
        remote: "origin",
        every: () => {
          fs.writeFileSync(marker, "");
          return () => {};
        },
        // Stopped once origin heard it, as when its limit runs out awake.
        after: (ms, stop) => {
          stopFetch = () => {
            awake += ms;
            stop();
          };
          return () => {};
        },
        awakeClock: () => awake,
        mainCallMs: 5000,
        check: () => true,
      }),
      /git fetch failed: did not finish within 5 seconds/,
    );
    assert.equal(fs.existsSync(marker), false, "the fetch never asked origin");
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a renewal origin does not answer keeps the turn, is reported once and is tried again at the next one", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const away = `${origin}-away`;
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn, signal) => {
        fs.renameSync(origin, away);
        const { written } = stderrOf(() => {
          for (let renewal = 1; renewal <= 2; renewal++) {
            wall += LEASE_RENEW_MS;
            renew();
          }
        });
        fs.renameSync(away, origin);
        assert.equal(
          written.filter((line) => line.includes("could not renew the lease")).length,
          1,
          written.join(""),
        );
        // The lease ran out just now, but no lander took it, so it is still this holder's to renew.
        wall += LEASE_RENEW_MS;
        renew();
        assert.equal(signal.aborted, false);
        const renewed = git(origin, "rev-parse", LEASE_REF);
        assert.equal(git(origin, "rev-list", "--count", renewed), "2");
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
      },
    );

    assert.equal(git(origin, "for-each-ref", LEASE_REF), "", "kept the renewed lease");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wait goes on while its queue or the lease moves, and ends once neither has moved for its limit", () => {
  const { root, origin, clone, seedEntries, dropEntries } = setup();
  try {
    const holder = clone("holder");
    const other = clone("other");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder", now: () => epoch });
    const ahead = (runId) => seedEntries([[runId, epoch - 1000]]);
    ahead("ahead-0");
    let time = 0;
    const moves = [
      // Another waiter goes first in place of the one before it, twice.
      () => {
        dropEntries(["ahead-0"]);
        ahead("ahead-1");
      },
      () => {
        dropEntries(["ahead-1"]);
        ahead("ahead-2");
      },
      // The waiter comes first, then the lease changes hands.
      () => dropEntries(["ahead-2"]),
      () => {
        release({ cwd: holder, remote: origin }, held);
        tryAcquire({ cwd: other, remote: origin, runId: "other", now: () => epoch });
      },
    ];
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          now: () => epoch,
          maxWaitMs: 10,
          sleep: () => {
            time += 6;
            moves.shift()?.();
          },
        }),
      /still holds/,
    );

    // The last move was seen at 24, and the poll at 36 was the first one 10 or more after it.
    assert.deepEqual([moves.length, time], [0, 36]);
    // A wait outlasts a turn, the lease a holder left behind, a queue entry that stopped renewing and one call to origin.
    assert.equal(MAX_WAIT_MS, TURN_MAX_MS + LEASE_TTL_MS + QUEUE_STALE_MS + LEASE_CALL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wait counts the queue moving while its head checks its place before a take", () => {
  const { root, origin, clone, seedEntries } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    tryAcquire({
      cwd: holder,
      remote: origin,
      runId: "holder",
      now: () => epoch,
      machine: ELSEWHERE,
    });
    let wall = epoch;
    let time = 0;
    let pauses = 0;
    let joinAtRead = false;
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          maxWaitMs: 5,
          // In the third poll the holder's lease has run out, and an older entry joins as the waiter reads the lease.
          now: () => {
            if (joinAtRead) {
              joinAtRead = false;
              seedEntries([["older", epoch - 1000]]);
              wall = epoch + 2 * LEASE_TTL_MS;
            }
            return wall;
          },
          sleep: () => {
            pauses += 1;
            joinAtRead = pauses === 2;
            time += 5;
          },
        }),
      /timed out waiting for main's landing queue/,
    );

    // The head moved at 10, as the waiter checked its place, so its wait ended at 15.
    assert.equal(time, 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting landers take the turn in arrival order while both stay in the queue", async () => {
  const { root, origin, git, clone } = setup();
  const landers = [];
  try {
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const entries = () =>
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX).split("\n").filter(Boolean);
    // The first lander stays in its pause after it joins, while the later one polls the free lease.
    const go = path.join(root, "go");
    const first = startLander({ name: "first", cwd: clone("first"), origin, go });
    landers.push(first);
    await reach(first.paused(1), "the first lander never waited", landers);
    const released = path.join(root, "released");
    const later = startLander({ name: "later", cwd: clone("later"), origin, released });
    landers.push(later);
    // Each lander joins the queue in the poll before its first pause.
    await reach(later.paused(1), "the later lander never waited", landers);
    assert.equal(entries().length, 2, "the later lander joined the queue");
    release({ cwd: holder, remote: origin }, held);
    fs.writeFileSync(released, "");
    await reach(later.pausedSinceRelease(2), "the later lander stopped polling", landers);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "", "the later lander took the turn");

    fs.writeFileSync(go, "");
    await reach(first.closed, "the first lander never took the turn", [later]);
    assert.equal(first.result.code, 0, first.result.stderr);
    assert.equal(git(origin, "rev-parse", LEASE_REF), first.result.stdout);
    assert.equal(entries().length, 1, "the later lander left the queue");
    release({ cwd: holder, remote: origin }, first.result.stdout);
    await reach(later.closed, "the later lander never took the turn", []);
    assert.equal(later.result.code, 0, later.result.stderr);
    assert.equal(git(origin, "rev-parse", LEASE_REF), later.result.stdout);
    assert.deepEqual(entries(), []);
  } finally {
    for (const lander of landers) if (lander.result === null) lander.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter that joins after another comes after it, however far ahead the other's clock runs", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const ahead = clone("ahead");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}ahead.1`;
    git(
      ahead,
      "push",
      "-q",
      "origin",
      `${entryCommit(ahead, "ahead", epoch + 60 * 60_000)}:${ref}`,
    );

    let time = 0;
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          now: () => epoch,
          maxWaitMs: 1,
          sleep: () => (time += 1),
        }),
      /timed out waiting for main's landing queue/,
    );
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
    assert.equal(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), ref);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a queue longer than one poll reads still gives the turn to its first waiter", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const holder = clone("holder");
    const others = clone("others");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // More waiters join after it than the queue prunes in bulk for, each with its own entry commit.
    const laterCount = 210;
    let time = 0;
    let pauses = 0;
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => time,
      awakeClock: () => time,
      now: () => epoch,
      sleep: () => {
        time += 1;
        pauses += 1;
        assert.ok(pauses <= 10, "never took the turn");
        if (pauses > 1) return;
        const later = Array.from({ length: laterCount }, (_, index) => [
          entryCommit(others, `later-${index}`, epoch + 1000 + index),
          `${QUEUE_PREFIX}later-${index}.1`,
        ]);
        git(others, "push", "-q", "origin", ...later.map(([sha, ref]) => `${sha}:${ref}`));
        release({ cwd: holder, remote: origin }, held);
      },
    });

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    // One pause behind the holder, then one per bounded batch it reads; the poll reading the last batch takes the turn.
    assert.equal(pauses, Math.ceil(laterCount / QUEUE_FETCH_MAX));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter that finds a long queue reads one bounded batch per poll and joins while later landers come and go", () => {
  const { root, origin, clone, seedEntries, dropEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // Already waiting when it starts, on machines whose clocks run ahead of its own.
    const waitingCount = 250;
    const known = seedEntries(
      Array.from({ length: waitingCount }, (_, index) => [`a-${index}`, epoch + 60_000 + index]),
    );
    const latest = epoch + 60_000 + waitingCount - 1;
    // More landers than one poll reads join between its polls and leave before the next.
    const passing = (round) =>
      Array.from({ length: QUEUE_FETCH_MAX + 1 }, (_, index) => `z-${round}-${index}`);
    known.push(...seedEntries(passing(0).map((runId) => [runId, epoch + 120_000])));
    const fetched = () =>
      execFileSync("git", ["-C", waiter, "cat-file", "--batch-check"], {
        input: `${known.join("\n")}\n`,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line && !line.endsWith(" missing")).length;
    const isOwn = (name) => !/^[az]-/.test(name);
    let pauses = 0;
    let read = 0;
    const joined = new Error("joined");
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => pauses,
          awakeClock: () => pauses,
          now: () => epoch,
          sleep: () => {
            pauses += 1;
            const total = fetched();
            assert.ok(
              total - read <= QUEUE_FETCH_MAX,
              `poll ${pauses} read ${total - read} entries`,
            );
            read = total;
            const own = ticketsOn(isOwn);
            if (own.length > 0) {
              assert.ok(
                own.every((since) => since > latest),
                "joined ahead of entries it had seen",
              );
              throw joined;
            }
            // Its first poll reads a batch and the next ones what is left of the entries it found.
            assert.ok(pauses < Math.ceil(waitingCount / QUEUE_FETCH_MAX), "never joined the queue");
            dropEntries(passing(pauses - 1));
            known.push(...seedEntries(passing(pauses).map((runId) => [runId, epoch + 120_000])));
          },
        }),
      (error) => error === joined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter whose last read of the queue was cut short joins only once it has read it whole", () => {
  const { root, origin, clone, seedEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // The holder's lease ran out a whole lease ago, so a waiter that finds the queue empty reads it again before taking
    // over.
    tryAcquire({
      cwd: holder,
      remote: origin,
      runId: "holder",
      now: () => epoch - 2 * LEASE_TTL_MS,
      machine: ELSEWHERE,
    });
    // Between those reads, more landers join than one poll reads, on machines whose clocks run ahead.
    const ahead = Array.from({ length: QUEUE_FETCH_MAX + 10 }, (_, index) => [
      `ahead-${index}`,
      epoch + 60_000 + index,
    ]);
    const latest = epoch + 60_000 + ahead.length - 1;
    let wallReads = 0;
    let pauses = 0;
    const joined = new Error("joined");
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => pauses,
          awakeClock: () => pauses,
          // Its arrival reads the wall clock first, then the expiry check between the two reads of the queue.
          now: () => {
            wallReads += 1;
            if (wallReads === 2) seedEntries(ahead);
            return epoch;
          },
          sleep: () => {
            pauses += 1;
            const own = ticketsOn((name) => !name.startsWith("ahead-"));
            assert.ok(
              own.every((since) => since > latest),
              "joined ahead of entries it had seen",
            );
            if (own.length > 0) throw joined;
            assert.ok(pauses < 2, "never joined the queue");
          },
        }),
      (error) => error === joined,
    );
    assert.ok(wallReads >= 2, "the lease's expiry was never checked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale entry origin will not delete blocks no one, and the waiter says so once", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const crashed = clone("crashed");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}crashed.1`;
    git(crashed, "push", "-q", "origin", `${entryCommit(crashed, "crashed", epoch - 1)}:${ref}`);
    fs.writeFileSync(path.join(origin, `${ref}.lock`), "");

    let time = 0;
    const pauses = [QUEUE_STALE_MS - 1, QUEUE_STALE_MS];
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch,
        sleep: () => {
          time = pauses.shift();
          assert.notEqual(time, undefined, "waited after the entry went stale");
        },
      }),
    );

    assert.equal(time, QUEUE_STALE_MS);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), ref);
    assert.equal(
      written.filter((line) => line.includes("could not remove stale queue entries")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruning moves past stale entries origin will not delete, with one warning however the batches differ", () => {
  const { root, origin, git, clone, seedEntries } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // Eleven entries origin will not delete, more than one batch, and one it will.
    const locked = Array.from(
      { length: 11 },
      (_, index) => `crashed-${String(index).padStart(2, "0")}`,
    );
    seedEntries([...locked, "crashed-11"].map((runId, index) => [runId, epoch - 100 + index]));
    for (const runId of locked)
      fs.writeFileSync(path.join(origin, `${QUEUE_PREFIX}${runId}.1.lock`), "");

    let time = 0;
    let polls = 0;
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch,
        sleep: () => {
          polls += 1;
          if (polls === 5) release({ cwd: holder, remote: origin }, held);
          assert.ok(polls <= 5, "kept waiting after the lease was free");
          time = QUEUE_STALE_MS + polls;
        },
      }),
    );

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.deepEqual(
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX).split("\n"),
      locked.map((runId) => `${QUEUE_PREFIX}${runId}.1`),
    );
    assert.equal(
      written.filter((line) => line.includes("could not remove stale queue entries")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed lander blocks the next waiter until its entry is observed unchanged for the stale window", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const crashed = clone("crashed");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}crashed.1`;
    const sha = entryCommit(crashed, "crashed", epoch - 1);
    git(crashed, "push", "-q", "origin", `${sha}:${ref}`);

    let time = 0;
    const pauses = [QUEUE_STALE_MS - 1, QUEUE_STALE_MS];
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => time,
      awakeClock: () => time,
      // The other machine's wall clock is far behind, but the entry starts out fresh to this waiter.
      now: () => epoch + time,
      sleep: () => {
        assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
        assert.equal(git(origin, "rev-parse", ref), sha);
        time = pauses.shift();
        assert.notEqual(time, undefined, "waited after the entry went stale");
      },
    });

    assert.equal(time, QUEUE_STALE_MS, "took the turn before the stale window elapsed");
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(git(origin, "for-each-ref", QUEUE_PREFIX), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat renames the entry with its commit, and while origin keeps the old names it renews the newest in place", () => {
  const { root, origin, git, clone, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const later = clone("later");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const names = () =>
      git(origin, "for-each-ref", "--format=%(refname) %(objectname)", QUEUE_PREFIX)
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split(" "));
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    let time = 0;
    // A lander that came later polls the queue on the same clock.
    const behind = createQueueWaiter({
      remote: origin,
      runId: "later",
      arrivedAt: Date.parse("2026-01-01T00:00:00Z"),
      clock: () => time,
      remoteGit: (args) => git(later, ...args),
      readMessage: (sha) => git(later, "show", "-s", "--format=%B", sha),
      makeCommit: () => assert.fail("the later lander joined"),
      warn: () => {},
    });
    let commit;
    let ticket;
    const counts = [];
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        sleep: () => {
          const tickets = ticketsOn(() => true);
          ticket ??= tickets[0];
          commit ??= names()[0]?.[1];
          assert.ok(ticket, "published an entry");
          assert.ok(
            tickets.every((since) => since === ticket),
            "a heartbeat changed the ticket",
          );
          counts.push(tickets.length);
          if (counts.length <= 3) {
            assert.ok(
              names().every(([, sha]) => sha === commit),
              "a renaming heartbeat changed the commit",
            );
          }
          assert.equal(behind.poll(), false, "the later lander went ahead of a live waiter");
          // From its first heartbeat on, origin refuses to delete any queue entry.
          if (counts.length === 1) {
            fs.writeFileSync(
              path.join(hooks, "update"),
              `#!/bin/sh\ncase "$1" in ${QUEUE_PREFIX}*) [ "$3" = ${"0".repeat(40)} ] && exit 1;; esac\nexit 0\n`,
              { mode: 0o755 },
            );
          }
          if (counts.length === 9) release({ cwd: holder, remote: origin }, held);
          assert.ok(counts.length <= 9, "kept waiting after the lease was free");
          time += QUEUE_REFRESH_MS;
        },
      }),
    );

    // One more name per heartbeat while origin keeps the old ones, until three; then the newest moves on.
    assert.deepEqual(counts, [1, 2, 3, 3, 3, 3, 3, 3, 3]);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const [newest] = names()
      .map(([ref]) => ref)
      .sort((a, b) => Number(b.split(".").pop()) - Number(a.split(".").pop()));
    // Six renewals in place, each a fast-forward from the commit before.
    assert.equal(git(origin, "rev-list", "--count", newest), "7");
    assert.equal(
      written.filter((line) => line.includes("renews the newest in place")).length,
      1,
      written.join(""),
    );
    assert.equal(
      written.filter((line) => line.includes("could not remove old names")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter whose first entry origin refused joins again after the entries that came meanwhile", () => {
  const { root, origin, git, clone, entryCommit, dropEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const other = clone("other");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    fs.writeFileSync(
      path.join(hooks, "update"),
      `#!/bin/sh\ncase "$1" in ${QUEUE_PREFIX}*) [ -e refuse-entry ] && rm refuse-entry && exit 1;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(origin, "refuse-entry"), "");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ownTickets = () => ticketsOn((name) => !name.startsWith("other."));
    let time = 0;
    const pauses = [
      () => {
        assert.deepEqual(ownTickets(), [], "origin took the first entry");
        // Another lander joins, seeing no entry of the waiter's.
        const sha = entryCommit(other, "other", epoch + 60_000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        const [own] = ownTickets();
        assert.ok(own > epoch + 60_000, `joined ahead of an entry it had read: ${own}`);
        dropEntries(["other"]);
        release({ cwd: holder, remote: origin }, held);
        time = 2;
      },
    ];
    const { result: turn } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch + time,
        sleep: () => {
          const pause = pauses.shift();
          assert.ok(pause, "waited after the lease was free");
          pause();
        },
      }),
    );

    assert.equal(pauses.length, 0);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander removes its queue entry whether it takes the turn or ends its wait", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const refs = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const options = { cwd: waiter, remote: origin, now: () => epoch };
    const stopped = new Error("stopped waiting");
    const leaseLock = path.join(origin, `${LEASE_REF}.lock`);

    for (const outcome of ["timeout", "remote failure", "unexpected error", "acquired"]) {
      const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
      let time = 0;
      let queued;
      const wait = () =>
        acquire({
          ...options,
          clock: () => time,
          awakeClock: () => time,
          maxWaitMs: outcome === "timeout" ? 1 : undefined,
          failingMs: 0,
          sleep: () => {
            queued = refs();
            time += 1;
            if (outcome === "unexpected error") throw stopped;
            if (outcome === "remote failure") {
              release({ cwd: holder, remote: origin }, held);
              fs.writeFileSync(leaseLock, "");
            }
            if (outcome === "acquired") release({ cwd: holder, remote: origin }, held);
          },
        });

      if (outcome === "timeout") assert.throws(wait, /still holds/);
      if (outcome === "remote failure") {
        assert.throws(wait, /git push failed/);
        fs.rmSync(leaseLock);
      }
      if (outcome === "unexpected error") assert.throws(wait, (error) => error === stopped);
      if (outcome === "acquired") assert.equal(wait(), git(origin, "rev-parse", LEASE_REF));
      assert.ok(queued?.startsWith(QUEUE_PREFIX), outcome);
      assert.equal(refs(), "", outcome);
      if (outcome === "timeout" || outcome === "unexpected error")
        release({ cwd: holder, remote: origin }, held);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a waiter in a worktree of the lander's clone takes over a lease whose lander exited, and waits out one it cannot prove abandoned",
  {
    skip: !TAKES_OVER,
  },
  (t) => {
    const { root, origin, git, clone } = setup();
    try {
      const checkout = clone("checkout");
      // Another worktree of the same clone, as each landing in CodeShip has.
      const sibling = path.join(root, "sibling");
      git(checkout, "worktree", "add", "-q", "--detach", sibling);
      const records = path.join(checkout, ".git", "landing-turn");
      const lease = () => git(origin, "for-each-ref", "--format=%(objectname)", LEASE_REF);
      const wait = () => tryAcquire({ cwd: sibling, remote: origin, runId: "waiter" });

      takeAndExit(checkout, origin);
      const taken = wait();
      assert.equal(lease(), taken);
      assert.deepEqual(fs.readdirSync(records), [taken]);
      release({ cwd: sibling, remote: origin }, taken);
      assert.deepEqual(fs.readdirSync(records), []);

      // A lander that runs, one whose push to main may be in flight, one in another machine, boot or PID namespace, and
      // one whose record cannot be read may each still push.
      const live = tryAcquire({ cwd: checkout, remote: origin, runId: "live" });
      assert.equal(wait(), null);
      release({ cwd: checkout, remote: origin }, live);
      const exited = takeAndExit(checkout, origin);
      const record = path.join(records, exited);
      const written = fs.readFileSync(record, "utf8");
      const { host } = JSON.parse(written);
      const boot = fs.readFileSync(BOOT_ID, "utf8").trim();
      for (const unproven of [
        JSON.stringify({ ...JSON.parse(written), pushing: true }),
        JSON.stringify({ ...JSON.parse(written), host: "another machine" }),
        JSON.stringify({ ...JSON.parse(written), host: host.replace(boot, "another boot") }),
        "{",
      ]) {
        fs.writeFileSync(record, unproven);
        assert.equal(wait(), null, unproven);
      }
      // The lander marks a push and exits between the waiter's read of its record and the probe.
      fs.writeFileSync(record, written);
      const probe = process.kill;
      t.mock.method(process, "kill", (pid, signal) => {
        fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(written), pushing: true }));
        return probe.call(process, pid, signal);
      });
      assert.equal(wait(), null);
      t.mock.restoreAll();
      fs.writeFileSync(record, written);
      const retaken = wait();
      assert.equal(lease(), retaken);
      assert.deepEqual(fs.readdirSync(records), [retaken]);
      release({ cwd: sibling, remote: origin }, retaken);

      // A folder where the record should be leaves the lease to expire, and neither it nor another folder stops a take.
      const blocked = path.join(records, takeAndExit(checkout, origin));
      fs.rmSync(blocked);
      fs.mkdirSync(blocked);
      fs.mkdirSync(path.join(records, "other"));
      assert.equal(wait(), null);
      const future = Date.parse("2100-01-01T00:00:00Z");
      const late = tryAcquire({ cwd: sibling, remote: origin, runId: "waiter", now: () => future });
      assert.deepEqual([lease(), fs.readdirSync(records)], [late, [late]]);
      release({ cwd: sibling, remote: origin }, late);

      const away = takeAndExit(clone("elsewhere"), origin);
      assert.deepEqual([wait(), lease()], [null, away]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a waiter whose /proc shows no boot id it can use waits for the lease to expire, and still takes a free one",
  {
    skip: !TAKES_OVER,
  },
  (t) => {
    const { root, origin, git, clone } = setup();
    try {
      const checkout = clone("checkout");
      const sibling = path.join(root, "sibling");
      git(checkout, "worktree", "add", "-q", "--detach", sibling);
      const records = path.join(checkout, ".git", "landing-turn");
      const lease = () => git(origin, "for-each-ref", "--format=%(objectname)", LEASE_REF);
      const wait = () => tryAcquire({ cwd: sibling, remote: origin, runId: "waiter" });
      const read = fs.readFileSync;
      const bootReads = (boot) =>
        t.mock.method(fs, "readFileSync", (file, ...rest) =>
          file === BOOT_ID ? boot() : read.call(fs, file, ...rest),
        );
      const locked = () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${BOOT_ID}'`), {
          code: "EACCES",
        });
      };

      // An exited lander that, like this waiter, read an empty boot id.
      const exited = takeAndExit(checkout, origin);
      const record = path.join(records, exited);
      const blank = `${os.hostname()}  ${fs.readlinkSync("/proc/self/ns/pid")}`;
      fs.writeFileSync(
        record,
        JSON.stringify({ ...JSON.parse(read(record, "utf8")), host: blank }),
      );
      for (const boot of [() => "", () => "not a boot id", locked]) {
        bootReads(boot);
        assert.equal(wait(), null);
        t.mock.restoreAll();
      }
      release({ cwd: checkout, remote: origin }, exited);

      bootReads(locked);
      const free = wait();
      t.mock.restoreAll();
      const { host } = JSON.parse(read(path.join(records, free), "utf8"));
      assert.deepEqual([lease(), host], [free, os.hostname()]);
      release({ cwd: sibling, remote: origin }, free);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the holder command shows the lease and, when a worktree of this clone took it, its lander and whether it is gone", () => {
  const { root, origin, git, clone } = setup();
  try {
    const checkout = clone("checkout");
    const sibling = path.join(root, "sibling");
    git(checkout, "worktree", "add", "-q", "--detach", sibling);
    const holderOf = (cwd) => {
      const shown = spawnSync(
        process.execPath,
        [path.join(__dirname, "landing-turn.cjs"), "holder"],
        {
          cwd,
          encoding: "utf8",
        },
      );
      assert.equal(shown.status, 0, shown.stderr);
      return JSON.parse(shown.stdout);
    };

    assert.deepEqual(holderOf(sibling), { lease: null, local: null });
    const live = tryAcquire({ cwd: checkout, remote: origin, runId: "live" });
    const running = holderOf(sibling);
    assert.deepEqual(
      [
        running.lease,
        running.run_id,
        running.local.pid,
        running.local.checkout,
        running.local.gone,
      ],
      [live, "live", process.pid, checkout, false],
    );
    release({ cwd: checkout, remote: origin }, live);

    const exited = takeAndExit(checkout, origin);
    const gone = holderOf(sibling);
    assert.deepEqual(
      [gone.lease, gone.local.checkout, gone.local.gone],
      [exited, checkout, TAKES_OVER],
    );
    release({ cwd: checkout, remote: origin }, exited);

    const away = takeAndExit(clone("elsewhere"), origin);
    const elsewhere = holderOf(checkout);
    assert.deepEqual([elsewhere.lease, elsewhere.local], [away, null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting lander waits through failed reads of origin, and only failures that go on or come from its checkout end its wait", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const away = `${origin}-away`;
    // Each pause between polls takes 2 minutes. Origin cannot be reached for the second and the fourth poll: failures
    // 4 minutes apart, longer than failingMs, with a poll between them that saw the holder. Then the holder gives the
    // turn back.
    let minutes = 0;
    const pauses = [
      () => fs.renameSync(origin, away),
      () => fs.renameSync(away, origin),
      () => fs.renameSync(origin, away),
      () => {
        fs.renameSync(away, origin);
        release({ cwd: holder, remote: origin }, held);
      },
    ];
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => minutes * 60_000,
      awakeClock: () => minutes * 60_000,
      failingMs: 3 * 60_000,
      sleep: () => {
        minutes += 2;
        pauses.shift()();
      },
    });

    assert.deepEqual([pauses.length, git(origin, "rev-parse", "landing-lease/main")], [0, turn]);
    release({ cwd: waiter, remote: origin }, turn);

    // A Mac asleep with its lid closed wakes for a few seconds every half hour, without a network. The failures span an
    // hour of the clock that counts sleep, but under a minute awake, so the wait goes on, and so does the release that
    // meets the same wakes; failures the lander meets for as long as failingMs awake end the wait.
    const again = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    let asleepMs = 0;
    let awakeMs = 0;
    const darkWake = (after) => () => {
      asleepMs += 30 * 60_000;
      awakeMs += 10_000;
      after.shift()();
    };
    const dark = [
      () => fs.renameSync(origin, away),
      () => {},
      () => {},
      () => {
        fs.renameSync(away, origin);
        release({ cwd: holder, remote: origin }, again);
      },
    ];
    const afterSleep = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => asleepMs + awakeMs,
      awakeClock: () => awakeMs,
      sleep: darkWake(dark),
    });
    assert.deepEqual(
      [dark.length, git(origin, "rev-parse", "landing-lease/main")],
      [0, afterSleep],
    );
    fs.renameSync(origin, away);
    const darkRelease = [() => {}, () => {}, () => fs.renameSync(away, origin)];
    release(
      {
        cwd: waiter,
        remote: origin,
        clock: () => asleepMs + awakeMs,
        awakeClock: () => awakeMs,
        sleep: darkWake(darkRelease),
      },
      afterSleep,
    );
    assert.deepEqual(
      [darkRelease.length, git(origin, "for-each-ref", "refs/heads/landing-lease/main")],
      [0, ""],
    );
    const stillHeld = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    fs.renameSync(origin, away);
    let awakeMinutes = 0;
    const { written } = stderrOf(() =>
      assert.throws(
        () =>
          acquire({
            cwd: waiter,
            remote: origin,
            clock: () => 0,
            awakeClock: () => awakeMinutes * 60_000,
            sleep: () => {
              awakeMinutes += 6;
              if (awakeMinutes > 12) assert.fail("waited on after 10 minutes of failures awake");
            },
          }),
        /git ls-remote failed/,
      ),
    );
    assert.equal(awakeMinutes, 12);
    assert.ok(
      written.includes("landing turn: origin kept failing for 12 minutes awake; the wait ends.\n"),
      written.join(""),
    );
    fs.renameSync(away, origin);
    release({ cwd: holder, remote: origin }, stillHeld);

    fs.renameSync(origin, away);
    assert.throws(
      () => acquire({ cwd: holder, remote: origin, failingMs: 0 }),
      /git ls-remote failed/,
    );
    fs.renameSync(away, origin);

    // Origin answers, but this checkout cannot write the lease commit: waiting does not change that.
    const broken = clone("broken");
    git(broken, "config", "core.repositoryformatversion", "1");
    git(broken, "config", "extensions.landingTurnTest", "true");
    assert.throws(
      () =>
        acquire({
          cwd: broken,
          remote: origin,
          sleep: () => assert.fail("retried a local failure"),
        }),
      // git translates its own message, but not the extension's name.
      /git commit-tree failed: .*landingturntest/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Mac's awake clock is read again when the Mac slept through a read, and a reader that fails again throws", () => {
  const timedOut = {
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync /usr/bin/osascript ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  };
  const reads =
    (...results) =>
    () =>
      results.shift() ?? assert.fail("read the clock once more than expected");
  assert.equal(
    macAwakeMs(reads(timedOut, { status: 0, stdout: "153885715\n", stderr: "" })),
    153885715,
  );
  // A child can still print and exit 0 when the timeout kills it: the timeout decides.
  const killedLate = { ...timedOut, status: 0, stdout: "153885715\n" };
  assert.throws(() => macAwakeMs(reads(timedOut, killedLate)), /systemUptime failed: .*ETIMEDOUT/);
  assert.throws(
    () => macAwakeMs(reads({ status: 1, stdout: "", stderr: "execution error: -2700" })),
    /systemUptime failed: execution error: -2700/,
  );
  assert.throws(
    () => macAwakeMs(reads({ status: 1, signal: null, stdout: "", stderr: "" })),
    /systemUptime failed: exit status 1$/,
  );
  assert.throws(
    () => macAwakeMs(reads({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })),
    /systemUptime failed: signal SIGKILL$/,
  );
});

test("a waiting lander that cannot fetch the holder's lease leaves it in place", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    // Origin lists the lease but cannot send its commit, as when the fetch after the listing fails.
    fs.rmSync(path.join(origin, "objects", held.slice(0, 2), held.slice(2)));

    assert.throws(() => acquire({ cwd: waiter, remote: origin, maxWaitMs: 0 }), /git fetch failed/);
    assert.equal(git(waiter, "ls-remote", "--refs", origin, LEASE_REF).split("\t")[0], held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose push fails or times out is the lander's when origin took it, and a failed poll when it did not", () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    const { marker } = loseNextAnswer(lander, origin, git);

    const turn = acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 });
    assert.deepEqual(
      [fs.existsSync(marker), git(origin, "rev-parse", "landing-lease/main")],
      [false, turn],
    );
    // The lease is its wait's by the run id that wait made: another wait that names the same id does not get it.
    const { run_id: runId } = JSON.parse(
      git(origin, "show", "-s", "--format=%B", turn).split("\n")[0],
    );
    assert.equal(tryAcquire({ cwd: lander, remote: origin, runId }), turn);
    assert.throws(
      () => acquire({ cwd: lander, remote: origin, runId, maxWaitMs: 0 }),
      /still holds/,
    );
    // A release tries a passing failure of origin again, and logs one that goes on instead of throwing it.
    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    release({ cwd: lander, remote: "origin", failingMs: 0 }, turn);
    assert.equal(git(origin, "rev-parse", "landing-lease/main"), turn);
    release(
      {
        cwd: lander,
        remote: "origin",
        sleep: () => git(lander, "config", "--unset", "remote.origin.pushurl"),
      },
      turn,
    );
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    const stall = path.join(origin, "stall");
    fs.writeFileSync(stall, "");
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      'stall() { echo $$ > "$1/stall.pid"; cd / && while [ -f "$1/stall" ]; do sleep 0.1; done; exit 1; }; stall',
    );
    try {
      assert.throws(
        () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0, callMs: 10_000 }),
        /git push failed: did not finish within 10 seconds/,
      );
      // A lease call gives up together with its transport.
      const transport = Number(fs.readFileSync(path.join(origin, "stall.pid"), "utf8"));
      assert.equal(running(transport), false, "transport still runs");
    } finally {
      fs.rmSync(stall);
      git(lander, "config", "--unset", "remote.origin.receivepack");
    }

    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    assert.throws(
      () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 }),
      /git push failed/,
    );
    // Either take may have reached origin, so its record stays until a later take finds it past the turn's end.
    const records = path.join(lander, ".git", "landing-turn");
    assert.equal(fs.readdirSync(records).length, 2);
    git(lander, "config", "--unset", "remote.origin.pushurl");
    const later = Date.parse("2100-01-01T00:00:00Z");
    const taken = tryAcquire({ cwd: lander, remote: origin, runId: "later", now: () => later });
    assert.deepEqual(fs.readdirSync(records), [taken]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take that reached origin but lost its answer is the lander's although another entry is now first", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const pauses = [
      () => {
        reconnect();
        // An entry older than the lander's own joins while the lander cannot tell whether its take applied.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
      },
    ];
    let time = 0;
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      now: () => epoch,
      maxWaitMs: 2,
      sleep: () => {
        time += 1;
        const pause = pauses.shift();
        assert.ok(pause, "waited behind its own lease");
        pause();
      },
    });

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX),
      `${QUEUE_PREFIX}other.1`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose answer was lost goes back through the queue when its lease expired before it was confirmed", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        reconnect();
        lost = git(origin, "rev-parse", LEASE_REF);
        // The lease runs out before the lander can tell its take applied, and an older entry joins meanwhile.
        wall = epoch + LEASE_TTL_MS;
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      now: () => wall,
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), wall + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose lost answer is confirmed only after its lease expired goes back through the queue", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { marker } = loseNextAnswer(lander, origin, git);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const expired = epoch + LEASE_TTL_MS + 1000;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        lost = git(origin, "rev-parse", LEASE_REF);
        // An older entry joins while the lease that take left is expired.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      // The lease runs out between the take and the read that confirms it.
      now: () => (fs.existsSync(marker) ? epoch : expired),
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), expired + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing hands its check what the turn leaves, less the reserve for the push", () => {
  const full = (TURN_MAX_MS - LEASE_RESERVE_MS) / 1000;
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, 0), full);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, 30 * 60 * 1000), full - 1800);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS - 60 * 60 * 1000, 0), full - 3600);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, TURN_MAX_MS), 1);
});

test("land passes the budget the turn has left, measured from the turn's start", async () => {
  const { root, origin, clone, commit, git } = setup();
  try {
    const dir = clone("lander");
    const mover = clone("mover");
    commit(dir, "budget.txt");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    let budget;
    const result = await land({
      cwd: dir,
      remote: origin,
      now: () => wall,
      // An hour of the turn is gone when it starts, as when a take whose answer was lost is confirmed later.
      turnClock: () => {
        wall = epoch + 60 * 60 * 1000;
        return ticks.shift();
      },
      check: (turn, _base, seconds) => {
        if (turn) budget = seconds;
        else {
          assert.equal(seconds, undefined);
          commit(mover, "new-main.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
        }
        return true;
      },
    });
    assert.equal(result.status, "landed");
    assert.equal(budget, (TURN_MAX_MS - LEASE_RESERVE_MS) / 1000 - 3600 - 600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose main stays still checks once, before its wait, and holds the turn for the push alone", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "still.txt");
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const checks = [];
    const pushRecord = watchPushRecord(git, origin, dir);
    const result = await land({
      cwd: dir,
      remote: origin,
      check: (turn, base) => (checks.push([turn, base]), true),
      sleep: () => {
        assert.equal(checks.length, 1);
        release({ cwd: holder, remote: origin }, held);
      },
    });
    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [[null, git(holder, "rev-parse", "HEAD")]]);
    // A waiter that read the record while git pushed saw the push in flight.
    assert.equal(pushRecord().pushing, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the checks read a private checkout of the landed commit, not the lander's worktree", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const landed = git(dir, "rev-parse", "HEAD");
    let seen;
    let checkout;

    const result = await land({
      cwd: dir,
      remote: origin,
      check: (_turn, _base, _budget, directory) => {
        checkout = directory;
        // An edit made and undone while the checks run leaves the worktree clean again.
        fs.writeFileSync(path.join(dir, "base.txt"), "transient\n");
        seen = fs.readFileSync(path.join(directory, "base.txt"), "utf8");
        fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
        assert.equal(git(directory, "rev-parse", "HEAD"), landed);
        assert.notEqual(path.resolve(directory), path.resolve(dir));
        return true;
      },
    });

    assert.equal(seen, "base\n");
    assert.equal(result.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), landed);
    assert.equal(fs.existsSync(checkout), false);
    assert.equal(git(dir, "worktree", "list", "--porcelain").includes(checkout), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing continued after its rebase checks against the main it rebased onto, and stops if its branch left it", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const mover = clone("mover");
    commit(mover, "first.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const first = git(mover, "rev-parse", "HEAD");
    const rebased = await land({
      cwd: lander,
      remote: origin,
      check: () => assert.fail("checked"),
    });
    assert.deepEqual(rebased, {
      status: "rebased",
      base: first,
      head: git(lander, "rev-parse", "HEAD"),
    });
    commit(mover, "second.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    // A checkout switched to another branch after the rebase holds the base, but is not what was rebased.
    git(lander, "switch", "-q", "-c", "other", first);
    const switched = await land({
      cwd: lander,
      remote: origin,
      rebased,
      check: () => assert.fail("checked"),
    });
    assert.equal(switched.status, "head-moved");
    git(lander, "switch", "-q", "-");

    const checks = [];
    const result = await land({
      cwd: lander,
      remote: origin,
      rebased,
      check: (turn, base) => (checks.push([turn !== null, base]), true),
    });

    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [
      [false, first],
      [true, git(mover, "rev-parse", "HEAD")],
    ]);
    // The mover's branch is behind the commit that landed, as a rebased branch that was reset would be.
    git(mover, "fetch", "-q", "origin");
    const left = await land({
      cwd: mover,
      remote: origin,
      rebased: { base: result.commit, head: git(mover, "rev-parse", "HEAD") },
      check: () => assert.fail("checked"),
    });
    assert.equal(left.status, "head-moved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it fetches main before the wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // The fetch runs this transport, which moves the checkout as another process could, then serves main.
    const transport = path.join(root, "switching-transport.sh");
    fs.writeFileSync(
      transport,
      `git -C "${lander}" switch -q -c elsewhere HEAD~1\nexec git upload-pack "${origin}"\n`,
    );
    git(lander, "config", "protocol.ext.allow", "always");
    // ext:: splits its command at spaces; `% ` and `%%` keep the path whole.
    const quoted = transport.replaceAll("%", "%%").replaceAll(" ", "% ");
    git(lander, "remote", "add", "switching", `ext::sh ${quoted}`);
    const result = await land({
      cwd: lander,
      remote: "switching",
      check: () => assert.fail("checked"),
    });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it inspects the working tree", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // Another commit with the same tree, so the working tree stays clean after the switch.
    const other = git(lander, "commit-tree", "HEAD^{tree}", "-p", "HEAD~1", "-m", "other");
    git(lander, "branch", "elsewhere", other);
    // `git status` runs this fsmonitor hook from the worktree, so no path of the fixture goes through a shell.
    const script = "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/elsewhere\nexit 1\n";
    fs.writeFileSync(path.join(lander, ".git", "switching-fsmonitor.sh"), script, { mode: 0o755 });
    git(lander, "config", "core.fsmonitor", ".git/switching-fsmonitor.sh");
    const result = await land({ cwd: lander, remote: origin, check: () => assert.fail("checked") });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it fetches a main that moved under the turn", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const racer = clone("racer");
    let started = false;
    const result = await land({
      cwd: lander,
      remote: origin,
      check: () => true,
      turnClock: () => {
        if (!started) {
          started = true;
          git(lander, "switch", "-q", "-c", "elsewhere", "HEAD~1");
          commit(racer, "raced.txt");
          git(racer, "push", "-q", "origin", "HEAD:main");
        }
        return 0;
      },
    });
    assert.equal(result.status, "head-moved");
    assert.equal(git(origin, "rev-parse", "main"), git(racer, "rev-parse", "HEAD"));
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push of a commit checked elsewhere lands that commit while its record shows the push, and stops when its checkout left it", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const sync = clone("sync");
    commit(sync, "synced.txt");
    const checked = git(sync, "rev-parse", "HEAD");
    const main = git(sync, "rev-parse", "HEAD~1");
    // The checked tree on main's commit, so a pass for the checked tree covers it too.
    const sibling = git(sync, "commit-tree", "HEAD^{tree}", "-p", main, "-m", "sibling");
    const push = () => pushChecked({ cwd: sync, remote: origin, head: checked });
    // Git hands pre-push each ref as `<source> <sha> <destination> <sha>`: a source of `HEAD` would push
    // whatever the checkout is on when git reads it, after the check above.
    const hooks = path.join(root, "sync-hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\ncat >> ../pre-push.txt\n", {
      mode: 0o755,
    });
    git(sync, "config", "core.hooksPath", hooks);
    git(sync, "reset", "-q", "--hard", sibling);
    await assert.rejects(push, /the checkout moved off/);
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    git(sync, "reset", "-q", "--hard", checked);
    const pushRecord = watchPushRecord(git, origin, sync);
    // Once main took the push, a record the lander cannot write must not turn the landing into a failure.
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (fs.existsSync(to) && JSON.parse(fs.readFileSync(to, "utf8")).pushing) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    await push();
    t.mock.restoreAll();
    assert.deepEqual(
      [
        git(origin, "rev-parse", "main"),
        pushRecord().pushing,
        fs.readdirSync(path.join(sync, ".git", "landing-turn")),
      ],
      [checked, true, []],
    );
    const pushedToMain = fs
      .readFileSync(path.join(root, "pre-push.txt"), "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .filter((fields) => fields[2] === "refs/heads/main");
    assert.deepEqual(
      pushedToMain.map((fields) => fields[0]),
      [checked],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Whether `pid` still runs; a POSIX process that ended but is not yet reaped does not. */
function running(pid) {
  try {
    // oxlint-disable-next-line t3code/no-raw-process-probe -- a CommonJS test that loads no package
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM: a process of another user runs there. Anything else, such as a pid that is no number, fails the test
    // rather than pass it as a process that ended.
    if (error.code !== "EPERM") throw error;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain node test, with no Effect runtime
  if (process.platform === "win32") return true;
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return !/^\s*(Z|$)/.test(state);
}

test("a lander gives up on a fetch of main that stops answering, and stops its transport", async () => {
  const { root, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // A remote that never answers: git waits for the transport's first line. The transport ends by itself only
    // long after the call's limit, which leaves its start a wide margin.
    const pidFile = path.join(root, "transport.pid");
    fs.writeFileSync(
      path.join(root, "transport.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 60_000);
`,
    );
    git(lander, "config", "protocol.ext.allow", "always");
    git(lander, "remote", "add", "stalled", "ext::node ../transport.cjs");
    await assert.rejects(
      () =>
        land({
          cwd: lander,
          remote: "stalled",
          mainCallMs: 5000,
          check: () => assert.fail("checked"),
        }),
      /git fetch failed: did not finish within 5 seconds/,
    );
    assert.equal(running(Number(fs.readFileSync(pidFile, "utf8"))), false, "transport still runs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander runs a fetch of main again when a Mac's sleep used up its time limit", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // The first connection never answers, as one the Mac slept under; later ones reach origin.
    const slept = path.join(root, "slept").replaceAll("\\", "/");
    git(lander, "config", "protocol.ext.allow", "always");
    git(
      lander,
      "remote",
      "add",
      "sleepy",
      `ext::sh -c if% test% -e% '${slept}';% then% exec% %S% '${origin.replaceAll("\\", "/")}';% fi;% touch% '${slept}';% exec% sleep% 30`,
    );
    const result = await land({
      cwd: lander,
      remote: "sleepy",
      mainCallMs: 5000,
      // No time awake passes, so every limit that runs out here ran out asleep.
      awakeClock: () => 0,
      check: () => true,
      report: () => {},
    });
    assert.equal(result.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), result.commit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main that a Mac's sleep cut short runs again on a renewed lease, and one that used its limit awake fails", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  // Whether the time origin holds the push passes awake, or in a sleep longer than the lease.
  let awakeUnderPush = true;
  let awake = 0;
  const epoch = Date.parse("2026-01-01T00:00:00Z");
  let wall = epoch;
  const signals = await signalServer(root, (name) => name === "stalled" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const transactions = logTransactions(origin);
    // Origin holds the first push to main until the lander stops it, as when its limit runs out.
    const stalled = path.join(root, "stalled").replaceAll("\\", "/");
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        'grep -q " refs/heads/main$" || exit 0',
        `[ -e '${stalled}' ] && exit 0`,
        `touch '${stalled}'`,
        signals.command("stalled"),
        "sleep 30",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const landing = (options) =>
      land({
        cwd: lander,
        remote: origin,
        every: () => () => {},
        after: (ms, stop) => {
          stopPush = () => {
            if (awakeUnderPush) awake += ms;
            wall += awakeUnderPush ? ms : 2 * LEASE_TTL_MS;
            stop();
          };
          return () => {};
        },
        now: () => wall,
        awakeClock: () => awake,
        check: () => true,
        report: () => {},
        ...options,
      });

    // Near the turn's end a push may take only what the turn has left, less than a call to main may take.
    await assert.rejects(
      landing({
        mainCallMs: 3 * LEASE_TTL_MS,
        turnClock: () => {
          wall = epoch + TURN_MAX_MS - 2 * 60_000;
          return 0;
        },
      }),
      /git push failed: did not finish within 120 seconds/,
    );
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(
      git(origin, "for-each-ref", LEASE_REF),
      "",
      "the failed landing gave its lease back",
    );

    fs.rmSync(stalled);
    awakeUnderPush = false;
    const result = await landing({ mainCallMs: 5000 });
    const head = git(lander, "rev-parse", "HEAD");
    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "", "the push gave the lease back");
    // The lease the first push ran on expired in the sleep, so the push that landed gave back one renewed after it.
    const givenBack = landingTransaction(transactions).find(({ ref }) => ref === LEASE_REF);
    const lease = git(origin, "show", "-s", "--format=%B", givenBack.oldSha).split("\n")[0];
    assert.equal(JSON.parse(lease).renewed_at, new Date(wall).toISOString());
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main that a Mac's sleep cut short has landed when origin applies it before the rerun's renewal", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "stalled" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // Main stays still, so the landing pushes this commit; origin has its objects, as from the push it applies late.
    const head = git(lander, "rev-parse", "HEAD");
    git(origin, "fetch", "-q", lander, "HEAD");
    const stalled = path.join(root, "stalled").replaceAll("\\", "/");
    const applied = path.join(root, "applied").replaceAll("\\", "/");
    // Origin holds the push to main until the lander stops it, and applies it once the rerun renews the lease.
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        'if grep -q " refs/heads/main$"; then',
        `  [ -e '${stalled}' ] && exit 0`,
        `  touch '${stalled}'`,
        `  ${signals.command("stalled")}`,
        "  sleep 30",
        "  exit 1",
        "fi",
        `[ -e '${stalled}' ] && [ ! -e '${applied}' ] || exit 0`,
        `touch '${applied}'`,
        "unset GIT_QUARANTINE_PATH",
        `git update-ref refs/heads/main ${head} && git update-ref -d ${LEASE_REF}`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = await land({
      cwd: lander,
      remote: origin,
      every: () => () => {},
      // Stopped as when its limit runs out over a sleep, with no time awake spent.
      after: (_ms, stop) => ((stopPush = stop), () => {}),
      awakeClock: () => 0,
      mainCallMs: 5000,
      check: () => true,
      report: () => {},
    });

    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a replace ref cannot make main look contained in a commit that does not hold it", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const mover = clone("mover");
    commit(mover, "newer.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const newer = git(mover, "rev-parse", "HEAD");
    // A commit with HEAD's tree on top of main's newer commit, shown in HEAD's place.
    git(lander, "fetch", "-q", "origin");
    const fake = git(lander, "commit-tree", "HEAD^{tree}", "-p", newer, "-m", "fake");
    git(lander, "replace", "HEAD", fake);
    assert.equal(git(lander, "merge-base", "--is-ancestor", newer, "HEAD"), "");

    const rebased = await land({ cwd: lander, remote: origin, check: () => true });
    assert.equal(rebased.status, "rebased");
    const result = await land({ cwd: lander, remote: origin, rebased, check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "merge-base", "--is-ancestor", newer, "main") ?? "", "");
    assert.equal(git(origin, "show", "main:newer.txt"), "newer.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a command given an argument it does not take is refused before it takes the turn or pushes", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const main_ = git(origin, "rev-parse", "main");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(line));
    // `land` first: a mistyped flag there once started a real landing. `verify` would wait on stdin.
    const refused = [
      ["land", "--quick-precheck"],
      ["push"],
      ["push", "HEAD"],
      ["precheck"],
      [],
      ["verify"],
    ];
    for (const argv of [
      ...refused,
      ["push", git(dir, "rev-parse", "HEAD"), "extra"],
      ["verify", "origin", "extra"],
    ]) {
      assert.equal(await main(argv, { cwd: dir }), 2, JSON.stringify(argv));
    }
    assert.deepEqual(
      errors,
      Array(8).fill(
        "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote> | merge-budget <base> <ours> <theirs>",
      ),
    );
    assert.equal(git(origin, "rev-parse", "main"), main_);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("`push` reports the commit it names as landed only once main holds it", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("upgrade");
    commit(dir, "upgraded.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const reports = [];
    // What origin's main is when the command reports, so a report ahead of the push shows.
    t.mock.method(console, "log", (line) => reports.push([line, git(origin, "rev-parse", "main")]));

    assert.equal(await main(["push", head], { cwd: dir }), 0);
    assert.deepEqual(reports, [[JSON.stringify({ status: "landed", commit: head }), head]]);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander refuses files marked assume-unchanged or skip-worktree, whose edits status does not list", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git(dir, "update-index", flag, "base.txt");
      const result = await land({
        cwd: dir,
        remote: origin,
        check: () => assert.fail("checked a tree it cannot push"),
      });
      assert.deepEqual(result, { status: "marked-files", files: ["base.txt"] });
      git(dir, "update-index", flag.replace("--", "--no-"), "base.txt");
    }
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rebase that conflicts is aborted after the overlap listing, and a worktree in a stopped rebase is refused before the wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    fs.writeFileSync(path.join(lander, "base.txt"), "mine\n");
    git(lander, "commit", "-qam", "mine");
    const overlapping = path.join(root, "overlapping");
    git(lander, "worktree", "add", "-q", "-b", "overlapping", overlapping, "origin/main");
    commit(overlapping, "base.txt");
    const mover = clone("mover");
    fs.writeFileSync(path.join(mover, "base.txt"), "theirs\n");
    git(mover, "commit", "-qam", "theirs");
    git(mover, "push", "-q", "origin", "HEAD:main");

    // A conflict is when the listing helps most: it names the work to reconcile with.
    const reports = [];
    const report = (text) => reports.push(text);
    await assert.rejects(
      () => land({ cwd: lander, remote: origin, check: () => true, report }),
      /rebase/,
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*base\.txt/);
    assert.equal(git(lander, "status", "--porcelain"), "");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // Stop a rebase by hand: the next landing must not start from it.
    git(lander, "fetch", "-q", "origin");
    spawnSync("git", ["-C", lander, "rebase", "origin/main"], { encoding: "utf8" });
    const stopped = await land({
      cwd: lander,
      remote: origin,
      check: () => assert.fail("checked"),
    });
    assert.equal(stopped.status, "rebase-in-progress");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing lists other worktrees with unmerged work on the same files, and none that share nothing", async () => {
  const { root, git, clone, commit } = setup();
  try {
    const mine = clone("mine");
    commit(mine, "shared.txt");
    const base = git(mine, "rev-parse", "origin/main");
    const add = (name, file) => {
      const dir = path.join(root, name);
      git(mine, "worktree", "add", "-q", "-b", name, dir, base);
      commit(dir, file);
    };
    add("overlapping", "shared.txt");
    add("unrelated", "other.txt");
    // A branch with more changed file names than spawnSync's default 1 MiB buffer holds.
    const bulk = path.join(root, "bulk");
    git(mine, "worktree", "add", "--no-checkout", "-q", "-b", "bulk", bulk, base);
    const blob = git(bulk, "rev-parse", base + ":base.txt");
    const names = Array.from({ length: 6000 }, (_, i) => "x".repeat(200) + i);
    assert.ok(Buffer.byteLength(names.join("\n")) > 1024 * 1024);
    const tree = execFileSync("git", ["-C", bulk, "mktree"], {
      input:
        [
          git(bulk, "ls-tree", base),
          ...names.map((name) => "100644 blob " + blob + "\t" + name),
        ].join("\n") + "\n",
      encoding: "utf8",
    }).trim();
    git(bulk, "update-ref", "HEAD", git(bulk, "commit-tree", tree, "-p", base, "-m", "bulk"), base);
    const found = overlappingWorktrees({ cwd: mine, base });
    assert.deepEqual(
      found.map(({ branch, files }) => ({ branch, files })),
      [{ branch: "overlapping", files: ["shared.txt"] }],
    );
    // Git for Windows lists `C:/…`; the landing names the path as the system writes it.
    assert.equal(found[0].worktree, path.join(root, "overlapping"));

    // Main moved, so the landing rebases and lands from a relaunch, which does not list the overlaps again.
    const mover = clone("mover");
    commit(mover, "newer.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const reports = [];
    const options = {
      cwd: mine,
      remote: "origin",
      check: () => true,
      report: (text) => reports.push(text),
    };
    const rebased = await land(options);
    assert.equal(rebased.status, "rebased");
    assert.equal((await land({ ...options, rebased })).status, "landed");
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*shared\.txt/);
    assert.doesNotMatch(reports[0], /unrelated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
