// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { runtimePromotion } from "@t3tools/shared/runtimePromotion";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (
  root: string,
  beforeChecksum?: () => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `t3-${VERSION}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "release", stem, "t3"),
    `#!/bin/sh
if [ "$T3CODE_VERIFY_INSTALL" = 1 ]; then
  if [ -n "$FIXTURE_PROBE_RECEIPT" ]; then
    if [ -e "\${0%/*}/.install-complete" ]; then echo marked; else echo unmarked; fi > "$FIXTURE_PROBE_RECEIPT"
    if [ -n "$FIXTURE_INSTALLED_DIR" ]; then cat "$FIXTURE_INSTALLED_DIR/sidecar" >> "$FIXTURE_PROBE_RECEIPT"; fi
  fi
  echo "t3 v\${FIXTURE_PROBE_VERSION:-${VERSION}}"
  exit "\${FIXTURE_PROBE_STATUS:-0}"
fi
echo "stub $* launcher=$T3CODE_NPM_LAUNCHER_PATH"
exit 7
`,
  );
  yield* fs.chmod(path.join(root, "release", stem, "t3"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: process.env.PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  const archiveChecksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  let checksum = archiveChecksum;
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${VERSION}/SHA256SUMS`) {
      beforeChecksum?.();
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setChecksumValid: (valid: boolean) => {
      checksum = valid ? archiveChecksum : "0".repeat(64);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.each([
    { matches: true, peerAt: null, outcome: "restores the matching rollback offline" },
    {
      matches: false,
      peerAt: null,
      outcome: "preserves the wrong-version rollback and requests the release",
    },
    {
      matches: true,
      peerAt: "marker",
      outcome: "reuses a peer restore before reading the rollback marker",
    },
    {
      matches: true,
      peerAt: "probe",
      outcome: "reuses a peer restore before probing the rollback executable",
    },
  ])("the npm entry point $outcome", ({ matches, peerAt }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const version = matches ? process.versions.node : "0.0.1";
      const { packageDir } = yield* buildNpmLauncher({
        version,
        outputDir: path.join(root, "out"),
      });
      const launcher = path.join(packageDir, "bin/t3.mjs");
      const home = path.join(root, "home");
      const versions = path.join(home, "runtime/versions");
      const previous = path.join(versions, "." + version + ".previous");
      const entry = (yield* HostProcess.Platform) === "win32" ? "t3.exe" : "t3";
      yield* fs.makeDirectory(previous, { recursive: true });
      yield* fs.writeFileString(path.join(previous, ".install-complete"), version + "\n");
      // Node provides a portable executable whose --version and launch path are observable.
      yield* fs
        .link(process.execPath, path.join(previous, entry))
        .pipe(Effect.catch(() => fs.copyFile(process.execPath, path.join(previous, entry))));
      yield* fs.writeFileString(
        path.join(root, "update"),
        "console.log(JSON.stringify([process.execPath, ...process.argv.slice(2)]))",
      );
      const offline = path.join(root, "offline.mjs");
      yield* fs.writeFileString(
        offline,
        `import fs from "node:fs";
globalThis.fetch = (url) => {
  fs.appendFileSync("requests", url + "\\n");
  throw new Error("offline fixture refused " + url);
};`,
      );
      const preloads = ["--import", "./offline.mjs"];
      if (peerAt !== null) {
        yield* fs.writeFileString(
          path.join(root, "peer.mjs"),
          `import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const { openSync } = fs;
const { spawnSync } = childProcess;
const restore = () => {
  const peer = spawnSync(process.execPath, ["--import", "./offline.mjs", ${JSON.stringify(launcher)}, "update", ${JSON.stringify(version)}], { encoding: "utf8", timeout: 30_000 });
  if (peer.status !== 0) throw new Error("peer restore failed: " + peer.stderr);
  fs.appendFileSync("restore-events", "peer finished\\n");
};
fs.openSync = (file, ...args) => {
  if (${JSON.stringify(peerAt)} === "marker" && file === ${JSON.stringify(path.join(previous, ".install-complete"))}) restore();
  return openSync(file, ...args);
};
childProcess.spawnSync = (file, args, options) => {
  if (${JSON.stringify(peerAt)} === "probe" && file === ${JSON.stringify(path.join(previous, entry))}) restore();
  if (file === ${JSON.stringify(path.join(versions, version, entry))} && args?.[0] === "--version" && options?.env?.T3CODE_VERIFY_INSTALL === "1")
    fs.appendFileSync("restore-events", "canonical probe\\n");
  return spawnSync(file, args, options);
};
syncBuiltinESMExports();
`,
        );
        preloads.push("--import", "./peer.mjs");
      }
      const result = yield* run(process.execPath, [...preloads, launcher, "update", version], {
        cwd: root,
        env: {
          ...process.env,
          T3CODE_HOME: home,
          T3CODE_RELEASE_BASE_URL: "https://release.invalid",
        },
      });
      if (matches) {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(
          result.stdout.trim(),
          JSON.stringify([path.join(versions, version, entry), version]),
        );
        assert.isFalse(yield* fs.exists(previous));
        assert.isFalse(yield* fs.exists(path.join(root, "requests")));
        if (peerAt !== null) {
          assert.equal(
            yield* fs.readFileString(path.join(root, "restore-events")),
            "peer finished\ncanonical probe\n",
          );
        }
      } else {
        assert.equal(result.exitCode, 1);
        assert.include(
          result.stderr,
          "offline fixture refused https://release.invalid/v0.0.1/SHA256SUMS",
        );
        assert.isTrue(yield* fs.exists(previous));
        assert.isFalse(yield* fs.exists(path.join(versions, version)));
      }
    }),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("download verification", () => {
    it.effect.each([
      { reported: "2.0.0", status: 0, publisher: "npm" },
      { reported: VERSION, status: 78, publisher: "npm" },
      { reported: "2.0.0", status: 0, publisher: "shared installer" },
    ])(
      "never launches a peer rejected by $publisher on retry (reported $reported, exit $status)",
      ({ reported, status, publisher }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          const { packageDir } = yield* buildNpmLauncher({
            version: VERSION,
            outputDir: path.join(root, "out"),
          });
          const home = path.join(root, "home");
          const versions = path.join(home, "runtime/versions");
          const installed = path.join(versions, VERSION);
          const peer = path.join(versions, "peer");
          yield* fs.makeDirectory(peer, { recursive: true });
          yield* fs.writeFileString(path.join(peer, ".install-complete"), VERSION);
          if (status === 78 || publisher === "shared installer")
            yield* fs.writeFileString(path.join(peer, ".npm-verified"), VERSION);
          yield* fs.writeFileString(
            path.join(peer, "t3"),
            `#!/bin/sh
if [ "$T3CODE_VERIFY_INSTALL" = 1 ]; then
  printf 'probe\\n' >> "$TRACE"
  echo 't3 v${reported}'
  exit ${status}
fi
printf 'ordinary launch\\n' >> "$TRACE"
`,
          );
          yield* fs.chmod(path.join(peer, "t3"), 0o755);
          const release = yield* serveFakeRelease(root, () => {
            if (NodeFS.existsSync(peer)) NodeFS.renameSync(peer, installed);
          });
          const trace = path.join(root, "trace");
          const invoke = run(process.execPath, [path.join(packageDir, "bin/t3.mjs"), "serve"], {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              T3CODE_HOME: home,
              T3CODE_RELEASE_BASE_URL: release.baseUrl,
              TRACE: trace,
            },
          });
          if (publisher === "shared installer") {
            yield* fs.rename(peer, installed);
            const refused = yield* run(
              "sh",
              ["-c", runtimePromotion + '\nt3_runtime_ready "$1" "$2"', "sh", installed, VERSION],
              { cwd: root, env: { PATH: process.env.PATH, TRACE: trace } },
            );
            assert.equal(refused.exitCode, 1, refused.stderr);
          } else {
            const first = yield* invoke;
            assert.equal(first.exitCode, 1, first.stderr);
            assert.include(first.stderr, "verification");
          }
          assert.equal(yield* fs.readFileString(trace), "probe\n");
          release.setChecksumValid(false);
          const retry = yield* invoke;
          assert.notInclude(yield* fs.readFileString(trace), "ordinary launch");
          assert.equal(retry.exitCode, 1, retry.stderr);
          assert.include(retry.stderr, "checksum mismatch");
          release.setChecksumValid(true);
          const repaired = yield* invoke;
          assert.equal(repaired.exitCode, 7, repaired.stderr);
          assert.include(repaired.stdout, "stub serve launcher=");
          const requestsAfterRepair = release.requests.length;
          const warmProbe = path.join(root, "probe-after-repair");
          const cached = yield* run(
            process.execPath,
            [path.join(packageDir, "bin/t3.mjs"), "serve"],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                T3CODE_HOME: home,
                T3CODE_RELEASE_BASE_URL: release.baseUrl,
                FIXTURE_PROBE_RECEIPT: warmProbe,
              },
            },
          );
          assert.equal(cached.exitCode, 7, cached.stderr);
          assert.isFalse(yield* fs.exists(warmProbe));
          assert.equal(release.requests.length, requestsAfterRepair);
          assert.notInclude(yield* fs.readFileString(trace), "ordinary launch");
        }),
    );

    it.effect.each(["missing", "empty", "damaged"] as const)(
      "preserves the %s destination when the downloaded runtime fails verification",
      (destination) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          const { packageDir } = yield* buildNpmLauncher({
            version: VERSION,
            outputDir: path.join(root, "out"),
          });
          const release = yield* serveFakeRelease(root);
          const home = path.join(root, "home");
          const installed = path.join(home, "runtime/versions", VERSION);
          const original = "#!/bin/sh\nprintf 'original runtime\\n'\n";
          if (destination !== "missing") yield* fs.makeDirectory(installed, { recursive: true });
          if (destination === "damaged") {
            yield* fs.writeFileString(path.join(installed, "t3"), original);
            yield* fs.chmod(path.join(installed, "t3"), 0o755);
            yield* fs.writeFileString(path.join(installed, "sidecar"), "original helper");
          }
          for (const [probeVersion, probeStatus] of [
            ["2.0.0", "0"],
            [VERSION, "78"],
          ] as const) {
            const receipt = path.join(root, `previous-helper-during-probe-${probeStatus}`);
            const result = yield* run(
              process.execPath,
              [path.join(packageDir, "bin/t3.mjs"), "--version"],
              {
                cwd: root,
                env: {
                  PATH: process.env.PATH,
                  T3CODE_HOME: home,
                  T3CODE_RELEASE_BASE_URL: release.baseUrl,
                  FIXTURE_PROBE_VERSION: probeVersion,
                  FIXTURE_PROBE_STATUS: probeStatus,
                  FIXTURE_INSTALLED_DIR: destination === "damaged" ? installed : undefined,
                  FIXTURE_PROBE_RECEIPT: receipt,
                },
              },
            );
            assert.equal(result.exitCode, 1, result.stderr);
            assert.include(
              result.stderr,
              `the downloaded t3 ${VERSION} runtime failed verification`,
            );
            assert.equal(
              yield* fs.readFileString(receipt),
              destination === "damaged" ? "unmarked\noriginal helper" : "unmarked\n",
            );
            assert.deepStrictEqual(
              yield* fs.readDirectory(path.dirname(installed)),
              destination === "missing" ? [] : [VERSION],
            );
            if (destination === "damaged") {
              assert.equal(yield* fs.readFileString(path.join(installed, "t3")), original);
              assert.equal(
                yield* fs.readFileString(path.join(installed, "sidecar")),
                "original helper",
              );
            }
            if (destination === "empty")
              assert.deepStrictEqual(yield* fs.readDirectory(installed), []);
          }
        }),
    );
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The launcher reports its real path; macOS tmpdir sits behind /var -> /private/var.
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" }),
        );
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "t3");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { t3: "./bin/t3.mjs" });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);
        assert.isAbove(npmReleaseDatabaseMigration(manifest) ?? 0, 0);

        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: process.env.PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          T3CODE_HOME: home,
          T3CODE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/t3.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        const versionDir = path.join(home, "runtime/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/versions"))).sort(),
          [VERSION],
        );

        const requestsAfterFirst = release.requests.length;
        const warmProbe = path.join(root, "warm-probe");
        const second = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, FIXTURE_PROBE_RECEIPT: warmProbe },
        });
        assert.isFalse(yield* fs.exists(warmProbe));
        assert.equal(second.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst);

        const ipcServer = path.join(home, "runtime/versions", VERSION, "t3");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 7, one.stderr);
        assert.equal(two.exitCode, 7, two.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(raceHome, "runtime/versions")), [
          VERSION,
        ]);

        const requestsAfterRace = release.requests.length;
        const afterRace = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: raceHome, FIXTURE_PROBE_RECEIPT: warmProbe },
        });
        assert.equal(afterRace.exitCode, 7, afterRace.stderr);
        assert.isFalse(yield* fs.exists(warmProbe), "a verified npm winner stays warm");
        assert.equal(release.requests.length, requestsAfterRace);

        // A peer's executable and sidecar stay available after every later rename or removal,
        // even when it publishes after our missing-marker read.
        const staleHome = path.join(root, "stale-home");
        const staleDir = path.join(staleHome, "runtime/versions", VERSION);
        const peerDir = path.join(root, "peer-runtime");
        yield* fs.makeDirectory(staleDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleDir, "t3"), "");
        const fifo = yield* run("mkfifo", [path.join(staleDir, ".install-complete")], {
          cwd: root,
          env,
        });
        assert.equal(fifo.exitCode, 0, fifo.stderr);
        yield* fs.makeDirectory(peerDir);
        yield* fs.writeFileString(
          path.join(peerDir, "t3"),
          `#!/bin/sh\nif [ "$T3CODE_VERIFY_INSTALL" = 1 ]; then echo "t3 v${VERSION}"; exit 0; fi\necho "peer $*"\nexit 7\n`,
        );
        yield* fs.chmod(path.join(peerDir, "t3"), 0o755);
        yield* fs.writeFileString(path.join(peerDir, ".install-complete"), `${VERSION}\n`);
        yield* fs.writeFileString(path.join(peerDir, "sidecar"), "peer sidecar");
        const peerChecks = path.join(root, "peer-checks.txt");
        // The peer publishes after the launcher's rename fails and it reads the marker.
        const peerHook = path.join(root, "peer-publishes.mjs");
        yield* fs.writeFileString(
          peerHook,
          `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = ${JSON.stringify(staleDir)};
const { openSync, fstatSync, closeSync, readFileSync, renameSync, rmSync } = fs;
const markerHandles = new Set();
fs.openSync = (file, flags, ...args) => {
  if (file !== dir + "/.install-complete") return openSync(file, flags, ...args);
  if (typeof flags !== "number" || !(flags & fs.constants.O_NONBLOCK)) {
    fs.appendFileSync(${JSON.stringify(peerChecks)}, "opened marker without O_NONBLOCK\\n");
    throw new Error("opening the incomplete marker would block");
  }
  const fd = openSync(file, flags, ...args);
  markerHandles.add(fd);
  return fd;
};
fs.readFileSync = (file, ...args) => {
  if (markerHandles.has(file) && !fstatSync(file).isFile()) {
    fs.appendFileSync(${JSON.stringify(peerChecks)}, "read nonregular marker\\n");
    throw new Error("reading the incomplete marker would block");
  }
  return readFileSync(file, ...args);
};
let checking = false;
let published = false;
const checkPeer = () => {
  const child = spawnSync(dir + "/t3", ["--version"], { encoding: "utf8" });
  let sidecar;
  try {
    sidecar = readFileSync(dir + "/sidecar", "utf8");
  } catch (error) {
    sidecar = error.code;
  }
  fs.appendFileSync(${JSON.stringify(peerChecks)},
    [child.status, child.error?.code ?? child.stdout.trim(), sidecar].join("|") + "\\n");
};
fs.renameSync = (from, to) => {
  try {
    return renameSync(from, to);
  } catch (error) {
    checking ||= to === dir;
    throw error;
  } finally {
    if (published) checkPeer();
  }
};
fs.rmSync = (...args) => {
  try {
    return rmSync(...args);
  } finally {
    if (published) checkPeer();
  }
};
fs.closeSync = (fd, ...rest) => {
  try {
    return closeSync(fd, ...rest);
  } finally {
    if (markerHandles.delete(fd) && checking) {
      checking = false;
      rmSync(dir, { recursive: true });
      renameSync(${JSON.stringify(peerDir)}, dir);
      published = true;
      checkPeer();
    }
  }
};
`,
        );
        const recovered = yield* run(
          process.execPath,
          ["--import", peerHook, launcher, "--version"],
          { cwd: root, env: { ...env, T3CODE_HOME: staleHome } },
        );
        const checks = (yield* fs.readFileString(peerChecks)).trim().split("\n");
        assert.isAtLeast(checks.length, 2);
        assert.deepStrictEqual([...new Set(checks)], ["7|peer --version|peer sidecar"]);
        assert.equal(recovered.stdout.trim(), "peer --version", recovered.stderr);
        assert.equal(recovered.exitCode, 7);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(staleHome, "runtime/versions")), [
          VERSION,
        ]);

        // While another launch holds the lock, a stale folder is left alone and the error says
        // how to clear a lock left by a crash.
        const staleOnlyHome = path.join(root, "stale-only-home");
        const staleOnlyDir = path.join(staleOnlyHome, "runtime/versions", VERSION);
        yield* fs.makeDirectory(staleOnlyDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleOnlyDir, "t3"), "incomplete");
        yield* fs.makeDirectory(`${staleOnlyDir}.lock`);
        const locked = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: staleOnlyHome },
        });
        assert.equal(locked.exitCode, 1);
        assert.include(locked.stderr, `delete ${staleOnlyDir}.lock`);
        assert.equal(yield* fs.readFileString(path.join(staleOnlyDir, "t3")), "incomplete");

        // A shell installer that died while repairing the version left one owner inode at all three names.
        yield* fs.remove(`${staleOnlyDir}.lock`, { recursive: true });
        const versionsDir = path.dirname(staleOnlyDir);
        const claim = path.join(versionsDir, `.${VERSION}.install.claim`);
        const deadOwner = path.join(claim, "999999999");
        yield* fs.makeDirectory(claim);
        yield* fs.writeFileString(deadOwner, "999999999\n");
        yield* fs.link(deadOwner, path.join(versionsDir, `.${VERSION}.install.lock`));
        yield* fs.link(deadOwner, `${staleOnlyDir}.lock`);
        const replaced = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: staleOnlyHome },
        });
        assert.equal(
          replaced.stdout.trim(),
          `stub --version launcher=${launcher}`,
          replaced.stderr,
        );
        assert.equal(replaced.exitCode, 7);
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(staleOnlyHome, "runtime/versions")),
          [VERSION],
        );

        release.setChecksumValid(false);
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/versions")),
          [],
        );
      }),
  );
});
