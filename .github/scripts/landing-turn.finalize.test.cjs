const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { CHECK_METRICS_FILE_ENV, land, main } = require("./landing-turn.cjs");
const { QUEUE_PREFIX, setupGatedRepo } = require("./landing-turn.testkit.cjs");

test("AB#7486: queued second candidate establishes final SHA after integrating main move before approval, build, checks, and real pre-push", async () => {
  const { recordPass, requirePass } = require("./check-changed-receipt.cjs");
  const { root, origin, git, cloneGated, commitChange, readMainPushes } = setupGatedRepo();
  let firstChild;
  try {
    const first = cloneGated("first");
    const second = cloneGated("second");
    commitChange(first, "first.txt", "First candidate");
    commitChange(second, "second.txt", "Second candidate");
    const initialMain = git(origin, "rev-parse", "main");
    const initialSecond = git(second, "rev-parse", "HEAD");

    // Run candidate 1 in its own process so candidate 2's synchronous queue poll never blocks candidate 1.
    const firstScript = `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { land } = require(process.env.LANDING_TURN);
const { recordPass } = require(process.env.RECEIPT_MOD);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
(async () => {
  const res = await land({
    cwd: process.env.FIRST_CWD,
    remote: "origin",
    pollMs: 25,
    finalize: async ({ commit, base, rebased, directory }) => {
      if (rebased !== false || git(directory, "rev-parse", "HEAD") !== commit) return false;
      fs.writeSync(3, JSON.stringify({ commit, base }) + "\\n");
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", resolve);
        process.stdin.once("end", resolve);
      });
      return true;
    },
    check: (_turn, base, _budget, directory) => {
      recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
      return true;
    },
  });
  process.stdout.write(JSON.stringify(res));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
    firstChild = spawn(process.execPath, ["-e", firstScript], {
      env: {
        ...process.env,
        LANDING_TURN: require.resolve("./landing-turn.cjs"),
        RECEIPT_MOD: require.resolve("./check-changed-receipt.cjs"),
        FIRST_CWD: first,
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let firstStdout = "";
    let firstStderr = "";
    firstChild.stdout.on("data", (chunk) => (firstStdout += chunk));
    firstChild.stderr.on("data", (chunk) => (firstStderr += chunk));
    const firstDone = new Promise((resolve) =>
      firstChild.on("close", (code) => resolve({ code, stdout: firstStdout, stderr: firstStderr })),
    );
    const firstReady = new Promise((resolve, reject) => {
      let buf = "";
      firstChild.stdio[3].on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\n")) resolve(JSON.parse(buf.trim()));
      });
      firstChild.on("close", (code) =>
        reject(new Error(`first candidate exited early (${code}): ${firstStderr}`)),
      );
    });
    await firstReady;

    const events = [];
    let finalizedSha = null;
    let approvedSha = null;
    let builtSha = null;
    let speculativeCheckedTree = null;
    let speculativeCheckedBase = null;
    let sawQueuedBehindFirst = false;
    const specDone = Promise.withResolvers();

    const secondResult = await land({
      cwd: second,
      remote: "origin",
      pollMs: 25,
      sleep: async () => {
        if (!sawQueuedBehindFirst) {
          const queueRefs = git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
          if (queueRefs !== "") {
            sawQueuedBehindFirst = true;
            await specDone.promise;
            // Release candidate 1 only after candidate 2 is queued and has speculatively pre-checked candidate 1.
            firstChild.stdin.end("go\n");
            await firstDone;
          }
        }
      },
      finalize: async ({ commit, base, rebased, directory }) => {
        events.push(["finalize", commit, base, rebased]);
        assert.equal(rebased, true);
        assert.notEqual(commit, initialSecond);
        assert.equal(git(directory, "rev-parse", "HEAD"), commit);
        assert.equal(git(directory, "rev-parse", "HEAD^"), base);
        finalizedSha = commit;
        // Independent approval and exact build run strictly on the established final SHA.
        approvedSha = git(directory, "rev-parse", "HEAD");
        builtSha = git(directory, "rev-parse", "HEAD");
        return true;
      },
      check: (turn, base, _budget, directory) => {
        const sha = git(directory, "rev-parse", "HEAD");
        const phase = turn ? "turn" : base === initialMain ? "pre-wait" : "speculative";
        events.push(["check", phase, sha, base]);
        if (phase === "speculative") {
          // Prior pre-wait receipt against initialMain must not satisfy the new base.
          assert.throws(() => requirePass(directory, sha, base), /check:changed/);
          speculativeCheckedTree = git(directory, "rev-parse", "HEAD^{tree}");
          speculativeCheckedBase = base;
        }
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
        if (phase === "speculative") specDone.resolve();
        return true;
      },
    });

    const firstExit = await firstDone;
    assert.equal(firstExit.code, 0, firstExit.stderr);
    const firstResult = JSON.parse(firstExit.stdout);
    assert.equal(sawQueuedBehindFirst, true);
    assert.equal(firstResult.status, "landed");
    assert.equal(secondResult.status, "landed");
    assert.ok(finalizedSha);
    assert.equal(approvedSha, finalizedSha);
    assert.equal(builtSha, finalizedSha);
    assert.equal(speculativeCheckedBase, firstResult.commit);
    assert.equal(speculativeCheckedTree, git(second, "rev-parse", `${finalizedSha}^{tree}`));
    assert.equal(secondResult.commit, finalizedSha);
    assert.equal(git(origin, "rev-parse", "main"), finalizedSha);
    assert.deepEqual(readMainPushes(), [
      { oldSha: initialMain, newSha: firstResult.commit },
      { oldSha: firstResult.commit, newSha: finalizedSha },
    ]);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    assert.deepEqual(
      events.map(([kind, phase]) => (kind === "check" ? `${kind}:${phase}` : kind)),
      ["check:pre-wait", "check:speculative", "finalize"],
    );
  } finally {
    if (firstChild && firstChild.exitCode === null) {
      firstChild.stdin.end();
      firstChild.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7486: CLI `land --finalize` passes final commit/base metadata and fails closed on nonzero exit without pushing", async (t) => {
  const { recordPass } = require("./check-changed-receipt.cjs");
  const { root, origin, git, cloneGated, commitChange, readMainPushes } = setupGatedRepo();
  try {
    const dir = cloneGated("cli-lander");
    commitChange(dir, "cli.txt", "CLI finalize candidate");
    const mainBefore = git(origin, "rev-parse", "main");
    const head = git(dir, "rev-parse", "HEAD");
    const outFile = path.join(root, "finalize-env.json");
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(line));

    // Nonzero finalize command fails closed before any push and releases the lease.
    const failedCode = await main(["land", "--finalize", "exit 1"], {
      cwd: dir,
      check: (_turn, base, _budget, directory) => {
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
        return true;
      },
    });
    assert.equal(failedCode, 1);
    assert.deepEqual(JSON.parse(logs.at(-1)), {
      status: "finalize-failed",
      commit: head,
      base: mainBefore,
    });
    assert.equal(readMainPushes().length, 0);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // Passing finalize command receives exact commit, base, and rebased metadata, strips any outer
    // CHECK_CHANGED_METRICS_FILE (including mixed-case variants), and lands.
    const priorMetricsEnv = Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() === CHECK_METRICS_FILE_ENV,
    );
    for (const [key] of priorMetricsEnv) delete process.env[key];
    process.env.Check_Changed_Metrics_File = "/outer/mixed.json";
    process.env[CHECK_METRICS_FILE_ENV] = "/outer/upper.json";
    let okCode;
    try {
      const recordCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({commit: process.env.T3_LANDING_FINAL_COMMIT, base: process.env.T3_LANDING_FINAL_BASE, rebased: process.env.T3_LANDING_REBASED, cwdHead: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(), metricsKeys: Object.keys(process.env).filter((k) => k.toUpperCase() === ${JSON.stringify(CHECK_METRICS_FILE_ENV)})}))`,
      )}`;
      okCode = await main(["land", "--finalize", recordCmd], {
        cwd: dir,
        check: (_turn, base, _budget, directory) => {
          recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
          return true;
        },
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === CHECK_METRICS_FILE_ENV) delete process.env[key];
      }
      for (const [key, value] of priorMetricsEnv) {
        if (value !== undefined) process.env[key] = value;
      }
    }
    assert.equal(okCode, 0);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "landed", commit: head });
    assert.deepEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), {
      commit: head,
      base: mainBefore,
      rebased: "0",
      cwdHead: head,
      metricsKeys: [],
    });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
