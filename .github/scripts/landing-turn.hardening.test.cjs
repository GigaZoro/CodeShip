const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  ACTIVE_TOKEN_ENV,
  CHECK_TIMEOUT_ENV,
  LEASE_REF,
  PRE_TURN_TEST_STEP_MAX_SECONDS,
  TEST_STEP_MAX_ENV,
  TURN_ENV,
  TURN_MAX_MS,
  WORKTREE_LOCK_FILE,
  WORKTREE_LOCK_MAX_AGE_MS,
  land,
  landRemote,
  main,
  resolveTestStepMaxSeconds,
  testing: {
    acquireWorktreeLock,
    checkWorktreeLock,
    gitCommand,
    inspectWorktreeLock,
    parseRefTransactionEntries,
    refTransactionTargetsLockedWorktree,
    release,
    runCheck,
    runFinalize,
    tryAcquire,
    withoutManagedCheckEnv,
    worktreeLockPath,
  },
} = require("./landing-turn.cjs");
const { recordPass } = require("./check-changed-receipt.cjs");
const { QUEUE_PREFIX, readLandings, setup, setupGatedRepo } = require("./landing-turn.testkit.cjs");

const FIXED_NOW = Date.parse("2026-11-28T12:00:00Z");

test("AB#7672: resolveTestStepMaxSeconds scales pre-turn budget to TURN_MAX_MS, honors caller overrides, and caps under-turn checks to lease budget", () => {
  assert.equal(PRE_TURN_TEST_STEP_MAX_SECONDS, Math.floor(TURN_MAX_MS / 1000));
  assert.equal(PRE_TURN_TEST_STEP_MAX_SECONDS, 10_800);

  // Pre-turn (budgetSeconds === undefined)
  assert.equal(resolveTestStepMaxSeconds(undefined, {}), 10_800);
  assert.equal(resolveTestStepMaxSeconds(undefined, { [TEST_STEP_MAX_ENV]: "4200" }), 4200);
  assert.equal(resolveTestStepMaxSeconds(undefined, { [CHECK_TIMEOUT_ENV]: "5400" }), 5400);
  assert.equal(
    resolveTestStepMaxSeconds(undefined, {
      [TEST_STEP_MAX_ENV]: "4200",
      [CHECK_TIMEOUT_ENV]: "5400",
    }),
    4200,
  );
  // Case-insensitive env lookup and invalid value fallback
  assert.equal(resolveTestStepMaxSeconds(undefined, { Check_Changed_Test_Step_Max: "6100" }), 6100);
  assert.equal(resolveTestStepMaxSeconds(undefined, { check_changed_timeout: "7200" }), 7200);
  assert.equal(
    resolveTestStepMaxSeconds(undefined, {
      [TEST_STEP_MAX_ENV]: "0",
      [CHECK_TIMEOUT_ENV]: "4800",
    }),
    4800,
  );
  assert.equal(
    resolveTestStepMaxSeconds(undefined, {
      [TEST_STEP_MAX_ENV]: "-10",
      [CHECK_TIMEOUT_ENV]: "not-a-number",
    }),
    10_800,
  );

  // Under-turn (budgetSeconds defined)
  assert.equal(resolveTestStepMaxSeconds(900.9, {}), 900);
  assert.equal(resolveTestStepMaxSeconds(900, { [TEST_STEP_MAX_ENV]: "300" }), 300);
  assert.equal(resolveTestStepMaxSeconds(900, { [TEST_STEP_MAX_ENV]: "5000" }), 900);
  assert.equal(resolveTestStepMaxSeconds(900, { [CHECK_TIMEOUT_ENV]: "5000" }), 900);
  assert.equal(resolveTestStepMaxSeconds(0, {}), 1);

  // Non-finite or non-numeric budgetSeconds fall back to pre-turn budget
  for (const invalidBudget of [NaN, Infinity, -Infinity, null]) {
    assert.equal(resolveTestStepMaxSeconds(invalidBudget, {}), 10_800);
    assert.equal(resolveTestStepMaxSeconds(invalidBudget, { [TEST_STEP_MAX_ENV]: "4200" }), 4200);
    assert.equal(resolveTestStepMaxSeconds(invalidBudget, { [CHECK_TIMEOUT_ENV]: "5400" }), 5400);
  }
});

test("AB#7672: runCheck and runFinalize pass dynamic CHECK_CHANGED_TEST_STEP_MAX to child processes", async () => {
  const { root, clone } = setup();
  try {
    const dir = clone("budget-env");
    const outFile = path.join(root, "captured-env.json");
    const captureCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ max: process.env.${TEST_STEP_MAX_ENV} ?? null, turn: process.env.${TURN_ENV} ?? null, token: process.env.${ACTIVE_TOKEN_ENV} ?? null }))`,
    )}`;
    const readCaptured = () => JSON.parse(fs.readFileSync(outFile, "utf8"));

    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (
        key.toUpperCase() === TEST_STEP_MAX_ENV ||
        key.toUpperCase() === CHECK_TIMEOUT_ENV ||
        key.toUpperCase() === TURN_ENV ||
        key.toUpperCase() === ACTIVE_TOKEN_ENV
      ) {
        delete cleanEnv[key];
      }
    }

    // 1. Pre-turn default -> 10800, no T3_LANDING_TURN
    assert.equal(
      await runCheck(dir, null, "HEAD", undefined, undefined, {
        command: captureCmd,
        stdio: "ignore",
        env: cleanEnv,
      }),
      true,
    );
    assert.deepEqual(readCaptured(), {
      max: String(PRE_TURN_TEST_STEP_MAX_SECONDS),
      turn: null,
      token: null,
    });

    // 2. Pre-turn with caller CHECK_CHANGED_TIMEOUT
    assert.equal(
      await runCheck(dir, null, "HEAD", undefined, undefined, {
        command: captureCmd,
        stdio: "ignore",
        env: { ...cleanEnv, [CHECK_TIMEOUT_ENV]: "5100" },
      }),
      true,
    );
    assert.deepEqual(readCaptured(), { max: "5100", turn: null, token: null });

    // 3. Pre-turn with explicit caller CHECK_CHANGED_TEST_STEP_MAX overrides CHECK_CHANGED_TIMEOUT
    assert.equal(
      await runCheck(dir, null, "HEAD", undefined, undefined, {
        command: captureCmd,
        stdio: "ignore",
        env: { ...cleanEnv, [CHECK_TIMEOUT_ENV]: "5100", [TEST_STEP_MAX_ENV]: "4300" },
      }),
      true,
    );
    assert.deepEqual(readCaptured(), { max: "4300", turn: null, token: null });

    // 4. Under-turn caps larger caller override at lease budget and propagates turn
    assert.equal(
      await runCheck(dir, "turn-sha", "HEAD", 840, undefined, {
        command: captureCmd,
        stdio: "ignore",
        env: {
          ...cleanEnv,
          [TEST_STEP_MAX_ENV]: "5000",
          [ACTIVE_TOKEN_ENV]: "must-not-leak-check",
        },
      }),
      true,
    );
    assert.deepEqual(readCaptured(), { max: "840", turn: "turn-sha", token: null });

    // 5. Under-turn respects tighter caller override
    assert.equal(
      await runCheck(dir, "turn-sha", "HEAD", 840, undefined, {
        command: captureCmd,
        stdio: "ignore",
        env: { ...cleanEnv, [TEST_STEP_MAX_ENV]: "250" },
      }),
      true,
    );
    assert.deepEqual(readCaptured(), { max: "250", turn: "turn-sha", token: null });

    // 6. runFinalize passes lease-bounded CHECK_CHANGED_TEST_STEP_MAX (or tighter caller override)
    assert.equal(
      await runFinalize(
        dir,
        { turn: "turn-sha", commit: "abc", base: "def", rebased: true, budgetSeconds: 720 },
        {
          command: captureCmd,
          stdio: "ignore",
          env: {
            ...cleanEnv,
            [TEST_STEP_MAX_ENV]: "9999",
            t3_landing_active_token: "must-not-leak-finalize",
          },
        },
      ),
      true,
    );
    assert.deepEqual(readCaptured(), { max: "720", turn: "turn-sha", token: null });
    assert.deepEqual(
      withoutManagedCheckEnv({
        KEEP: "1",
        [ACTIVE_TOKEN_ENV]: "a",
        t3_landing_active_token: "b",
      }),
      { KEEP: "1" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: worktree active-landing lock tracks HEAD across rebase, blocks concurrent landers, and cleans up on every exit path", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "mine.txt");
    const initialHead = git(dir, "rev-parse", "HEAD");
    const lockPath = worktreeLockPath(dir);
    assert.ok(lockPath.endsWith(WORKTREE_LOCK_FILE));
    assert.equal(fs.existsSync(lockPath), false);

    // 1. Failing check cleans up the lock in finally.
    let markerDuringCheck = null;
    let concurrentError = null;
    const failed = await land({
      cwd: dir,
      remote: origin,
      check: async () => {
        markerDuringCheck = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        // A second concurrent landing in the same worktree is refused immediately.
        try {
          await land({ cwd: dir, remote: origin, check: () => true });
        } catch (error) {
          concurrentError = error;
        }
        return false;
      },
    });
    assert.equal(failed.status, "check-failed");
    assert.equal(markerDuringCheck.pid, process.pid);
    assert.equal(markerDuringCheck.head, initialHead);
    assert.equal(typeof markerDuringCheck.token, "string");
    assert.match(
      concurrentError?.message ?? "",
      /refusing to modify worktree while a landing is active/,
    );
    assert.equal(fs.existsSync(lockPath), false, "lock must be removed after check-failed");

    // 2. When main moves before wait, land returns { status: "rebased" } and releases the lock
    //    so a follow-up land({ rebased }) acquires cleanly and cleans up on success.
    const other = clone("other");
    commit(other, "other.txt");
    git(other, "push", "-q", "origin", "HEAD:main");
    const rebased = await land({ cwd: dir, remote: origin, check: () => true });
    assert.equal(rebased.status, "rebased");
    assert.equal(fs.existsSync(lockPath), false, "lock must be released before rebased handoff");

    let headDuringLandRebased = null;
    const landed = await land({
      cwd: dir,
      remote: origin,
      rebased,
      check: () => {
        headDuringLandRebased = JSON.parse(fs.readFileSync(lockPath, "utf8")).head;
        return true;
      },
    });
    assert.equal(landed.status, "landed");
    assert.equal(headDuringLandRebased, rebased.head);
    assert.equal(fs.existsSync(lockPath), false, "lock must be removed after landed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: git hooks refuse foreign commits, --no-verify commits, resets, branch switches, and rebases while allowing fetches, sibling worktrees, and the lander's own rebase", async () => {
  const { root, origin, git, cloneGated, commitChange } = setupGatedRepo({
    extraHooks: ["pre-commit", "pre-rebase", "reference-transaction"],
  });
  try {
    const dir = cloneGated("locked-lander");
    commitChange(dir, "base-change.txt", "Base change");
    const headBefore = git(dir, "rev-parse", "HEAD");
    const branchBefore = git(dir, "branch", "--show-current");

    // Create a sibling worktree before locking so we can verify sibling commits remain unblocked.
    const sibling = path.join(root, "sibling-worktree");
    git(dir, "worktree", "add", "-q", "-b", "sibling-branch", sibling, "origin/main");

    // Advance origin/main from another clone so we can test `git fetch origin` while locked.
    const remoteMover = cloneGated("remote-mover");
    commitChange(remoteMover, "remote.txt", "Remote advance");
    git(remoteMover, "push", "-q", "--no-verify", "origin", "HEAD:main");

    const lock = acquireWorktreeLock({ cwd: dir, branch: branchBefore, head: headBefore });
    try {
      const runGitRaw = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

      // 1. Foreign commit refused by pre-commit
      fs.writeFileSync(path.join(dir, "foreign.txt"), "foreign\n");
      git(dir, "add", "foreign.txt");
      const commitRes = runGitRaw(dir, ["commit", "-m", "foreign commit"]);
      assert.notEqual(commitRes.status, 0, "foreign git commit must be refused");
      assert.match(commitRes.stderr, /refusing to modify worktree while a landing is active/);
      assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

      // 2. Foreign commit --no-verify refused by reference-transaction
      const noVerifyRes = runGitRaw(dir, ["commit", "--no-verify", "-m", "bypass commit"]);
      assert.notEqual(noVerifyRes.status, 0, "foreign git commit --no-verify must be refused");
      assert.match(noVerifyRes.stderr, /refusing to modify worktree while a landing is active/);
      assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

      // Unstage test file so reset/checkout/rebase test cleanly
      git(dir, "reset", "-q", "--", "foreign.txt");
      fs.rmSync(path.join(dir, "foreign.txt"));

      // 3. Foreign git reset --hard HEAD~1 refused by reference-transaction
      const resetRes = runGitRaw(dir, ["reset", "--hard", "HEAD~1"]);
      assert.notEqual(resetRes.status, 0, "foreign git reset --hard must be refused");
      assert.match(resetRes.stderr, /refusing to modify worktree while a landing is active/);
      assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);
      // Git updates index/worktree before the aborted ref transaction; restore them to HEAD for subsequent checks.
      git(dir, "read-tree", "--reset", "-u", "HEAD");

      // 4. Foreign branch switch refused by reference-transaction
      const checkoutRes = runGitRaw(dir, ["checkout", "-b", "stray-branch"]);
      assert.notEqual(checkoutRes.status, 0, "foreign git checkout -b must be refused");
      assert.match(checkoutRes.stderr, /refusing to modify worktree while a landing is active/);
      assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);
      assert.equal(git(dir, "branch", "--show-current"), branchBefore);

      // 5. Foreign git fetch origin (remote-tracking ref update) is ALLOWED
      const fetchRes = runGitRaw(dir, ["fetch", "origin"]);
      assert.equal(fetchRes.status, 0, `git fetch must succeed while locked: ${fetchRes.stderr}`);

      // 6. Foreign git rebase refused by pre-rebase
      const rebaseRes = runGitRaw(dir, ["rebase", "origin/main"]);
      assert.notEqual(rebaseRes.status, 0, "foreign git rebase must be refused");
      assert.match(rebaseRes.stderr, /refusing to modify worktree while a landing is active/);
      assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

      // 7. Sibling worktree commits are ALLOWED (lock is per-worktree)
      fs.writeFileSync(path.join(sibling, "sibling.txt"), "sibling\n");
      git(sibling, "add", "sibling.txt");
      const siblingCommit = runGitRaw(sibling, ["commit", "-m", "sibling commit"]);
      assert.equal(
        siblingCommit.status,
        0,
        `sibling worktree commit must succeed: ${siblingCommit.stderr}`,
      );
    } finally {
      lock.release();
    }

    // 8. Lander's own rebase and landing succeed with all hooks active (via T3_LANDING_ACTIVE_TOKEN).
    const rebased = await land({
      cwd: dir,
      remote: "origin",
      check: (_turn, base, _budget, directory) => {
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
        return true;
      },
    });
    assert.equal(rebased.status, "rebased");
    const landed = await land({
      cwd: dir,
      remote: "origin",
      rebased,
      check: (_turn, base, _budget, directory) => {
        recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
        return true;
      },
    });
    assert.equal(landed.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), landed.commit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: inspectWorktreeLock auto-clears corrupt, expired, wrong-host, dead-pid, and recycled-pid locks while honoring live locks", () => {
  const { root, clone } = setup();
  try {
    const dir = clone("stale");
    const lockPath = worktreeLockPath(dir);
    const writeMarker = (value) =>
      fs.writeFileSync(lockPath, typeof value === "string" ? value : JSON.stringify(value));

    // 1. Corrupt JSON
    writeMarker("{not json");
    assert.deepEqual(inspectWorktreeLock({ cwd: dir, now: () => FIXED_NOW }), {
      locked: false,
      lockPath,
      clearedStale: "corrupt",
    });
    assert.equal(fs.existsSync(lockPath), false);

    // 2. Malformed marker (missing token / invalid pid)
    writeMarker({ pid: -1, token: "" });
    assert.deepEqual(inspectWorktreeLock({ cwd: dir, now: () => FIXED_NOW }), {
      locked: false,
      lockPath,
      clearedStale: "corrupt",
    });
    assert.equal(fs.existsSync(lockPath), false);

    // 3. Expired marker (> WORKTREE_LOCK_MAX_AGE_MS)
    writeMarker({
      pid: process.pid,
      host: "host-a",
      hostScoped: true,
      started: "12345",
      token: "tok-expired",
      branch: "feat",
      head: "a".repeat(40),
      startedAt: new Date(FIXED_NOW - WORKTREE_LOCK_MAX_AGE_MS - 1000).toISOString(),
    });
    assert.deepEqual(
      inspectWorktreeLock({
        cwd: dir,
        now: () => FIXED_NOW,
        readHost: () => "host-a",
        probePid: () => "alive",
      }),
      { locked: false, lockPath, clearedStale: "expired" },
    );
    assert.equal(fs.existsSync(lockPath), false);

    // 4. Host / boot mismatch
    writeMarker({
      pid: process.pid,
      host: "host-old-boot",
      hostScoped: true,
      started: "12345",
      token: "tok-host",
      branch: "feat",
      head: "a".repeat(40),
      startedAt: new Date(FIXED_NOW - 1000).toISOString(),
    });
    assert.deepEqual(
      inspectWorktreeLock({
        cwd: dir,
        now: () => FIXED_NOW,
        readHost: () => "host-new-boot",
        probePid: () => "alive",
      }),
      { locked: false, lockPath, clearedStale: "host-changed" },
    );
    assert.equal(fs.existsSync(lockPath), false);

    // 5. Dead PID (both mocked probe and real exited child process)
    writeMarker({
      pid: 999_999,
      host: "host-a",
      hostScoped: true,
      started: "12345",
      token: "tok-dead",
      branch: "feat",
      head: "a".repeat(40),
      startedAt: new Date(FIXED_NOW - 1000).toISOString(),
    });
    assert.deepEqual(
      inspectWorktreeLock({
        cwd: dir,
        now: () => FIXED_NOW,
        readHost: () => "host-a",
        probePid: () => "gone",
      }),
      { locked: false, lockPath, clearedStale: "dead-pid" },
    );
    assert.equal(fs.existsSync(lockPath), false);

    const exitedChild = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      {
        encoding: "utf8",
      },
    );
    const deadPid = Number(exitedChild.stdout);
    writeMarker({
      pid: deadPid,
      host: "host-a",
      hostScoped: false,
      started: null,
      token: "tok-real-dead",
      branch: "feat",
      head: "a".repeat(40),
      startedAt: new Date(FIXED_NOW - 1000).toISOString(),
    });
    assert.deepEqual(inspectWorktreeLock({ cwd: dir, now: () => FIXED_NOW }), {
      locked: false,
      lockPath,
      clearedStale: "dead-pid",
    });
    assert.equal(fs.existsSync(lockPath), false);

    // 6. Recycled PID (alive, but process start time differs)
    writeMarker({
      pid: process.pid,
      host: "host-a",
      hostScoped: true,
      started: "old-start-ticks",
      token: "tok-reused",
      branch: "feat",
      head: "a".repeat(40),
      startedAt: new Date(FIXED_NOW - 1000).toISOString(),
    });
    assert.deepEqual(
      inspectWorktreeLock({
        cwd: dir,
        now: () => FIXED_NOW,
        platform: "linux",
        readHost: () => "host-a",
        probePid: () => "alive",
        readStarted: () => "new-start-ticks",
      }),
      { locked: false, lockPath, clearedStale: "pid-reused" },
    );
    assert.equal(fs.existsSync(lockPath), false);

    // 7. Live lock stays active and rejects foreign ref transactions on HEAD or branch, while ignoring remote refs.
    const liveMarker = {
      pid: process.pid,
      host: "host-a",
      hostScoped: true,
      started: "same-start",
      token: "tok-live",
      branch: "feat-x",
      head: "b".repeat(40),
      startedAt: new Date(FIXED_NOW - 1000).toISOString(),
    };
    writeMarker(liveMarker);
    const liveState = inspectWorktreeLock({
      cwd: dir,
      now: () => FIXED_NOW,
      platform: "linux",
      readHost: () => "host-a",
      probePid: () => "alive",
      readStarted: () => "same-start",
    });
    assert.equal(liveState.locked, true);
    assert.equal(fs.existsSync(lockPath), true);

    assert.deepEqual(
      parseRefTransactionEntries("0000 1111 refs/remotes/origin/main\n1111 2222 HEAD\n"),
      [
        { oldOid: "0000", newOid: "1111", ref: "refs/remotes/origin/main" },
        { oldOid: "1111", newOid: "2222", ref: "HEAD" },
      ],
    );
    assert.equal(
      refTransactionTargetsLockedWorktree(
        [
          { oldOid: "0".repeat(40), newOid: "1".repeat(40), ref: "refs/remotes/origin/main" },
          { oldOid: "0".repeat(40), newOid: "1".repeat(40), ref: "refs/heads/other" },
        ],
        liveMarker,
      ),
      false,
    );
    assert.equal(
      refTransactionTargetsLockedWorktree(
        [{ oldOid: "0".repeat(40), newOid: "1".repeat(40), ref: "refs/heads/feat-x" }],
        liveMarker,
      ),
      true,
    );
    assert.equal(
      refTransactionTargetsLockedWorktree(
        [{ oldOid: "0".repeat(40), newOid: "1".repeat(40), ref: "HEAD" }],
        liveMarker,
      ),
      true,
    );

    assert.equal(
      checkWorktreeLock({
        cwd: dir,
        now: () => FIXED_NOW,
        platform: "linux",
        readHost: () => "host-a",
        probePid: () => "alive",
        readStarted: () => "same-start",
        refTransaction: true,
        stdin: "0000 1111 refs/remotes/origin/main\n",
      }).ok,
      true,
    );
    assert.throws(
      () =>
        checkWorktreeLock({
          cwd: dir,
          now: () => FIXED_NOW,
          platform: "linux",
          readHost: () => "host-a",
          probePid: () => "alive",
          readStarted: () => "same-start",
          refTransaction: true,
          stdin: "0000 1111 refs/heads/feat-x\n",
        }),
      /refusing to modify worktree while a landing is active/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: waiter detects worktree HEAD drift early during wait, leaves queue cleanly, and never touches the lease", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    commit(waiter, "waiter.txt");
    const initialHead = git(waiter, "rev-parse", "HEAD");
    const mainBefore = git(origin, "rev-parse", "main");

    // Holder keeps the lease for the entire test (never releases it).
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    assert.ok(held);

    let sleeps = 0;
    let driftedHead = null;
    const result = await land({
      cwd: waiter,
      remote: origin,
      pollMs: 10,
      maxWaitMs: 60_000,
      check: () => true,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 1) {
          // Confirm waiter actually entered the remote queue before drift happens.
          assert.notEqual(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), "");
          // Simulate out-of-band commit bypassing hooks (e.g. --no-verify without reference-transaction).
          commit(waiter, "foreign-drift.txt");
          driftedHead = git(waiter, "rev-parse", "HEAD");
        }
        assert.ok(sleeps <= 2, `expected early abort on next poll, saw ${sleeps} sleeps`);
      },
    });

    assert.deepEqual(result, {
      status: "head-moved",
      expected: initialHead,
      actual: driftedHead,
    });
    assert.equal(sleeps, 1, "waiter must abort immediately after the first sleep once HEAD moved");
    // Queue entry cleaned up, worktree lock cleaned up, lease and main completely untouched.
    assert.equal(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), "");
    assert.equal(git(origin, "for-each-ref", "--format=%(objectname)", LEASE_REF), held);
    assert.equal(git(origin, "rev-parse", "main"), mainBefore);
    assert.equal(fs.existsSync(worktreeLockPath(waiter)), false);
    assert.equal(readLandings(waiter, git).at(-1)?.status, "head-moved");

    release({ cwd: holder, remote: origin }, held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: CLI `check-worktree-lock` enforces lock exit codes and ref-transaction filtering", async (t) => {
  const { root, git, clone, commit } = setup();
  try {
    const dir = clone("cli-lock");
    commit(dir, "work.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const branch = git(dir, "branch", "--show-current");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(line));

    assert.equal(await main(["check-worktree-lock"], { cwd: dir }), 0);
    assert.equal(await main(["check-worktree-lock", "--bad-flag"], { cwd: dir }), 2);

    const lock = acquireWorktreeLock({ cwd: dir, branch, head });
    try {
      assert.equal(await main(["check-worktree-lock"], { cwd: dir, env: {} }), 1);
      assert.match(errors.at(-1) ?? "", /refusing to modify worktree while a landing is active/);
      assert.equal(
        await main(["check-worktree-lock"], {
          cwd: dir,
          env: { [ACTIVE_TOKEN_ENV]: lock.token },
        }),
        0,
      );
      assert.equal(
        await main(["check-worktree-lock", "--ref-transaction"], {
          cwd: dir,
          env: {},
          stdin: "0000 1111 refs/remotes/origin/main\n",
        }),
        0,
      );
      assert.equal(
        await main(["check-worktree-lock", "--ref-transaction"], {
          cwd: dir,
          env: {},
          stdin: `0000 1111 refs/heads/${branch}\n`,
        }),
        1,
      );
    } finally {
      lock.release();
    }
    assert.equal(await main(["check-worktree-lock"], { cwd: dir, env: {} }), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: git worktree add (-b and --detach) succeeds from locked primary and linked worktrees while checkout remains refused", () => {
  const { root, git, cloneGated, commitChange } = setupGatedRepo({
    extraHooks: ["pre-commit", "pre-rebase", "reference-transaction"],
  });
  try {
    const primary = cloneGated("primary");
    commitChange(primary, "p1.txt", "Primary commit");
    const linked = path.join(root, "linked");
    git(primary, "worktree", "add", "-b", "linked-branch", linked);
    commitChange(linked, "l1.txt", "Linked commit");

    const runGitRaw = (cwd, args) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === ACTIVE_TOKEN_ENV) delete env[key];
      }
      return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    };

    const verifyLockedCheckout = (dir, label) => {
      const headBefore = git(dir, "rev-parse", "HEAD");
      const branchBefore = git(dir, "branch", "--show-current");
      const lock = acquireWorktreeLock({ cwd: dir, branch: branchBefore, head: headBefore });
      try {
        const wtBranch = `wt-branch-${label}`;
        const wtBranchPath = path.join(root, `wt-${label}-b`);
        const addBranch = runGitRaw(dir, ["worktree", "add", "-b", wtBranch, wtBranchPath]);
        assert.equal(
          addBranch.status,
          0,
          `git worktree add -b from locked ${label} must succeed: ${addBranch.stderr}`,
        );
        assert.equal(git(wtBranchPath, "branch", "--show-current"), wtBranch);
        assert.equal(git(wtBranchPath, "rev-parse", "HEAD"), headBefore);
        assert.equal(git(dir, "branch", "--show-current"), branchBefore);
        assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

        const wtDetachPath = path.join(root, `wt-${label}-detach`);
        const addDetach = runGitRaw(dir, ["worktree", "add", "--detach", wtDetachPath]);
        assert.equal(
          addDetach.status,
          0,
          `git worktree add --detach from locked ${label} must succeed: ${addDetach.stderr}`,
        );
        assert.equal(git(wtDetachPath, "branch", "--show-current"), "");
        assert.equal(git(wtDetachPath, "rev-parse", "HEAD"), headBefore);
        assert.equal(git(dir, "branch", "--show-current"), branchBefore);
        assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

        // Real mutations to the locked worktree's own HEAD remain refused.
        const detachSelf = runGitRaw(dir, ["checkout", "--detach"]);
        assert.notEqual(
          detachSelf.status,
          0,
          `git checkout --detach in locked ${label} must be refused`,
        );
        assert.match(detachSelf.stderr, /refusing to modify worktree while a landing is active/);
        assert.equal(git(dir, "branch", "--show-current"), branchBefore);
        assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);

        const branchSelf = runGitRaw(dir, ["checkout", "-b", `stray-${label}`]);
        assert.notEqual(branchSelf.status, 0, `git checkout -b in locked ${label} must be refused`);
        assert.match(branchSelf.stderr, /refusing to modify worktree while a landing is active/);
        assert.equal(git(dir, "branch", "--show-current"), branchBefore);
        assert.equal(git(dir, "rev-parse", "HEAD"), headBefore);
      } finally {
        lock.release();
      }
    };

    verifyLockedCheckout(primary, "primary");
    verifyLockedCheckout(linked, "linked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: git pack-refs --all and git gc succeed while locked, while branch delete and move remain refused", () => {
  const { root, git, cloneGated, commitChange } = setupGatedRepo({
    extraHooks: ["pre-commit", "pre-rebase", "reference-transaction"],
  });
  try {
    const dir = cloneGated("pack-target");
    commitChange(dir, "first.txt", "First commit");
    commitChange(dir, "second.txt", "Second commit");
    const linked = path.join(root, "pack-linked");
    git(dir, "worktree", "add", "-b", "pack-linked-branch", linked);
    commitChange(linked, "linked.txt", "Linked commit");

    const runGitRaw = (cwd, args) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === ACTIVE_TOKEN_ENV) delete env[key];
      }
      return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    };

    const verifyPackAndGc = (cwd, label) => {
      const headBefore = git(cwd, "rev-parse", "HEAD");
      const prevCommit = git(cwd, "rev-parse", "HEAD~1");
      const branch = git(cwd, "branch", "--show-current");
      const refName = `refs/heads/${branch}`;
      const lockPath = worktreeLockPath(cwd);
      const lock = acquireWorktreeLock({ cwd, branch, head: headBefore });
      try {
        // Before packing (loose ref): deleting or moving the locked branch is refused.
        const delLoose = runGitRaw(cwd, ["update-ref", "-d", refName]);
        assert.notEqual(delLoose.status, 0, `loose delete must be refused (${label})`);
        assert.match(delLoose.stderr, /refusing to modify worktree while a landing is active/);

        const moveLoose = runGitRaw(cwd, ["update-ref", refName, prevCommit]);
        assert.notEqual(moveLoose.status, 0, `loose move must be refused (${label})`);
        assert.match(moveLoose.stderr, /refusing to modify worktree while a landing is active/);
        assert.equal(git(cwd, "rev-parse", refName), headBefore);

        // pack-refs --all succeeds without breaking the lock.
        const packRes = runGitRaw(cwd, ["pack-refs", "--all"]);
        assert.equal(
          packRes.status,
          0,
          `git pack-refs --all must succeed while locked (${label}): ${packRes.stderr}`,
        );
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(git(cwd, "rev-parse", refName), headBefore);

        // After packing: deleting (with or without old-oid) or moving the locked branch is STILL refused.
        const delPacked = runGitRaw(cwd, ["update-ref", "-d", refName]);
        assert.notEqual(delPacked.status, 0, `packed delete must be refused (${label})`);
        assert.match(delPacked.stderr, /refusing to modify worktree while a landing is active/);

        const delPackedOid = runGitRaw(cwd, ["update-ref", "-d", refName, headBefore]);
        assert.notEqual(
          delPackedOid.status,
          0,
          `packed delete with old-oid must be refused (${label})`,
        );
        assert.match(delPackedOid.stderr, /refusing to modify worktree while a landing is active/);

        const movePacked = runGitRaw(cwd, ["update-ref", refName, prevCommit]);
        assert.notEqual(movePacked.status, 0, `packed move must be refused (${label})`);
        assert.match(movePacked.stderr, /refusing to modify worktree while a landing is active/);
        assert.equal(git(cwd, "rev-parse", refName), headBefore);

        // git gc succeeds while locked (including repacking a newly created loose branch).
        git(cwd, "branch", `extra-loose-${label}`, prevCommit);
        const gcRes = runGitRaw(cwd, ["gc"]);
        assert.equal(
          gcRes.status,
          0,
          `git gc must succeed while locked (${label}): ${gcRes.stderr}`,
        );
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(git(cwd, "rev-parse", refName), headBefore);
      } finally {
        lock.release();
      }
    };

    verifyPackAndGc(dir, "primary");
    verifyPackAndGc(linked, "linked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: acquireWorktreeLock blocks self-token bypass, prevents concurrent overwrites, and gitCommand deduplicates case-variant tokens", async () => {
  const { root, git, clone, commit } = setup();
  try {
    const dir = clone("exclusive-lock");
    commit(dir, "work.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const branch = git(dir, "branch", "--show-current");
    const lockPath = worktreeLockPath(dir);

    // 1. Self-token in env cannot bypass or steal an existing live lock.
    const lock1 = acquireWorktreeLock({ cwd: dir, branch, head });
    const prevLower = process.env.t3_landing_active_token;
    try {
      assert.throws(
        () =>
          acquireWorktreeLock({
            cwd: dir,
            branch,
            head,
            env: { ...process.env, [ACTIVE_TOKEN_ENV]: lock1.token },
          }),
        /refusing to modify worktree while a landing is active/,
      );
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, lock1.token);

      // Should-Fix #3: gitCommand deduplicates case-variant T3_LANDING_ACTIVE_TOKEN keys from process.env.
      process.env.t3_landing_active_token = "stale-lowercase";
      const [, spawnOpts] = gitCommand(dir, ["status"], {});
      const tokenKeys = Object.keys(spawnOpts.env).filter(
        (key) => key.toUpperCase() === ACTIVE_TOKEN_ENV,
      );
      assert.deepEqual(tokenKeys, [ACTIVE_TOKEN_ENV]);
      assert.equal(spawnOpts.env[ACTIVE_TOKEN_ENV], lock1.token);
    } finally {
      if (prevLower === undefined) delete process.env.t3_landing_active_token;
      else process.env.t3_landing_active_token = prevLower;
      lock1.release();
    }
    assert.equal(fs.existsSync(lockPath), false);

    // 2. Two concurrent processes racing acquireWorktreeLock cannot overwrite each other.
    const scriptPath = path.join(__dirname, "landing-turn.cjs");
    const workerCode = [
      `const { testing: { acquireWorktreeLock } } = require(${JSON.stringify(scriptPath)});`,
      "const [cwd, branch, head] = process.argv.slice(1);",
      "try {",
      "  const lock = acquireWorktreeLock({ cwd, branch, head });",
      '  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, token: lock.token }) + "\\n");',
      "  process.stdin.resume();",
      '  process.stdin.on("end", () => { lock.release(); process.exit(0); });',
      "} catch (error) {",
      '  process.stdout.write(JSON.stringify({ ok: false, pid: process.pid, message: error.message }) + "\\n");',
      "  process.exit(1);",
      "}",
    ].join("\n");
    const spawnRacer = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", workerCode, dir, branch, head], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let resolved = false;
        child.stdout.on("data", (chunk) => {
          out += chunk.toString("utf8");
          const nl = out.indexOf("\n");
          if (nl !== -1 && !resolved) {
            resolved = true;
            resolve({ child, message: JSON.parse(out.slice(0, nl)) });
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (!resolved) {
            resolved = true;
            reject(new Error(`racer exited early with code ${code}: ${out}`));
          }
        });
      });

    const racers = await Promise.all([spawnRacer(), spawnRacer()]);
    try {
      const winners = racers.filter((r) => r.message.ok);
      const losers = racers.filter((r) => !r.message.ok);
      assert.equal(winners.length, 1, "exactly one concurrent acquirer must win");
      assert.equal(losers.length, 1, "exactly one concurrent acquirer must lose");
      assert.match(
        losers[0].message.message,
        /refusing to modify worktree while a landing is active/,
      );
      const onDisk = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(onDisk.pid, winners[0].message.pid);
      assert.equal(onDisk.token, winners[0].message.token);
    } finally {
      await Promise.all(
        racers.map(
          ({ child }) =>
            new Promise((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once("exit", resolve);
              child.stdin.end();
            }),
        ),
      );
    }
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: landRemote acquires local worktree lock, refuses foreign mutations, allows post-land fast-forward sync, and releases lock on completion or remote-unavailable fallback", async () => {
  const { root, origin, git, clone, commit, cloneGated, commitChange } = setupGatedRepo({
    extraHooks: ["pre-commit", "pre-rebase", "reference-transaction"],
  });
  try {
    const dir = cloneGated("remote-locked");
    git(dir, "checkout", "-b", "feat-remote");
    commitChange(dir, "remote-work.txt", "Remote work");
    const tip = git(dir, "rev-parse", "HEAD");
    const lockPath = worktreeLockPath(dir);

    const runGitRaw = (cwd, args) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === ACTIVE_TOKEN_ENV) delete env[key];
      }
      return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    };

    // 1. remote-unavailable holds the lock during probe and releases it before returning so fallback works.
    let lockSeenDuringProbe = false;
    const unavailable = await landRemote({
      cwd: dir,
      remote: "origin",
      hosts: ["box-a"],
      remoteDir: "/srv/CodeShip",
      probeHost: async () => {
        lockSeenDuringProbe = fs.existsSync(lockPath);
        return { ok: false, host: "box-a", reason: "unreachable" };
      },
    });
    assert.equal(unavailable.status, "remote-unavailable");
    assert.equal(lockSeenDuringProbe, true);
    assert.equal(fs.existsSync(lockPath), false, "lock must be released on remote-unavailable");

    // Advance origin/main so remote landing produces a rebased commit distinct from local tip.
    const other = clone("other-main");
    commit(other, "upstream.txt");
    git(other, "push", "-q", "origin", "HEAD:main");

    // 2. Full remote landing holds the lock while remote runs, blocks foreign mutations and concurrent landers,
    //    allows syncLocalAfterRemoteLand's git reset --keep, and releases the lock on completion.
    let lockMarkerDuringRemote = null;
    let foreignCommitStatus = null;
    let foreignResetStatus = null;
    let concurrentRemoteError = null;
    let landedCommit = null;

    const remoteRes = await landRemote({
      cwd: dir,
      remote: "origin",
      hosts: ["box-a"],
      remoteDir: "/srv/CodeShip",
      probeHost: async ({ host, remoteDir }) => ({
        ok: true,
        host,
        dir: remoteDir,
        load: 0.1,
      }),
      runRemote: async ({ stagingRef }) => {
        lockMarkerDuringRemote = JSON.parse(fs.readFileSync(lockPath, "utf8"));

        // Foreign commit (--no-verify) refused by reference-transaction hook.
        fs.writeFileSync(path.join(dir, "stray.txt"), "stray\n");
        git(dir, "add", "stray.txt");
        const commitRes = runGitRaw(dir, ["commit", "--no-verify", "-m", "stray"]);
        foreignCommitStatus = commitRes.status;
        assert.match(commitRes.stderr, /refusing to modify worktree while a landing is active/);
        git(dir, "reset", "-q", "--", "stray.txt");
        fs.rmSync(path.join(dir, "stray.txt"));

        // Foreign reset refused by reference-transaction hook.
        const resetRes = runGitRaw(dir, ["reset", "--hard", "HEAD~1"]);
        foreignResetStatus = resetRes.status;
        assert.match(resetRes.stderr, /refusing to modify worktree while a landing is active/);
        git(dir, "read-tree", "--reset", "-u", "HEAD");

        // Concurrent remote landing on the same worktree refused.
        try {
          await landRemote({
            cwd: dir,
            remote: "origin",
            hosts: ["box-a"],
            remoteDir: "/srv/CodeShip",
            probeHost: async () => ({ ok: true, host: "box-a", dir: "/srv/CodeShip", load: 0.1 }),
          });
        } catch (error) {
          concurrentRemoteError = error;
        }

        // Simulate remote host rebasing stagingRef onto origin/main and pushing to origin/main.
        const remoteBox = clone("remote-box");
        git(remoteBox, "fetch", "-q", "origin", `${stagingRef}:refs/heads/staged`);
        git(remoteBox, "checkout", "-q", "staged");
        git(remoteBox, "rebase", "-q", "origin/main");
        landedCommit = git(remoteBox, "rev-parse", "HEAD");
        git(remoteBox, "push", "-q", "origin", "HEAD:main");
        return {
          code: 0,
          result: { status: "landed", commit: landedCommit, releaseConfirmed: true },
        };
      },
    });

    assert.equal(remoteRes.status, "landed");
    assert.equal(remoteRes.commit, landedCommit);
    assert.notEqual(landedCommit, tip);
    assert.equal(lockMarkerDuringRemote?.pid, process.pid);
    assert.equal(lockMarkerDuringRemote?.head, tip);
    assert.notEqual(foreignCommitStatus, 0);
    assert.notEqual(foreignResetStatus, 0);
    assert.match(
      concurrentRemoteError?.message ?? "",
      /refusing to modify worktree while a landing is active/,
    );
    // Post-land fast-forward sync succeeded through hooks via active token!
    assert.equal(git(dir, "rev-parse", "HEAD"), landedCommit);
    assert.equal(git(origin, "rev-parse", "main"), landedCommit);
    assert.equal(fs.existsSync(lockPath), false, "lock must be removed after remote landing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7681: acquireWorktreeLock publishes lock atomically under tight multi-round concurrent barrier contention and falls back when hardlinks are unsupported", async () => {
  const { root, git, clone, commit } = setup();
  try {
    const dir = clone("atomic-barrier-race");
    commit(dir, "work.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const branch = git(dir, "branch", "--show-current");
    const lockPath = worktreeLockPath(dir);
    const gitDir = path.dirname(lockPath);
    const scriptPath = path.join(__dirname, "landing-turn.cjs");
    const tmpPrefix = `${WORKTREE_LOCK_FILE}.`;

    const workerCode = [
      `const { testing: { acquireWorktreeLock } } = require(${JSON.stringify(scriptPath)});`,
      "const [cwd, branch, head] = process.argv.slice(1);",
      "let activeLock = null;",
      'process.on("message", (msg) => {',
      '  if (msg.type === "go") {',
      "    try {",
      "      activeLock = acquireWorktreeLock({",
      "        cwd,",
      "        branch,",
      "        head,",
      '        readHost: () => "barrier-host",',
      "        readStarted: (pid) => String(pid),",
      "      });",
      '      process.send({ type: "result", round: msg.round, ok: true, pid: process.pid, token: activeLock.token });',
      "    } catch (error) {",
      '      process.send({ type: "result", round: msg.round, ok: false, pid: process.pid, message: error.message });',
      "    }",
      '  } else if (msg.type === "release") {',
      "    if (activeLock) {",
      "      activeLock.release();",
      "      activeLock = null;",
      "    }",
      '    process.send({ type: "released", round: msg.round });',
      '  } else if (msg.type === "quit") {',
      "    if (activeLock) {",
      "      activeLock.release();",
      "      activeLock = null;",
      "    }",
      "    process.exit(0);",
      "  }",
      "});",
      'process.send({ type: "ready" });',
    ].join("\n");

    const spawnBarrierWorker = () => {
      const child = spawn(process.execPath, ["-e", workerCode, dir, branch, head], {
        env: { ...process.env, GIT_DIR: gitDir },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const waitMessage = (expectedType, expectedRound) =>
        new Promise((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return reject(
              new Error(
                `barrier worker already exited (code=${child.exitCode}, signal=${child.signalCode}): ${stderr.trim()}`,
              ),
            );
          }
          const onMessage = (msg) => {
            if (
              msg?.type === expectedType &&
              (expectedRound === undefined || msg.round === expectedRound)
            ) {
              cleanup();
              resolve(msg);
            }
          };
          const onExit = (code, signal) => {
            cleanup();
            reject(
              new Error(
                `barrier worker exited early (code=${code}, signal=${signal}): ${stderr.trim()}`,
              ),
            );
          };
          const onError = (error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            child.off("message", onMessage);
            child.off("exit", onExit);
            child.off("error", onError);
          };
          child.on("message", onMessage);
          child.on("exit", onExit);
          child.on("error", onError);
        });
      return { child, waitMessage };
    };

    const workers = [spawnBarrierWorker(), spawnBarrierWorker()];
    try {
      await Promise.all(workers.map((w) => w.waitMessage("ready")));

      const ROUNDS = 80;
      for (let round = 0; round < ROUNDS; round += 1) {
        const order = round % 2 === 0 ? [0, 1] : [1, 0];
        const resultsPromise = Promise.all(workers.map((w) => w.waitMessage("result", round)));
        workers[order[0]].child.send({ type: "go", round });
        workers[order[1]].child.send({ type: "go", round });
        const results = await resultsPromise;

        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);
        assert.equal(
          winners.length,
          1,
          `round ${round}: expected exactly 1 winner, got ${winners.length}`,
        );
        assert.equal(losers.length, 1, `round ${round}: expected exactly 1 loser`);
        assert.match(
          losers[0].message,
          /refusing to modify worktree while a landing is active/,
          `round ${round}: loser must observe live lock error`,
        );

        const raw = fs.readFileSync(lockPath, "utf8");
        const onDisk = JSON.parse(raw);
        assert.equal(onDisk.pid, winners[0].pid, `round ${round}: lock pid must match winner`);
        assert.equal(
          onDisk.token,
          winners[0].token,
          `round ${round}: lock token must match winner`,
        );
        const leftovers = fs
          .readdirSync(gitDir)
          .filter((name) => name.startsWith(tmpPrefix) && name.endsWith(".tmp"));
        assert.deepEqual(leftovers, [], `round ${round}: no temp lock files should remain`);

        const winnerIndex = results[0].ok ? 0 : 1;
        const releasedPromise = workers[winnerIndex].waitMessage("released", round);
        workers[winnerIndex].child.send({ type: "release", round });
        await releasedPromise;
        assert.equal(fs.existsSync(lockPath), false, `round ${round}: lock must be removed`);
      }
    } finally {
      await Promise.all(
        workers.map(
          ({ child }) =>
            new Promise((resolve) => {
              if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
                return resolve();
              }
              const done = () => {
                child.off("exit", done);
                child.off("error", done);
                resolve();
              };
              child.once("exit", done);
              child.once("error", done);
              if (child.connected) {
                child.send({ type: "quit" }, (err) => {
                  if (err) child.kill();
                });
              } else {
                child.kill();
              }
            }),
        ),
      );
    }

    // Unsupported hardlink errors must fall back to exclusive write ("wx") while preserving EEXIST/self-token guards.
    const originalLinkSync = fs.linkSync;
    const lockEnv = { ...process.env, GIT_DIR: gitDir };
    try {
      for (const code of ["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
        fs.linkSync = () => {
          const err = new Error(`simulated ${code}`);
          err.code = code;
          throw err;
        };
        const lock = acquireWorktreeLock({ cwd: dir, branch, head, env: lockEnv });
        try {
          const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          assert.equal(parsed.token, lock.token, `fallback ${code}: lock JSON must match`);
          assert.throws(
            () =>
              acquireWorktreeLock({
                cwd: dir,
                branch,
                head,
                env: { ...lockEnv, [ACTIVE_TOKEN_ENV]: lock.token },
              }),
            /refusing to modify worktree while a landing is active/,
            `fallback ${code}: concurrent acquire must still fail with EEXIST lock error`,
          );
          const leftovers = fs
            .readdirSync(gitDir)
            .filter((name) => name.startsWith(tmpPrefix) && name.endsWith(".tmp"));
          assert.deepEqual(leftovers, [], `fallback ${code}: temp file must be cleaned up`);
        } finally {
          lock.release();
        }
        assert.equal(fs.existsSync(lockPath), false);
      }

      // Non-fallback errors from linkSync must propagate and still clean up the temp file.
      fs.linkSync = () => {
        const err = new Error("simulated EIO");
        err.code = "EIO";
        throw err;
      };
      assert.throws(
        () => acquireWorktreeLock({ cwd: dir, branch, head, env: lockEnv }),
        /simulated EIO/,
      );
      const leftovers = fs
        .readdirSync(gitDir)
        .filter((name) => name.startsWith(tmpPrefix) && name.endsWith(".tmp"));
      assert.deepEqual(leftovers, [], "non-fallback error must still clean up temp file");
    } finally {
      fs.linkSync = originalLinkSync;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
