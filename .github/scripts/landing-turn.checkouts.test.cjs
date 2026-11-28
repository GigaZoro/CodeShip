const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CHECK_METRICS_FILE_ENV,
  TURN_MAX_MS,
  land,
  testing: {
    KEPT_CHECKOUTS,
    acquireCheckoutSlot,
    checkoutsFolder,
    dirtyMarkerHost,
    isSqliteBusy,
    landingCheckout,
    lockFile,
    machineBudgetSlots,
    readProcessStarted,
    release,
    resolveWarmLimit,
    runCheck,
    stopDirtyGroup,
    tryAcquire,
    withPrivateCheckout,
  },
} = require("./landing-turn.cjs");
const { endGroup } = require("./process-tree.cjs");
const { running, setup } = require("./landing-turn.testkit.cjs");

// oxlint-disable-next-line t3code/no-global-process-runtime -- a plain node test, with no Effect runtime
const POSIX_ONLY = { skip: process.platform === "win32" };

// Holds a checkout in another process until it is stopped, and prints the checkout's directory.
const HOLDER = `
const { withPrivateCheckout } = require(process.env.LANDING_TURN).testing;
const warmLimit = process.env.WARM_LIMIT ? Number(process.env.WARM_LIMIT) : undefined;
const role = process.env.ROLE || "preWait";
withPrivateCheckout(
  { cwd: process.env.LANDER, commit: process.env.COMMIT, role, warmLimit },
  (directory) => {
    console.log(directory);
    return new Promise(() => setInterval(() => {}, 60 * 60 * 1000));
  },
);
`;

// Holds an extra checkout while running a tracked child process inside it, printing directory and child pid.
const EXTRA_WITH_CHILD = `
const { withPrivateCheckout, runCheck } = require(process.env.LANDING_TURN).testing;
const warmLimit = Number(process.env.WARM_LIMIT);
withPrivateCheckout(
  { cwd: process.env.LANDER, commit: process.env.COMMIT, role: "underTurn", warmLimit },
  async (directory, context) => {
    const command = \`"\${process.execPath}" -e "console.log('CHILD ' + process.pid); setInterval(() => {}, 60 * 60 * 1000)"\`;
    console.log("DIR " + directory);
    await runCheck(directory, "turn", process.env.COMMIT, 60, undefined, {
      ...context,
      command,
      stdio: "inherit",
    });
  },
);
`;

// Enters the local pre-turn FIFO queue in a child process and prints QUEUED once its ticket is held.
const QUEUED_WAITER = `
const { acquireCheckoutSlot } = require(process.env.LANDING_TURN).testing;
const warmLimit = Number(process.env.WARM_LIMIT);
(async () => {
  let announced = false;
  const slot = await acquireCheckoutSlot({
    cwd: process.env.LANDER,
    role: "preWait",
    warmLimit,
    waitSlot: () => {
      if (!announced) {
        announced = true;
        console.log("QUEUED");
      }
      return new Promise(() => setInterval(() => {}, 60 * 60 * 1000));
    },
  });
  slot.release();
})();
`;

function fixture() {
  const { root, origin, git, clone, commit } = setup();
  const dir = clone("lander");
  const write = (file, text = "") => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write(".gitignore", "node_modules\n*.tsbuildinfo\n");
  write("package.json", "{}\n");
  write("kept/package.json", "{}\n");
  write("gone/package.json", "{}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "packages");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "rm", "-q", "gone/package.json");
  git(dir, "commit", "-qm", "drop gone");
  const second = git(dir, "rev-parse", "HEAD");
  // Normalize worktree paths with path.resolve so assertions match on Windows (C:/ vs C:\) and POSIX.
  const listed = () =>
    git(dir, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)));
  const poolFolder = () =>
    checkoutsFolder(
      fs.realpathSync.native(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    );
  return { root, origin, git, clone, commit, dir, first, second, listed, poolFolder };
}

function holdInChild(cwd, commit, { role = "preWait", warmLimit } = {}) {
  const child = spawn(process.execPath, ["-e", HOLDER], {
    env: {
      ...process.env,
      LANDING_TURN: require.resolve("./landing-turn.cjs"),
      LANDER: cwd,
      COMMIT: commit,
      ROLE: role,
      ...(warmLimit === undefined ? {} : { WARM_LIMIT: String(warmLimit) }),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const directory = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.trim());
    });
    child.on("exit", () => reject(new Error(`the holder exited first: ${out}`)));
  });
  return { child, exited, directory };
}

/** Runs `run` while `count` warm checkouts are held, and returns the held directories. */
async function withKeptHeld(cwd, commit, run, count = KEPT_CHECKOUTS) {
  const held = [];
  const hold = (left) =>
    withPrivateCheckout({ cwd, commit, warmLimit: count }, async (directory) => {
      held.push(directory);
      if (left > 1) return hold(left - 1);
      return run(held);
    });
  await hold(count);
  return held;
}

function recordsOf(lander) {
  const file = path.join(lander, ".git", "t3-landing", "landings.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a second check reuses the kept checkout's node_modules, even under a non-English locale, and nothing else", async () => {
  const { root, git, dir, first, second } = fixture();
  const savedLocale = {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
    LANGUAGE: process.env.LANGUAGE,
  };
  try {
    const used = await withPrivateCheckout({ cwd: dir, commit: first }, (directory) => {
      for (const file of [
        "node_modules/.vite/task-cache/marker",
        "kept/node_modules/marker",
        "gone/node_modules/marker",
        "stray.txt",
        "build/out.js",
        "kept/app.tsbuildinfo",
      ]) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), "");
      }
      fs.writeFileSync(path.join(directory, "base.txt"), "edited\n");
      return directory;
    });

    // Simulate a non-English host locale so resetCheckout must force C locale on `git clean -ffdxn`.
    process.env.LC_ALL = "uk_UA.UTF-8";
    process.env.LANG = "uk_UA.UTF-8";
    process.env.LANGUAGE = "uk:de";
    await withPrivateCheckout({ cwd: dir, commit: second }, (directory) => {
      assert.equal(directory, used);
      assert.equal(git(directory, "rev-parse", "HEAD"), second);
      assert.equal(fs.readFileSync(path.join(directory, "base.txt"), "utf8"), "base\n");
      // The package the second commit removed takes its node_modules with it.
      assert.equal(fs.existsSync(path.join(directory, "gone")), false);
      assert.deepEqual(git(directory, "status", "--porcelain", "--ignored").split("\n").sort(), [
        "!! kept/node_modules/",
        "!! node_modules/",
      ]);
      assert.ok(fs.existsSync(path.join(directory, "node_modules/.vite/task-cache/marker")));
      assert.ok(fs.existsSync(path.join(directory, "kept/node_modules/marker")));
    });
  } finally {
    for (const [key, value] of Object.entries(savedLocale)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const EXTRA_BASENAME = /^extra-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("pre-turn checkouts wait in FIFO order without overflowing, while a turn holder takes bounded overflow", async () => {
  const { root, dir, second, listed, poolFolder } = fixture();
  let holder = null;
  let waiterBSlot = null;
  let waiterCSlot = null;
  const bNext = Promise.withResolvers();
  const cFirstWake = Promise.withResolvers();
  const cSecondWake = Promise.withResolvers();
  let waiterB = null;
  let waiterC = null;
  try {
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    const order = [];
    const bQueued = Promise.withResolvers();
    const cQueued = Promise.withResolvers();
    const cSecondWait = Promise.withResolvers();

    let bWaits = 0;
    waiterB = acquireCheckoutSlot({
      cwd: dir,
      role: "preWait",
      warmLimit: 1,
      waitSlot: async () => {
        bWaits += 1;
        if (bWaits === 1) bQueued.resolve();
        await bNext.promise;
      },
    }).then((slot) => {
      waiterBSlot = slot;
      order.push("B");
      return slot;
    });

    await bQueued.promise;

    let cWaits = 0;
    waiterC = acquireCheckoutSlot({
      cwd: dir,
      role: "preWait",
      warmLimit: 1,
      waitSlot: async () => {
        cWaits += 1;
        if (cWaits === 1) {
          cQueued.resolve();
          await cFirstWake.promise;
          return;
        }
        if (cWaits === 2) cSecondWait.resolve();
        await cSecondWake.promise;
      },
    }).then((slot) => {
      waiterCSlot = slot;
      order.push("C");
      return slot;
    });

    await cQueued.promise;

    // While pre-turn waiters B and C wait in the FIFO queue, an under-turn run takes bounded overflow without stalling.
    let extra;
    await withPrivateCheckout(
      { cwd: dir, commit: second, role: "underTurn", warmLimit: 1 },
      (directory) => {
        extra = directory;
        assert.match(path.basename(extra), EXTRA_BASENAME);
      },
    );
    assert.equal(fs.existsSync(extra), false);
    assert.equal(fs.existsSync(`${extra}.lock`), false);
    assert.equal(listed().includes(path.resolve(extra)), false);

    // Release warm slot 0, then wake C BEFORE B: C must stay behind B in FIFO order!
    holder.release();
    holder = null;
    cFirstWake.resolve();
    await cSecondWait.promise;
    assert.deepEqual(order, []);
    assert.equal(waiterCSlot, null);

    // Now wake B: B takes warm slot 0 (no overflow directory created).
    bNext.resolve();
    await waiterB;
    assert.equal(waiterBSlot.index, 0);
    assert.equal(waiterBSlot.waited, true);
    assert.deepEqual(order, ["B"]);

    // Release B and wake C: C now takes warm slot 0.
    waiterBSlot.release();
    waiterBSlot = null;
    cSecondWake.resolve();
    await waiterC;
    assert.equal(waiterCSlot.index, 0);
    assert.equal(waiterCSlot.waited, true);
    assert.deepEqual(order, ["B", "C"]);
    waiterCSlot.release();
    waiterCSlot = null;

    // No overflow directories or leftover locks remain in the pool folder.
    const names = fs
      .readdirSync(poolFolder())
      .filter((name) => /^(?:\d+|extra-[0-9a-f-]+)(?:\.(?:lock|dirty))?$/.test(name));
    assert.deepEqual(names, ["0.lock"]);
  } finally {
    holder?.release();
    bNext.resolve();
    cFirstWake.resolve();
    cSecondWake.resolve();
    await Promise.allSettled([
      waiterB?.then((slot) => slot.release()),
      waiterC?.then((slot) => slot.release()),
    ]);
    waiterBSlot?.release();
    waiterCSlot?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a killed waiter in the local FIFO queue releases its ticket immediately so the next waiter proceeds", async () => {
  const { root, dir } = fixture();
  const holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
  const deadWaiter = spawn(process.execPath, ["-e", QUEUED_WAITER], {
    env: {
      ...process.env,
      LANDING_TURN: require.resolve("./landing-turn.cjs"),
      LANDER: dir,
      WARM_LIMIT: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) =>
    deadWaiter.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const bWake = Promise.withResolvers();
  let waiterB = null;
  let slotB = null;
  try {
    await new Promise((resolve, reject) => {
      let out = "";
      deadWaiter.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("QUEUED")) resolve();
      });
      deadWaiter.on("exit", () => reject(new Error(`waiter exited early: ${out}`)));
    });

    const bQueued = Promise.withResolvers();
    waiterB = acquireCheckoutSlot({
      cwd: dir,
      role: "preWait",
      warmLimit: 1,
      waitSlot: async () => {
        bQueued.resolve();
        await bWake.promise;
      },
    });
    await bQueued.promise;

    // Kill the first waiter and release slot 0: waiter B sweeps the dead ticket and takes slot 0 immediately.
    deadWaiter.kill("SIGKILL");
    await exited;
    holder.release();
    bWake.resolve();

    slotB = await waiterB;
    assert.equal(slotB.index, 0);
    assert.equal(slotB.waited, true);
  } finally {
    deadWaiter.kill("SIGKILL");
    await exited;
    holder.release();
    bWake.resolve();
    if (!slotB && waiterB) {
      await waiterB.then(
        (slot) => slot.release(),
        () => {},
      );
    }
    slotB?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting for a precheck slot records localSlotWait separately and rebases onto fresh main before checking", async () => {
  const { root, origin, git, clone, commit, dir } = fixture();
  let holder = null;
  try {
    git(dir, "push", "-q", "origin", "HEAD:main");
    commit(dir, "mine.txt");
    const mover = clone("mover");

    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    let elapsed = 0;
    const seenChecks = [];
    const result = await land({
      cwd: dir,
      remote: origin,
      warmLimit: 1,
      now: () => Date.UTC(2026, 0, 1),
      recordClock: () => elapsed,
      waitSlot: async () => {
        elapsed += 4000;
        // Origin advances while we wait in the local warm-slot queue.
        commit(mover, "moved-while-waiting.txt");
        git(mover, "push", "-q", "origin", "HEAD:main");
        holder.release();
        holder = null;
      },
      check: (turn, base, _budget, directory) => {
        elapsed += 1500;
        seenChecks.push({
          turn,
          base,
          head: git(directory, "rev-parse", "HEAD"),
          hasMovedFile: fs.existsSync(path.join(directory, "moved-while-waiting.txt")),
        });
        return true;
      },
    });

    const latestMain = git(mover, "rev-parse", "HEAD");
    assert.equal(result.status, "landed");
    // Only ONE check ran (pre-wait), on the freshly rebased commit containing mover's file!
    assert.equal(seenChecks.length, 1);
    assert.equal(seenChecks[0].turn, null);
    assert.equal(seenChecks[0].base, latestMain);
    assert.equal(seenChecks[0].hasMovedFile, true);
    assert.equal(seenChecks[0].head, result.commit);

    const [record] = recordsOf(dir);
    assert.equal(record.status, "landed");
    assert.equal(record.phases.localSlotWait, 4000);
    assert.equal(record.phases.preWaitCheck, 1500);
    assert.equal(typeof record.phases.rebase, "number");
    assert.equal(record.phases.underTurnCheck, undefined);
    assert.equal(record.head, result.commit);
    assert.equal(record.base, latestMain);
  } finally {
    holder?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebase-after-wait relaunches when .github/scripts/ changed, re-checks notesMergeProblem, and records latestBase on conflict", async () => {
  const { root, origin, git, clone, commit, dir } = fixture();
  let holder = null;
  let verifyFree = null;
  try {
    git(dir, "push", "-q", "origin", "HEAD:main");
    commit(dir, "mine.txt");
    const mover = clone("mover");

    // Case 1: origin changes .github/scripts/ while we wait -> release slot and return status "rebased" carrying localSlotWait.
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    let elapsed = 0;
    let carriedState = null;
    const rebasedResult = await land({
      cwd: dir,
      remote: origin,
      warmLimit: 1,
      now: () => Date.UTC(2026, 0, 1),
      recordClock: () => elapsed,
      onRebased: (state) => {
        carriedState = JSON.parse(state);
      },
      waitSlot: async () => {
        elapsed += 3000;
        fs.mkdirSync(path.join(mover, ".github", "scripts"), { recursive: true });
        commit(mover, ".github/scripts/updated-helper.cjs");
        git(mover, "push", "-q", "origin", "HEAD:main");
        holder.release();
        holder = null;
      },
      check: () =>
        assert.fail("should relaunch instead of checking in place when .github/scripts/ changed"),
    });

    const scriptBase = git(mover, "rev-parse", "HEAD");
    assert.equal(rebasedResult.status, "rebased");
    assert.equal(rebasedResult.base, scriptBase);
    assert.equal(rebasedResult.head, git(dir, "rev-parse", "HEAD"));
    assert.equal(carriedState.phases.localSlotWait, 3000);
    assert.equal(typeof carriedState.phases.rebase, "number");
    assert.deepEqual(recordsOf(dir), []);

    // Warm slot 0 was released before returning "rebased".
    verifyFree = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    verifyFree.release();
    verifyFree = null;

    // Case 2: origin breaks .gitattributes release-notes merge driver while we wait -> throws notesMergeProblem after rebase.
    const brokenBaseMover = clone("broken-notes");
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    await assert.rejects(
      () =>
        land({
          cwd: dir,
          remote: origin,
          warmLimit: 1,
          waitSlot: async () => {
            fs.writeFileSync(
              path.join(brokenBaseMover, ".gitattributes"),
              "docs/release-notes.md -merge\n",
            );
            git(brokenBaseMover, "add", ".gitattributes");
            git(brokenBaseMover, "commit", "-qm", "break release-notes driver");
            git(brokenBaseMover, "push", "-q", "origin", "HEAD:main");
            holder.release();
            holder = null;
          },
          check: () => assert.fail("should fail notesMergeProblem before checking"),
        }),
      /release-notes: rebases and merges here/,
    );
    // Restore .gitattributes on origin and dir so Case 3 starts clean.
    fs.writeFileSync(
      path.join(brokenBaseMover, ".gitattributes"),
      "docs/release-notes.md merge=release-notes\n",
    );
    git(brokenBaseMover, "add", ".gitattributes");
    git(brokenBaseMover, "commit", "-qm", "restore release-notes driver");
    git(brokenBaseMover, "push", "-q", "origin", "HEAD:main");
    git(dir, "fetch", "-q", "origin", "main");
    git(dir, "rebase", "-q", "FETCH_HEAD");

    // Case 3: origin edits mine.txt while we wait -> rebase conflicts and landings.jsonl records latestBase.
    const conflictMover = clone("conflict-mover");
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    await assert.rejects(
      () =>
        land({
          cwd: dir,
          remote: origin,
          warmLimit: 1,
          waitSlot: async () => {
            fs.writeFileSync(path.join(conflictMover, "mine.txt"), "conflict-from-main\n");
            git(conflictMover, "add", "mine.txt");
            git(conflictMover, "commit", "-qm", "conflict on mine.txt");
            git(conflictMover, "push", "-q", "origin", "HEAD:main");
            holder.release();
            holder = null;
          },
          check: () => assert.fail("should conflict before checking"),
        }),
      /rebase/i,
    );
    const conflictBase = git(conflictMover, "rev-parse", "HEAD");
    const lastRecord = recordsOf(dir).at(-1);
    assert.equal(lastRecord.status, "conflict");
    assert.equal(lastRecord.base, conflictBase);
  } finally {
    holder?.release();
    verifyFree?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting for a precheck slot releases cleanly if HEAD moves or uncommitted edits appear while waiting", async () => {
  const { root, origin, git, commit, dir } = fixture();
  let holder = null;
  let verifyFree = null;
  try {
    git(dir, "push", "-q", "origin", "HEAD:main");
    commit(dir, "mine.txt");

    // Case 1: uncommitted edit appears while waiting.
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    const dirtyResult = await land({
      cwd: dir,
      remote: origin,
      warmLimit: 1,
      waitSlot: async () => {
        fs.writeFileSync(path.join(dir, "stray.txt"), "dirty\n");
        holder.release();
        holder = null;
      },
      check: () => assert.fail("should not check dirty worktree"),
    });
    assert.equal(dirtyResult.status, "uncommitted");
    fs.rmSync(path.join(dir, "stray.txt"));

    // Warm slot 0 must be free again after early return.
    holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    const movedResult = await land({
      cwd: dir,
      remote: origin,
      warmLimit: 1,
      waitSlot: async () => {
        commit(dir, "another.txt");
        holder.release();
        holder = null;
      },
      check: () => assert.fail("should not check moved HEAD"),
    });
    assert.equal(movedResult.status, "head-moved");

    verifyFree = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    verifyFree.release();
    verifyFree = null;
  } finally {
    holder?.release();
    verifyFree?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a kept checkout left dirty by a SIGKILLed holder rebuilds cleanly instead of reusing potentially poisoned node_modules", async () => {
  const { root, git, dir, first, second, listed } = fixture();
  try {
    const holder = holdInChild(dir, first, { warmLimit: 1 });
    let used;
    try {
      used = await holder.directory;
      // The holder died in a checkout: index half-updated, file half-written, git lock left, node_modules potentially poisoned.
      fs.mkdirSync(path.join(used, "node_modules"));
      fs.writeFileSync(path.join(used, "node_modules/marker"), "");
      git(used, "read-tree", second);
      fs.writeFileSync(path.join(used, "base.txt"), "half\n");
      const lock = git(used, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
      fs.writeFileSync(lock, "");
    } finally {
      holder.child.kill("SIGKILL");
      await holder.exited;
    }

    const check = () =>
      withPrivateCheckout({ cwd: dir, commit: second, warmLimit: 1 }, (directory, context) => {
        assert.equal(directory, used);
        assert.equal(git(directory, "rev-parse", "HEAD"), second);
        assert.equal(git(directory, "status", "--porcelain"), "");
        return {
          reused: context.reused,
          hasMarker: fs.existsSync(path.join(directory, "node_modules/marker")),
        };
      });

    // First run after SIGKILL sees the dirty marker and forces a clean rebuild, wiping node_modules.
    assert.deepEqual(await check(), { reused: false, hasMarker: false });

    // A subsequent clean run reuses the rebuilt warm checkout.
    assert.deepEqual(await check(), { reused: true, hasMarker: false });

    // Its worktree entry pruned while the directory stays.
    const admin = git(used, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.rmSync(admin, { recursive: true });
    assert.deepEqual(await check(), { reused: false, hasMarker: false });

    // The directory deleted, with its entry left behind.
    fs.rmSync(used, { recursive: true });
    assert.deepEqual(await check(), { reused: false, hasMarker: false });
    assert.equal(listed().filter((entry) => entry === path.resolve(used)).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "dirty-slot recovery verifies boot-scoped host and process start time before killing, and still rebuilds when skipped",
  POSIX_ONLY,
  async () => {
    const { root, dir, second, poolFolder } = fixture();
    const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 60 * 60 * 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const strayExited = new Promise((resolve) => stray.on("exit", resolve));
    try {
      assert.equal(running(stray.pid), true);
      const here = dirtyMarkerHost();
      const started = readProcessStarted(stray.pid);
      assert.equal(typeof here, "string");
      assert.equal(typeof started, "string");
      assert.ok(started.length > 0);

      // Seed warm slot 0, then verify markers with missing host, wrong host, bare hostname, wrong started, or legacy pgid
      // rebuild cleanly WITHOUT killing the unrelated live process group.
      await withPrivateCheckout({ cwd: dir, commit: second, warmLimit: 1 }, () => {});
      const dirtyPath = path.join(poolFolder(), "0.dirty");
      const unsafeMarkers = [
        { pid: stray.pid, childGroups: [{ group: stray.pid, started }] },
        {
          pid: stray.pid,
          host: "other-host other-boot",
          childGroups: [{ group: stray.pid, started }],
        },
        { pid: stray.pid, host: os.hostname(), childGroups: [{ group: stray.pid, started }] },
        { pid: stray.pid, host: here, childGroups: [{ group: stray.pid, started: "0" }] },
        { pid: stray.pid, host: here, childGroups: [{ group: stray.pid, started: "" }] },
        { pid: stray.pid, host: here, pgid: stray.pid },
      ];
      for (const marker of unsafeMarkers) {
        fs.writeFileSync(dirtyPath, JSON.stringify(marker));
        await withPrivateCheckout(
          { cwd: dir, commit: second, warmLimit: 1 },
          (_directory, context) => {
            assert.equal(context.reused, false);
          },
        );
        assert.equal(
          running(stray.pid),
          true,
          `unsafe marker must not kill: ${JSON.stringify(marker)}`,
        );
      }

      // Matching boot-scoped host + group + exact start time DOES stop the lingering process group.
      fs.writeFileSync(
        dirtyPath,
        JSON.stringify({
          pid: stray.pid,
          host: here,
          childGroups: [{ group: stray.pid, started }],
        }),
      );
      await withPrivateCheckout(
        { cwd: dir, commit: second, warmLimit: 1 },
        (_directory, context) => {
          assert.equal(context.reused, false);
        },
      );
      await strayExited;
      assert.equal(running(stray.pid), false);
    } finally {
      try {
        process.kill(-stray.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
      await strayExited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "dirty marker tracks all active child groups atomically, and EPERM in stopDirtyGroup/endGroup does not hang",
  POSIX_ONLY,
  async (t) => {
    const { root, dir, second, poolFolder } = fixture();
    const childA = Promise.withResolvers();
    const childB = Promise.withResolvers();
    try {
      await withPrivateCheckout(
        { cwd: dir, commit: second, warmLimit: 1 },
        async (_directory, context) => {
          let procA;
          let procB;
          let untrackA;
          let untrackB;
          const waitExit = (proc) =>
            !proc || proc.exitCode !== null || proc.signalCode !== null
              ? Promise.resolve()
              : new Promise((resolve) => proc.once("exit", resolve));
          try {
            procA = spawn(process.execPath, ["-e", "setInterval(() => {}, 60 * 60 * 1000)"], {
              detached: true,
              stdio: "ignore",
            });
            procB = spawn(process.execPath, ["-e", "setInterval(() => {}, 60 * 60 * 1000)"], {
              detached: true,
              stdio: "ignore",
            });
            untrackA = context.trackChild({
              group: procA.pid,
              stop: () => procA.kill("SIGKILL"),
              done: childA.promise,
            });
            untrackB = context.trackChild({
              group: procB.pid,
              stop: () => procB.kill("SIGKILL"),
              done: childB.promise,
            });
            const dirtyPath = path.join(poolFolder(), "0.dirty");
            assert.equal(fs.existsSync(`${dirtyPath}.tmp`), false);
            const marker = JSON.parse(fs.readFileSync(dirtyPath, "utf8"));
            assert.equal(marker.pid, process.pid);
            assert.equal(marker.host, dirtyMarkerHost());
            assert.equal("pgid" in marker, false);
            assert.equal(Array.isArray(marker.childGroups), true);
            assert.deepEqual(
              marker.childGroups.map((entry) => entry.group).sort((a, b) => a - b),
              [procA.pid, procB.pid].sort((a, b) => a - b),
            );
            for (const entry of marker.childGroups) {
              assert.equal(entry.started, readProcessStarted(entry.group));
            }
          } finally {
            untrackA?.();
            untrackB?.();
            const exited = Promise.all([waitExit(procA), waitExit(procB)]);
            if (procA && procA.exitCode === null && procA.signalCode === null)
              procA.kill("SIGKILL");
            if (procB && procB.exitCode === null && procB.signalCode === null)
              procB.kill("SIGKILL");
            await exited;
            childA.resolve();
            childB.resolve();
          }
        },
      );

      // stopDirtyGroup skips EPERM groups immediately without invoking endGroup.
      const dirtyPath = path.join(poolFolder(), "0.dirty");
      fs.writeFileSync(
        dirtyPath,
        JSON.stringify({
          pid: 999999,
          host: "linux-boot",
          childGroups: [{ group: 424242, started: "12345" }],
        }),
      );
      let ended = false;
      const wasDirty = await stopDirtyGroup(dirtyPath, {
        platform: "linux",
        currentHost: () => "linux-boot",
        readStarted: () => "12345",
        probe: () => "eperm",
        getOwnPgid: () => 100,
        end: () => {
          ended = true;
          throw new Error("should not call endGroup on EPERM");
        },
      });
      assert.equal(wasDirty, true);
      assert.equal(ended, false);

      // endGroup rejects immediately on EPERM instead of looping 30s on groupAlive.
      const eperm = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      t.mock.method(process, "kill", () => {
        throw eperm;
      });
      await assert.rejects(() => endGroup(424242), { code: "EPERM" });
    } finally {
      childA.resolve();
      childB.resolve();
      t.mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("runCheck rebuilds and retries install once when install fails in a reused warm checkout", async () => {
  const { root, dir, second } = fixture();
  try {
    // Seed a warm checkout with a poisoned marker file inside node_modules.
    await withPrivateCheckout({ cwd: dir, commit: second, warmLimit: 1 }, (directory) => {
      fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(directory, "node_modules/poison"), "bad");
    });

    // Install script fails while node_modules/poison exists, succeeds after clean rebuild removes it.
    const installScript = path.join(root, "install.js");
    const runsLog = path.join(root, "install-runs.log");
    fs.writeFileSync(
      installScript,
      [
        'const fs = require("node:fs");',
        `fs.appendFileSync(${JSON.stringify(runsLog)}, "install\\n");`,
        'if (fs.existsSync("node_modules/poison")) process.exit(1);',
      ].join("\n"),
    );

    const passed = await withPrivateCheckout(
      { cwd: dir, commit: second, warmLimit: 1 },
      (directory, context) => {
        assert.equal(context.reused, true);
        return runCheck(directory, null, second, undefined, undefined, {
          ...context,
          installCommand: `"${process.execPath}" "${installScript}"`,
          checkCommand: `"${process.execPath}" -e "process.exit(0)"`,
          stdio: "pipe",
        });
      },
    );

    assert.equal(passed, true);
    assert.deepEqual(fs.readFileSync(runsLog, "utf8").trim().split("\n"), ["install", "install"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runCheck passes abort signal into rebuild(signal) and stops without retrying install on abort", async () => {
  const { root, dir, second } = fixture();
  try {
    await withPrivateCheckout({ cwd: dir, commit: second, warmLimit: 1 }, () => {});

    const runsLog = path.join(root, "install-runs.log");
    const installScript = path.join(root, "install-fail.js");
    fs.writeFileSync(
      installScript,
      [
        'const fs = require("node:fs");',
        `fs.appendFileSync(${JSON.stringify(runsLog)}, "install\\n");`,
        "process.exit(1);",
      ].join("\n"),
    );

    const lost = new AbortController();
    let seenSignal = null;
    const passed = await withPrivateCheckout(
      { cwd: dir, commit: second, warmLimit: 1 },
      (directory, context) => {
        assert.equal(context.reused, true);
        return runCheck(directory, "turn", second, 60, lost.signal, {
          ...context,
          rebuild: async (signal) => {
            seenSignal = signal;
            lost.abort(new Error("lost turn during rebuild"));
            await context.rebuild(signal);
          },
          installCommand: `"${process.execPath}" "${installScript}"`,
          checkCommand: `"${process.execPath}" -e "process.exit(0)"`,
          stdio: "pipe",
        });
      },
    );

    assert.equal(passed, false);
    assert.equal(seenSignal, lost.signal);
    assert.deepEqual(fs.readFileSync(runsLog, "utf8").trim().split("\n"), ["install"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "SIGTERM on an extra checkout stops its active child process before removing the checkout",
  POSIX_ONLY,
  async () => {
    const { root, dir, second, listed } = fixture();
    try {
      await withKeptHeld(
        dir,
        second,
        async () => {
          const stopped = spawn(process.execPath, ["-e", EXTRA_WITH_CHILD], {
            env: {
              ...process.env,
              LANDING_TURN: require.resolve("./landing-turn.cjs"),
              LANDER: dir,
              COMMIT: second,
              WARM_LIMIT: "1",
            },
            stdio: ["ignore", "pipe", "inherit"],
          });
          const exited = new Promise((resolve) =>
            stopped.on("exit", (code, signal) => resolve({ code, signal })),
          );
          let own;
          let innerPid;
          let exit = null;
          try {
            ({ own, innerPid } = await new Promise((resolve, reject) => {
              let out = "";
              stopped.stdout.on("data", (chunk) => {
                out += chunk;
                const dirMatch = /^DIR (.+)$/m.exec(out);
                const childMatch = /^CHILD (\d+)$/m.exec(out);
                if (dirMatch && childMatch) {
                  resolve({ own: dirMatch[1].trim(), innerPid: Number(childMatch[1]) });
                }
              });
              stopped.on("exit", () => reject(new Error(`extra holder exited early: ${out}`)));
            }));
            assert.match(path.basename(own), EXTRA_BASENAME);
            assert.ok(fs.existsSync(own));
            assert.equal(running(innerPid), true);

            stopped.kill("SIGTERM");
            exit = await exited;
          } finally {
            if (exit === null) {
              stopped.kill("SIGKILL");
              await exited;
            }
          }

          assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
          assert.equal(running(innerPid), false);
          assert.equal(fs.existsSync(own), false);
          assert.equal(fs.existsSync(`${own}.lock`), false);
          assert.equal(fs.existsSync(`${own}.dirty`), false);
          assert.equal(listed().includes(path.resolve(own)), false);
        },
        1,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// Runs land() in a child process where origin advances before the turn so underTurnCheck uses an extra slot,
// then waits inside a tracked child until SIGTERM arrives.
const LAND_EXTRA_SIGTERM = `
const { land, testing: { runCheck } } = require(process.env.LANDING_TURN);
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  let announcedWait = false;
  await land({
    cwd: process.env.LANDER,
    remote: process.env.ORIGIN,
    warmLimit: 1,
    pollMs: 25,
    sleep: (ms) => {
      if (!announcedWait) {
        announcedWait = true;
        console.log("WAITING_TURN");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    check: async (turn, base, budget, directory, signal, checkoutContext) => {
      if (turn === null) {
        // Advance origin before the turn so underTurnCheck runs in an extra slot while slot 0 is held.
        fs.writeFileSync(path.join(process.env.MOVER, "advance.txt"), "moved\\n");
        spawnSync("git", ["-C", process.env.MOVER, "add", "advance.txt"], { stdio: "ignore" });
        spawnSync("git", ["-C", process.env.MOVER, "commit", "-qm", "advance"], { stdio: "ignore" });
        spawnSync("git", ["-C", process.env.MOVER, "push", "-q", "origin", "HEAD:main"], { stdio: "ignore" });
        return true;
      }
      console.log("EXTRA_DIR " + directory);
      const command = \`"\${process.execPath}" -e "console.log('EXTRA_CHILD ' + process.pid); setInterval(() => {}, 60 * 60 * 1000)"\`;
      return runCheck(directory, turn, base, budget, signal, {
        ...checkoutContext,
        command,
        stdio: "inherit",
      });
    },
  });
})();
`;

test(
  "SIGTERM during an under-turn extra checkout run tears down once without recording a bogus check-failed",
  POSIX_ONLY,
  async () => {
    const { root, origin, git, clone, commit, dir, listed } = fixture();
    let holder = null;
    let parentLease = null;
    try {
      git(dir, "push", "-q", "origin", "HEAD:main");
      commit(dir, "mine.txt");
      const mover = clone("mover");

      // Hold the remote lease so the child finishes preWait (releasing slot 0) and pauses waiting for the turn.
      parentLease = tryAcquire({ cwd: mover, remote: origin, runId: "parent-gate" });
      assert.ok(parentLease);

      const child = spawn(process.execPath, ["-e", LAND_EXTRA_SIGTERM], {
        env: {
          ...process.env,
          LANDING_TURN: require.resolve("./landing-turn.cjs"),
          LANDER: dir,
          ORIGIN: origin,
          MOVER: mover,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = new Promise((resolve) =>
        child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      let extraDir;
      let innerPid;
      let exit = null;
      try {
        await new Promise((resolve, reject) => {
          let out = "";
          const onData = (chunk) => {
            out += chunk;
            if (out.includes("WAITING_TURN")) {
              child.stdout.off("data", onData);
              resolve();
            }
          };
          child.stdout.on("data", onData);
          child.on("exit", () =>
            reject(new Error(`land child exited before WAITING_TURN: ${out}`)),
          );
        });

        // Child has released warm slot 0 and is waiting for the turn; hold slot 0, then release the turn.
        const extraReady = new Promise((resolve, reject) => {
          let out = "";
          child.stdout.on("data", (chunk) => {
            out += chunk;
            const dirMatch = /^EXTRA_DIR (.+)$/m.exec(out);
            const childMatch = /^EXTRA_CHILD (\d+)$/m.exec(out);
            if (dirMatch && childMatch) {
              resolve({ extraDir: dirMatch[1].trim(), innerPid: Number(childMatch[1]) });
            }
          });
          child.on("exit", () => reject(new Error(`land child exited before EXTRA_CHILD: ${out}`)));
        });
        holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
        release({ cwd: mover, remote: origin }, parentLease);
        parentLease = null;
        ({ extraDir, innerPid } = await extraReady);

        assert.match(path.basename(extraDir), EXTRA_BASENAME);
        assert.equal(running(innerPid), true);

        child.kill("SIGTERM");
        exit = await exited;
      } finally {
        if (exit === null) {
          child.kill("SIGKILL");
          await exited;
        }
        if (parentLease) {
          release({ cwd: mover, remote: origin }, parentLease);
          parentLease = null;
        }
        holder?.release();
      }

      assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
      assert.equal(running(innerPid), false);
      assert.equal(fs.existsSync(extraDir), false);
      assert.equal(fs.existsSync(`${extraDir}.lock`), false);
      assert.equal(fs.existsSync(`${extraDir}.dirty`), false);
      assert.equal(listed().includes(path.resolve(extraDir)), false);
      // Must NOT have resumed runLanding to write a bogus check-failed/error record.
      assert.deepEqual(recordsOf(dir), []);
    } finally {
      holder?.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a killed extra checkout is skipped by under-turn runs and swept (with its lock and legacy overflow) by the next pre-turn landing", async () => {
  const { root, dir, second, listed, poolFolder } = fixture();
  try {
    let killed;
    await withKeptHeld(
      dir,
      second,
      async () => {
        const dead = holdInChild(dir, second, { role: "underTurn", warmLimit: 1 });
        try {
          killed = await dead.directory;
        } finally {
          dead.child.kill("SIGKILL");
          await dead.exited;
        }
        assert.match(path.basename(killed), EXTRA_BASENAME);
        assert.ok(fs.existsSync(killed));
      },
      1,
    );

    // Also plant a legacy numeric overflow directory (>= warmLimit) and an orphan extra dirty marker.
    const legacyDir = path.join(poolFolder(), "2");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(`${legacyDir}.dirty`, JSON.stringify({ pid: 1, host: null, childGroups: [] }));
    const orphanDirty = path.join(poolFolder(), `extra-${randomUUID()}.dirty`);
    fs.writeFileSync(orphanDirty, JSON.stringify({ pid: 1, host: null, childGroups: [] }));

    // An under-turn checkout skips sweepCheckouts so it never stalls on sweep work under the main lease.
    await withPrivateCheckout(
      { cwd: dir, commit: second, role: "underTurn", warmLimit: 1 },
      () => {},
    );
    assert.ok(fs.existsSync(killed));
    assert.ok(fs.existsSync(legacyDir));

    // The next pre-turn landing sweeps the abandoned extra checkout, orphan extra dirty marker, and legacy numeric overflow.
    await withPrivateCheckout(
      { cwd: dir, commit: second, role: "preWait", warmLimit: 1 },
      () => {},
    );
    assert.equal(fs.existsSync(killed), false);
    assert.equal(fs.existsSync(`${killed}.lock`), false);
    assert.equal(fs.existsSync(`${killed}.dirty`), false);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(`${legacyDir}.lock`), false);
    assert.equal(fs.existsSync(`${legacyDir}.dirty`), false);
    assert.equal(fs.existsSync(orphanDirty), false);
    assert.equal(listed().includes(path.resolve(killed)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing removes the temp-folder checkouts older landings left, once no turn can still use them", async () => {
  const { root, git, dir, second, listed } = fixture();
  const old = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  const recent = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  try {
    for (const directory of [old, recent]) git(dir, "worktree", "add", "-q", "--detach", directory);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const oldAdded = new Date(now - TURN_MAX_MS - 60 * 1000);
    fs.utimesSync(path.join(old, ".git"), oldAdded, oldAdded);
    fs.utimesSync(path.join(recent, ".git"), new Date(now), new Date(now));

    await withPrivateCheckout({ cwd: dir, commit: second, now: () => now }, () => {});

    assert.equal(fs.existsSync(old), false);
    assert.equal(listed().includes(path.resolve(old)), false);
    assert.ok(fs.existsSync(recent));
  } finally {
    for (const directory of [old, recent]) fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SQLITE_BUSY/win32 SQLITE_CANTOPEN, boot host & process start parsing, machine budget sizing, and landingCheckout validation", () => {
  // Primary and extended SQLite busy codes (5, SQLITE_BUSY_RECOVERY=261, SNAPSHOT=517, TIMEOUT=773).
  for (const errcode of [5, 261, 517, 773]) {
    assert.equal(isSqliteBusy({ errcode }), true, `errcode ${errcode} should be busy`);
  }
  for (const error of [{ errcode: 1 }, { errcode: 14 }, { errcode: "5" }, {}, null, undefined]) {
    assert.equal(isSqliteBusy(error), false);
  }

  // Windows transient SQLITE_CANTOPEN (14, and extended 270) when parent directory exists returns null in lockFile.
  for (const errcode of [14, 270]) {
    const cantOpen = Object.assign(new Error("unable to open database file"), { errcode });
    assert.equal(
      lockFile("/dir/0.lock", {
        platform: "win32",
        existsSync: () => true,
        openDatabase: () => {
          throw cantOpen;
        },
      }),
      null,
    );
    // Unique lock creation disables SQLITE_CANTOPEN suppression so persistent Windows failures throw instead of spinning.
    assert.throws(
      () =>
        lockFile("/dir/extra-uuid.lock", {
          platform: "win32",
          existsSync: () => true,
          tolerateCantOpen: false,
          openDatabase: () => {
            throw cantOpen;
          },
        }),
      (error) => error === cantOpen,
    );
    let closed = false;
    assert.equal(
      lockFile("/dir/0.lock", {
        platform: "win32",
        existsSync: () => true,
        openDatabase: () => ({
          exec: () => {
            throw cantOpen;
          },
          close: () => {
            closed = true;
          },
        }),
      }),
      null,
    );
    assert.equal(closed, true);
    assert.throws(
      () =>
        lockFile("/missing/0.lock", {
          platform: "win32",
          existsSync: () => false,
          openDatabase: () => {
            throw cantOpen;
          },
        }),
      /unable to open database file/,
    );
    assert.throws(
      () =>
        lockFile("/dir/0.lock", {
          platform: "linux",
          existsSync: () => true,
          openDatabase: () => {
            throw cantOpen;
          },
        }),
      /unable to open database file/,
    );
  }

  // Boot-scoped host identity across platforms.
  assert.equal(
    dirtyMarkerHost({
      platform: "darwin",
      hostname: () => "mac.local",
      spawn: () => ({
        status: 0,
        stdout: "{ sec = 1712345678, usec = 123456 } Fri Apr  5 12:34:38 2024\n",
      }),
    }),
    "darwin:mac.local:1712345678",
  );
  assert.equal(
    dirtyMarkerHost({
      platform: "darwin",
      hostname: () => "mac.local",
      spawn: () => ({ status: 1, stdout: "" }),
    }),
    null,
  );
  assert.equal(dirtyMarkerHost({ platform: "freebsd" }), null);

  // Process start time parsing handles Linux comm with spaces and parentheses, and macOS ps lstart.
  const fakeStat =
    "4242 (my (weird) proc) S 1 4242 4242 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 987654321 1000 10\n";
  assert.equal(
    readProcessStarted(4242, { platform: "linux", readFileSync: () => fakeStat }),
    "987654321",
  );
  assert.equal(
    readProcessStarted(4242, {
      platform: "darwin",
      spawn: () => ({ status: 0, stdout: "  Fri Nov 27 21:00:00 2026 \n" }),
    }),
    "Fri Nov 27 21:00:00 2026",
  );

  // Machine budget sizing matches check-changed.ts defaultConcurrency(cores, totalMemBytes).
  const GiB = 1024 ** 3;
  assert.equal(machineBudgetSlots(2, 8 * GiB), 1);
  assert.equal(machineBudgetSlots(10, 12 * GiB), 2);
  assert.equal(machineBudgetSlots(10, 10 * GiB), 1);
  assert.equal(machineBudgetSlots(16, 64 * GiB), 8);
  assert.equal(resolveWarmLimit(1), 1);
  assert.equal(resolveWarmLimit(3), 3);

  // Tightened landingCheckout validation requires 16-hex clone folder and numeric or extra-<uuid> slot basename.
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/0"), true);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/12"), true);
  assert.equal(
    landingCheckout(`/cache/t3-landing-checkouts/0123456789abcdef/extra-${randomUUID()}`),
    true,
  );
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/extra-bad"), false);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/not-hex-folder!!/0"), false);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/feature"), false);
  assert.equal(landingCheckout(`/tmp/t3-landing-${randomUUID()}`), true);
  assert.equal(landingCheckout("/home/user/worktrees/my-branch"), false);
});

test("runCheck skips spawning checkCommand when checkout teardown starts right after install", async () => {
  const { root, dir } = fixture();
  try {
    let stopping = false;
    let spawns = 0;
    const ok = await runCheck(dir, "turn-1", "HEAD", undefined, undefined, {
      installCommand: `"${process.execPath}" -e "process.exit(0)"`,
      checkCommand: `"${process.execPath}" -e "process.exit(0)"`,
      stdio: "ignore",
      isStopping: () => stopping,
      onSpawn: () => {
        spawns += 1;
        // Simulate SIGTERM arriving right as installCommand finishes and before checkCommand starts.
        stopping = true;
      },
    });
    assert.equal(ok, false);
    assert.equal(spawns, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runCheck isolates metrics in a private temp dir, sweeps *.tmp, guards callback errors, and strips mixed-case metrics env", async () => {
  const { root, dir } = fixture();
  const prior = Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() === CHECK_METRICS_FILE_ENV,
  );
  try {
    for (const [key] of prior) delete process.env[key];
    // Mixed-case first so Windows keeps the mixed-case key name; POSIX carries both keys.
    process.env.Check_Changed_Metrics_File = "/outer/mixed.json";
    process.env[CHECK_METRICS_FILE_ENV] = "/outer/upper.json";

    const installLog = path.join(root, "install-env.log");
    const checkLog = path.join(root, "check-env.log");
    const helper = path.join(root, "emit-metrics.cjs");
    fs.writeFileSync(
      helper,
      [
        'const fs = require("node:fs");',
        `const matching = Object.keys(process.env).filter((k) => k.toUpperCase() === ${JSON.stringify(CHECK_METRICS_FILE_ENV)});`,
        `if (process.argv[2] === "install") { fs.appendFileSync(${JSON.stringify(installLog)}, JSON.stringify(matching) + "\\n"); process.exit(0); }`,
        `const metricsPath = process.env[${JSON.stringify(CHECK_METRICS_FILE_ENV)}] ?? "";`,
        `fs.appendFileSync(${JSON.stringify(checkLog)}, JSON.stringify({ matching, metricsPath }) + "\\n");`,
        'if (metricsPath && process.argv[3] !== "NONE") {',
        '  fs.writeFileSync(metricsPath, Buffer.from(process.argv[3], "base64").toString("utf8"));',
        '  fs.writeFileSync(metricsPath + ".999.tmp", "partial");',
        "}",
        "process.exit(Number(process.argv[4] ?? 0));",
      ].join("\n"),
    );
    const installCommand = `"${process.execPath}" "${helper}" install`;
    const runCase = (payload, exitCode, onCheckMetrics) => {
      const encoded = payload === "NONE" ? "NONE" : Buffer.from(payload, "utf8").toString("base64");
      return runCheck(dir, null, "HEAD", undefined, undefined, {
        installCommand,
        checkCommand: `"${process.execPath}" "${helper}" check ${encoded} ${exitCode}`,
        stdio: "pipe",
        onCheckMetrics,
      });
    };

    const seen = [];
    const collect = (m) => seen.push(m);
    assert.equal(await runCase(JSON.stringify({ schema: 1, slotWaitMs: 1250 }), 0, collect), true);
    assert.equal(await runCase(JSON.stringify({ schema: 1, slotWaitMs: 750 }), 1, collect), false);
    for (const bad of ["not-json", "NONE", JSON.stringify({ schema: 1, slotWaitMs: 0 })]) {
      assert.equal(await runCase(bad, 0, collect), true);
    }
    assert.deepEqual(seen, [{ slotWaitMs: 1250 }, { slotWaitMs: 750 }]);
    // Throwing callback must never mask the check result; omitted callback creates no temp metrics file.
    assert.equal(
      await runCase(JSON.stringify({ schema: 1, slotWaitMs: 300 }), 0, () => {
        throw new Error("boom");
      }),
      true,
    );
    assert.equal(await runCase("NONE", 0, undefined), true);

    const readLines = (file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const installRecords = readLines(installLog);
    assert.equal(installRecords.length, 7);
    assert.ok(installRecords.every((keys) => keys.length === 0));

    const checkRecords = readLines(checkLog);
    assert.equal(checkRecords.length, 7);
    const tmpBase = fs.realpathSync(os.tmpdir());
    for (const { matching, metricsPath } of checkRecords.slice(0, 6)) {
      assert.deepEqual(matching, [CHECK_METRICS_FILE_ENV]);
      assert.equal(path.basename(metricsPath), "metrics.json");
      const metricsDir = path.dirname(metricsPath);
      assert.ok(path.basename(metricsDir).startsWith("t3-check-metrics-"));
      assert.equal(fs.realpathSync(path.dirname(metricsDir)), tmpBase);
      assert.equal(fs.existsSync(metricsDir), false, `expected ${metricsDir} to be removed`);
    }
    assert.deepEqual(checkRecords[6], { matching: [], metricsPath: "" });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === CHECK_METRICS_FILE_ENV) delete process.env[key];
    }
    for (const [key, value] of prior) {
      if (value !== undefined) process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
