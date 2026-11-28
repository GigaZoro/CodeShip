const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const {
  land,
  testing: { release, tryAcquire },
} = require("./landing-turn.cjs");
const { recordPass, requirePass } = require("./check-changed-receipt.cjs");
const { QUEUE_PREFIX, setupGatedRepo } = require("./landing-turn.testkit.cjs");

async function runDriftScenario(scenario) {
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

const DRIFT_SCENARIOS = [
  { name: "candidate-tree-drift-during-finalize", kind: "candidate-tree", when: "finalize" },
  { name: "candidate-same-tree-amend-during-check", kind: "candidate-amend", when: "check" },
  { name: "base-drift-during-finalize", kind: "base", when: "finalize" },
  { name: "base-drift-during-check", kind: "base", when: "check" },
];

for (const scenario of DRIFT_SCENARIOS) {
  test(`AB#7486: ${scenario.name} aborts with zero main push attempts, no receipt reuse, and lease release`, async () => {
    await runDriftScenario(scenario);
  });
}
