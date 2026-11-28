const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  TURN_ENV,
  TURN_MAX_MS,
  land,
  testing: { runCheck },
  verifyPush,
  withTurn,
} = require("./landing-turn.cjs");
const { probeProcess } = require("../../packages/shared/src/processProbe.ts");
const { isWindowsHost } = require("../../packages/shared/src/testing/hostPlatform.ts");
const {
  LANDING_UPDATES,
  setup,
  signalServer,
  logTransactions,
  landingTransaction,
  stderrOf,
  running,
} = require("./landing-turn.testkit.cjs");

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

function killIfAlive(pid) {
  if (!(pid > 0) || probeProcess(pid).state !== "alive") return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

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
    killIfAlive(step);
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
      killIfAlive(worker);
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
      killIfAlive(worker);
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
      killIfAlive(worker);
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
      killIfAlive(worker);
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
      killIfAlive(worker);
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
        const lease = JSON.parse(git(origin, "show", "-s", "--format=%B", renewed).split("\n")[0]);
        assert.deepEqual([lease.turn, lease.renewed_at], [turn, new Date(wall).toISOString()]);
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

test("a lander gives up on a fetch of main that stops answering, and stops its transport", async () => {
  const { root, git, clone, commit } = setup();
  let stopFetch = () => {};
  const signals = await signalServer(root, (name) => name === "stalled" && stopFetch());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // A remote that never answers: git waits for the transport's first line. Once the transport writes its pid
    // and signals readiness, `after`'s callback stops the call immediately without waiting on wall-clock time.
    const pidFile = path.join(root, "transport.pid");
    fs.writeFileSync(
      path.join(root, "transport.cjs"),
      `const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
spawn(${JSON.stringify(signals.command("stalled"))}, { shell: true, stdio: "ignore" });
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
          after: (_ms, stop) => {
            stopFetch = stop;
            return () => {};
          },
          check: () => assert.fail("checked"),
        }),
      /git fetch failed: did not finish within 5 seconds/,
    );
    assert.equal(running(Number(fs.readFileSync(pidFile, "utf8"))), false, "transport still runs");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander runs a fetch of main again when a Mac's sleep used up its time limit", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopFetch = () => {};
  const signals = await signalServer(root, (name) => name === "slept" && stopFetch());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // The first connection never answers, as one the Mac slept under; later ones reach origin.
    const slept = path.join(root, "slept").replaceAll("\\", "/");
    const wrapper = path.join(root, "sleepy.sh").replaceAll("\\", "/");
    fs.writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `if test -e '${slept}'; then exec "$1" '${origin.replaceAll("\\", "/")}'; fi`,
        `touch '${slept}'`,
        `${signals.command("slept")}`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    git(lander, "config", "protocol.ext.allow", "always");
    git(lander, "remote", "add", "sleepy", `ext::sh ${wrapper.replaceAll(" ", "% ")} %S`);
    const result = await land({
      cwd: lander,
      remote: "sleepy",
      mainCallMs: 5000,
      after: (_ms, stop) => {
        stopFetch = stop;
        return () => {};
      },
      // No time awake passes, so every limit that runs out here ran out asleep.
      awakeClock: () => 0,
      check: () => true,
      report: () => {},
    });
    assert.equal(result.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), result.commit);
  } finally {
    await signals.close();
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
