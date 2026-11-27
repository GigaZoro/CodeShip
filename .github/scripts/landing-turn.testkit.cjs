// What the landing-turn.*.test.cjs files share. Requiring it also clears git's environment.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { LEASE_REF } = require("./landing-turn.cjs");

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

const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";

// What a lease names a machine other than the one the tests run on. A holder there sleeps when the waiter does not.
const ELSEWHERE = "another machine";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// What the pre-push hook hears of a push `land` makes: main moves, and the lease is deleted.
const ZERO = "0".repeat(40);
const LANDING_UPDATES = [
  { localSha: "1".repeat(40), remoteRef: "refs/heads/main" },
  { localSha: ZERO, remoteRef: LEASE_REF },
];

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

module.exports = {
  QUEUE_PREFIX,
  ELSEWHERE,
  ZERO,
  LANDING_UPDATES,
  setup,
  loseNextAnswer,
  signalServer,
  logTransactions,
  landingTransaction,
  stderrOf,
  running,
};
