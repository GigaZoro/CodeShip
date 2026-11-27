const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TURN_MAX_MS,
  land,
  testing: {
    KEPT_CHECKOUTS,
    acquireCheckoutSlot,
    checkoutsFolder,
    isSqliteBusy,
    landingCheckout,
    machineBudgetSlots,
    resolveWarmLimit,
    runCheck,
    withPrivateCheckout,
  },
} = require("./landing-turn.cjs");
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

test("pre-turn checkouts wait in FIFO order without overflowing, while a turn holder takes bounded overflow", async () => {
  const { root, dir, second, listed, poolFolder } = fixture();
  try {
    const holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    let waiterBSlot = null;
    let waiterCSlot = null;
    const order = [];
    const bQueued = Promise.withResolvers();
    const bNext = Promise.withResolvers();
    const cQueued = Promise.withResolvers();
    const cFirstWake = Promise.withResolvers();
    const cSecondWait = Promise.withResolvers();
    const cSecondWake = Promise.withResolvers();

    let bWaits = 0;
    const waiterB = acquireCheckoutSlot({
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
    const waiterC = acquireCheckoutSlot({
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
        assert.equal(path.basename(extra), "1");
      },
    );
    assert.equal(fs.existsSync(extra), false);
    assert.equal(fs.existsSync(`${extra}.lock`), false);
    assert.equal(listed().includes(path.resolve(extra)), false);

    // Release warm slot 0, then wake C BEFORE B: C must stay behind B in FIFO order!
    holder.release();
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
    cSecondWake.resolve();
    await waiterC;
    assert.equal(waiterCSlot.index, 0);
    assert.equal(waiterCSlot.waited, true);
    assert.deepEqual(order, ["B", "C"]);
    waiterCSlot.release();

    // No overflow directories or leftover locks remain in the pool folder.
    const names = fs.readdirSync(poolFolder()).filter((name) => /^\d+(?:\.lock)?$/.test(name));
    assert.deepEqual(names, ["0.lock"]);
  } finally {
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
    const bWake = Promise.withResolvers();
    const waiterB = acquireCheckoutSlot({
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

    const slotB = await waiterB;
    try {
      assert.equal(slotB.index, 0);
      assert.equal(slotB.waited, true);
    } finally {
      slotB.release();
    }
  } finally {
    holder.release();
    deadWaiter.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting for a precheck slot records localSlotWait separately and rebases onto fresh main before checking", async () => {
  const { root, origin, git, clone, commit, dir } = fixture();
  try {
    git(dir, "push", "-q", "origin", "HEAD:main");
    commit(dir, "mine.txt");
    const mover = clone("mover");

    const holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting for a precheck slot releases cleanly if HEAD moves or uncommitted edits appear while waiting", async () => {
  const { root, origin, git, commit, dir } = fixture();
  try {
    git(dir, "push", "-q", "origin", "HEAD:main");
    commit(dir, "mine.txt");

    // Case 1: uncommitted edit appears while waiting.
    let holder = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    const dirtyResult = await land({
      cwd: dir,
      remote: origin,
      warmLimit: 1,
      waitSlot: async () => {
        fs.writeFileSync(path.join(dir, "stray.txt"), "dirty\n");
        holder.release();
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
      },
      check: () => assert.fail("should not check moved HEAD"),
    });
    assert.equal(movedResult.status, "head-moved");

    const verifyFree = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
    verifyFree.release();
  } finally {
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
  "dirty-slot recovery stops a lingering process group left in the slot dirty marker",
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
      // Seed warm slot 0, then plant a dirty marker naming the lingering detached process group.
      await withPrivateCheckout({ cwd: dir, commit: second, warmLimit: 1 }, () => {});
      fs.writeFileSync(
        path.join(poolFolder(), "0.dirty"),
        JSON.stringify({ pid: stray.pid, pgid: stray.pid }),
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
            assert.ok(fs.existsSync(own));
            assert.equal(running(innerPid), true);
          } finally {
            stopped.kill("SIGTERM");
            const exit = await exited;
            assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
          }

          assert.equal(running(innerPid), false);
          assert.equal(fs.existsSync(own), false);
          assert.equal(fs.existsSync(`${own}.lock`), false);
          assert.equal(listed().includes(path.resolve(own)), false);
        },
        1,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a killed extra checkout is skipped by under-turn runs and swept (with its lock) by the next pre-turn landing", async () => {
  const { root, dir, second, listed } = fixture();
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
        assert.ok(fs.existsSync(killed));
      },
      1,
    );

    // An under-turn checkout skips sweepCheckouts so it never stalls on sweep work under the main lease.
    await withPrivateCheckout(
      { cwd: dir, commit: second, role: "underTurn", warmLimit: 1 },
      () => {},
    );
    assert.ok(fs.existsSync(killed));

    // The next pre-turn landing sweeps the abandoned extra checkout directory and its lock file.
    await withPrivateCheckout(
      { cwd: dir, commit: second, role: "preWait", warmLimit: 1 },
      () => {},
    );
    assert.equal(fs.existsSync(killed), false);
    assert.equal(fs.existsSync(`${killed}.lock`), false);
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

test("extended SQLITE_BUSY codes, machine budget sizing, and landingCheckout path validation", () => {
  // Primary and extended SQLite busy codes (5, SQLITE_BUSY_RECOVERY=261, SNAPSHOT=517, TIMEOUT=773).
  for (const errcode of [5, 261, 517, 773]) {
    assert.equal(isSqliteBusy({ errcode }), true, `errcode ${errcode} should be busy`);
  }
  for (const error of [{ errcode: 1 }, { errcode: 14 }, { errcode: "5" }, {}, null, undefined]) {
    assert.equal(isSqliteBusy(error), false);
  }

  // Machine budget sizing matches check-changed.ts defaultConcurrency(cores, totalMemBytes).
  const GiB = 1024 ** 3;
  assert.equal(machineBudgetSlots(2, 8 * GiB), 1);
  assert.equal(machineBudgetSlots(10, 12 * GiB), 2);
  assert.equal(machineBudgetSlots(10, 10 * GiB), 1);
  assert.equal(machineBudgetSlots(16, 64 * GiB), 8);
  assert.equal(resolveWarmLimit(1), 1);
  assert.equal(resolveWarmLimit(3), 3);

  // Tightened landingCheckout validation requires 16-hex clone folder and numeric slot basename.
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/0"), true);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/12"), true);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/not-hex-folder!!/0"), false);
  assert.equal(landingCheckout("/cache/t3-landing-checkouts/0123456789abcdef/feature"), false);
  assert.equal(landingCheckout(`/tmp/t3-landing-${randomUUID()}`), true);
  assert.equal(landingCheckout("/home/user/worktrees/my-branch"), false);
});
