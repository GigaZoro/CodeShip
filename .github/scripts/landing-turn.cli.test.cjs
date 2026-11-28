const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CHECK_METRICS_FILE_ENV,
  RECORD_ENV,
  land,
  overlappingWorktrees,
  main,
  pushChecked,
  testing: { release, runCheck, tryAcquire, withPrivateCheckout },
} = require("./landing-turn.cjs");
const { startLandingRecord } = require("./landing-record.cjs");
const { setup, watchPushRecord } = require("./landing-turn.testkit.cjs");

/** The landing records in the lander's Git folder, oldest first; `file` names the current or the rotated one. */
function recordsOf(lander, file = "landings.jsonl") {
  const records = path.join(lander, ".git", "t3-landing", file);
  if (!fs.existsSync(records)) return [];
  return fs
    .readFileSync(records, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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
      ["land", "--finalize"],
      ["land", "--finalize", ""],
      ["land", "--finalize", "echo ok", "extra"],
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
      Array(11).fill(
        "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote> | check-worktree-lock [--ref-transaction] | merge-budget <base> <ours> <theirs> | land [--remote <host[,...]>] [--remote-dir <path>] [--local] [--finalize <command>]",
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
    // A landing's checkout is left on the commit it checked, which is no parked work.
    const checked = git(path.join(root, "overlapping"), "rev-parse", "HEAD");
    await withPrivateCheckout({ cwd: mine, commit: checked }, () => {});
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

test("a landing records one line with its status, commits and the time each phase took", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    git(dir, "switch", "-q", "-c", "topic/recorded");
    commit(dir, "recorded.txt");
    const base = git(dir, "rev-parse", "HEAD~1");
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    let elapsed = 0;

    const result = await land({
      cwd: dir,
      remote: origin,
      now: () => Date.UTC(2026, 0, 1),
      recordClock: () => elapsed,
      check: () => ((elapsed += 1000), true),
      sleep: () => {
        elapsed += 5000;
        release({ cwd: holder, remote: origin }, held);
      },
    });

    assert.equal(result.status, "landed");
    // The whole record: a field added, renamed or dropped changes what landing measurements read.
    assert.deepEqual(recordsOf(dir), [
      {
        schema: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        branch: "topic/recorded",
        base,
        head: git(dir, "rev-parse", "HEAD"),
        status: "landed",
        stage: "under-turn",
        releaseConfirmed: true,
        durationMs: 6000,
        phases: { preWaitCheck: 1000, waitForTurn: 5000, push: 0 },
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing records a check that failed under the turn apart from one that failed before the wait", async () => {
  const { root, git, origin, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const mover = clone("mover");
    let elapsed = 0;
    const failing = (check) =>
      land({ cwd: dir, remote: origin, recordClock: () => elapsed, check });

    assert.equal((await failing(() => false)).status, "check-failed");
    const underTurn = await failing((turn) => {
      elapsed += turn === null ? 1000 : 3000;
      if (turn !== null) return false;
      commit(mover, "mover.txt");
      git(mover, "push", "-q", "origin", "HEAD:main");
      return true;
    });

    assert.equal(underTurn.status, "check-failed");
    const records = recordsOf(dir);
    assert.deepEqual(
      records.map(({ status, stage, base }) => [status, stage, base]),
      [
        ["check-failed", "before-wait", git(mover, "rev-parse", "HEAD~1")],
        ["check-failed", "under-turn", git(mover, "rev-parse", "HEAD")],
      ],
    );
    assert.deepEqual(records[1].phases, {
      preWaitCheck: 1000,
      waitForTurn: 0,
      rebase: 0,
      underTurnCheck: 3000,
    });
    assert.equal(records[1].head, git(dir, "rev-parse", "HEAD"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing that rebases before its wait and its relaunch record one line between them, a conflict one of its own", async (t) => {
  const { root, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "mine.txt");
    const mover = clone("mover");
    commit(mover, "mover.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    let elapsed = 0;
    let carried;

    const rebased = await land({
      cwd: dir,
      remote: "origin",
      now: () => Date.UTC(2026, 0, 1),
      // Each reading is a second after the last.
      recordClock: () => (elapsed += 1000),
      check: () => assert.fail("checked"),
      onRebased: (state) => (carried = state),
    });
    assert.equal(rebased.status, "rebased");
    assert.deepEqual(recordsOf(dir), []);

    // As the first process starts the relaunch: its record's state in the environment, which no check may inherit.
    process.env[RECORD_ENV] = carried;
    t.mock.method(console, "log", () => {});
    const code = await main(["land-rebased", "--base", rebased.base, "--head", rebased.head], {
      cwd: dir,
      check: () => !(RECORD_ENV in process.env),
    });

    assert.equal(code, 0);
    const [record, ...others] = recordsOf(dir);
    assert.deepEqual(others, []);
    assert.deepEqual(
      [record.status, record.startedAt, record.base, record.head],
      ["landed", "2026-01-01T00:00:00.000Z", rebased.base, rebased.head],
    );
    assert.deepEqual(Object.keys(record.phases), ["rebase", "preWaitCheck", "waitForTurn", "push"]);
    // The first process's rebase and its three seconds, with what the relaunch took added.
    assert.equal(record.phases.rebase, 1000);
    assert.ok(record.durationMs >= 3000, `${record.durationMs}`);

    for (const [lander, text] of [
      [dir, "mine\n"],
      [mover, "theirs\n"],
    ]) {
      git(lander, "pull", "-q", "--rebase", "origin", "main");
      fs.writeFileSync(path.join(lander, "base.txt"), text);
      git(lander, "commit", "-qam", text.trim());
    }
    git(mover, "push", "-q", "origin", "HEAD:main");
    await assert.rejects(
      () => land({ cwd: dir, remote: "origin", check: () => assert.fail("checked") }),
      /git rebase failed/,
    );
    const conflict = recordsOf(dir).at(-1);
    assert.deepEqual(
      [recordsOf(dir).length, conflict.status, conflict.stage, Object.keys(conflict.phases)],
      [2, "conflict", "before-wait", ["rebase"]],
    );
  } finally {
    delete process.env[RECORD_ENV];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a record that cannot be written warns once and leaves the landing's outcome as it was", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    // A file where the records' folder goes.
    fs.writeFileSync(path.join(dir, ".git", "t3-landing"), "");
    const warnings = [];
    t.mock.method(process.stderr, "write", (chunk) => warnings.push(String(chunk)) > 0);

    const failed = await land({ cwd: dir, remote: origin, check: () => false });
    const landed = await land({ cwd: dir, remote: origin, check: () => true });
    t.mock.restoreAll();

    assert.deepEqual([failed, landed.status], [{ status: "check-failed" }, "landed"]);
    assert.equal(git(origin, "rev-parse", "main"), git(dir, "rev-parse", "HEAD"));
    const unrecorded = warnings.filter((line) => line.includes("could not record the landing"));
    assert.equal(unrecorded.length, 2, warnings.join(""));
    for (const line of unrecorded) assert.match(line, /^[^\n]+\n$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the landing records stay bounded: a full file replaces the one before it", async () => {
  const { root, origin, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const folder = path.join(dir, ".git", "t3-landing");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "landings.1.jsonl"), '{"old":0}\n');
    fs.writeFileSync(path.join(folder, "landings.jsonl"), '{"old":1}\n'.repeat(999));
    const fail = () => land({ cwd: dir, remote: origin, check: () => false });

    await fail();
    await fail();

    const rotated = recordsOf(dir, "landings.1.jsonl");
    assert.deepEqual(
      [rotated.length, rotated[0], rotated.at(-1).status, recordsOf(dir).length],
      [1000, { old: 1 }, "check-failed", 1],
    );

    // A lock left by a lander that died while rotating: the next landing clears it, the one after rotates.
    const lock = path.join(folder, "landings.jsonl.lock");
    fs.mkdirSync(lock);
    const longAgo = new Date(Date.UTC(2026, 0, 1));
    fs.utimesSync(lock, longAgo, longAgo);
    fs.writeFileSync(path.join(folder, "landings.jsonl"), '{"old":2}\n'.repeat(999));
    await fail();
    await fail();
    assert.deepEqual(
      [recordsOf(dir, "landings.1.jsonl").length, fs.existsSync(lock), recordsOf(dir).length],
      [1001, false, 0],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a relaunch keeps only the carried fields of their own type", (t) => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-record-"));
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));
  t.mock.method(process.stderr, "write", () => true);
  const carried = [
    JSON.stringify({ startedAt: {}, elapsedMs: "x", phases: { rebase: 5, push: "y" } }),
    JSON.stringify({ phases: "abc" }),
    "123",
    "not json",
  ];

  for (const value of carried) {
    startLandingRecord({ now: () => Date.UTC(2026, 0, 1), clock: () => 0, carried: value }).write(
      () => gitDir,
      "landed",
    );
  }

  const records = fs
    .readFileSync(path.join(gitDir, "t3-landing", "landings.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ startedAt, durationMs, phases }) => [startedAt, durationMs, phases]),
    [
      ["2026-01-01T00:00:00.000Z", 0, { rebase: 5 }],
      ["2026-01-01T00:00:00.000Z", 0, {}],
      ["2026-01-01T00:00:00.000Z", 0, {}],
      ["2026-01-01T00:00:00.000Z", 0, {}],
    ],
  );
});

test("startLandingRecord.add accumulates positive phase durations, ignores invalid values, and survives carry()", (t) => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-record-add-"));
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  const ignored = startLandingRecord({ now: () => Date.UTC(2026, 0, 1), clock: () => 0 });
  for (const invalid of [
    0,
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "100",
    null,
    undefined,
  ]) {
    ignored.add("checkSlotWait", invalid);
  }
  ignored.write(() => gitDir, "landed");

  const first = startLandingRecord({ now: () => Date.UTC(2026, 0, 1), clock: () => 0 });
  first.add("checkSlotWait", 120.4);
  first.add("checkSlotWait", 0);
  first.add("checkSlotWait", 80.3);
  const carried = first.carry();

  const relaunched = startLandingRecord({
    now: () => Date.UTC(2026, 0, 1),
    clock: () => 0,
    carried,
  });
  relaunched.add("checkSlotWait", 50);
  relaunched.write(() => gitDir, "landed");

  const records = fs
    .readFileSync(path.join(gitDir, "t3-landing", "landings.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((entry) => entry.phases),
    [{}, { checkSlotWait: 251 }],
  );
});

test("land() accumulates inner check:changed slotWaitMs across preWaitCheck and underTurnCheck into landings.jsonl", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const helper = path.join(root, "emit-metrics.cjs");
    fs.writeFileSync(
      helper,
      [
        'const fs = require("node:fs");',
        `const metricsPath = process.env[${JSON.stringify(CHECK_METRICS_FILE_ENV)}];`,
        "if (metricsPath) fs.writeFileSync(metricsPath, JSON.stringify({ schema: 1, slotWaitMs: Number(process.argv[2]) }));",
      ].join("\n"),
    );
    const noopInstall = `"${process.execPath}" -e "process.exit(0)"`;
    const mover = clone("mover");
    let checkCalls = 0;
    const result = await land({
      cwd: dir,
      remote: origin,
      check: async (turn, base, budgetSeconds, directory, signal, checkoutContext) => {
        checkCalls += 1;
        const waitMs = turn === null ? 1200 : 800;
        if (turn === null) {
          commit(mover, "moved.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
        }
        return runCheck(directory, turn, base, budgetSeconds, signal, {
          ...checkoutContext,
          installCommand: noopInstall,
          checkCommand: `"${process.execPath}" "${helper}" ${waitMs}`,
          stdio: "pipe",
          onCheckMetrics: ({ slotWaitMs }) => checkoutContext?.recordSlotWait?.(slotWaitMs),
        });
      },
    });
    assert.equal(result.status, "landed");
    assert.equal(checkCalls, 2);
    const [landRecord] = recordsOf(dir);
    assert.equal(landRecord.phases.checkSlotWait, 2000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
