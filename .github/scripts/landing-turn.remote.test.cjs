const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  REMOTE_DIR_ENV,
  REMOTE_HOST_ENV,
  STAGING_REF_PREFIX,
  land,
  landRemote,
  main,
  testing: {
    RemoteConfigError,
    buildRemoteLandCommand,
    buildRemoteProbeCommand,
    buildSshArgs,
    normalizeOriginUrl,
    normalizedLoad,
    parseLandArgs,
    parseLandingResultLine,
    parseRemoteHosts,
    probeRemoteHost,
    selectRemoteHost,
    shellQuote,
    syncLocalAfterRemoteLand,
    validateRemoteDir,
    validateRemoteHost,
  },
} = require("./landing-turn.cjs");
const { running, setup } = require("./landing-turn.testkit.cjs");

// oxlint-disable-next-line t3code/no-global-process-runtime -- plain CommonJS node:test script
const POSIX_ONLY = { skip: process.platform === "win32" };

function recordsOf(lander) {
  const file = path.join(lander, ".git", "t3-landing", "landings.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runShell(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stopped: false,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

test("AB#7668: CLI flag parsing, input validation, SSH option safety, and quoting", async (t) => {
  assert.deepEqual(parseLandArgs("land", []), {
    rebased: undefined,
    finalizeCommand: undefined,
    remoteSpec: undefined,
    remoteDir: undefined,
    local: false,
  });
  assert.deepEqual(
    parseLandArgs("land", [
      "--finalize",
      "echo ok",
      "--remote",
      "box-a,box-b",
      "--remote-dir",
      "/srv/CodeShip",
    ]),
    {
      rebased: undefined,
      finalizeCommand: "echo ok",
      remoteSpec: "box-a,box-b",
      remoteDir: "/srv/CodeShip",
      local: false,
    },
  );
  assert.deepEqual(parseLandArgs("land", ["--local", "--finalize", "echo ok"]), {
    rebased: undefined,
    finalizeCommand: "echo ok",
    remoteSpec: undefined,
    remoteDir: undefined,
    local: true,
  });

  // Reject conflicting, duplicate, missing, blank, or unknown flags.
  for (const bad of [
    ["--local", "--remote", "linux-box"],
    ["--remote", "linux-box", "--local"],
    ["--remote"],
    ["--remote", "   "],
    ["--remote", "a", "--remote", "b"],
    ["--remote-dir"],
    ["--remote-dir", ""],
    ["--remote-dir", "/a", "--remote-dir", "/b"],
    ["--local", "--local"],
    ["--finalize", "a", "--finalize", "b"],
    ["--unknown"],
    ["--remote", "box", "extra"],
  ]) {
    assert.equal(parseLandArgs("land", bad), null, JSON.stringify(bad));
  }

  // Valid SSH host tokens and deduplication preserving order.
  assert.deepEqual(parseRemoteHosts("linux-box, zoro@100.64.0.1, [::1], fe80::1%eth0, linux-box"), [
    "linux-box",
    "zoro@100.64.0.1",
    "[::1]",
    "fe80::1%eth0",
  ]);
  assert.equal(validateRemoteHost("my_host+1.example.com"), "my_host+1.example.com");
  assert.equal(validateRemoteDir("/srv/CodeShip"), "/srv/CodeShip");

  // Reject SSH option injection, shell metacharacters, empty list segments, and control characters.
  for (const badHost of [
    "",
    "   ",
    "-oProxyCommand=evil",
    "-v",
    "host;rm -rf /",
    "host$(id)",
    "host`id`",
    "host name",
    "host'quote",
    'host"quote',
    "host\nline",
    "host\0nul",
  ]) {
    assert.throws(() => validateRemoteHost(badHost), RemoteConfigError, JSON.stringify(badHost));
  }
  for (const badList of ["", "host1,", ",host1", "host1,,host2", "ok,-oProxyCommand=evil"]) {
    assert.throws(() => parseRemoteHosts(badList), RemoteConfigError, JSON.stringify(badList));
  }
  for (const badDir of ["", "   ", "/tmp/a\0b", "/tmp/a\nb", "/tmp/a\x1fb"]) {
    assert.throws(() => validateRemoteDir(badDir), RemoteConfigError, JSON.stringify(badDir));
  }

  // Strict single-quoting and `--` separator before host in ssh argv.
  assert.equal(shellQuote("it's $HOME; rm -rf /"), "'it'\\''s $HOME; rm -rf /'");
  assert.throws(() => shellQuote("bad\0arg"), RemoteConfigError);
  const sshArgs = buildSshArgs("zoro@linux-box", "echo hi");
  const separatorIndex = sshArgs.indexOf("--");
  assert.ok(separatorIndex > 0);
  assert.equal(sshArgs[separatorIndex + 1], "zoro@linux-box");
  assert.equal(sshArgs[separatorIndex + 2], "echo hi");
  assert.ok(sshArgs.includes("BatchMode=yes"));

  // Origin URL normalization treats HTTPS and SSH URLs for the same repo as equal.
  assert.equal(
    normalizeOriginUrl("https://github.com/GigaZoro/CodeShip.git"),
    normalizeOriginUrl("git@github.com:GigaZoro/CodeShip"),
  );
  assert.equal(
    normalizeOriginUrl("ssh://git@github.com/GigaZoro/CodeShip.git/"),
    normalizeOriginUrl("https://github.com/gigazoro/codeship"),
  );

  // CLI rejects unsafe hosts and conflicting flags with exit 2 and zero SSH calls or local fallback.
  const { root, clone, commit } = setup();
  try {
    const dir = clone("invalid-cli");
    commit(dir, "a.txt");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(String(line)));
    let sshCalls = 0;
    let localChecks = 0;
    const opts = {
      cwd: dir,
      check: () => ((localChecks += 1), true),
      probeHost: async () => ((sshCalls += 1), { host: "x", ok: false, reason: "should not run" }),
    };

    assert.equal(await main(["land", "--remote", "-oProxyCommand=evil"], opts), 2);
    assert.equal(await main(["land", "--remote", "host;rm -rf /"], opts), 2);
    assert.equal(await main(["land", "--local", "--remote", "linux-box"], opts), 2);
    assert.equal(
      await main(["land"], { ...opts, env: { [REMOTE_HOST_ENV]: "-oProxyCommand=evil" } }),
      2,
    );
    assert.equal(
      await main(["land", "--remote", "linux-box", "--remote-dir", "/tmp/bad\ndir"], opts),
      2,
    );
    assert.equal(sshCalls, 0);
    assert.equal(localChecks, 0);
    assert.ok(errors.some((line) => line.includes("invalid remote host")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: reachable remote host lands rebased commit, cleans staging ref, leaves remote main checkout untouched, syncs clean local branch, and logs privacy-safe record", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("local");
    const remoteHost = clone("remote-host");
    const mover = clone("mover");

    git(local, "switch", "-q", "-c", "cs/remote-feature");
    commit(local, "feature.txt");
    const localTip = git(local, "rev-parse", "HEAD");

    // Advance origin/main so remote landing must rebase.
    commit(mover, "moved-main.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const movedMain = git(origin, "rev-parse", "main");

    // Put dirty uncommitted edits in remoteHost's main checkout to prove remote landing never touches it.
    const dirtyFile = path.join(remoteHost, "remote-wip.txt");
    fs.writeFileSync(dirtyFile, "untouched dirty work\n");
    const remoteHeadBefore = git(remoteHost, "rev-parse", "HEAD");

    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));

    let observedStagingRef = null;
    let stagingExistedDuringRun = false;
    let forwardedFinalize = null;

    const exitCode = await main(
      ["land", "--remote", "linux-box", "--remote-dir", remoteHost, "--finalize", "echo ok"],
      {
        cwd: local,
        check: () => assert.fail("local check must not run when remote host succeeds"),
        probeHost: async ({ host, remoteDir }) => ({
          host,
          ok: true,
          dir: remoteDir,
          load1: 0.4,
          cpus: 8,
        }),
        runRemote: async ({ dir, stagingRef, tip, runId, finalizeCommand }) => {
          observedStagingRef = stagingRef;
          forwardedFinalize = finalizeCommand;
          assert.equal(tip, localTip);
          assert.ok(stagingRef.startsWith(STAGING_REF_PREFIX));
          assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
          stagingExistedDuringRun = git(origin, "rev-parse", stagingRef) === localTip;

          // Simulate the remote temp worktree executing real land() against bare origin.
          const tmpRef = `refs/tmp/remote-land-${runId}`;
          const tmpBranch = `remote-land-${runId}`;
          const tmpWt = path.join(root, `remote-wt-${runId}`);
          try {
            git(
              dir,
              "fetch",
              "-q",
              "--no-tags",
              "--no-write-fetch-head",
              "origin",
              `+${stagingRef}:${tmpRef}`,
            );
            assert.equal(git(dir, "rev-parse", tmpRef), tip);
            git(dir, "worktree", "add", "-q", "-B", tmpBranch, tmpWt, tip);

            let res = await land({ cwd: tmpWt, remote: "origin", check: () => true });
            if (res.status === "rebased") {
              res = await land({
                cwd: tmpWt,
                remote: "origin",
                rebased: { base: res.base, head: res.head },
                check: () => true,
              });
            }
            return { code: res.status === "landed" ? 0 : 1, result: res };
          } finally {
            git(dir, "worktree", "remove", "--force", tmpWt);
            git(dir, "branch", "-D", tmpBranch);
            git(dir, "update-ref", "-d", tmpRef);
          }
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stagingExistedDuringRun, true);
    assert.equal(forwardedFinalize, "echo ok");

    const output = JSON.parse(logs.at(-1));
    assert.equal(output.status, "landed");
    assert.equal(output.remote, "linux-box");
    assert.notEqual(output.commit, localTip);
    assert.equal(git(origin, "rev-parse", "main"), output.commit);
    assert.equal(git(origin, "rev-parse", `${output.commit}^`), movedMain);

    // Staging ref and lease ref are both cleaned up on origin.
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    assert.ok(observedStagingRef);

    // Remote host's main checkout and dirty file were never touched.
    assert.equal(git(remoteHost, "rev-parse", "HEAD"), remoteHeadBefore);
    assert.equal(fs.readFileSync(dirtyFile, "utf8"), "untouched dirty work\n");

    // Clean local branch was synced to the remotely landed commit.
    assert.equal(git(local, "branch", "--show-current"), "cs/remote-feature");
    assert.equal(git(local, "rev-parse", "HEAD"), output.commit);
    assert.equal(git(local, "status", "--porcelain"), "");

    // Local landings.jsonl records remote: true with no host name or path.
    const records = recordsOf(local);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.status, "landed");
    assert.equal(record.stage, "remote");
    assert.equal(record.remote, true);
    assert.equal(record.branch, "cs/remote-feature");
    assert.equal(record.head, output.commit);
    assert.equal(record.releaseConfirmed, true);
    assert.deepEqual(Object.keys(record.phases), ["remoteProbe", "stagingPush", "remoteLand"]);
    const rawLine = JSON.stringify(record);
    assert.equal(rawLine.includes("linux-box"), false);
    assert.equal(rawLine.includes(remoteHost), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: post-land local sync leaves local worktree untouched if edited while remote landing ran", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("local-edited");
    const remoteHost = clone("remote-host");
    const mover = clone("mover");

    commit(local, "mine.txt");
    const originalTip = git(local, "rev-parse", "HEAD");
    commit(mover, "other.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");

    const stderrLines = [];
    t.mock.method(process.stderr, "write", (chunk) => stderrLines.push(String(chunk)) > 0);
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));

    const exitCode = await main(["land", "--remote", "linux-box"], {
      cwd: local,
      probeHost: async ({ host }) => ({ host, ok: true, dir: remoteHost, load1: 0.1, cpus: 4 }),
      runRemote: async ({ dir, stagingRef, tip, runId }) => {
        // Edit local worktree while remote landing is in flight.
        fs.writeFileSync(path.join(local, "in-flight-edit.txt"), "keep me\n");

        const tmpRef = `refs/tmp/remote-land-${runId}`;
        const tmpBranch = `remote-land-${runId}`;
        const tmpWt = path.join(root, `remote-wt-${runId}`);
        try {
          git(dir, "fetch", "-q", "--no-tags", "origin", `+${stagingRef}:${tmpRef}`);
          git(dir, "worktree", "add", "-q", "-B", tmpBranch, tmpWt, tip);
          let res = await land({ cwd: tmpWt, remote: "origin", check: () => true });
          if (res.status === "rebased") {
            res = await land({
              cwd: tmpWt,
              remote: "origin",
              rebased: { base: res.base, head: res.head },
              check: () => true,
            });
          }
          return { code: 0, result: res };
        } finally {
          git(dir, "worktree", "remove", "--force", tmpWt);
          git(dir, "branch", "-D", tmpBranch);
          git(dir, "update-ref", "-d", tmpRef);
        }
      },
    });

    assert.equal(exitCode, 0);
    const output = JSON.parse(logs.at(-1));
    assert.equal(output.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), output.commit);
    // Local HEAD and local edit were NOT touched.
    assert.equal(git(local, "rev-parse", "HEAD"), originalTip);
    assert.equal(fs.readFileSync(path.join(local, "in-flight-edit.txt"), "utf8"), "keep me\n");
    assert.ok(stderrLines.join("").includes("left local worktree untouched"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: unreachable remote host falls back cleanly to local landing with no staging ref left behind", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("local-fallback");
    commit(local, "fallback.txt");
    const tip = git(local, "rev-parse", "HEAD");
    const finalizeFile = path.join(root, "local-finalize-ran");
    const finalizeCmd = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1],'ok')" ${JSON.stringify(finalizeFile)}`;

    const stderrLines = [];
    t.mock.method(process.stderr, "write", (chunk) => stderrLines.push(String(chunk)) > 0);
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));

    let localChecked = false;
    const exitCode = await main(["land", "--remote", "dead-box", "--finalize", finalizeCmd], {
      cwd: local,
      execSsh: async () => ({
        code: 255,
        signal: null,
        stopped: false,
        stdout: "",
        stderr: "ssh: connect to host dead-box port 22: Connection refused\n",
      }),
      check: () => ((localChecked = true), true),
    });

    assert.equal(exitCode, 0);
    assert.equal(localChecked, true);
    assert.equal(fs.readFileSync(finalizeFile, "utf8"), "ok");
    assert.equal(git(origin, "rev-parse", "main"), tip);
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "landed", commit: tip });
    assert.ok(
      stderrLines.join("").includes("remote landing unavailable") &&
        stderrLines.join("").includes("falling back to local landing"),
    );

    // Exactly one local record (no duplicate record from the failed probe).
    const records = recordsOf(local);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "landed");
    assert.equal("remote" in records[0], false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: multi-host load-aware selection skips unreachable hosts, prefers lower load1/cpus, and preserves order on ties", async () => {
  assert.equal(normalizedLoad({ load1: 2, cpus: 8 }), 0.25);
  assert.equal(normalizedLoad({ load1: null, cpus: 8 }), Number.POSITIVE_INFINITY);
  assert.equal(normalizedLoad({ load1: 1, cpus: null }), Number.POSITIVE_INFINITY);

  // Busy, idle, down -> picks idle.
  const probed = [];
  const selection = await selectRemoteHost({
    hosts: ["host-busy", "host-idle", "host-down"],
    remoteDir: undefined,
    expectedOriginUrl: "",
    probeHost: async ({ host }) => {
      probed.push(host);
      if (host === "host-busy") return { host, ok: true, dir: "/srv/busy", load1: 6.0, cpus: 4 };
      if (host === "host-idle") return { host, ok: true, dir: "/srv/idle", load1: 0.5, cpus: 4 };
      return { host, ok: false, reason: "Connection refused" };
    },
  });
  assert.deepEqual(probed, ["host-busy", "host-idle", "host-down"]);
  assert.equal(selection.selected.host, "host-idle");
  assert.equal(selection.selected.dir, "/srv/idle");

  // Unknown load loses to known load; ties preserve original list order.
  const unknownVsKnown = await selectRemoteHost({
    hosts: ["host-unknown", "host-known"],
    remoteDir: undefined,
    expectedOriginUrl: "",
    probeHost: async ({ host }) =>
      host === "host-unknown"
        ? { host, ok: true, dir: "/a", load1: null, cpus: 4 }
        : { host, ok: true, dir: "/b", load1: 8.0, cpus: 4 },
  });
  assert.equal(unknownVsKnown.selected.host, "host-known");

  const tie = await selectRemoteHost({
    hosts: ["host-first", "host-second"],
    remoteDir: undefined,
    expectedOriginUrl: "",
    probeHost: async ({ host }) =>
      host === "host-first"
        ? { host, ok: true, dir: "/a", load1: 1.0, cpus: 4 }
        : { host, ok: true, dir: "/b", load1: 2.0, cpus: 8 },
  });
  assert.equal(tie.selected.host, "host-first");

  // A rejecting host probe does not fail the whole batch; healthy hosts are still chosen.
  const withRejection = await selectRemoteHost({
    hosts: ["host-throws", "host-ok"],
    remoteDir: undefined,
    expectedOriginUrl: "",
    probeHost: async ({ host }) => {
      if (host === "host-throws") throw new Error("unexpected probe error");
      return { host, ok: true, dir: "/srv/ok", load1: 0.2, cpus: 4 };
    },
  });
  assert.equal(withRejection.selected.host, "host-ok");
  assert.equal(withRejection.probes[0].ok, false);
  assert.ok(withRejection.probes[0].reason.includes("unexpected probe error"));

  // All unreachable -> returns null with combined reason.
  const allDown = await selectRemoteHost({
    hosts: ["down-a", "down-b"],
    remoteDir: undefined,
    expectedOriginUrl: "",
    probeHost: async ({ host }) => ({ host, ok: false, reason: `${host} timed out` }),
  });
  assert.equal(allDown.selected, null);
  assert.ok(allDown.reason.includes("down-a"));
  assert.ok(allDown.reason.includes("down-b"));
});

test("AB#7668: remote check-failed, conflict, remote error, and mid-run SSH disconnect never fall back to local landing and always clean up staging ref", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("no-fallback");
    commit(local, "work.txt");
    const mainBefore = git(origin, "rev-parse", "main");

    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));
    const stderrLines = [];
    t.mock.method(process.stderr, "write", (chunk) => stderrLines.push(String(chunk)) > 0);

    let localChecks = 0;
    const baseOpts = {
      cwd: local,
      check: () => ((localChecks += 1), true),
      probeHost: async ({ host }) => ({
        host,
        ok: true,
        dir: "/srv/CodeShip",
        load1: 0.2,
        cpus: 8,
      }),
    };

    // 1. Remote check-failed.
    const checkFailedCode = await main(["land", "--remote", "linux-box"], {
      ...baseOpts,
      runRemote: async () => ({
        code: 1,
        stdout: `${JSON.stringify({ status: "check-failed" })}\n`,
      }),
    });
    assert.equal(checkFailedCode, 1);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "check-failed", remote: "linux-box" });
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");

    // 2. Remote conflict.
    const conflictCode = await main(["land", "--remote", "linux-box"], {
      ...baseOpts,
      runRemote: async () => ({ code: 1, stdout: `${JSON.stringify({ status: "conflict" })}\n` }),
    });
    assert.equal(conflictCode, 1);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "conflict", remote: "linux-box" });
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");

    // 3. Mid-run SSH disconnect (exit 255, no JSON result line).
    const disconnectCode = await main(["land", "--remote", "linux-box"], {
      ...baseOpts,
      runRemote: async () => ({ code: 255, stdout: "Checking packages...\n" }),
    });
    assert.equal(disconnectCode, 1);
    assert.deepEqual(JSON.parse(logs.at(-1)), {
      status: "remote-disconnected",
      remote: "linux-box",
      exitCode: 255,
    });
    assert.ok(stderrLines.join("").includes("disconnected after remote landing started"));
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");

    // 4. Remote exit 1 without JSON (e.g. uncaught rebase error on remote).
    const remoteErrCode = await main(["land", "--remote", "linux-box"], {
      ...baseOpts,
      runRemote: async () => ({ code: 1, stdout: "" }),
    });
    assert.equal(remoteErrCode, 1);
    assert.deepEqual(JSON.parse(logs.at(-1)), {
      status: "remote-failed",
      remote: "linux-box",
      exitCode: 1,
    });
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");

    // Local landing was NEVER invoked in any of the 4 cases, and main never moved.
    assert.equal(localChecks, 0);
    assert.equal(git(origin, "rev-parse", "main"), mainBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: dirty local worktree and marked files fail immediately before SSH probe or staging push", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("dirty-local");
    commit(local, "clean.txt");

    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));

    let probes = 0;
    let remoteRuns = 0;
    const opts = {
      cwd: local,
      probeHost: async ({ host }) => ((probes += 1), { host, ok: true, dir: "/srv/CodeShip" }),
      runRemote: async () => ((remoteRuns += 1), { code: 0, result: { status: "landed" } }),
    };

    // Uncommitted file.
    fs.writeFileSync(path.join(local, "dirty.txt"), "uncommitted\n");
    assert.equal(await main(["land", "--remote", "linux-box"], opts), 1);
    assert.equal(JSON.parse(logs.at(-1)).status, "uncommitted");
    assert.equal(probes, 0);
    assert.equal(remoteRuns, 0);
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    fs.rmSync(path.join(local, "dirty.txt"));

    // Marked file (--assume-unchanged).
    git(local, "update-index", "--assume-unchanged", "base.txt");
    const markedResult = await landRemote({
      cwd: local,
      remote: "origin",
      hosts: "linux-box",
      probeHost: opts.probeHost,
      runRemote: opts.runRemote,
    });
    assert.equal(markedResult.status, "marked-files");
    assert.equal(probes, 0);
    assert.equal(remoteRuns, 0);
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: T3_LANDING_REMOTE_HOST/DIR env defaults, --local override, and infinite-recursion guard", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("env-defaults");
    commit(local, "env.txt");
    const tip = git(local, "rev-parse", "HEAD");
    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));

    // Env defaults route land to remote host + dir.
    let probedHost = null;
    let probedDir = null;
    const envCode = await main(["land"], {
      cwd: local,
      env: { [REMOTE_HOST_ENV]: "vps-box", [REMOTE_DIR_ENV]: "/opt/CodeShip" },
      probeHost: async ({ host, remoteDir }) => {
        probedHost = host;
        probedDir = remoteDir;
        return { host, ok: true, dir: remoteDir, load1: 0.1, cpus: 4 };
      },
      runRemote: async () => ({ code: 1, result: { status: "check-failed" } }),
    });
    assert.equal(envCode, 1);
    assert.equal(probedHost, "vps-box");
    assert.equal(probedDir, "/opt/CodeShip");

    // --local overrides T3_LANDING_REMOTE_HOST (even an invalid one) and runs locally.
    let sshCalled = false;
    const localCode = await main(["land", "--local"], {
      cwd: local,
      env: { [REMOTE_HOST_ENV]: "-oProxyCommand=ignored-when-local" },
      probeHost: async () => ((sshCalled = true), { host: "x", ok: false }),
      check: () => true,
    });
    assert.equal(localCode, 0);
    assert.equal(sshCalled, false);
    assert.equal(git(origin, "rev-parse", "main"), tip);

    // Remote command is single-line `sh -c`, clears remote env vars, and safely passes finalizeCommand.
    const cmd = buildRemoteLandCommand({
      remoteDir: "/opt/CodeShip",
      stagingRef: `${STAGING_REF_PREFIX}1234`,
      tip,
      runId: "1234",
      finalizeCommand: "echo 'safe $VAR'",
    });
    assert.ok(cmd.startsWith("exec sh -c "));
    assert.equal(cmd.includes("\n"), false);
    assert.ok(cmd.includes("unset T3_LANDING_REMOTE_HOST T3_LANDING_REMOTE_DIR"));
    assert.ok(cmd.includes("exec node .github/scripts/landing-turn.cjs"));
    assert.ok(cmd.includes("CHILD_PID=$!"));
    assert.ok(cmd.includes(shellQuote("echo 'safe $VAR'")));

    // buildRemoteLandCommand rejects missing/empty remoteDir and malformed stagingRef values.
    for (const badDir of [undefined, null, "", "   "]) {
      assert.throws(
        () =>
          buildRemoteLandCommand({
            remoteDir: badDir,
            stagingRef: `${STAGING_REF_PREFIX}1234`,
            tip,
            runId: "1234",
          }),
        RemoteConfigError,
        JSON.stringify(badDir),
      );
    }
    for (const badRef of [
      "refs/heads/main",
      STAGING_REF_PREFIX,
      `${STAGING_REF_PREFIX}has space`,
      `${STAGING_REF_PREFIX}has\nnewline`,
      `${STAGING_REF_PREFIX}has\0nul`,
    ]) {
      assert.throws(
        () =>
          buildRemoteLandCommand({
            remoteDir: "/opt/CodeShip",
            stagingRef: badRef,
            tip,
            runId: "1234",
          }),
        /invalid staging ref/,
        JSON.stringify(badRef),
      );
    }

    // parseLandingResultLine enforces the exact terminal status allowlist, boolean releaseConfirmed, and SHA validation for landed.
    assert.equal(
      parseLandingResultLine(JSON.stringify({ status: "landed", commit: tip }))?.status,
      "landed",
    );
    assert.equal(
      parseLandingResultLine(
        JSON.stringify({ status: "landed", commit: tip, releaseConfirmed: true }),
      )?.releaseConfirmed,
      true,
    );
    assert.equal(
      parseLandingResultLine(
        JSON.stringify({ status: "landed", commit: tip, releaseConfirmed: false }),
      )?.releaseConfirmed,
      false,
    );
    assert.equal(
      parseLandingResultLine(
        JSON.stringify({ status: "landed", commit: tip, releaseConfirmed: "yes" }),
      ),
      null,
    );
    assert.equal(
      parseLandingResultLine(
        JSON.stringify({ status: "landed", commit: tip, releaseConfirmed: 1 }),
      ),
      null,
    );
    assert.equal(
      parseLandingResultLine(
        JSON.stringify({ status: "landed", commit: tip, releaseConfirmed: null }),
      ),
      null,
    );
    assert.equal(parseLandingResultLine('{"status":"landed","commit":"abc"}'), null);
    assert.equal(parseLandingResultLine('{"status":"landed"}'), null);
    assert.equal(parseLandingResultLine('{"status":"remote-unavailable"}'), null);
    assert.equal(parseLandingResultLine('{"status":"bogus-status"}'), null);
    assert.equal(parseLandingResultLine("not json"), null);

    // Probe helper handles banner output, invalid dir, timeout, and spawn error cleanly.
    const bannerProbe = await probeRemoteHost({
      host: "box",
      execSsh: async () => ({
        code: 0,
        stopped: false,
        stdout: 'Welcome to Ubuntu\n{"ok":true,"dir":"/srv/CodeShip","load1":0.5,"cpus":4}\n',
        stderr: "",
      }),
    });
    assert.deepEqual(bannerProbe, {
      host: "box",
      ok: true,
      dir: "/srv/CodeShip",
      load1: 0.5,
      cpus: 4,
    });
    const badDirProbe = await probeRemoteHost({
      host: "box",
      execSsh: async () => ({
        code: 0,
        stopped: false,
        stdout: `${JSON.stringify({ ok: true, dir: "/srv/bad\ndir", load1: 0.1, cpus: 4 })}\n`,
        stderr: "",
      }),
    });
    assert.equal(badDirProbe.ok, false);
    assert.ok(badDirProbe.reason.includes("control characters"));
    const timedOutProbe = await probeRemoteHost({
      host: "box",
      execSsh: async () => ({ code: null, stopped: true, stdout: "", stderr: "" }),
    });
    assert.deepEqual(timedOutProbe, { host: "box", ok: false, reason: "probe timed out" });
    const spawnErrProbe = await probeRemoteHost({
      host: "box",
      execSsh: async () => {
        throw new Error("spawn ssh ENOENT");
      },
    });
    assert.deepEqual(spawnErrProbe, { host: "box", ok: false, reason: "spawn ssh ENOENT" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "AB#7668: end-to-end POSIX execution of real remote probe and land shell scripts",
  POSIX_ONLY,
  async (t) => {
    const { root, origin, git, clone, commit } = setup();
    try {
      // Seed origin with the real landing scripts so the remote temp worktree runs them.
      const seed = clone("seed-scripts");
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
      git(seed, "add", ".");
      git(seed, "commit", "-qm", "add landing scripts");
      git(seed, "push", "-q", "origin", "HEAD:main");

      // Prepare fake remote host HOME with auto-discovered ~/CodeShip checkout and ~/.config/vite-plus/env.
      const remoteHome = path.join(root, "remote-home");
      const remoteCheckout = path.join(remoteHome, "CodeShip");
      const remoteBin = path.join(root, "remote-bin");
      const remoteTmp = path.join(root, "remote-tmp");
      fs.mkdirSync(path.join(remoteHome, ".config", "vite-plus"), { recursive: true });
      fs.mkdirSync(remoteBin, { recursive: true });
      fs.mkdirSync(remoteTmp, { recursive: true });
      git(root, "clone", "-q", origin, remoteCheckout);

      // Stub `vp` ONLY reachable via ~/.config/vite-plus/env to prove the remote script sources it.
      const vpStub = path.join(remoteBin, "vp");
      fs.writeFileSync(vpStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const nodeDir = path.dirname(process.execPath);
      fs.writeFileSync(
        path.join(remoteHome, ".config", "vite-plus", "env"),
        `export PATH=${shellQuote(`${remoteBin}:${nodeDir}`)}:"$PATH"\n`,
      );

      // Dirty the remote host's main checkout to prove remote landing leaves it untouched.
      const remoteDirty = path.join(remoteCheckout, "keep-dirty.txt");
      fs.writeFileSync(remoteDirty, "remote uncommitted\n");
      const remoteHeadBefore = git(remoteCheckout, "rev-parse", "HEAD");

      // Create local branch and advance origin/main so remote landing rebases + relaunches land-rebased.
      const local = clone("local-caller");
      git(local, "switch", "-q", "-c", "cs/e2e-remote");
      commit(local, "e2e-feature.txt");
      const mover = clone("mover-e2e");
      commit(mover, "moved-e2e.txt");
      git(mover, "push", "-q", "origin", "HEAD:main");

      const finalizeMarker = path.join(root, "finalize-marker.txt");
      const finalizeCommand = `${shellQuote(process.execPath)} -e ${shellQuote(
        `require("node:fs").writeFileSync(${JSON.stringify(finalizeMarker)}, "it's ok:" + process.env.T3_LANDING_FINAL_COMMIT)`,
      )}`;

      const remoteEnv = {
        ...process.env,
        HOME: remoteHome,
        TMPDIR: remoteTmp,
        // Set on remote to verify buildRemoteLandCommand unsets it and never recurses!
        [REMOTE_HOST_ENV]: "should-never-recurse",
        [REMOTE_DIR_ENV]: "/should-never-be-used",
      };

      const logs = [];
      t.mock.method(console, "log", (line) => logs.push(String(line)));

      const exitCode = await main(
        ["land", "--remote", "sim-linux", "--finalize", finalizeCommand],
        {
          cwd: local,
          execSsh: async ({ host, remoteCommand }) => {
            assert.equal(host, "sim-linux");
            return runShell(remoteCommand, remoteEnv);
          },
        },
      );

      assert.equal(exitCode, 0);
      const output = JSON.parse(logs.at(-1));
      assert.equal(output.status, "landed");
      assert.equal(output.remote, "sim-linux");
      assert.equal(git(origin, "rev-parse", "main"), output.commit);
      assert.equal(git(local, "rev-parse", "HEAD"), output.commit);
      assert.equal(fs.readFileSync(finalizeMarker, "utf8"), `it's ok:${output.commit}`);

      // Origin has no leftover staging or lease refs.
      assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

      // Remote host's main checkout is untouched, with no leftover temp worktrees, branches, or refs.
      assert.equal(git(remoteCheckout, "rev-parse", "HEAD"), remoteHeadBefore);
      assert.equal(fs.readFileSync(remoteDirty, "utf8"), "remote uncommitted\n");
      assert.equal(git(remoteCheckout, "branch", "--list", "remote-land-*"), "");
      assert.equal(git(remoteCheckout, "for-each-ref", "refs/tmp/remote-land-"), "");
      const worktreeCount = git(remoteCheckout, "worktree", "list", "--porcelain")
        .split("\n")
        .filter(
          (line) => line.startsWith("worktree ") && !line.includes("t3-landing-checkouts"),
        ).length;
      assert.equal(worktreeCount, 1);

      // Direct probe command verification: mismatched origin is rejected.
      const probeOther = await runShell(
        buildRemoteProbeCommand(remoteCheckout, "https://github.com/other/repo.git"),
        remoteEnv,
      );
      assert.equal(probeOther.code, 0);
      assert.equal(JSON.parse(probeOther.stdout.trim()).ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("AB#7668: probe command strips embedded Git credentials and matches SSH remote origin", async (t) => {
  const secretUrl = "https://user:ghp_secret123@github.com/org/repo.git";
  const normalized = normalizeOriginUrl(secretUrl);
  assert.equal(normalized, "github.com/org/repo");
  // Idempotent on already-normalized remote origin strings.
  assert.equal(normalizeOriginUrl(normalized), "github.com/org/repo");

  // RFC 3986 schemes: git+https/git+ssh strip credentials; unsupported/malformed schemes fail closed without leaking secrets.
  assert.equal(
    normalizeOriginUrl("git+https://user:ghp_secret@github.com/org/repo.git"),
    "github.com/org/repo",
  );
  assert.equal(normalizeOriginUrl("git+ssh://git@github.com/org/repo.git/"), "github.com/org/repo");
  assert.equal(normalizeOriginUrl("ftp://user:ghp_secret@example.com/repo.git"), "");
  assert.equal(normalizeOriginUrl("ftps://user:ghp_secret@example.com/repo.git"), "");
  assert.equal(normalizeOriginUrl("custom+scheme://user:ghp_secret@example.com/repo.git"), "");
  assert.equal(normalizeOriginUrl("https://user:ghp_secret@bad host/org/repo.git"), "");

  // buildRemoteProbeCommand fails closed on malformed or unsupported expectedOriginUrl without leaking secrets.
  for (const badOrigin of [
    "https://user:ghp_secret@bad host/org/repo.git",
    "ftp://user:ghp_secret@example.com/repo.git",
  ]) {
    assert.throws(
      () => buildRemoteProbeCommand("/srv/CodeShip", badOrigin),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid expected origin URL/i);
        assert.equal(error.message.includes("ghp_secret"), false);
        assert.equal(error.message.includes("user:"), false);
        return true;
      },
      badOrigin,
    );
  }

  const probeCmd = buildRemoteProbeCommand("/srv/CodeShip", secretUrl);
  assert.ok(probeCmd.startsWith("exec sh -c "));
  assert.equal(probeCmd.includes("\n"), false);
  assert.equal(probeCmd.includes("ghp_secret123"), false);
  assert.equal(probeCmd.includes("user:"), false);
  assert.ok(probeCmd.includes("'github.com/org/repo'"));

  // landRemote normalizes origin URL locally before passing it to probeHost and fails closed on malformed/missing origin.
  const { root, git, clone, commit } = setup();
  try {
    const local = clone("cred-local");
    commit(local, "a.txt");
    git(local, "remote", "set-url", "origin", secretUrl);
    let seenExpectedOrigin = null;
    const res = await landRemote({
      cwd: local,
      remote: "origin",
      hosts: "linux-box",
      probeHost: async ({ host, expectedOriginUrl }) => {
        seenExpectedOrigin = expectedOriginUrl;
        return { host, ok: false, reason: "probe-only" };
      },
    });
    assert.equal(res.status, "remote-unavailable");
    assert.equal(seenExpectedOrigin, "github.com/org/repo");

    // Malformed credentialed local origin must fail closed before probing any remote host and never leak the secret.
    const stderrLines = [];
    t.mock.method(process.stderr, "write", (chunk) => stderrLines.push(String(chunk)) > 0);
    git(local, "remote", "set-url", "origin", "https://user:ghp_secret@bad host/org/repo.git");
    let probes = 0;
    let remoteRuns = 0;
    const badOriginRes = await landRemote({
      cwd: local,
      remote: "origin",
      hosts: "linux-box",
      probeHost: async ({ host }) => ((probes += 1), { host, ok: true, dir: "/srv/mismatched" }),
      runRemote: async () => ((remoteRuns += 1), { code: 0, result: { status: "landed" } }),
    });
    assert.deepEqual(badOriginRes, {
      status: "remote-unavailable",
      reason: "could not normalize local origin URL",
    });
    assert.equal(probes, 0);
    assert.equal(remoteRuns, 0);
    assert.equal(stderrLines.join("").includes("ghp_secret"), false);
    assert.equal(badOriginRes.reason.includes("ghp_secret"), false);
    assert.equal(recordsOf(local).length, 0);

    // Missing local origin remote also fails closed before probing any remote host.
    git(local, "remote", "remove", "origin");
    const missingOriginRes = await landRemote({
      cwd: local,
      remote: "origin",
      hosts: "linux-box",
      probeHost: async ({ host }) => ((probes += 1), { host, ok: true, dir: "/srv/mismatched" }),
      runRemote: async () => ((remoteRuns += 1), { code: 0, result: { status: "landed" } }),
    });
    assert.deepEqual(missingOriginRes, {
      status: "remote-unavailable",
      reason: "missing local origin remote",
    });
    assert.equal(probes, 0);
    assert.equal(remoteRuns, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "AB#7668: POSIX probe command built from credentialed HTTPS URL matches remote git@github.com origin",
  POSIX_ONLY,
  async () => {
    const { root, git, clone } = setup();
    try {
      const remoteCheckout = clone("remote-ssh-origin");
      const scriptsDir = path.join(remoteCheckout, ".github", "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, "landing-turn.cjs"), "// stub\n");
      git(remoteCheckout, "remote", "set-url", "origin", "git@github.com:org/repo.git");

      const probeCmd = buildRemoteProbeCommand(
        remoteCheckout,
        "https://user:ghp_secret123@github.com/org/repo.git",
      );
      assert.equal(probeCmd.includes("ghp_secret123"), false);

      const probeEnv = {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      };
      const probe = await runShell(probeCmd, probeEnv);
      assert.equal(probe.code, 0, probe.stderr);
      const parsed = JSON.parse(probe.stdout.trim());
      assert.equal(parsed.ok, true);
      assert.equal(fs.realpathSync(parsed.dir), fs.realpathSync(remoteCheckout));

      const mismatch = await runShell(
        buildRemoteProbeCommand(
          remoteCheckout,
          "https://user:ghp_secret123@github.com/other/repo.git",
        ),
        probeEnv,
      );
      assert.equal(mismatch.code, 0, mismatch.stderr);
      const mismatchParsed = JSON.parse(mismatch.stdout.trim());
      assert.equal(mismatchParsed.ok, false);
      assert.equal(mismatchParsed.reason, "origin remote mismatch");

      // Remote checkout with git+https credentialed origin matches normalized https origin.
      git(
        remoteCheckout,
        "remote",
        "set-url",
        "origin",
        "git+https://user:ghp_secret@github.com/org/repo.git",
      );
      const gitPlusProbe = await runShell(
        buildRemoteProbeCommand(remoteCheckout, "https://github.com/org/repo.git"),
        probeEnv,
      );
      assert.equal(gitPlusProbe.code, 0, gitPlusProbe.stderr);
      assert.equal(JSON.parse(gitPlusProbe.stdout.trim()).ok, true);

      // Remote checkout with unsupported ftp:// scheme fails closed as origin remote mismatch.
      git(
        remoteCheckout,
        "remote",
        "set-url",
        "origin",
        "ftp://user:ghp_secret@example.com/repo.git",
      );
      const ftpProbe = await runShell(
        buildRemoteProbeCommand(remoteCheckout, "https://github.com/org/repo.git"),
        probeEnv,
      );
      assert.equal(ftpProbe.code, 0, ftpProbe.stderr);
      const ftpParsed = JSON.parse(ftpProbe.stdout.trim());
      assert.equal(ftpParsed.ok, false);
      assert.equal(ftpParsed.reason, "origin remote mismatch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("AB#7668: syncLocalAfterRemoteLand fails closed on broken index and untracked files, preserves FETCH_HEAD, and uses reset --keep when clean", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("sync-local");
    const mover = clone("sync-mover");

    git(local, "switch", "-q", "-c", "cs/sync-test");
    commit(local, "mine.txt");
    const tip = git(local, "rev-parse", "HEAD");

    commit(mover, "remote-landed.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const landedCommit = git(origin, "rev-parse", "main");
    assert.notEqual(landedCommit, tip);

    const stderrLines = [];
    t.mock.method(process.stderr, "write", (chunk) => stderrLines.push(String(chunk)) > 0);

    // 1. Corrupt .git/index so `git status` fails: must NOT fail open or reset HEAD.
    const indexPath = path.join(local, ".git", "index");
    const originalIndex = fs.readFileSync(indexPath);
    fs.writeFileSync(indexPath, "not-a-valid-git-index");
    await syncLocalAfterRemoteLand({
      cwd: local,
      remote: "origin",
      branch: "main",
      tip,
      topic: "cs/sync-test",
      landedCommit,
    });
    assert.equal(git(local, "rev-parse", "HEAD"), tip);
    assert.equal(git(local, "for-each-ref", "refs/worktree/landing-turn/"), "");
    fs.writeFileSync(indexPath, originalIndex);

    // 2. Untracked file with status.showUntrackedFiles=no: must still detect it and refuse reset.
    git(local, "config", "status.showUntrackedFiles", "no");
    const untrackedFile = path.join(local, "hidden-untracked.txt");
    fs.writeFileSync(untrackedFile, "keep me\n");
    await syncLocalAfterRemoteLand({
      cwd: local,
      remote: "origin",
      branch: "main",
      tip,
      topic: "cs/sync-test",
      landedCommit,
    });
    assert.equal(git(local, "rev-parse", "HEAD"), tip);
    assert.equal(fs.readFileSync(untrackedFile, "utf8"), "keep me\n");
    assert.equal(git(local, "for-each-ref", "refs/worktree/landing-turn/"), "");
    fs.rmSync(untrackedFile);
    git(local, "config", "--unset", "status.showUntrackedFiles");

    // 3. Clean worktree: syncs via `reset --keep`, does NOT overwrite FETCH_HEAD, cleans sync ref.
    const fetchHeadPath = path.join(local, ".git", "FETCH_HEAD");
    fs.writeFileSync(fetchHeadPath, "sentinel-fetch-head\n");
    await syncLocalAfterRemoteLand({
      cwd: local,
      remote: "origin",
      branch: "main",
      tip,
      topic: "cs/sync-test",
      landedCommit,
    });
    assert.equal(git(local, "rev-parse", "HEAD"), landedCommit);
    assert.equal(git(local, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(fetchHeadPath, "utf8"), "sentinel-fetch-head\n");
    assert.equal(git(local, "for-each-ref", "refs/worktree/landing-turn/"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7668: fail-closed remote stdout parsing rejects missing commit, SSH exit 255, remote-unavailable, and bogus statuses", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("fail-closed");
    commit(local, "work.txt");
    const tip = git(local, "rev-parse", "HEAD");
    const mainBefore = git(origin, "rev-parse", "main");

    const logs = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));
    t.mock.method(process.stderr, "write", () => true);

    let localChecks = 0;
    const baseOpts = {
      cwd: local,
      check: () => ((localChecks += 1), true),
      probeHost: async ({ host }) => ({
        host,
        ok: true,
        dir: "/srv/CodeShip",
        load1: 0.1,
        cpus: 4,
      }),
    };

    // 1. Streamed stdout ending with {"status":"landed"} (missing commit) fails closed.
    assert.equal(
      await main(["land", "--remote", "linux-box"], {
        ...baseOpts,
        runRemote: async () => ({
          code: 0,
          stdout: 'running checks...\n{"status":"landed"}\n',
        }),
      }),
      1,
    );
    assert.equal(JSON.parse(logs.at(-1)).status, "remote-failed");

    // 2. Streamed stdout ending with valid landed SHA but SSH exit 255 fails closed.
    assert.equal(
      await main(["land", "--remote", "linux-box"], {
        ...baseOpts,
        runRemote: async () => ({
          code: 255,
          stdout: `${JSON.stringify({ status: "landed", commit: tip })}\n`,
        }),
      }),
      1,
    );
    assert.equal(JSON.parse(logs.at(-1)).status, "remote-disconnected");

    // 3. Streamed stdout ending with valid landed SHA (releaseConfirmed !== false) but exit 1 fails closed.
    assert.equal(
      await main(["land", "--remote", "linux-box"], {
        ...baseOpts,
        runRemote: async () => ({
          code: 1,
          stdout: `${JSON.stringify({ status: "landed", commit: tip })}\n`,
        }),
      }),
      1,
    );
    assert.equal(JSON.parse(logs.at(-1)).status, "remote-failed");

    // 4. Streamed stdout ending with {"status":"remote-unavailable"} fails closed and never falls back.
    assert.equal(
      await main(["land", "--remote", "linux-box"], {
        ...baseOpts,
        runRemote: async () => ({
          code: 0,
          stdout: '{"status":"remote-unavailable"}\n',
        }),
      }),
      1,
    );
    assert.equal(JSON.parse(logs.at(-1)).status, "remote-failed");

    // 5. Streamed stdout ending with {"status":"bogus-status"} fails closed and never lands in landings.jsonl.
    assert.equal(
      await main(["land", "--remote", "linux-box"], {
        ...baseOpts,
        runRemote: async () => ({
          code: 0,
          stdout: '{"status":"bogus-status"}\n',
        }),
      }),
      1,
    );
    assert.equal(JSON.parse(logs.at(-1)).status, "remote-failed");

    // Local fallback never ran, main never moved, staging refs are clean, and landings.jsonl has no bogus status.
    assert.equal(localChecks, 0);
    assert.equal(git(origin, "rev-parse", "main"), mainBefore);
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    const records = recordsOf(local);
    assert.equal(records.length, 5);
    assert.equal(
      records.some((record) => record.status === "bogus-status"),
      false,
    );
    assert.equal(
      records.some((record) => record.status === "remote-unavailable"),
      false,
    );
    assert.equal(
      records.some((record) => record.status === "landed"),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "AB#7668: POSIX SIGTERM during landRemote stops SSH child and deletes staging ref; remote shell forwards SIGTERM to background child",
  POSIX_ONLY,
  async () => {
    const { root, origin, git, clone, commit } = setup();
    try {
      // Part 1: Local SIGTERM during landRemote stops SSH child and deletes refs/heads/landing-staging/<id>.
      const local = clone("sigterm-local");
      commit(local, "work.txt");
      const fakeBin = path.join(root, "fake-bin");
      const sshPidFile = path.join(root, "ssh-pids.txt");
      fs.mkdirSync(fakeBin, { recursive: true });
      const fakeSsh = path.join(fakeBin, "ssh");
      fs.writeFileSync(
        fakeSsh,
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *"exec node -e"*)',
          '    printf \'%s\\n\' \'{"ok":true,"dir":"/tmp/fake","load1":0.1,"cpus":4}\'',
          "    exit 0",
          "    ;;",
          "esac",
          '"$NODE_BIN" -e \'require("node:net").createServer().listen(0, "127.0.0.1")\' &',
          "WAIT_PID=$!",
          'printf "%s %s\\n" "$$" "$WAIT_PID" > "$SSH_PID_FILE"',
          'printf "SSH_LAND_READY\\n"',
          'wait "$WAIT_PID"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      let sawStagingRefBeforeSigterm = false;
      const localChild = spawn(
        process.execPath,
        [path.join(__dirname, "landing-turn.cjs"), "land", "--remote", "fake-box"],
        {
          cwd: local,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            SSH_PID_FILE: sshPidFile,
            NODE_BIN: process.execPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderrBuf = "";
      let sentSigterm = false;
      const localExit = await new Promise((resolve, reject) => {
        localChild.on("error", reject);
        localChild.stderr.on("data", (chunk) => {
          stderrBuf += chunk.toString("utf8");
          if (!sentSigterm && stderrBuf.includes("SSH_LAND_READY")) {
            sentSigterm = true;
            sawStagingRefBeforeSigterm = git(origin, "for-each-ref", STAGING_REF_PREFIX).length > 0;
            localChild.kill("SIGTERM");
          }
        });
        localChild.on("close", (code, signal) => resolve({ code, signal }));
      });

      assert.equal(sentSigterm, true);
      assert.equal(sawStagingRefBeforeSigterm, true);
      assert.equal(localExit.signal, "SIGTERM");
      const [sshPid, waitPid] = fs.readFileSync(sshPidFile, "utf8").trim().split(/\s+/).map(Number);
      assert.ok(Number.isInteger(sshPid) && sshPid > 0);
      assert.ok(Number.isInteger(waitPid) && waitPid > 0);
      assert.equal(running(sshPid), false);
      assert.equal(running(waitPid), false);
      assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");

      // Part 2: Remote buildRemoteLandCommand forwards SIGTERM to background node child and cleans up temp worktree.
      const remoteSeed = clone("remote-sigterm-seed");
      const stubDir = path.join(remoteSeed, ".github", "scripts");
      fs.mkdirSync(stubDir, { recursive: true });
      fs.writeFileSync(
        path.join(stubDir, "landing-turn.cjs"),
        [
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          'process.on("SIGTERM", () => {',
          '  fs.writeFileSync(process.env.REMOTE_CHILD_STOPPED, "term");',
          "  process.exit(143);",
          "});",
          'const server = net.createServer().listen(0, "127.0.0.1", () => {',
          '  process.stdout.write("REMOTE_CHILD_READY\\n");',
          "});",
          "void server;",
          "",
        ].join("\n"),
      );
      git(remoteSeed, "add", ".");
      git(remoteSeed, "commit", "-qm", "add remote sigterm stub");
      const stubTip = git(remoteSeed, "rev-parse", "HEAD");
      const stagingRef = `${STAGING_REF_PREFIX}sigterm-remote`;
      git(remoteSeed, "push", "-q", "origin", `${stubTip}:${stagingRef}`);

      const remoteCheckout = clone("remote-sigterm-checkout");
      const remoteTmp = path.join(root, "remote-sigterm-tmp");
      fs.mkdirSync(remoteTmp, { recursive: true });
      const remoteChildStopped = path.join(root, "remote-child-stopped");

      const remoteCmd = buildRemoteLandCommand({
        remoteDir: remoteCheckout,
        stagingRef,
        tip: stubTip,
        runId: "sigterm-remote",
      });
      const remoteChild = spawn("sh", ["-c", remoteCmd], {
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: remoteTmp,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          REMOTE_CHILD_STOPPED: remoteChildStopped,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let remoteStdout = "";
      let sentRemoteTerm = false;
      const remoteExit = await new Promise((resolve, reject) => {
        remoteChild.on("error", reject);
        remoteChild.stdout.on("data", (chunk) => {
          remoteStdout += chunk.toString("utf8");
          if (!sentRemoteTerm && remoteStdout.includes("REMOTE_CHILD_READY")) {
            sentRemoteTerm = true;
            remoteChild.kill("SIGTERM");
          }
        });
        remoteChild.on("close", (code, signal) => resolve({ code, signal }));
      });

      assert.equal(sentRemoteTerm, true);
      assert.equal(remoteExit.code, 143);
      assert.equal(fs.readFileSync(remoteChildStopped, "utf8"), "term");
      assert.equal(git(remoteCheckout, "branch", "--list", "remote-land-*"), "");
      assert.equal(git(remoteCheckout, "for-each-ref", "refs/tmp/remote-land-"), "");
      assert.deepEqual(fs.readdirSync(remoteTmp), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
