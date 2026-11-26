// @effect-diagnostics nodeBuiltinImport:off - node:path.win32 stands in for a Windows host in one test.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodePath from "node:path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { cliArchiveFileName, cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { runtimePromotion } from "@t3tools/shared/runtimePromotion";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildNpmLauncher } from "../../../../scripts/build-npm-launcher.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  isVersionExecutable,
  ensurePinnedRuntimeInstalled,
  isUnpublishedRelease,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const version = "1.2.3";
const verifiedExecutable = `#!/bin/sh\necho "t3 v${version}"\n`;
const installPlatform = isWindowsHost ? "win32" : "linux";
const archiveName = cliArchiveFileName(version, isWindowsHost ? "win32-x64" : "linux-x64");
const entryName = isWindowsHost ? "t3.exe" : "t3";
const tarCommand = cliArchiveTarCommand(installPlatform, HostProcess.Environment.defaultValue());
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveHex = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const validChecksums = archiveHex(archiveBytes).pipe(
  Effect.map((hex) => `${hex}  ${archiveName}\n`),
);
const releaseHttpClient = (checksums: string, requests: string[] = []) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const body = new URL(request.url).pathname.endsWith("/SHA256SUMS") ? checksums : archiveBytes;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
const extractingRunner = (fs: FileSystem.FileSystem, path: Path.Path, commands: string[] = []) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        if (input.command === "sh") {
          return yield* ProcessRunner.ProcessRunner.pipe(
            Effect.flatMap((runner) => runner.run(input)),
            Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
            Effect.orDie,
          );
        }
        const targetIndex = input.args.indexOf("-C");
        const stagingDir = input.args[targetIndex + 1];
        if (input.command !== tarCommand || stagingDir === undefined) {
          return yield* Effect.die(`unexpected command ${input.command}`);
        }
        yield* fs
          .writeFileString(path.join(stagingDir, entryName), "#!/bin/sh\n")
          .pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.live.skipIf(isWindowsHost)(
  "serializes first publication with a shell installer already promoting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const paths = pinnedRuntimePaths(path, baseDir, version, "linux");
      const versions = path.dirname(paths.versionDir);
      yield* fs.makeDirectory(versions, { recursive: true });
      const staged = yield* fs.makeTempDirectory({ directory: versions, prefix: ".staging-" });
      yield* fs.writeFileString(path.join(staged, "t3"), verifiedExecutable);
      yield* fs.chmod(path.join(staged, "t3"), 0o755);
      yield* fs.writeFileString(path.join(staged, ".install-complete"), version);
      const allowRename = yield* Deferred.make<void>();
      const peer = yield* ChildProcess.make(
        "sh",
        [
          "-c",
          `set -eu
${runtimePromotion}
trap t3_release_lock EXIT
t3_acquire_lock "$1" "$2" 5
mv() {
  if [ "$1" = "$t3_staged" ]; then echo ready; read -r _; fi
  command mv "$@"
}
t3_promote_runtime "$3"`,
          "sh",
          versions,
          version,
          staged,
        ],
        {
          stdin: Stream.fromEffect(Deferred.await(allowRename).pipe(Effect.as("go\n"))).pipe(
            Stream.encodeText,
          ),
        },
      );
      yield* peer.stdout.pipe(Stream.runHead);
      // Signal the first publisher when the service actually waits on its claim.
      yield* fs.writeFileString(
        path.join(baseDir, "sleep"),
        '#!/bin/sh\necho waiting\nexec /bin/sleep "$@"\n',
      );
      yield* fs.chmod(path.join(baseDir, "sleep"), 0o755);
      const env = yield* HostProcess.Environment;
      const extractor = extractingRunner(fs, path);
      let waited = false;
      let checkedWinner = false;
      yield* ensurePinnedRuntimeInstalled({
        fs,
        path,
        baseDir,
        version,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: ProcessRunner.ProcessRunner.of({
          run: (call) =>
            call.command === "sh"
              ? extractor.run({
                  ...call,
                  env: { PATH: baseDir + ":" + env.PATH },
                  onStdoutChunk: () => {
                    waited = true;
                    Deferred.doneUnsafe(allowRename, Effect.void);
                  },
                })
              : extractor.run(call),
        }),
        validate: (candidate) =>
          Effect.sync(() => {
            if (candidate.versionDir === paths.versionDir) checkedWinner = true;
          }),
      }).pipe(Effect.ensuring(Deferred.succeed(allowRename, undefined)));
      assert.equal(Number(yield* peer.exitCode), 0);
      assert.deepEqual((yield* fs.readDirectory(paths.versionDir)).toSorted(), [
        ".install-complete",
        "t3",
      ]);
      assert.isTrue(waited);
      assert.isTrue(checkedWinner);
      assert.equal(yield* fs.readFileString(paths.entryPath), verifiedExecutable);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const publishedNpmRuntime = Effect.fn("test.publishedNpmRuntime")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const home = path.join(root, "home");
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const stem = `t3-${version}-${platform}-${arch}`;
  const archive = stem + ".tar.gz";
  yield* fs.makeDirectory(path.join(root, stem));
  yield* fs.writeFileString(
    path.join(root, stem, "t3"),
    `#!/bin/sh
if [ "$T3CODE_VERIFY_INSTALL" = 1 ]; then
  echo probe >> "$PROBE_LOG"
  echo 't3 v${version}'
else
  echo 'healthy launch'
fi
`,
  );
  yield* fs.chmod(path.join(root, stem, "t3"), 0o755);
  const runner = yield* ProcessRunner.ProcessRunner.pipe(Effect.provide(ProcessRunner.layer));
  const tar = yield* runner.run({ command: "tar", args: ["-czf", archive, stem], cwd: root });
  assert.equal(Number(tar.code), 0, tar.stderr);
  const digest = yield* archiveHex(yield* fs.readFile(path.join(root, archive)));
  yield* fs.writeFileString(path.join(root, "SHA256SUMS"), `${digest}  ${archive}\n`);
  // The packaged launcher's ordinary fetches consume the private release files.
  const preload = path.join(root, "release.mjs");
  yield* fs.writeFileString(
    preload,
    `import fs from "node:fs";
globalThis.fetch = (url) => {
  const name = new URL(url).pathname.split("/").at(-1);
  fs.appendFileSync("requests", name + "\\n");
  return Promise.resolve(new Response(fs.readFileSync(name)));
};`,
  );
  const { packageDir } = yield* buildNpmLauncher({ version, outputDir: path.join(root, "out") });
  const requests = path.join(root, "requests");
  const probes = path.join(root, "probes");
  const launch = runner.run({
    command: yield* HostProcess.ExecutablePath,
    args: ["--import", preload, path.join(packageDir, "bin/t3.mjs"), "serve"],
    cwd: root,
    env: {
      T3CODE_HOME: home,
      T3CODE_RELEASE_BASE_URL: "https://release.invalid",
      PROBE_LOG: probes,
    },
  });
  const cold = yield* launch;
  assert.equal(Number(cold.code), 0, cold.stderr);
  assert.equal(cold.stdout.trim(), "healthy launch");
  assert.equal(yield* fs.readFileString(requests), `SHA256SUMS\n${archive}\n`);
  yield* fs.writeFileString(requests, "");
  yield* fs.writeFileString(probes, "");
  return { root, home, platform, arch, archive, packageDir, launch, requests, probes };
});

const rejectedNpmExecutable = `#!/bin/sh
if [ "$T3CODE_VERIFY_INSTALL" = 1 ]; then
  echo 'rejected probe' >> "$PROBE_LOG"
  exit 78
fi
echo 'rejected ordinary launch' >> "$PROBE_LOG"
`;

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "rechecks a displaced npm runtime if it returns after the service accepts its healthy replacement",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const npm = yield* publishedNpmRuntime();
        const paths = pinnedRuntimePaths(path, npm.home, version, npm.platform);
        const winner = path.join(npm.root, "winner");
        yield* fs.rename(paths.versionDir, winner);
        yield* fs.makeDirectory(paths.versionDir);
        const versions = path.dirname(paths.versionDir);
        const displaced = path.join(versions, `.${version}.previous`);
        yield* fs.writeFileString(paths.entryPath, rejectedNpmExecutable);
        yield* fs.chmod(paths.entryPath, 0o755);
        // An earlier candidate wrote this version marker for a previously verified installation.
        yield* fs.writeFileString(path.join(paths.versionDir, ".npm-verified"), version);
        yield* fs.writeFileString(paths.sentinelPath, version);
        const checked: string[] = [];
        const requests: string[] = [];
        const ready = yield* ensurePinnedRuntimeInstalled({
          fs,
          path,
          baseDir: npm.home,
          version,
          platform: npm.platform,
          arch: npm.arch,
          httpClient: releaseHttpClient("", requests),
          runner: extractingRunner(fs, path),
          validate: (candidate) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileString(candidate.entryPath).pipe(Effect.orDie);
              if (content === rejectedNpmExecutable) {
                checked.push("displaced");
                yield* fs.rename(paths.versionDir, displaced).pipe(Effect.orDie);
                yield* fs.rename(winner, paths.versionDir).pipe(Effect.orDie);
                return yield* new PinnedRuntimeInstallError({
                  step: "validating displaced runtime",
                  exitCode: 78,
                });
              }
              assert.include(content, "healthy launch");
              checked.push("winner");
            }),
        });
        assert.deepEqual(ready, paths);
        assert.deepEqual(checked, ["displaced", "winner"]);
        assert.deepEqual(requests, []);
        const warm = yield* npm.launch;
        assert.equal(Number(warm.code), 0, warm.stderr);
        assert.equal(warm.stdout.trim(), "healthy launch");
        const healthyProbes = yield* fs.readFileString(npm.probes);
        assert.equal(yield* fs.readFileString(npm.requests), "");

        yield* fs.rename(paths.versionDir, winner);
        const runner = yield* ProcessRunner.make();
        const restore = yield* runner.run({
          command: "sh",
          args: [path.join(npm.packageDir, "bin", "promote-runtime.sh"), versions, version],
        });
        assert.equal(Number(restore.code), 0, restore.stderr);
        assert.equal(yield* fs.readFileString(paths.entryPath), rejectedNpmExecutable);
        assert.isFalse(yield* fs.exists(displaced));
        yield* fs.remove(path.join(npm.root, "SHA256SUMS"));
        yield* fs.writeFileString(npm.probes, "");
        const rollback = yield* npm.launch;
        assert.equal(Number(rollback.code), 1, rollback.stderr);
        assert.equal(yield* fs.readFileString(npm.probes), "rejected probe\n");
        assert.equal(yield* fs.readFileString(npm.requests), "SHA256SUMS\n");
        assert.equal(healthyProbes, "probe\n");
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "repairs an incomplete npm installation after the service finds its executable missing offline",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const npm = yield* publishedNpmRuntime();
        const paths = pinnedRuntimePaths(path, npm.home, version, npm.platform);
        yield* fs.remove(paths.entryPath);
        const legacyReceipt = path.join(paths.versionDir, ".npm-verified");
        yield* fs.writeFileString(legacyReceipt, version);
        yield* fs.chmod(legacyReceipt, 0o444);
        const requests: string[] = [];
        const offline = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
          );
        });
        yield* ensurePinnedRuntimeInstalled({
          fs,
          path,
          baseDir: npm.home,
          version,
          platform: npm.platform,
          arch: npm.arch,
          httpClient: offline,
          runner: extractingRunner(fs, path),
          validate: () =>
            Effect.fail(
              new PinnedRuntimeInstallError({ step: "checking missing executable", exitCode: 78 }),
            ),
        }).pipe(Effect.flip);
        assert.equal(requests.length, 1);
        assert.isTrue(requests[0]?.endsWith("/SHA256SUMS"));
        // Restoring write access to an old receipt must not make this incomplete executable runnable.
        if (yield* fs.exists(legacyReceipt)) yield* fs.chmod(legacyReceipt, 0o644);
        yield* fs.writeFileString(paths.entryPath, rejectedNpmExecutable);
        yield* fs.chmod(paths.entryPath, 0o755);
        const repaired = yield* npm.launch;
        assert.equal(Number(repaired.code), 0, repaired.stderr);
        assert.equal(repaired.stdout.trim(), "healthy launch");
        assert.equal(yield* fs.readFileString(npm.requests), `SHA256SUMS\n${npm.archive}\n`);
        const probesAfterRepair = yield* fs.readFileString(npm.probes);
        assert.include(probesAfterRepair, "rejected probe\n");
        assert.notInclude(probesAfterRepair, "rejected ordinary launch");
        const warm = yield* npm.launch;
        assert.equal(Number(warm.code), 0, warm.stderr);
        assert.equal(warm.stdout.trim(), "healthy launch");
        assert.equal(yield* fs.readFileString(npm.requests), `SHA256SUMS\n${npm.archive}\n`);
        assert.equal(yield* fs.readFileString(npm.probes), probesAfterRepair + "probe\n");
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "revalidates the installation offline after service validation is cancelled",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const npm = yield* publishedNpmRuntime();
        const started = yield* Deferred.make<void>();
        const requests: string[] = [];
        const service = yield* ensurePinnedRuntimeInstalled({
          fs,
          path,
          baseDir: npm.home,
          version,
          platform: npm.platform,
          arch: npm.arch,
          httpClient: releaseHttpClient("", requests),
          runner: extractingRunner(fs, path),
          validate: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(service);
        const warm = yield* npm.launch;
        assert.equal(Number(warm.code), 0, warm.stderr);
        assert.equal(warm.stdout.trim(), "healthy launch");
        assert.equal(yield* fs.readFileString(npm.probes), "probe\n");
        assert.equal(yield* fs.readFileString(npm.requests), "");
        assert.deepEqual(requests, []);
      }),
  );

  it.effect.skipIf(isWindowsHost)("validates an npm launcher that wins a first publication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const paths = pinnedRuntimePaths(path, baseDir, version, "linux");
      const npmStaging = yield* fs.makeTempDirectory({ directory: baseDir });
      yield* fs.writeFileString(path.join(npmStaging, "t3"), verifiedExecutable);
      yield* fs.chmod(path.join(npmStaging, "t3"), 0o755);
      yield* fs.writeFileString(path.join(npmStaging, ".install-complete"), version);
      const mv = path.join(baseDir, "mv");
      yield* fs.writeFileString(
        mv,
        `#!/bin/sh
if [ "$2" = "$INSTALL_ROOT" ] || { [ "$2" = "$INSTALL_PARENT/" ] && [ "\${1##*/}" = "$INSTALL_VERSION" ]; }; then
  "$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$NPM_STAGING" "$INSTALL_ROOT" || exit 1
fi
exec /bin/mv "$@"
`,
      );
      yield* fs.chmod(mv, 0o755);
      const env = yield* HostProcess.Environment;
      const node = yield* HostProcess.ExecutablePath;
      const extractor = extractingRunner(fs, path);
      const validated: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        fs,
        path,
        baseDir,
        version,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: ProcessRunner.ProcessRunner.of({
          run: (call) =>
            extractor.run(
              call.command === "sh"
                ? {
                    ...call,
                    env: {
                      PATH: baseDir + ":" + env.PATH,
                      NODE: node,
                      NPM_STAGING: npmStaging,
                      INSTALL_ROOT: paths.versionDir,
                      INSTALL_PARENT: path.dirname(paths.versionDir),
                      INSTALL_VERSION: version,
                    },
                  }
                : call,
            ),
        }),
        validate: (candidate) =>
          Effect.sync(() => {
            validated.push(candidate.versionDir);
          }),
      });
      assert.deepEqual((yield* fs.readDirectory(paths.versionDir)).toSorted(), [
        ".install-complete",
        "t3",
      ]);
      assert.equal(validated.at(-1), paths.versionDir);
      assert.equal(yield* fs.readFileString(paths.entryPath), verifiedExecutable);
    }),
  );

  it.effect("installs the verified release archive as the runtime executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
      const requests: string[] = [];
      const commands: string[] = [];
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        releaseBaseUrl: "https://releases.example/download",
        runner: extractingRunner(fs, path, commands),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.equal(paths.entryPath, path.join(paths.versionDir, entryName));
      assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
      assert.deepEqual(requests, [
        `https://releases.example/download/v${version}/SHA256SUMS`,
        `https://releases.example/download/v${version}/${archiveName}`,
      ]);
      assert.deepEqual(commands, isWindowsHost ? [tarCommand] : [tarCommand, "sh"]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
    }),
  );

  it.effect("cleans up an interrupted download without reporting verification or extraction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-failed-" });
      const checksums = yield* validChecksums;
      const progress: PinnedRuntimeProgress[] = [];
      let cancelled = false;
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/SHA256SUMS")
              ? new Response(checksums)
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(archiveBytes.slice(0, 4));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
          ),
        ),
      );
      const firstChunk = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: client,
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate an interrupted archive"),
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "download" && event.received === 4)
            Deferred.doneUnsafe(firstChunk, Effect.void);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(install);
      assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
      assert.isTrue(progress.every((event) => event.stage === "download"));
      assert.isTrue(cancelled);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("reports a release that lists an archive it does not serve as unpublished", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-missing-" });
      const checksums = yield* validChecksums;
      const failsWith = (status: number) =>
        ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/SHA256SUMS")
                  ? new Response(checksums)
                  : new Response("", { status }),
              ),
            ),
          ),
          // "404" in the mirror's path must not read a server error as a missing release.
          releaseBaseUrl: "https://updates.example.com/404/t3code",
          runner: extractingRunner(fs, path),
          validate: () => Effect.die("must not validate a missing archive"),
        }).pipe(Effect.flip);
      assert.isTrue(isUnpublishedRelease(yield* failsWith(404)));
      assert.isFalse(isUnpublishedRelease(yield* failsWith(403)));
    }),
  );

  it.effect("retries a release download that GitHub answers with a gateway timeout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-retry-" });
      const checksums = yield* validChecksums;
      const requests: string[] = [];
      const gatewayTimeoutServed = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: HttpClient.make((request) => {
          requests.push(request.url);
          const isChecksums = request.url.endsWith("/SHA256SUMS");
          if (requests.length === 1) {
            Deferred.doneUnsafe(gatewayTimeoutServed, Effect.void);
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("", { status: 504 })),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(isChecksums ? checksums : archiveBytes),
            ),
          );
        }),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(gatewayTimeoutServed);
      yield* TestClock.adjust(Duration.seconds(2));
      const paths = yield* Fiber.join(install);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.equal(requests.filter((url) => url.endsWith("/SHA256SUMS")).length, 2);
    }),
  );

  it.effect("retries a release archive whose body fails after the host answered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-retry-body-" });
      const checksums = yield* validChecksums;
      let archiveRequests = 0;
      const archiveRequested = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: HttpClient.make((request) => {
          const isChecksums = request.url.endsWith("/SHA256SUMS");
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(isChecksums ? checksums : archiveBytes),
          );
          if (isChecksums || ++archiveRequests > 1) return Effect.succeed(response);
          const failingBody = Stream.concat(
            Stream.make(archiveBytes.slice(0, 4)),
            Stream.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.DecodeError({ request, response }),
              }),
            ),
          );
          Deferred.doneUnsafe(archiveRequested, Effect.void);
          // TestClock follows the work a woken sleep starts, so one adjust reaches the retry wait.
          return Effect.sleep("1 second").pipe(
            Effect.as<HttpClientResponse.HttpClientResponse>(
              Object.create(response, { stream: { value: failingBody } }),
            ),
          );
        }),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(archiveRequested);
      yield* TestClock.adjust(Duration.seconds(3));
      const paths = yield* Fiber.join(install);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.equal(archiveRequests, 2);
    }),
  );

  it.effect("fails at once when the release host cannot be reached", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-offline-" });
      let requests = 0;
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: HttpClient.make((request) => {
          requests += 1;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          );
        }),
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate without a download"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(requests, 1);
    }),
  );

  it.effect("refuses an archive whose checksum does not match the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-bad-" });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(`${"0".repeat(64)}  ${archiveName}\n`),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unverified archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, "verifying the t3 release archive checksum");
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, installPlatform);
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, installPlatform);

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, installPlatform);
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");
      yield* fs.makeDirectory(finalPaths.sentinelPath);

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("reuses a cached runtime under a mirror only while the mirror lists it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-mirror-" });
      const cached = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(path.dirname(cached.entryPath), { recursive: true });
      yield* fs.writeFileString(cached.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(cached.sentinelPath, `${version}\n`);
      const install = (checksums: string, requests: string[]) =>
        ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(checksums, requests),
          // A signed mirror URL keeps its query on every file it serves.
          releaseBaseUrl: "https://updates.example.com/t3code/?token=abc",
          requirePublishedRelease: true,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
        });

      const withdrawn = yield* install("", []).pipe(Effect.flip);
      assert.include(withdrawn.message, `finding ${archiveName} in the t3 release checksums`);
      const requests: string[] = [];
      assert.equal((yield* install(yield* validChecksums, requests)).entryPath, cached.entryPath);
      // Listed, so the cached runtime is used without downloading it again.
      assert.deepEqual(requests, [
        `https://updates.example.com/t3code/v${version}/SHA256SUMS?token=abc`,
      ]);
    }),
  );
  it.effect.each(isWindowsHost ? (["win32"] as const) : (["linux", "win32"] as const))(
    "restores an interrupted %s promotion before checking the cache or network",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped();
        const paths = pinnedRuntimePaths(path, baseDir, version, platform);
        const versions = path.dirname(paths.versionDir);
        const previous = path.join(versions, `.${version}.previous`);
        yield* fs.makeDirectory(previous, { recursive: true });
        yield* fs.writeFileString(path.join(previous, path.basename(paths.entryPath)), "runnable");
        yield* fs.writeFileString(path.join(previous, ".install-complete"), version);
        yield* fs.writeFileString(path.join(versions, `.${version}.install.lock`), "999999999");
        const requests: string[] = [];
        yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform,
          arch: "x64",
          runner: extractingRunner(fs, path),
          httpClient: releaseHttpClient("", requests),
          validate: (candidate) =>
            fs.readFileString(candidate.entryPath).pipe(
              Effect.tap((text) => Effect.sync(() => assert.equal(text, "runnable"))),
              Effect.asVoid,
              Effect.orDie,
            ),
        });
        assert.deepEqual(requests, []);
        assert.equal(yield* fs.readFileString(paths.entryPath), "runnable");
      }),
  );
  it.effect("repairs a missing release component only after validating its replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const paths = pinnedRuntimePaths(path, baseDir, version, installPlatform);
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "old");
      yield* fs.writeFileString(paths.sentinelPath, version);
      let corruptReplacement = true;
      const install = ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        runner: extractingRunner(fs, path),
        httpClient: releaseHttpClient(yield* validChecksums),
        validate: (candidate) =>
          Effect.gen(function* () {
            assert.equal(yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie), "old");
            if (candidate.versionDir === paths.versionDir || corruptReplacement)
              return yield* new PinnedRuntimeInstallError({
                step: "checking release inventory",
                exitCode: 78,
              });
          }),
      });
      yield* install.pipe(Effect.flip);
      assert.equal(yield* fs.readFileString(paths.entryPath), "old");
      corruptReplacement = false;
      yield* install;
      assert.notEqual(yield* fs.readFileString(paths.entryPath), "old");
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, installPlatform);
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);

      let validations = 0;
      const requests: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: installPlatform,
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        runner: extractingRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.deepEqual(requests, []);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );
});

it("isVersionExecutable accepts only <version>/t3, never another drive or program", () => {
  const win32 = NodePath.win32 as unknown as Path.Path;
  assert.isTrue(isVersionExecutable(win32, "C:\\t3\\versions", "C:\\t3\\versions\\1.0.0\\t3.exe"));
  assert.isFalse(isVersionExecutable(win32, "C:\\t3\\versions", "D:\\t3.exe"));
  assert.isFalse(
    isVersionExecutable(win32, "C:\\t3\\versions", "C:\\t3\\versions\\1.0.0\\node.exe"),
  );
});

it.layer(NodeServices.layer)("prunePinnedRuntimes", (it) => {
  const lsofRunner = (stdout: string) =>
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    });

  const setup = Effect.fn(function* (versions: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-prune-" });
    const versionsDir = path.join(baseDir, "runtime", "versions");
    const now = Duration.toMillis(Duration.days(1));
    yield* TestClock.setTime(now);
    const install = Effect.fn(function* (
      version: string,
      completed: "long ago" | "just now" | "never" = "long ago",
    ) {
      const directory = path.join(versionsDir, version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      if (completed === "never") return;
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      const at = completed === "just now" ? now : 0;
      yield* fs.utimes(sentinel, at, at);
    });
    for (const version of versions) yield* install(version);
    return { baseDir, versionsDir, install };
  });

  it.effect("removes only completed runtimes nothing references", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir, install } = yield* setup([
        "1.0.0",
        "1.1.0",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "2.1.0",
      ]);
      // A downgrade another process installed but has not pointed anything at yet.
      yield* install("0.5.0", "just now");
      yield* install("1.0.1", "never");
      yield* install(".staging-abc", "never");
      yield* install(".pruned-0.8.0");
      yield* install("other", "never");
      yield* fs.symlink(path.join(versionsDir, "other"), path.join(versionsDir, "0.9.0"));
      const binDir = path.join(baseDir, "bin");
      const customBinDir = path.join(baseDir, "custom-bin");
      yield* fs.makeDirectory(binDir);
      yield* fs.makeDirectory(customBinDir);
      // Chained: the launcher reaches its runtime through a second link.
      yield* fs.symlink(path.join(versionsDir, "1.2.0", "t3"), path.join(baseDir, "alias-t3"));
      yield* fs.symlink(path.join(baseDir, "alias-t3"), path.join(binDir, "t3"));
      yield* fs.symlink(path.join(versionsDir, "1.2.5", "t3"), path.join(customBinDir, "t3"));
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "launchers"),
        `${path.join(customBinDir, "t3")}\n`,
      );
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.4.0",
          update: { id: "u", fromVersion: "1.4.0", targetVersion: "1.5.0", status: "rolled-back" },
        }),
      );

      const removed = yield* prunePinnedRuntimes({
        baseDir,
        keep: ["2.0.0"],
        references: [`ExecStart=${path.join(versionsDir, "1.3.5", "t3")} __service-launcher`],
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner(`p42\nftxt\nn${path.join(versionsDir, "1.3.0", "t3")}\n`),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: binDir }),
      );

      // 1.2.0 is the default launcher, 1.2.5 a recorded one, 1.3.0 running, 1.3.5 in the unit,
      // 1.4.0 active, 1.5.0 the rolled-back target, 2.0.0 the caller's, 0.5.0 just installed.
      // Being newer than the caller's version does not keep 2.1.0.
      assert.deepEqual(removed.toSorted(), ["0.8.0", "1.0.0", "1.1.0", "2.1.0"]);
      // The launcher found on PATH is remembered for a service that cannot see it.
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "runtime", "launchers")),
        `${path.join(customBinDir, "t3")}\n\n${path.join(binDir, "t3")}\n`,
      );
      assert.deepEqual((yield* fs.readDirectory(versionsDir)).toSorted(), [
        ".staging-abc",
        "0.5.0",
        "0.9.0",
        "1.0.1",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "other",
      ]);
    }),
  );

  // Emulates a darwin host with symlinked `t3` launchers and a colon-separated PATH, which a Windows temp path does not match.
  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "with a launcher on PATH",
    () => {
      it.effect.each([
        { name: "its directory is on PATH", onPath: true, recorded: false, linkedHome: false },
        {
          name: "an earlier prune recorded its entry as a launcher",
          onPath: false,
          recorded: true,
          linkedHome: false,
        },
        {
          name: "its real directory in a symlinked home is on PATH",
          onPath: true,
          recorded: false,
          linkedHome: true,
        },
      ])(
        "removes a runtime only its own entry names when $name",
        ({ onPath, recorded, linkedHome }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
            const binDir = path.join(baseDir, "bin");
            yield* fs.makeDirectory(binDir);
            yield* fs.symlink(path.join(versionsDir, "1.1.0", "t3"), path.join(binDir, "t3"));
            const ownDir = path.join(versionsDir, "1.0.0");
            if (recorded) {
              yield* fs.writeFileString(
                path.join(baseDir, "runtime", "launchers"),
                `${path.join(ownDir, "t3")}\n`,
              );
            }

            const home = linkedHome
              ? path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-link-" }), "home")
              : baseDir;
            if (linkedHome) yield* fs.symlink(baseDir, home);

            // The launch agent puts the running runtime's own directory on PATH.
            const removed = yield* prunePinnedRuntimes({ baseDir: home, keep: ["2.0.0"] }).pipe(
              Effect.provideService(
                ProcessRunner.ProcessRunner,
                lsofRunner("p1\nftxt\nn/sbin/launchd\n"),
              ),
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(HostProcess.Environment, {
                T3CODE_INSTALL_BIN_DIR: binDir,
                PATH: onPath ? `${ownDir}:/usr/bin:/bin` : "/usr/bin:/bin",
              }),
            );
            assert.deepEqual(removed, ["1.0.0"]);
          }),
      );

      it.effect.each([
        { name: "a launcher inside the versions directory", via: "bin" as const },
        { name: "a PATH directory linked to its version directory", via: "linked dir" as const },
        {
          name: "a PATH directory in the versions directory linked to its version directory",
          via: "linked versions dir" as const,
        },
      ])("keeps a runtime $name names", ({ via }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
          let pathDirs = "/usr/bin:/bin";
          if (via === "bin") {
            // The installer accepts any bin directory, including one under the versions directory.
            const binDir = path.join(versionsDir, "bin");
            yield* fs.makeDirectory(binDir);
            yield* fs.symlink(path.join(versionsDir, "1.0.0", "t3"), path.join(binDir, "t3"));
            yield* fs.writeFileString(
              path.join(baseDir, "runtime", "launchers"),
              `${path.join(binDir, "t3")}\n`,
            );
          } else {
            const linkedDir = path.join(via === "linked dir" ? baseDir : versionsDir, "current");
            yield* fs.symlink(path.join(versionsDir, "1.0.0"), linkedDir);
            pathDirs = `${linkedDir}:${pathDirs}`;
          }

          const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
            Effect.provideService(
              ProcessRunner.ProcessRunner,
              lsofRunner("p1\nftxt\nn/sbin/launchd\n"),
            ),
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Environment, { PATH: pathDirs }),
          );
          assert.deepEqual(removed, ["1.1.0"]);
        }),
      );

      it.effect.each([
        // An interrupted append cut this record short.
        { name: "an unterminated launcher record", recorded: "/opt/t", cut: "" },
        // Another process's append is cut short after prune reads the records.
        { name: "a record cut short after the read", recorded: "/opt/t3\n", cut: "/opt/t" },
      ])("remembers a launcher found on PATH after $name", ({ recorded, cut }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
          const binDir = path.join(baseDir, "custom-bin");
          yield* fs.makeDirectory(binDir);
          yield* fs.symlink(path.join(versionsDir, "1.0.0", "t3"), path.join(binDir, "t3"));
          const launchersFile = path.join(baseDir, "runtime", "launchers");
          yield* fs.writeFileString(launchersFile, recorded);
          const prune = (environment: Record<string, string>) =>
            prunePinnedRuntimes({ baseDir, keep: [] }).pipe(
              Effect.provideService(
                ProcessRunner.ProcessRunner,
                lsofRunner("p1\nftxt\nn/bin/sh\n"),
              ),
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(HostProcess.Environment, environment),
              Effect.provideService(HostProcess.HomeDirectory, baseDir),
            );

          yield* prune({ PATH: binDir }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                fs
                  .readFileString(file, encoding)
                  .pipe(
                    Effect.tap(() =>
                      file === launchersFile
                        ? fs.writeFileString(file, cut, { flag: "a" })
                        : Effect.void,
                    ),
                  ),
            }),
          );
          // A service that cannot see the interactive PATH.
          const removed = yield* prune({});

          assert.deepEqual(removed, []);
          assert.isTrue(yield* fs.exists(path.join(versionsDir, "1.0.0", "t3")));
        }),
      );
    },
  );

  it.effect("matches a Windows shim whatever its casing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
      const shim = path.join(baseDir, "t3.cmd");
      yield* fs.writeFileString(
        shim,
        `@echo off\r\n"${path.join(versionsDir, "1.0.0", "t3.exe").toUpperCase()}" %*`,
      );
      yield* fs.writeFileString(path.join(baseDir, "runtime", "launchers"), `${shim}\n`);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner("C:\\Windows\\explorer.exe\n"),
        ),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.deepEqual(removed, ["1.1.0"]);
    }),
  );

  it.effect.each([
    { name: "the process list is unavailable", state: undefined, lsof: "" },
    { name: "the service state is unparseable", state: "{", lsof: "p1\nftxt\nn/sbin/launchd\n" },
    {
      name: "the service state cannot be read",
      state: null,
      lsof: "p1\nftxt\nn/sbin/launchd\n",
    },
  ])("keeps everything when $name", ({ state, lsof }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0"]);
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      if (state === null) yield* fs.makeDirectory(statePath);
      else if (state !== undefined) yield* fs.writeFileString(statePath, state);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, lsofRunner(lsof)),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
      );
      assert.deepEqual(removed, []);
      assert.deepEqual(yield* fs.readDirectory(versionsDir), ["1.0.0"]);
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "keeps a runtime a process runs through a symlink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
        const entry = path.join(versionsDir, "1.0.0", "t3");
        // Multicall coreutils (Ubuntu's uutils) refuse to run renamed, so copy Node instead.
        yield* fs.copyFile(process.execPath, entry);
        yield* fs.chmod(entry, 0o755);
        const link = path.join(baseDir, "t3");
        yield* fs.symlink(entry, link);
        // Its argv names only the link, as with `t3 serve` run from PATH. Removing the link after
        // spawning leaves the process's executable as the only reference.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.spawn(ChildProcess.make(link, ["-e", "setTimeout(() => {}, 30_000)"]));
        yield* fs.remove(link);

        const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
          Effect.provide(ProcessRunner.layer),
        );
        assert.deepEqual(removed, ["1.1.0"]);
      }),
  );
});
