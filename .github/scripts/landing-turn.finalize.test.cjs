const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  land,
  main,
  testing: { release, tryAcquire },
} = require("./landing-turn.cjs");
const { QUEUE_PREFIX, setup } = require("./landing-turn.testkit.cjs");

function setupGatedRepo() {
  const env = setup();
  const { root, origin, git, clone } = env;
  const pushLog = path.join(root, "main-pushes.log");

  const seed = clone("gated-seed");
  const scriptsTarget = path.join(seed, ".github", "scripts");
  fs.mkdirSync(scriptsTarget, { recursive: true });
  for (const file of [
    "landing-turn.cjs",
    "landing-record.cjs",
    "bounded-git.cjs",
    "lease-queue.cjs",
    "git-history.cjs",
    "process-tree.cjs",
    "release-notes.cjs",
    "check-changed-receipt.cjs",
  ]) {
    fs.copyFileSync(path.join(__dirname, file), path.join(scriptsTarget, file));
  }
  const viteHooksTarget = path.join(seed, ".vite-hooks");
  fs.mkdirSync(viteHooksTarget, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../../.vite-hooks/pre-push"),
    path.join(viteHooksTarget, "pre-push"),
  );
  fs.chmodSync(path.join(viteHooksTarget, "pre-push"), 0o755);
  fs.mkdirSync(path.join(seed, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(seed, "docs", "release-notes.md"),
    "## 2026-11-27 — Seed release\n\n- Initial gated fixture.\n",
  );
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed gated landing scripts and hooks");
  git(seed, "push", "-q", "origin", "HEAD:main");

  // Install after seed push so pushLog tracks only test-initiated main push attempts.
  const hooksDir = path.join(origin, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "pre-receive"),
    `#!/bin/sh
while IFS=' ' read -r old_sha new_sha ref_name; do
  if [ "$ref_name" = "refs/heads/main" ]; then
    printf '%s %s\\n' "$old_sha" "$new_sha" >> ${JSON.stringify(pushLog)}
  fi
done
`,
    { mode: 0o755 },
  );

  const cloneGated = (name) => {
    const dir = clone(name);
    git(dir, "config", "core.hooksPath", ".vite-hooks");
    return dir;
  };
  const commitChange = (dir, file, noteTitle) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    const notesPath = path.join(dir, "docs", "release-notes.md");
    const existing = fs.readFileSync(notesPath, "utf8");
    fs.writeFileSync(notesPath, `## 2026-11-27 — ${noteTitle}\n\n- Added ${file}.\n\n${existing}`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", noteTitle);
  };
  const readMainPushes = () =>
    fs.existsSync(pushLog)
      ? fs
          .readFileSync(pushLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [oldSha, newSha] = line.split(" ");
            return { oldSha, newSha };
          })
      : [];
  return { ...env, cloneGated, commitChange, readMainPushes };
}

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
    let checkedUnderTurnSha = null;
    let checkedUnderTurnBase = null;
    let sawQueuedBehindFirst = false;

    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const secondResult = await land({
      cwd: second,
      remote: "origin",
      pollMs: 25,
      sleep: (ms) => {
        if (!sawQueuedBehindFirst) {
          const queueRefs = git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
          if (queueRefs !== "") {
            sawQueuedBehindFirst = true;
            // Release candidate 1 only after candidate 2 is visibly queued behind it.
            firstChild.stdin.end("go\n");
          }
        }
        pause(ms);
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
        events.push(["check", turn ? "turn" : "pre-wait", sha, base]);
        if (turn) {
          // Finalization (approval + build) must already have recorded this exact SHA before check:changed.
          assert.equal(finalizedSha, sha);
          // Prior pre-wait receipt against initialMain must not satisfy the new base.
          assert.throws(() => requirePass(directory, sha, base), /check:changed/);
          checkedUnderTurnSha = sha;
          checkedUnderTurnBase = base;
        }
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
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
    assert.equal(checkedUnderTurnSha, finalizedSha);
    assert.equal(checkedUnderTurnBase, firstResult.commit);
    assert.equal(secondResult.commit, finalizedSha);
    assert.equal(git(origin, "rev-parse", "main"), finalizedSha);
    assert.deepEqual(readMainPushes(), [
      { oldSha: initialMain, newSha: firstResult.commit },
      { oldSha: firstResult.commit, newSha: finalizedSha },
    ]);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    assert.deepEqual(
      events.map(([kind, phase]) => (kind === "check" ? `${kind}:${phase}` : kind)),
      ["check:pre-wait", "finalize", "check:turn"],
    );
  } finally {
    if (firstChild && firstChild.exitCode === null) {
      firstChild.stdin.end();
      firstChild.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7486: candidate or base drift injected after finalization aborts with zero main push attempts, no receipt reuse, and lease release", async () => {
  const { recordPass, requirePass } = require("./check-changed-receipt.cjs");
  const scenarios = [
    { name: "candidate-tree-drift-during-finalize", kind: "candidate-tree", when: "finalize" },
    { name: "candidate-same-tree-amend-during-check", kind: "candidate-amend", when: "check" },
    { name: "base-drift-during-finalize", kind: "base", when: "finalize" },
    { name: "base-drift-during-check", kind: "base", when: "check" },
  ];
  for (const scenario of scenarios) {
    const { root, origin, git, cloneGated, commitChange, readMainPushes } = setupGatedRepo();
    try {
      const first = cloneGated("first");
      const intruder = cloneGated("intruder");
      commitChange(first, "first.txt", "First candidate");

      // Advance main with first candidate first (through normal landing).
      const firstResult = await land({
        cwd: first,
        remote: "origin",
        pollMs: 25,
        check: (_turn, base, _budget, directory) => {
          recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
          return true;
        },
      });
      assert.equal(firstResult.status, "landed", scenario.name);

      // Clone second from firstResult.commit so its pre-wait check passes cleanly against it;
      // hold the lease with `tryAcquire` (no background timer) until second enters the queue.
      const second = cloneGated("second");
      commitChange(second, "second.txt", "Second candidate");
      const holder = cloneGated("holder");
      const held = tryAcquire({ cwd: holder, remote: "origin", runId: "holder" });
      assert.ok(held, scenario.name);

      let queuedBase = firstResult.commit;
      let finalizedSha = null;
      let driftedSha = null;
      let driftedBase = null;
      let checkUnderTurnRan = false;
      let releasedHolder = false;
      let pushesBeforeSecond = 0;

      const injectDrift = () => {
        if (scenario.kind === "candidate-tree") {
          commitChange(second, "drift.txt", "Drifted candidate");
          driftedSha = git(second, "rev-parse", "HEAD");
        } else if (scenario.kind === "candidate-amend") {
          execFileSync("git", ["-C", second, "commit", "--amend", "-m", "Amended after finalize"], {
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_COMMITTER_DATE: "2026-11-28T00:00:00Z",
            },
          });
          driftedSha = git(second, "rev-parse", "HEAD");
        } else if (scenario.kind === "base") {
          git(intruder, "fetch", "-q", "origin");
          git(intruder, "reset", "-q", "--hard", "origin/main");
          commitChange(intruder, "base-drift.txt", "Base drift");
          // Bypass hook on intruder to simulate out-of-band base drift on origin/main.
          git(intruder, "push", "-q", "--no-verify", "origin", "HEAD:main");
          driftedBase = git(origin, "rev-parse", "main");
        }
      };

      const result = await land({
        cwd: second,
        remote: "origin",
        pollMs: 25,
        sleep: () => {
          if (!releasedHolder) {
            assert.notEqual(
              git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX),
              "",
              scenario.name,
            );
            git(intruder, "fetch", "-q", "origin");
            git(intruder, "reset", "-q", "--hard", "origin/main");
            commitChange(intruder, "queued-move.txt", "Queued main move");
            git(intruder, "push", "-q", "--no-verify", "origin", "HEAD:main");
            queuedBase = git(origin, "rev-parse", "main");
            pushesBeforeSecond = readMainPushes().length;
            release({ cwd: holder, remote: "origin" }, held);
            releasedHolder = true;
          }
        },
        finalize: async ({ commit, base, rebased }) => {
          finalizedSha = commit;
          assert.equal(rebased, true, scenario.name);
          assert.equal(base, queuedBase, scenario.name);
          if (scenario.when === "finalize") injectDrift();
          return true;
        },
        check: (turn, base, _budget, directory) => {
          if (turn) {
            checkUnderTurnRan = true;
            if (scenario.when === "check") injectDrift();
          }
          recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
          return true;
        },
      });

      assert.equal(releasedHolder, true, scenario.name);
      const pushesAfterSecond = readMainPushes();
      const expectedExtraPushes = scenario.kind === "base" ? 1 : 0;

      if (scenario.kind === "base") {
        assert.equal(result.status, "base-moved", scenario.name);
        assert.equal(result.expected, queuedBase, scenario.name);
        assert.equal(result.actual, driftedBase, scenario.name);
        assert.equal(git(origin, "rev-parse", "main"), driftedBase, scenario.name);
        assert.throws(() => requirePass(second, finalizedSha, driftedBase), /check:changed/);
      } else {
        assert.equal(result.status, "head-moved", scenario.name);
        assert.equal(result.expected, finalizedSha, scenario.name);
        assert.equal(result.actual, driftedSha, scenario.name);
        assert.equal(git(origin, "rev-parse", "main"), queuedBase, scenario.name);
        if (scenario.kind === "candidate-tree") {
          assert.throws(() => requirePass(second, driftedSha, queuedBase), /check:changed/);
        }
      }
      // Zero main push attempts by second lander.
      assert.equal(
        pushesAfterSecond.length - pushesBeforeSecond,
        expectedExtraPushes,
        `${scenario.name}: expected zero main push attempts by second lander`,
      );
      if (scenario.when === "finalize") {
        assert.equal(
          checkUnderTurnRan,
          false,
          `${scenario.name}: should not run turn check after drift`,
        );
      } else {
        assert.equal(checkUnderTurnRan, true, scenario.name);
      }
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "", scenario.name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

    // Passing finalize command receives exact commit, base, and rebased metadata and lands.
    const recordCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({commit: process.env.T3_LANDING_FINAL_COMMIT, base: process.env.T3_LANDING_FINAL_BASE, rebased: process.env.T3_LANDING_REBASED, cwdHead: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim()}))`,
    )}`;
    const okCode = await main(["land", "--finalize", recordCmd], {
      cwd: dir,
      check: (_turn, base, _budget, directory) => {
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
        return true;
      },
    });
    assert.equal(okCode, 0);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "landed", commit: head });
    assert.deepEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), {
      commit: head,
      base: mainBefore,
      rebased: "0",
      cwdHead: head,
    });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
