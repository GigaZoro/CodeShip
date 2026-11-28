const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  REMOTE_DIR_ENV,
  REMOTE_DIR_GIT_CONFIG,
  REMOTE_HOST_ENV,
  REMOTE_HOST_GIT_CONFIG,
  STAGING_REF_PREFIX,
  landRemote,
  main,
  testing: {
    RemoteConfigError,
    buildRemoteLandCommand,
    buildRemoteProbeCommand,
    isSelfRemoteTarget,
    resolveRemoteConfig,
  },
} = require("./landing-turn.cjs");
const { setup } = require("./landing-turn.testkit.cjs");

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

test("AB#7790: isSelfRemoteTarget matches local hostname, short name, user@host, IPv6 brackets, and loopback without matching other hosts", () => {
  // Exact, case-insensitive, trailing-dot, user@host, and FQDN short-name matches.
  assert.equal(isSelfRemoteTarget("build-box", "build-box"), true);
  assert.equal(isSelfRemoteTarget("BUILD-BOX.", "build-box"), true);
  assert.equal(isSelfRemoteTarget("zoro@build-box", "build-box.tailnet.ts.net"), true);
  assert.equal(
    isSelfRemoteTarget("zoro@BUILD-BOX.tailnet.ts.net.", "build-box.tailnet.ts.net"),
    true,
  );
  assert.equal(isSelfRemoteTarget("ops@proxy@build-box", "build-box"), true);
  assert.equal(isSelfRemoteTarget("mac-studio", "Mac-Studio.local"), true);

  // Explicit loopback targets always match self.
  assert.equal(isSelfRemoteTarget("localhost", "other-host"), true);
  assert.equal(isSelfRemoteTarget("LOCALHOST.", "other-host"), true);
  assert.equal(isSelfRemoteTarget("zoro@localhost", "other-host"), true);
  assert.equal(isSelfRemoteTarget("127.0.0.1", "other-host"), true);
  assert.equal(isSelfRemoteTarget("[::1]", "other-host"), true);
  assert.equal(isSelfRemoteTarget("root@[::1]", "other-host"), true);
  assert.equal(isSelfRemoteTarget("::1", "other-host"), true);

  // IPv4/IPv6 local hostnames match exact address but never shorten on the first dot.
  assert.equal(isSelfRemoteTarget("10.20.30.40", "10.20.30.40"), true);
  assert.equal(isSelfRemoteTarget("10", "10.20.30.40"), false);
  assert.equal(isSelfRemoteTarget("[fe80::1]", "fe80::1"), true);

  // Distinct remote hosts and malformed/empty inputs do not match self.
  assert.equal(isSelfRemoteTarget("box-a", "build-box"), false);
  assert.equal(isSelfRemoteTarget("fake-host", "build-box.tailnet.ts.net"), false);
  assert.equal(isSelfRemoteTarget("build-box-2", "build-box"), false);
  assert.equal(isSelfRemoteTarget("build-box.example.com", "build-box"), false);
  assert.equal(isSelfRemoteTarget("zoro@", "build-box"), false);
  assert.equal(isSelfRemoteTarget("", "build-box"), false);
  assert.equal(isSelfRemoteTarget("build-box", ""), false);
});

test(
  "AB#7790: remote probe auto-discovers ~/Projects/CodeShip on case-sensitive paths",
  POSIX_ONLY,
  async () => {
    const { root, origin, git } = setup();
    try {
      const remoteHome = path.join(root, "remote-home");
      const remoteCheckout = path.join(remoteHome, "Projects", "CodeShip");
      fs.mkdirSync(path.dirname(remoteCheckout), { recursive: true });
      git(root, "clone", "-q", origin, remoteCheckout);
      fs.mkdirSync(path.join(remoteCheckout, ".github", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(remoteCheckout, ".github", "scripts", "landing-turn.cjs"), "");

      const probe = await runShell(buildRemoteProbeCommand(undefined, origin), {
        ...process.env,
        HOME: remoteHome,
      });
      assert.equal(probe.code, 0, probe.stderr);
      const parsed = JSON.parse(probe.stdout.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.dir, remoteCheckout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("AB#7790: self-host targets skip SSH and land locally; mixed lists probe only non-self hosts", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("self-skip");
    commit(local, "first.txt");
    const firstTip = git(local, "rev-parse", "HEAD");
    git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, "zoro@this-machine");

    const logs = [];
    const stderrLines = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));
    t.mock.method(process.stderr, "write", (chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });

    // Single self target from git config skips SSH completely and lands locally.
    let probeCalls = 0;
    let localChecks = 0;
    const singleSelfCode = await main(["land"], {
      cwd: local,
      env: {},
      localHostname: "this-machine.tailnet.ts.net",
      probeHost: async () => {
        probeCalls += 1;
        return { host: "unexpected", ok: false, reason: "must not probe self" };
      },
      check: () => ((localChecks += 1), true),
    });
    assert.equal(singleSelfCode, 0);
    assert.equal(probeCalls, 0);
    assert.equal(localChecks, 1);
    assert.equal(git(origin, "rev-parse", "main"), firstTip);
    assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    assert.ok(
      stderrLines
        .join("")
        .includes(
          "landing turn: remote host matches this machine (zoro@this-machine); landing locally.",
        ),
    );
    const records = recordsOf(local);
    assert.equal(records.length, 1);
    assert.equal("remote" in records[0], false);

    // Mixed [self, other] skips self and probes only other.
    commit(local, "second.txt");
    const probedHosts = [];
    const mixedCode = await main(["land", "--remote", "this-machine,other-box,localhost"], {
      cwd: local,
      env: {},
      localHostname: "this-machine.tailnet.ts.net",
      probeHost: async ({ host }) => {
        probedHosts.push(host);
        return { host, ok: true, dir: "/srv/CodeShip", load1: 0.2, cpus: 8 };
      },
      runRemote: async () => ({ code: 1, result: { status: "check-failed" } }),
      check: () => assert.fail("local check must not run when non-self remote host is selected"),
    });
    assert.equal(mixedCode, 1);
    assert.deepEqual(probedHosts, ["other-box"]);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "check-failed", remote: "other-box" });

    // Validation still runs before self-host filtering so invalid targets never slip through.
    await assert.rejects(
      () =>
        landRemote({
          cwd: local,
          hosts: ["localhost", "-oProxyCommand=evil"],
          localHostname: "this-machine",
        }),
      RemoteConfigError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7790: t3.landingRemoteHost and t3.landingRemoteDir follow exact precedence and security validation", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const local = clone("git-config");
    commit(local, "cfg.txt");
    const tip = git(local, "rev-parse", "HEAD");

    // t3.landingRemoteDir alone does not enable remote mode.
    git(local, "config", "--local", REMOTE_DIR_GIT_CONFIG, "~/Projects/CodeShip");
    assert.equal(resolveRemoteConfig({ cwd: local, env: {} }), null);

    // Git config alone provides host + dir defaults.
    git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, "git-box-a, git-box-b");
    assert.deepEqual(resolveRemoteConfig({ cwd: local, env: {} }), {
      hosts: ["git-box-a", "git-box-b"],
      remoteDir: "~/Projects/CodeShip",
    });

    // Env beats git config.
    assert.deepEqual(
      resolveRemoteConfig({
        cwd: local,
        env: { [REMOTE_HOST_ENV]: "env-box", [REMOTE_DIR_ENV]: "/env/CodeShip" },
      }),
      { hosts: ["env-box"], remoteDir: "/env/CodeShip" },
    );

    // CLI --remote / --remote-dir beat env and git config; --remote without --remote-dir inherits dir default.
    assert.deepEqual(
      resolveRemoteConfig({
        cwd: local,
        env: { [REMOTE_HOST_ENV]: "env-box", [REMOTE_DIR_ENV]: "/env/CodeShip" },
        remoteSpec: "cli-box",
        remoteDir: "/cli/CodeShip",
      }),
      { hosts: ["cli-box"], remoteDir: "/cli/CodeShip" },
    );
    assert.deepEqual(
      resolveRemoteConfig({
        cwd: local,
        env: {},
        remoteSpec: "cli-box",
      }),
      { hosts: ["cli-box"], remoteDir: "~/Projects/CodeShip" },
    );

    // main() routes via git config when neither CLI nor env is set.
    const logs = [];
    const errors = [];
    t.mock.method(console, "log", (line) => logs.push(String(line)));
    t.mock.method(console, "error", (line) => errors.push(String(line)));

    const probed = [];
    const gitCfgCode = await main(["land"], {
      cwd: local,
      env: {},
      localHostname: "different-machine",
      probeHost: async ({ host, remoteDir }) => {
        probed.push({ host, remoteDir });
        return { host, ok: true, dir: remoteDir, load1: host === "git-box-a" ? 4 : 0.1, cpus: 4 };
      },
      runRemote: async () => ({ code: 1, result: { status: "check-failed" } }),
    });
    assert.equal(gitCfgCode, 1);
    assert.deepEqual(probed, [
      { host: "git-box-a", remoteDir: "~/Projects/CodeShip" },
      { host: "git-box-b", remoteDir: "~/Projects/CodeShip" },
    ]);
    assert.deepEqual(JSON.parse(logs.at(-1)), { status: "check-failed", remote: "git-box-b" });

    // Security validation rejects unsafe git config host/dir with exit 2 and zero SSH/local calls.
    let probeCalls = 0;
    let localChecks = 0;
    const guardOpts = {
      cwd: local,
      env: {},
      localHostname: "different-machine",
      probeHost: async () => ((probeCalls += 1), { host: "x", ok: false }),
      check: () => ((localChecks += 1), true),
    };
    for (const badHost of ["-oProxyCommand=evil", "host;rm -rf /", "host$(id)"]) {
      git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, badHost);
      assert.equal(await main(["land"], guardOpts), 2, badHost);
    }
    git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, "safe-box");
    git(local, "config", "--local", REMOTE_DIR_GIT_CONFIG, "/tmp/bad\ndir");
    assert.equal(await main(["land"], guardOpts), 2);
    assert.equal(probeCalls, 0);
    assert.equal(localChecks, 0);
    assert.ok(errors.some((line) => line.includes("invalid remote host")));
    assert.ok(errors.some((line) => line.includes("control characters")));

    // --local beats git config (even invalid git config) and env, landing locally.
    git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, "-oProxyCommand=ignored");
    const localCode = await main(["land", "--local"], {
      cwd: local,
      env: { [REMOTE_HOST_ENV]: "-oProxyCommand=also-ignored" },
      localHostname: "different-machine",
      probeHost: async () => ((probeCalls += 1), { host: "x", ok: false }),
      check: () => ((localChecks += 1), true),
    });
    assert.equal(localCode, 0);
    assert.equal(probeCalls, 0);
    assert.equal(localChecks, 1);
    assert.equal(git(origin, "rev-parse", "main"), tip);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "AB#7790: remote SSH land passes --local to prevent recursion even when remote checkout has t3.landingRemoteHost set",
  POSIX_ONLY,
  async (t) => {
    const { root, origin, git, clone, commit } = setup();
    try {
      const tipSeed = clone("seed-cmd");
      const sampleTip = git(tipSeed, "rev-parse", "HEAD");
      const cmdWithoutFinalize = buildRemoteLandCommand({
        remoteDir: "/srv/CodeShip",
        stagingRef: `${STAGING_REF_PREFIX}abc1`,
        tip: sampleTip,
        runId: "abc1",
      });
      const cmdWithFinalize = buildRemoteLandCommand({
        remoteDir: "/srv/CodeShip",
        stagingRef: `${STAGING_REF_PREFIX}abc2`,
        tip: sampleTip,
        runId: "abc2",
        finalizeCommand: "echo done",
      });
      assert.ok(cmdWithoutFinalize.includes("set -- land --local"));
      assert.ok(cmdWithFinalize.includes('set -- land --local --finalize "$FINALIZE_CMD"'));

      // Seed real landing-turn.cjs + helper scripts into origin/main with a fast passing check:changed stub.
      const bootstrap = clone("bootstrap");
      const scriptsDir = path.join(bootstrap, ".github", "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const scriptFile of [
        "bounded-git.cjs",
        "git-history.cjs",
        "landing-record.cjs",
        "landing-turn.cjs",
        "lease-queue.cjs",
        "process-tree.cjs",
        "release-notes.cjs",
      ]) {
        fs.copyFileSync(path.join(__dirname, scriptFile), path.join(scriptsDir, scriptFile));
      }
      fs.writeFileSync(
        path.join(bootstrap, "package.json"),
        JSON.stringify({ name: "remote-defaults-fixture", version: "0.0.0" }, null, 2),
      );
      git(bootstrap, "add", ".");
      git(bootstrap, "commit", "-qm", "seed landing scripts");
      git(bootstrap, "push", "-q", "origin", "HEAD:main");

      // Place the remote checkout at ~/Projects/CodeShip (no --remote-dir) and configure an invalid
      // t3.landingRemoteHost on the remote repo itself to prove --local stops remote recursion.
      const remoteHome = path.join(root, "remote-home");
      const remoteTmp = path.join(root, "remote-tmp");
      const remoteCheckout = path.join(remoteHome, "Projects", "CodeShip");
      fs.mkdirSync(path.dirname(remoteCheckout), { recursive: true });
      fs.mkdirSync(remoteTmp, { recursive: true });
      git(root, "clone", "-q", origin, remoteCheckout);
      git(
        remoteCheckout,
        "config",
        "--local",
        REMOTE_HOST_GIT_CONFIG,
        "-oProxyCommand=must-not-recurse",
      );

      // Fake `vp` on PATH so the remote checkout's check:changed passes instantly.
      const fakeBin = path.join(root, "fake-bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      const fakeVp = path.join(fakeBin, "vp");
      fs.writeFileSync(fakeVp, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(fakeVp, 0o755);

      const local = clone("local-caller");
      git(local, "switch", "-q", "-c", "cs/remote-defaults-e2e");
      commit(local, "feature.txt");
      git(local, "config", "--local", REMOTE_HOST_GIT_CONFIG, "sim-vps");

      const remoteEnv = {
        ...process.env,
        HOME: remoteHome,
        TMPDIR: remoteTmp,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        [REMOTE_HOST_ENV]: "must-not-recurse",
        [REMOTE_DIR_ENV]: "/must-not-be-used",
      };

      const logs = [];
      t.mock.method(console, "log", (line) => logs.push(String(line)));

      const exitCode = await main(["land"], {
        cwd: local,
        env: {},
        localHostname: "local-macbook",
        execSsh: async ({ host, remoteCommand }) => {
          assert.equal(host, "sim-vps");
          return runShell(remoteCommand, remoteEnv);
        },
      });

      assert.equal(exitCode, 0);
      const output = JSON.parse(logs.at(-1));
      assert.equal(output.status, "landed");
      assert.equal(output.remote, "sim-vps");
      assert.equal(git(origin, "rev-parse", "main"), output.commit);
      assert.equal(git(local, "rev-parse", "HEAD"), output.commit);
      assert.equal(git(origin, "for-each-ref", STAGING_REF_PREFIX), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
