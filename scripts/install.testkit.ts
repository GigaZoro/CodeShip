// @effect-diagnostics nodeBuiltinImport:off - Exercises the POSIX release installers using a local HTTP archive.
import * as NodeAssert from "node:assert/strict";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

export async function verifyBundledRuntimeRepair(
  remoteRunner?: (version: string, base: string) => string,
) {
  const { promisify } = await import("node:util");
  const exec = promisify(NodeChildProcess.execFile);
  const version = "1.2.3";
  const stem = `t3-${version}-${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`;
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-repair-"));
  const server = NodeHttp.createServer();
  try {
    const source = NodePath.join(temp, stem);
    const native = NodePath.join(source, "codex-metadata/bin");
    await NodeFSP.mkdir(native, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(native, "helper"), "valid");
    await NodeFSP.writeFile(NodePath.join(source, "codex-metadata.files"), "fixture");
    await NodeFSP.writeFile(
      NodePath.join(source, "t3"),
      [
        "#!/bin/sh",
        "dir=${0%/*}",
        'if [ "${T3CODE_VERIFY_INSTALL:-}" = 1 ]; then',
        '  [ -f "$dir/codex-metadata.files" ] && [ "$(cat "$dir/codex-metadata/bin/helper")" = valid ] || exit 78',
        "fi",
        'echo "t3 v1.2.3"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const archive = NodePath.join(temp, "release.tar.gz");
    await exec("tar", ["-czf", archive, "-C", temp, stem]);
    const bytes = await NodeFSP.readFile(archive);
    let downloads = 0;
    let offline = false;
    let offlineRequests = 0;
    server.on("request", (request, response) => {
      if (offline) {
        offlineRequests++;
        response.statusCode = 503;
        response.end();
        return;
      }
      if (request.url?.endsWith("/SHA256SUMS"))
        response.end(`${NodeCrypto.hash("sha256", bytes)}  ${stem}.tar.gz\n`);
      else if (request.url?.endsWith("/" + stem + ".tar.gz")) {
        downloads++;
        response.end(bytes);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const base = `http://127.0.0.1:${address.port}`;
    const home = NodePath.join(temp, "home");
    const root = NodePath.join(home, ".t3/runtime/versions", version);
    await NodeFSP.mkdir(NodePath.dirname(root), { recursive: true });
    await NodeFSP.cp(source, root, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, ".install-complete"), version);
    let script = NodePath.join(import.meta.dirname, "install.sh");
    if (remoteRunner) {
      script = NodePath.join(temp, "ssh-run.sh");
      await NodeFSP.writeFile(script, remoteRunner(version, base));
    }
    const run = (env: NodeJS.ProcessEnv = {}) =>
      exec("sh", [script, "--version"], {
        env: {
          ...process.env,
          HOME: home,
          T3CODE_HOME: NodePath.join(home, ".t3"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(home, "bin"),
          T3CODE_RELEASE_BASE_URL: base,
          T3CODE_VERSION: version,
          ...env,
        },
      });
    await run();
    NodeAssert.equal(downloads, 0);
    await NodeFSP.rm(NodePath.join(root, "codex-metadata"), { recursive: true });
    await NodeFSP.rm(NodePath.join(root, "codex-metadata.files"));
    await run();
    NodeAssert.equal(downloads, 1);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(root, "codex-metadata/bin/helper"), "utf8"),
      "valid",
    );
    await run();
    NodeAssert.equal(downloads, 1);
    const mvShim = NodePath.join(temp, "rename-fixture");
    await NodeFSP.mkdir(mvShim);
    await NodeFSP.writeFile(
      NodePath.join(mvShim, "mv"),
      [
        "#!/bin/sh",
        'if [ "$1" = "$T3_TEST_INSTALLED_ROOT" ]; then exit 41; fi',
        'command -p mv "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const marker = NodePath.join(root, ".install-complete");
    await NodeFSP.rm(marker);
    await exec("mkfifo", [marker]);
    // Reading a FIFO would block indefinitely; record the attempted read instead.
    await NodeFSP.writeFile(
      NodePath.join(mvShim, "cat"),
      [
        "#!/bin/sh",
        'if [ -p "$1" ]; then echo read > "$T3_TEST_FIFO_READ"; exit 1; fi',
        'exec /bin/cat "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const fifoRead = NodePath.join(temp, "opened-fifo");
    await run({
      PATH: mvShim + NodePath.delimiter + process.env.PATH,
      T3_TEST_FIFO_READ: fifoRead,
    });
    await NodeAssert.rejects(NodeFSP.stat(fifoRead), { code: "ENOENT" });
    NodeAssert.ok((await NodeFSP.stat(marker)).isFile());
    const helper = NodePath.join(root, "codex-metadata/bin/helper");
    await NodeFSP.writeFile(helper, "wrong");
    const originalEntries = await NodeFSP.readdir(root);
    await NodeAssert.rejects(
      run({ PATH: mvShim + NodePath.delimiter + process.env.PATH, T3_TEST_INSTALLED_ROOT: root }),
    );
    NodeAssert.deepEqual(await NodeFSP.readdir(root), originalEntries);
    NodeAssert.equal(await NodeFSP.readFile(helper, "utf8"), "wrong");
    await NodeFSP.writeFile(
      NodePath.join(mvShim, "mv"),
      [
        "#!/bin/sh",
        'command -p mv "$@" || exit $?',
        'if [ "$1" = "$T3_TEST_INSTALLED_ROOT" ]; then kill -TERM "$PPID"; fi',
      ].join("\n"),
      { mode: 0o755 },
    );
    await NodeAssert.rejects(
      run({ PATH: mvShim + NodePath.delimiter + process.env.PATH, T3_TEST_INSTALLED_ROOT: root }),
      { code: 143 },
    );
    NodeAssert.equal(await NodeFSP.readFile(helper, "utf8"), "wrong");
    await NodeFSP.writeFile(
      NodePath.join(mvShim, "mv"),
      [
        "#!/bin/sh",
        'command -p mv "$@" || exit $?',
        'if [ -f "$T3_TEST_INSTALLED_ROOT/.install-complete" ] && [ "$(cat "$T3_TEST_INSTALLED_ROOT/codex-metadata/bin/helper")" = valid ]; then kill -TERM "$PPID"; fi',
      ].join("\n"),
      { mode: 0o755 },
    );
    await NodeAssert.rejects(
      run({ PATH: mvShim + NodePath.delimiter + process.env.PATH, T3_TEST_INSTALLED_ROOT: root }),
      { code: 143 },
    );
    NodeAssert.equal(await NodeFSP.readFile(helper, "utf8"), "valid");
    NodeAssert.deepEqual(await NodeFSP.readdir(NodePath.dirname(root)), [version]);
    offline = true;
    const parent = NodePath.dirname(root);
    const prior = NodePath.join(parent, `.${version}.previous`);
    const legacy = NodePath.join(parent, `.${version}.install.lock`);
    const claim = NodePath.join(parent, `.${version}.install.claim`);
    const deadPid = "999999999";
    await NodeFSP.rename(root, prior);
    await NodeFSP.mkdir(claim);
    await NodeFSP.writeFile(NodePath.join(claim, deadPid), deadPid);
    await NodeFSP.writeFile(legacy, deadPid);
    await run();
    NodeAssert.equal(offlineRequests, 0);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(root, "codex-metadata/bin/helper"), "utf8"),
      "valid",
    );

    await NodeFSP.rename(root, prior);
    await NodeFSP.mkdir(claim);
    await NodeFSP.writeFile(NodePath.join(claim, String(process.pid)), String(process.pid));
    await NodeFSP.writeFile(legacy, String(process.pid));
    const waiting = run();
    try {
      for (let poll = 0; poll < 100; poll++) {
        if ((await NodeFSP.readdir(parent)).some((name) => name.startsWith(".contender-"))) break;
        await NodeTimersPromises.setTimeout(20);
      }
      NodeAssert.ok((await NodeFSP.readdir(parent)).some((name) => name.startsWith(".contender-")));
      NodeAssert.equal(await NodeFSP.readFile(legacy, "utf8"), String(process.pid));
      NodeAssert.ok(await NodeFSP.stat(NodePath.join(prior, "t3")));
      await NodeAssert.rejects(NodeFSP.stat(root), { code: "ENOENT" });
    } finally {
      await NodeFSP.rm(legacy);
      await NodeFSP.rm(claim, { recursive: true });
      await waiting;
    }
    NodeAssert.equal(offlineRequests, 0);
    await NodeFSP.rename(root, prior);
    await NodeFSP.rm(NodePath.join(prior, "codex-metadata.files"));
    await NodeAssert.rejects(run());
    NodeAssert.ok(offlineRequests > 0);
    NodeAssert.match((await exec(NodePath.join(root, "t3"), ["--version"])).stdout, /v1.2.3/);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
