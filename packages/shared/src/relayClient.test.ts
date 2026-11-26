import { sha256 } from "@noble/hashes/sha2";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "./HostProcess.ts";

import * as RelayClient from "./relayClient.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const executableName = windowsHost ? "cloudflared.exe" : "cloudflared";
const pathDelimiter = windowsHost ? ";" : ":";

const layerHostRuntime = (env: Record<string, string> = {}, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, env),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0, output = "") {
  const stdout = output ? Stream.make(new TextEncoder().encode(output)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: stdout,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const layerSpawner = (commands: Array<string>, versions: Record<string, string> = {}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          commands.push("piped-command");
          return makeHandle();
        }
        commands.push(command.command);
        if (command.args[0] === "version") {
          const version = versions[command.command] ?? RelayClient.CLOUDFLARED_VERSION;
          return makeHandle(0, `cloudflared version ${version} (built 2026-01-01-00:00 UTC)\n`);
        }
        return makeHandle();
      }),
    ),
  );

const writeExecutable = (filePath: string, contents = "cloudflared") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fileSystem.makeDirectory(paths.dirname(filePath), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(filePath, contents);
    yield* fileSystem.chmod(filePath, 0o755);
  });

// Use an actual child so its stdout and its exit status follow the platform spawner's contract.
const versionProcess = (outcome: (executable: string) => { output: string; exitCode: number }) =>
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "version") {
        return Effect.die("Unexpected command in relay version fixture");
      }
      const { output, exitCode } = outcome(command.command);
      return native.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            "process.stdout.write(process.argv[1]); process.exitCode = Number(process.argv[2])",
            output,
            String(exitCode),
          ],
          { stdin: "ignore", stderr: "ignore" },
        ),
      );
    });
  }).pipe(Effect.provide(NodeServices.layer));

type RelayClientTestServices =
  | Layer.Success<
      ReturnType<typeof layerHostRuntime> | typeof NodeServices.layer | typeof NodeCrypto.layer
    >
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

const managedPathFor = (
  paths: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform = "linux",
  layout: "current" | "legacy" = "current",
) =>
  paths.join(
    baseDir,
    "tools",
    "cloudflared",
    ...(layout === "current" ? ["install"] : []),
    version,
    `${platform}-x64`,
    platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );

const legacyLockPathFor = (
  paths: Path.Path,
  baseDir: string,
  platform: NodeJS.Platform = "linux",
) => `${managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION, platform, "legacy")}.lock`;

// The simulated platform's exec bits live here because NTFS cannot hold them.
const withModeModel = (fileSystem: FileSystem.FileSystem) => {
  const modes = new Map<string, number>();
  return FileSystem.make({
    ...fileSystem,
    chmod: (target, mode) =>
      fileSystem
        .chmod(target, mode)
        .pipe(Effect.tap(() => Effect.sync(() => modes.set(target, mode)))),
    rename: (from, to) =>
      fileSystem.rename(from, to).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const mode = modes.get(from);
            if (mode !== undefined) modes.set(to, mode);
            modes.delete(from);
          }),
        ),
      ),
    stat: (target) =>
      fileSystem.stat(target).pipe(
        Effect.map((info) => {
          const mode = modes.get(target);
          return mode === undefined ? info : { ...info, mode: (info.mode & ~0o777) | mode };
        }),
      ),
  });
};

// Last in a merge so it replaces the plain file system of NodeServices.layer.
const layerModeledFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, withModeModel),
).pipe(Layer.provide(NodeServices.layer));

const layerNodeServices = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  layerModeledFileSystem,
);

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: code === "EBUSY" ? "Busy" : code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(code), { code }),
  });

/** Windows renames a directory over an existing file, where POSIX refuses it with ENOTDIR. */
const renamingOverFiles = (fileSystem: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...fileSystem,
  rename: (from, to) =>
    fileSystem.stat(to).pipe(
      Effect.option,
      Effect.flatMap((target) =>
        Option.isSome(target) && target.value.type === "File" ? fileSystem.remove(to) : Effect.void,
      ),
      Effect.andThen(fileSystem.rename(from, to)),
    ),
});

type InstallRename = "staging" | "activation";

const makeLockedRenames = (
  fileSystem: FileSystem.FileSystem,
  input: { readonly rename: InstallRename; readonly failures: number; readonly code: string },
) =>
  Effect.gen(function* () {
    const firstAttempt = yield* Deferred.make<void>();
    const renames = { attempts: 0 };
    const locked = FileSystem.make({
      ...fileSystem,
      rename: (from, to) =>
        Effect.suspend(() => {
          if ((to.endsWith(".tmp") ? "staging" : "activation") !== input.rename) {
            return fileSystem.rename(from, to);
          }
          renames.attempts += 1;
          return renames.attempts <= input.failures
            ? Deferred.succeed(firstAttempt, undefined).pipe(
                Effect.andThen(Effect.fail(renameError(input.code, to))),
              )
            : fileSystem.rename(from, to);
        }),
    });
    return { locked, renames, firstAttempt };
  });

const staleLockTime = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

const testBinary = new TextEncoder().encode("test-cloudflared-binary");
const testReleaseAsset = {
  url: "https://example.test/cloudflared",
  sha256: Hex.encode(sha256(testBinary)),
  archive: "binary",
} as const;

// A simulated Windows renames over files on every host, so a lock test never relies on rename refusing one.
const layerWindowsRenames = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fileSystem) => FileSystem.make(renamingOverFiles(fileSystem))),
).pipe(Layer.provide(layerNodeServices));

const layerInstallRuntime = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    platform === "win32"
      ? Layer.mergeAll(layerNodeServices, layerWindowsRenames)
      : layerNodeServices,
    layerHttpClient(testBinary),
    layerSpawner([]),
    layerHostRuntime({ PATH: "" }, platform),
  );

describe("RelayClient", () => {
  it.effect.each(["live owner", "unknown owner", "recent file"] as const)(
    "preserves a recent legacy lock while waiting (%s)",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
        const lockPath = legacyLockPathFor(paths, baseDir, "win32");
        const owner = kind === "live owner" ? `${process.pid}-still-running` : "unknown-owner";
        yield* fs.makeDirectory(paths.dirname(lockPath), { recursive: true });
        if (kind === "recent file") {
          yield* fs.writeFileString(lockPath, "legacy-installer");
        } else {
          yield* fs.makeDirectory(lockPath);
          yield* fs.writeFileString(paths.join(lockPath, owner), "");
        }
        const written = yield* fs.stat(lockPath);
        yield* TestClock.setTime(Option.getOrThrow(written.mtime).getTime() + 6_000);
        const waiting = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        });
        const installing = yield* manager
          .installWithProgress((event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Effect.die("Download started while a recent legacy lock was held")
              : Effect.void,
          )
          .pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
            }),
            Effect.forkChild,
          );
        yield* Effect.raceFirst(
          Deferred.await(waiting),
          Fiber.join(installing).pipe(
            Effect.andThen(Effect.die("Install finished without waiting for the legacy lock")),
          ),
        );
        yield* Fiber.interrupt(installing);
        if (kind === "recent file") {
          expect(yield* fs.readFileString(lockPath)).toBe("legacy-installer");
        } else {
          expect(yield* fs.readDirectory(lockPath)).toEqual([owner]);
        }
      }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("win32"))),
  );

  it.effect("installs separately when a legacy installer claims its path after inspection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const legacyLock = legacyLockPathFor(paths, baseDir, "win32");
      yield* fs.makeDirectory(paths.dirname(legacyLock), { recursive: true });
      let claimed = false;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (target) =>
            fs.stat(target).pipe(
              Effect.tapError(() =>
                target === legacyLock && !claimed
                  ? fs.writeFileString(legacyLock, "legacy-installer", { flag: "wx" }).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          claimed = true;
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      expect(yield* manager.install).toMatchObject({
        status: "available",
        executablePath: managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION, "win32"),
      });
      expect(claimed).toBe(true);
      expect(yield* fs.readFileString(legacyLock)).toBe("legacy-installer");
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("win32"))),
  );

  it.effect.each(["legacy file", "owned directory"] as const)(
    "preserves a %s that replaced a stale legacy lock after inspection",
    (replacement) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const lockPath = legacyLockPathFor(paths, baseDir, "win32");
        const owner = `${process.pid}-fresh-installer`;
        yield* fileSystem.makeDirectory(paths.dirname(lockPath), { recursive: true });
        yield* fileSystem.writeFileString(lockPath, "");
        // The replacement's real mtime is after this clock, so only the stale lock looks expired.
        yield* fileSystem.utimes(lockPath, staleLockTime, staleLockTime);
        yield* TestClock.setTime(staleLockTime.getTime() + 3_600_000);
        let replaced = false;
        // A second process clears the stale lock, then a third acquires that same path.
        const replaceStaleLock = Effect.suspend(() => {
          if (replaced) return Effect.void;
          replaced = true;
          return fileSystem
            .remove(lockPath)
            .pipe(
              Effect.andThen(
                replacement === "legacy file"
                  ? fileSystem.writeFileString(lockPath, "fresh-installer")
                  : fileSystem
                      .makeDirectory(lockPath)
                      .pipe(
                        Effect.andThen(fileSystem.writeFileString(paths.join(lockPath, owner), "")),
                      ),
              ),
            );
        });
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (target) =>
              fileSystem
                .stat(target)
                .pipe(Effect.tap(() => (target === lockPath ? replaceStaleLock : Effect.void))),
          }),
        );
        expect(yield* manager.install).toMatchObject({
          status: "available",
          executablePath: managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION, "win32"),
        });
        expect(replaced).toBe(true);
        if (replacement === "legacy file") {
          expect(yield* fileSystem.readFileString(lockPath)).toBe("fresh-installer");
        } else {
          expect(yield* fileSystem.readDirectory(lockPath)).toEqual([owner]);
        }
        const entries = yield* fileSystem.readDirectory(paths.dirname(lockPath));
        expect(entries.filter((entry) => entry.startsWith(".lock-stale-"))).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("win32"))),
  );

  it.effect("ignores a fresh legacy lock owned by an exited process without removing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = legacyLockPathFor(paths, baseDir);
      const marker = "2147483647-exited-installer";
      yield* fs.makeDirectory(lockPath, { recursive: true });
      yield* fs.writeFileString(paths.join(lockPath, marker), "");
      yield* fs.utimes(lockPath, staleLockTime, staleLockTime);
      yield* TestClock.setTime(staleLockTime.getTime());
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      const clock = yield* Clock.Clock;
      let waitingForLock = false;
      const installed = yield* manager
        .installWithProgress((event) =>
          Effect.sync(() => {
            if (event.type === "progress") waitingForLock = event.stage === "waiting_for_lock";
          }),
        )
        .pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              waitingForLock
                ? Effect.die("A fresh lock with only an exited owner must not delay installation")
                : clock.sleep(duration),
          }),
        );
      expect(installed).toMatchObject({
        executablePath: managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION),
      });
      expect(yield* fs.readDirectory(lockPath)).toEqual([marker]);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect("installs alongside a stale file left by a legacy installer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const lockPath = legacyLockPathFor(paths, baseDir);
      yield* fileSystem.makeDirectory(paths.dirname(lockPath), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(lockPath, "");
      const written = yield* fileSystem.stat(lockPath);
      const mtime = Option.getOrThrow(written.mtime).getTime();
      // File mtimes use wall time; advance the test clock past legacy expiry.
      yield* TestClock.setTime(mtime + 60 * 60 * 1_000);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });

      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.readFileString(lockPath)).toBe("");
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect(
    "keeps the lock across independent managers after 31 minutes and releases on cancel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
        const baseInfo = yield* fs.stat(baseDir);
        yield* TestClock.setTime(Option.getOrThrow(baseInfo.mtime).getTime());
        const owner = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        });
        const contender = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        });
        const downloading = yield* Deferred.make<void>();
        const installing = yield* owner
          .installWithProgress((event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Effect.raceFirst(
          Deferred.await(downloading),
          Fiber.join(installing).pipe(
            Effect.andThen(Effect.die("The owner installed without reaching the download gate")),
          ),
        );
        yield* TestClock.adjust("31 minutes");

        const waiting = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        const contended = yield* contender
          .installWithProgress((event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Effect.die("A second manager started downloading while the owner was active")
              : Effect.void,
          )
          .pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
            }),
            Effect.forkChild,
          );
        yield* Effect.raceFirst(
          Deferred.await(waiting),
          Fiber.join(contended).pipe(
            Effect.andThen(Effect.die("The contender installed while the owner was active")),
          ),
        );
        yield* Fiber.interrupt(contended);

        // Let a legacy installer hold its path for part of the contender's wait, then release it.
        // The current owner's transaction remains held for the whole wait.
        const legacyLock = legacyLockPathFor(paths, baseDir);
        const legacyTime = DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        yield* fs.makeDirectory(paths.dirname(legacyLock), { recursive: true });
        yield* fs.writeFileString(legacyLock, "legacy-installer");
        yield* fs.utimes(legacyLock, legacyTime, legacyTime);
        let retries = 0;
        const exhausted = yield* contender
          .installWithProgress((event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Effect.die("Cancelling a contender released the active owner's lock")
              : Effect.void,
          )
          .pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: () =>
                Effect.suspend(() => {
                  retries += 1;
                  expect(retries).toBeLessThan(100);
                  return retries === 37 ? fs.remove(legacyLock).pipe(Effect.orDie) : Effect.void;
                }),
            }),
            Effect.flip,
          );
        expect(exhausted.reason).toBe("install_locked");
        expect(retries).toBe(99);

        yield* Fiber.interrupt(installing);
        expect(yield* contender.install).toMatchObject({ status: "available" });
      }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect("reports an unusable lock database without spending the contention budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      yield* fs.makeDirectory(
        paths.join(baseDir, "tools", "cloudflared", "install-linux-x64.sqlite"),
        {
          recursive: true,
        },
      );
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      const clock = yield* Clock.Clock;
      const error = yield* manager.install.pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: () => Effect.die("An unusable lock database must fail without retrying"),
        }),
        Effect.flip,
      );
      expect(error.reason).toBe("write_failed");
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect.skipIf(windowsHost)(
    "removes a staged client whose rename lands after cancellation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const scope = yield* Effect.scope;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const directory = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64`;
        const renamePending = yield* Deferred.make<void>();
        const allowRename = yield* Deferred.make<void>();
        const renameFinished = yield* Deferred.make<void, PlatformError.PlatformError>();
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            // Like Node's rename, the staging rename completes even if its caller is interrupted.
            rename: (from, to) =>
              to.endsWith(".tmp")
                ? Effect.forkIn(
                    Deferred.complete(
                      renameFinished,
                      Deferred.await(allowRename).pipe(Effect.andThen(fileSystem.rename(from, to))),
                    ),
                    scope,
                  ).pipe(
                    Effect.andThen(Deferred.succeed(renamePending, undefined)),
                    Effect.andThen(Deferred.await(renameFinished)),
                  )
                : fileSystem.rename(from, to),
            // Land the rename before the install temp directory is removed.
            remove: (path, options) =>
              path.endsWith(".tmp")
                ? fileSystem
                    .remove(path, options)
                    .pipe(
                      Effect.andThen(Deferred.succeed(allowRename, undefined)),
                      Effect.andThen(Deferred.await(renameFinished)),
                    )
                : fileSystem.remove(path, options),
          }),
        );

        const installing = yield* manager.install.pipe(Effect.forkChild);
        yield* Deferred.await(renamePending);
        yield* Effect.yieldNow;
        const cancelling = yield* Fiber.interrupt(installing).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(allowRename, undefined);
        yield* Fiber.join(cancelling);
        yield* Deferred.await(renameFinished);

        expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect("downloads, verifies, validates, and atomically installs the managed executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const bytes = new TextEncoder().encode("test-cloudflared-binary");
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const progress: Array<string> = [];
      const installed = yield* manager.installWithProgress((event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
      );
      const managedPath = managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION);
      expect(installed).toEqual({
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
      expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
        "test-cloudflared-binary",
      );
      expect(progress).toEqual([
        "checking",
        "waiting_for_lock",
        "downloading",
        "verifying",
        "installing",
        "validating",
        "activating",
      ]);
      expect(yield* manager.resolve).toEqual(installed);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerNodeServices,
          layerHttpClient(new TextEncoder().encode("test-cloudflared-binary")),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)(
    "installs when the downloaded binary's first launch is held by an antivirus scan",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const scanning = yield* Deferred.make<void>();
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: testReleaseAsset,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Deferred.succeed(scanning, undefined).pipe(
                Effect.andThen(Effect.sleep("25 seconds")),
                Effect.as(
                  makeHandle(
                    0,
                    `cloudflared version ${RelayClient.CLOUDFLARED_VERSION} (built 2026-01-01-00:00 UTC)\n`,
                  ),
                ),
              ),
            ),
          ),
        );

        const installing = yield* manager.install.pipe(Effect.forkChild);
        yield* Deferred.await(scanning);
        yield* TestClock.adjust("25 seconds");

        expect(yield* Fiber.join(installing)).toMatchObject({
          status: "available",
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );

  it.effect("releases the install lock after an invalid checksum", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("tampered"))),
          archive: "binary",
        },
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClient.RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
      const next = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      expect(yield* next.install).toMatchObject({ status: "available" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerNodeServices,
          layerHttpClient(testBinary),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands).toHaveLength(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerNodeServices,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });

  it.effect("observes hydrated PATH changes after the manager has been constructed", () => {
    const configEnv = { PATH: "" };
    const hostEnv = { PATH: "" };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const paths = yield* Path.Path;
      const binDir = paths.join(baseDir, "bin");
      const executablePath = paths.join(binDir, executableName);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
      });

      const resolveWithStaleConfig = manager.resolve.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: configEnv }),
        ),
        Effect.provideService(HostProcess.Environment, hostEnv),
      );

      expect(yield* resolveWithStaleConfig).toEqual({
        status: "missing",
        version: RelayClient.CLOUDFLARED_VERSION,
      });

      yield* fileSystem.makeDirectory(binDir);
      yield* fileSystem.writeFileString(executablePath, "cloudflared");
      yield* fileSystem.chmod(executablePath, 0o755);
      hostEnv.PATH = binDir;

      expect(yield* resolveWithStaleConfig).toEqual({
        status: "available",
        executablePath,
        source: "path",
        version: RelayClient.CLOUDFLARED_VERSION,
      });

      const resolveWithOverride = manager.resolve.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { PATH: "", T3CODE_CLOUDFLARED_PATH: executablePath },
          }),
        ),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      );
      expect(yield* resolveWithOverride).toEqual({
        status: "available",
        executablePath,
        source: "override",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerNodeServices,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime(configEnv, hostPlatform),
        ),
      ),
    );
  });

  describe("version selection", () => {
    const run = <A, E>(
      body: (baseDir: string) => Effect.Effect<A, E, RelayClientTestServices>,
      options: { readonly versions?: Record<string, string> } = {},
    ) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        return yield* body(baseDir);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            layerNodeServices,
            layerHttpClient(new Uint8Array()),
            layerSpawner([], options.versions),
            layerHostRuntime({ PATH: "" }, hostPlatform),
          ),
        ),
      );

    it.effect(
      "rechecks an unchanged executable after its version command prints the pin and exits nonzero",
      () =>
        run((baseDir) =>
          Effect.gen(function* () {
            const paths = yield* Path.Path;
            const executable = paths.join(baseDir, executableName);
            yield* writeExecutable(executable);
            let code = 1;
            let starts = 0;
            const spawner = yield* versionProcess(() => {
              starts++;
              return {
                output: "cloudflared version " + RelayClient.CLOUDFLARED_VERSION,
                exitCode: code,
              };
            });
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
            const resolve = manager.resolve.pipe(
              Effect.provideService(HostProcess.Environment, { PATH: baseDir }),
            );
            expect((yield* resolve).status).toBe("missing");
            code = 0;
            expect(yield* resolve).toMatchObject({
              status: "available",
              source: "path",
              executablePath: executable,
            });
            expect((yield* resolve).status).toBe("available");
            expect(starts).toBe(2);
          }),
        ),
    );
    it.effect(
      "rejects a downloaded binary whose version command prints the pin and exits nonzero",
      () =>
        run((baseDir) =>
          Effect.gen(function* () {
            const spawner = yield* versionProcess(() => ({
              output: "cloudflared version " + RelayClient.CLOUDFLARED_VERSION,
              exitCode: 1,
            }));
            const manager = yield* RelayClient.makeCloudflaredRelayClient({
              baseDir,
              releaseAsset: testReleaseAsset,
            }).pipe(
              Effect.provide(layerHttpClient(testBinary)),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
            const outcome = yield* manager.install.pipe(
              Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "installed" }),
            );
            expect(outcome).toBe("validation_failed");
            const fileSystem = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const destination = managedPathFor(
              paths,
              baseDir,
              RelayClient.CLOUDFLARED_VERSION,
              hostPlatform,
            );
            expect(yield* fileSystem.exists(destination)).toBe(false);
            expect((yield* manager.resolve).status).toBe("missing");
          }),
        ),
    );
    it.effect("skips binaries older than the minimum version", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const paths = yield* Path.Path;
            const oldPath = paths.join(baseDir, "old", executableName);
            const newPath = paths.join(baseDir, "new", executableName);
            yield* writeExecutable(oldPath);
            yield* writeExecutable(newPath);
            const managed = managedPathFor(yield* Path.Path, baseDir, "2026.10.0", hostPlatform);
            yield* writeExecutable(managed);
            versions[managed] = "2026.10.0";
            versions[oldPath] = "2026.10.2";
            versions[newPath] = "2026.10.3";
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const env = {
              PATH: [paths.dirname(oldPath), paths.dirname(newPath)].join(pathDelimiter),
            };
            expect(
              yield* manager.resolve.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env }),
                ),
                Effect.provideService(HostProcess.Environment, env),
              ),
            ).toEqual({
              status: "available",
              executablePath: newPath,
              source: "path",
              version: RelayClient.CLOUDFLARED_MIN_VERSION,
            });
          }),
        { versions },
      );
    });
    it.effect.skipIf(windowsHost)(
      "finds a PATH binary through an empty entry by its absolute path",
      () =>
        run((baseDir) =>
          Effect.gen(function* () {
            const cwd = `${baseDir}/work`;
            const inCwd = `${cwd}/cloudflared`;
            yield* writeExecutable(inCwd);
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const resolveWith = (searchPath: string) => {
              const env = { PATH: searchPath };
              return manager.resolve.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env }),
                ),
                Effect.provideService(HostProcess.Environment, env),
                Effect.provideService(HostProcess.WorkingDirectory, cwd),
              );
            };
            const found = {
              status: "available",
              executablePath: inCwd,
              source: "path",
              version: RelayClient.CLOUDFLARED_VERSION,
            };

            expect(yield* resolveWith(`:${baseDir}/missing`)).toEqual(found);
            expect(yield* resolveWith(`${baseDir}/missing:`)).toEqual(found);
            const missing = { status: "missing", version: RelayClient.CLOUDFLARED_VERSION };
            // An empty PATH searches nothing, not even the working directory.
            expect(yield* resolveWith("")).toEqual(missing);
            // A whitespace entry is not an empty one.
            expect(yield* resolveWith(` :${baseDir}/missing`)).toEqual(missing);
            expect(yield* resolveWith(`${baseDir}/missing: `)).toEqual(missing);
          }),
        ),
    );

    it.effect("reuses an existing pinned install in the legacy directory", () =>
      run((baseDir) =>
        Effect.gen(function* () {
          const paths = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const legacy = managedPathFor(
            paths,
            baseDir,
            RelayClient.CLOUDFLARED_VERSION,
            hostPlatform,
            "legacy",
          );
          yield* writeExecutable(legacy);
          const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
          expect(yield* manager.resolve).toMatchObject({
            source: "managed",
            executablePath: legacy,
          });
          expect(yield* manager.install).toMatchObject({
            source: "managed",
            executablePath: legacy,
          });
          expect(
            yield* fs.exists(
              managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION, hostPlatform),
            ),
          ).toBe(false);
        }),
      ),
    );

    it.effect.each([RelayClient.CLOUDFLARED_VERSION, RelayClient.CLOUDFLARED_MIN_VERSION])(
      "reuses the previous install layout from release folder %s while offline",
      (folder) =>
        run((baseDir) =>
          Effect.gen(function* () {
            const paths = yield* Path.Path;
            const fs = yield* FileSystem.FileSystem;
            const legacy = managedPathFor(paths, baseDir, folder, hostPlatform, "legacy");
            const previous = paths.join(paths.dirname(legacy), "install", executableName);
            yield* writeExecutable(previous);
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("A pinned binary is already installed")),
              ),
            );
            const selected = {
              executablePath: previous,
              source: "managed",
              version: RelayClient.CLOUDFLARED_VERSION,
            };
            expect(yield* manager.resolve).toMatchObject(selected);
            expect(yield* manager.install).toMatchObject(selected);
            expect(yield* manager.pruneManagedVersions).toBe(true);
            expect(yield* fs.readFileString(previous)).toBe("cloudflared");
            expect(
              yield* fs.exists(
                managedPathFor(paths, baseDir, RelayClient.CLOUDFLARED_VERSION, hostPlatform),
              ),
            ).toBe(false);
          }),
        ),
    );

    it.effect("prefers the legacy pin over an older executable in the current layout", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const paths = yield* Path.Path;
            const pinned = RelayClient.CLOUDFLARED_VERSION;
            const current = managedPathFor(paths, baseDir, pinned, hostPlatform);
            const legacy = managedPathFor(paths, baseDir, pinned, hostPlatform, "legacy");
            yield* writeExecutable(current);
            yield* writeExecutable(legacy);
            versions[current] = RelayClient.CLOUDFLARED_MIN_VERSION;
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const resolved = { source: "managed", version: pinned, executablePath: legacy };

            expect(yield* manager.resolve).toMatchObject(resolved);
            expect(yield* manager.install).toMatchObject(resolved);
          }),
        { versions },
      );
    });

    it.effect.each(["current", "legacy"] as const)(
      "finds the exact pin in an older %s folder before a newer compatible folder",
      (layout) => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const paths = yield* Path.Path;
              const pinned = RelayClient.CLOUDFLARED_VERSION;
              const exact = managedPathFor(paths, baseDir, "2025.9.0", hostPlatform, layout);
              const otherLayout = layout === "current" ? "legacy" : "current";
              const sibling = managedPathFor(paths, baseDir, "2025.9.0", hostPlatform, otherLayout);
              const fallback = managedPathFor(
                paths,
                baseDir,
                RelayClient.CLOUDFLARED_MIN_VERSION,
                hostPlatform,
                otherLayout,
              );
              yield* writeExecutable(exact);
              yield* writeExecutable(sibling);
              yield* writeExecutable(fallback);
              versions[exact] = pinned;
              versions[sibling] = "2025.9.0";
              versions[fallback] = RelayClient.CLOUDFLARED_MIN_VERSION;
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
              const selected = { source: "managed", version: pinned, executablePath: exact };

              expect(yield* manager.resolve).toMatchObject(selected);
              expect(yield* manager.install).toMatchObject(selected);
              const fs = yield* FileSystem.FileSystem;
              yield* fs.remove(fallback);
              expect(yield* manager.resolve).toMatchObject(selected);
            }),
          { versions },
        );
      },
    );

    it.effect.each([
      ["2025.6.1", RelayClient.CLOUDFLARED_MIN_VERSION, "legacy"],
      [RelayClient.CLOUDFLARED_MIN_VERSION, "2025.6.1", "current"],
      [RelayClient.CLOUDFLARED_MIN_VERSION, RelayClient.CLOUDFLARED_MIN_VERSION, "current"],
      ["2025.6.1", "2025.9.0", "current"],
    ] as const)(
      "selects the compatible fallback for current %s and legacy %s from the %s layout",
      ([currentVersion, legacyVersion, preferred]) => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const paths = yield* Path.Path;
              const current = managedPathFor(
                paths,
                baseDir,
                RelayClient.CLOUDFLARED_MIN_VERSION,
                hostPlatform,
              );
              const legacy = managedPathFor(
                paths,
                baseDir,
                RelayClient.CLOUDFLARED_MIN_VERSION,
                hostPlatform,
                "legacy",
              );
              yield* writeExecutable(current);
              yield* writeExecutable(legacy);
              versions[current] = currentVersion;
              versions[legacy] = legacyVersion;
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
              const executablePath = preferred === "current" ? current : legacy;
              expect(yield* manager.resolve).toMatchObject({
                executablePath,
                source: "managed",
                version: versions[executablePath],
              });
            }),
          { versions },
        );
      },
    );

    it.effect("reports an outdated override as missing", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const paths = yield* Path.Path;
            const overridePath = paths.join(baseDir, "override", executableName);
            yield* writeExecutable(overridePath);
            versions[overridePath] = "2026.10.2";
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const env = { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath };
            const withEnv = Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env }),
            );
            expect(yield* manager.resolve.pipe(withEnv)).toEqual({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            });
            const error = yield* manager.install.pipe(withEnv, Effect.flip);
            expect(error.reason).toBe("override_missing");
          }),
        { versions },
      );
    });

    it.effect(
      "prefers the pinned release, then the newest older managed release, then PATH",
      () => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const paths = yield* Path.Path;
              const binDir = paths.join(baseDir, "bin");
              const pathBinary = paths.join(binDir, executableName);
              const managed = (version: string) =>
                managedPathFor(paths, baseDir, version, hostPlatform);
              const older = managed("2025.9.0");
              const newer = managed(RelayClient.CLOUDFLARED_MIN_VERSION);
              const pinned = managed(RelayClient.CLOUDFLARED_VERSION);
              const newerServer = managed("2099.1.0");
              versions[newerServer] = "2099.1.0";
              yield* writeExecutable(newerServer);
              versions[pathBinary] = "2026.10.3";
              versions[older] = "2025.9.0";
              versions[newer] = "2026.10.3";
              yield* writeExecutable(pathBinary);
              yield* writeExecutable(older);
              yield* writeExecutable(newer);
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
              const resolveWith = manager.resolve.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: { PATH: binDir } }),
                ),
                Effect.provideService(HostProcess.Environment, { PATH: binDir }),
              );

              expect(yield* resolveWith).toMatchObject({ source: "managed", version: "2026.10.3" });

              yield* writeExecutable(pinned);
              expect(yield* resolveWith).toMatchObject({
                executablePath: pinned,
                source: "managed",
                version: RelayClient.CLOUDFLARED_VERSION,
              });

              yield* manager.pruneManagedVersions;
              expect(
                (yield* fileSystem.readDirectory(
                  paths.join(baseDir, "tools", "cloudflared", "install"),
                )).sort(),
              ).toEqual([
                RelayClient.CLOUDFLARED_MIN_VERSION,
                RelayClient.CLOUDFLARED_VERSION,
                "2099.1.0",
              ]);

              yield* fileSystem.remove(pinned);
              expect(yield* resolveWith).toMatchObject({ source: "managed", version: "2026.10.3" });
              yield* fileSystem.remove(newer);
              expect(yield* resolveWith).toMatchObject({ source: "path", version: "2026.10.3" });
            }),
          { versions },
        );
      },
    );

    it.effect("prunes only older executables owned by the current cache", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const pinned = RelayClient.CLOUDFLARED_VERSION;
            const managed = (version: string, layout: "current" | "legacy" = "current") =>
              managedPathFor(paths, baseDir, version, hostPlatform, layout);
            const legacyPin = managed(pinned, "legacy");
            const currentFallback = managed(pinned);
            const legacyOld = managed("2025.9.0", "legacy");
            const rollback = managed(RelayClient.CLOUDFLARED_MIN_VERSION);
            const old = managed("2025.9.0");
            const relocatedPin = managed("2025.8.0");
            const upgraded = managed("2025.7.0");
            const unreadableVersion = managed("2025.6.1");
            const foreign = paths.join(
              paths.dirname(paths.dirname(old)),
              `${hostPlatform}-arm64`,
              executableName,
            );
            const preserved = [
              legacyPin,
              currentFallback,
              legacyOld,
              paths.join(`${legacyOld}.lock`, `${process.pid}-legacy-installer`),
              paths.join(paths.dirname(legacyOld), ".install-legacy", executableName),
              rollback,
              relocatedPin,
              upgraded,
              unreadableVersion,
              foreign,
              paths.join(paths.dirname(old), ".install-current", executableName),
              `${old}.staged.tmp`,
            ];
            versions[legacyOld] = "2025.9.0";
            versions[currentFallback] = "2026.9.3";
            versions[rollback] = RelayClient.CLOUDFLARED_MIN_VERSION;
            versions[old] = "2025.9.0";
            versions[upgraded] = "2099.1.0";
            versions[unreadableVersion] = "unparseable";
            for (const file of [...preserved, old]) yield* writeExecutable(file);
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });

            expect(yield* manager.resolve).toMatchObject({ executablePath: legacyPin });
            expect(yield* manager.pruneManagedVersions).toBe(true);

            expect(yield* fs.exists(old)).toBe(false);
            for (const file of preserved) {
              expect(yield* fs.readFileString(file), file).toBe("cloudflared");
            }
            expect(yield* manager.resolve).toMatchObject({ executablePath: legacyPin });
          }),
        { versions },
      );
    });

    it.effect.each(["empty", "plausible"] as const)(
      "retries pruning after a nonzero version command with %s stdout",
      (outputKind) =>
        run((baseDir) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const old = managedPathFor(paths, baseDir, "2025.9.0", hostPlatform);
            const rollback = managedPathFor(
              paths,
              baseDir,
              RelayClient.CLOUDFLARED_MIN_VERSION,
              hostPlatform,
            );
            yield* writeExecutable(old);
            yield* writeExecutable(rollback);

            let failing = true;
            let oldProbes = 0;
            const spawner = yield* versionProcess((executable) => {
              if (executable === rollback) {
                return {
                  output: `cloudflared version ${RelayClient.CLOUDFLARED_MIN_VERSION}`,
                  exitCode: 0,
                };
              }
              expect(executable).toBe(old);
              oldProbes++;
              return {
                output: failing && outputKind === "empty" ? "" : "cloudflared version 2025.9.0",
                exitCode: failing ? 1 : 0,
              };
            });
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );

            expect(yield* manager.pruneManagedVersions).toBe(false);
            expect(yield* fs.readFileString(old)).toBe("cloudflared");
            expect(yield* fs.readFileString(rollback)).toBe("cloudflared");

            failing = false;
            expect(yield* manager.pruneManagedVersions).toBe(true);
            expect(oldProbes).toBe(2);
            expect(yield* fs.exists(old)).toBe(false);
            expect(yield* fs.readFileString(rollback)).toBe("cloudflared");
          }),
        ),
    );

    it.effect.each(["readDirectory", "stat", "version", "remove"] as const)(
      "retries incomplete cache cleanup after %s recovers",
      (operation) => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const paths = yield* Path.Path;
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const root = paths.join(baseDir, "tools", "cloudflared", "install");
              const old = managedPathFor(paths, baseDir, "2025.9.0", hostPlatform);
              const rollback = managedPathFor(
                paths,
                baseDir,
                RelayClient.CLOUDFLARED_MIN_VERSION,
                hostPlatform,
              );
              versions[old] = "2025.9.0";
              versions[rollback] = RelayClient.CLOUDFLARED_MIN_VERSION;
              yield* writeExecutable(old);
              yield* writeExecutable(rollback);

              let failing = true;
              const failure = Effect.fail(
                PlatformError.systemError({
                  _tag: operation === "remove" ? "Busy" : "PermissionDenied",
                  module: operation === "version" ? "ChildProcess" : "FileSystem",
                  method: operation,
                  pathOrDescriptor: operation === "readDirectory" ? root : old,
                }),
              );
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
                Effect.provideService(
                  FileSystem.FileSystem,
                  FileSystem.make({
                    ...fs,
                    readDirectory: (dir) =>
                      failing && operation === "readDirectory" && dir === root
                        ? failure
                        : fs.readDirectory(dir),
                    stat: (file) =>
                      failing && operation === "stat" && file === old ? failure : fs.stat(file),
                    remove: (file, options) =>
                      failing && operation === "remove" && file === old
                        ? failure
                        : fs.remove(file, options),
                  }),
                ),
                Effect.provideService(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make((cmd) =>
                    failing &&
                    operation === "version" &&
                    ChildProcess.isStandardCommand(cmd) &&
                    cmd.command === old
                      ? failure
                      : spawner.spawn(cmd),
                  ),
                ),
              );
              expect(yield* manager.pruneManagedVersions).toBe(false);
              expect(yield* fs.exists(old)).toBe(true);
              expect(yield* fs.exists(rollback)).toBe(true);
              if (operation === "readDirectory") {
                expect((yield* manager.resolve).status).toBe("missing");
              }
              failing = false;
              expect(yield* manager.pruneManagedVersions).toBe(true);
              expect(yield* fs.exists(old)).toBe(false);
              expect(yield* fs.exists(rollback)).toBe(true);
            }),
          { versions },
        );
      },
    );

    it.effect("does not prune while an independent manager is installing", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const pinned = RelayClient.CLOUDFLARED_VERSION;
            const currentPin = managedPathFor(paths, baseDir, pinned, hostPlatform);
            const rollback = managedPathFor(
              paths,
              baseDir,
              RelayClient.CLOUDFLARED_MIN_VERSION,
              hostPlatform,
            );
            const old = managedPathFor(paths, baseDir, "2025.9.0", hostPlatform);
            versions[rollback] = RelayClient.CLOUDFLARED_MIN_VERSION;
            versions[old] = "2025.9.0";
            yield* writeExecutable(rollback);
            yield* writeExecutable(old);
            const installer = yield* RelayClient.makeCloudflaredRelayClient({
              baseDir,
              releaseAsset: testReleaseAsset,
            });
            const pruner = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const downloading = yield* Deferred.make<void>();
            const installing = yield* installer
              .installWithProgress((event) =>
                event.type === "progress" && event.stage === "downloading"
                  ? Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              )
              .pipe(Effect.forkChild);
            yield* Effect.raceFirst(
              Deferred.await(downloading),
              Fiber.join(installing).pipe(
                Effect.andThen(Effect.die("Install finished without reaching the download gate")),
              ),
            );
            const directory = paths.dirname(currentPin);
            const staging = (yield* fs.readDirectory(directory)).filter((name) =>
              name.startsWith(".install-"),
            );
            expect(staging).toHaveLength(1);
            const activeArtifact = paths.join(directory, staging[0]!, "download.part");
            yield* fs.writeFileString(activeArtifact, "active install");
            const legacyPin = managedPathFor(paths, baseDir, pinned, hostPlatform, "legacy");
            yield* writeExecutable(legacyPin);
            const clock = yield* Clock.Clock;
            const completed = yield* pruner.pruneManagedVersions.pipe(
              Effect.provideService(Clock.Clock, {
                ...clock,
                sleep: () => Effect.die("Pruning must not wait for an active install"),
              }),
            );

            expect(completed).toBe(false);
            expect(yield* fs.readFileString(activeArtifact)).toBe("active install");
            expect(yield* fs.exists(old)).toBe(true);
            yield* Fiber.interrupt(installing);
            expect(yield* pruner.pruneManagedVersions).toBe(true);
            expect(yield* fs.exists(old)).toBe(false);
            expect(yield* fs.exists(rollback)).toBe(true);
          }),
        { versions },
      );
    });

    it.effect("keeps a self-updated managed binary as a fallback but still installs the pin", () =>
      run((baseDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const pinned = managedPathFor(
            paths,
            baseDir,
            RelayClient.CLOUDFLARED_VERSION,
            hostPlatform,
          );
          yield* writeExecutable(pinned, "cloudflared version 2026.10.3");
          const bytes = new TextEncoder().encode(
            `cloudflared version ${RelayClient.CLOUDFLARED_VERSION}`,
          );
          // The version probe reads the fixture's contents, including after activation at the same path.
          const spawner = ChildProcessSpawner.make((command) => {
            if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "version") {
              return Effect.die("Unexpected fixture command");
            }
            return fs.readFileString(command.command).pipe(
              Effect.orDie,
              Effect.map((output) => makeHandle(0, output)),
            );
          });
          const manager = yield* RelayClient.makeCloudflaredRelayClient({
            baseDir,
            releaseAsset: { ...testReleaseAsset, sha256: Hex.encode(sha256(bytes)) },
          }).pipe(
            Effect.provide(layerHttpClient(bytes)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const resolved = yield* manager.resolve;
          expect(resolved).toEqual({
            status: "available",
            executablePath: pinned,
            source: "managed",
            version: "2026.10.3",
          });
          expect(
            resolved.status === "available" && RelayClient.isPinnedManagedRelayClient(resolved),
          ).toBe(false);
          const expected = {
            status: "available",
            executablePath: pinned,
            source: "managed",
            version: RelayClient.CLOUDFLARED_VERSION,
          };
          expect(yield* manager.install).toEqual(expected);
          expect(yield* manager.resolve).toEqual(expected);
        }),
      ),
    );
  });

  it("orders and parses cloudflared versions", () => {
    expect(
      RelayClient.parseCloudflaredVersionOutput(
        "cloudflared version 2026.5.2 (built 2026-05-20-10:00 UTC)",
      ),
    ).toBe("2026.5.2");
    expect(RelayClient.parseCloudflaredVersionOutput("Incorrect Usage")).toBeNull();
    expect(RelayClient.compareCloudflaredVersions("2025.10.0", "2025.6.1")).toBeGreaterThan(0);
    expect(RelayClient.compareCloudflaredVersions("2023.8.2", "2025.6.1")).toBeLessThan(0);
  });

  it.effect.each([
    ["linux", "EBUSY"],
    ["win32", "EXDEV"],
  ] as const)("fails staging at once on %s for %s", ([platform, code]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const { locked, renames } = yield* makeLockedRenames(withModeModel(fileSystem), {
        rename: "staging",
        failures: Infinity,
        code,
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked));

      const error = yield* manager.install.pipe(Effect.flip);

      expect(error.message).toBe("Could not stage the relay client.");
      expect(renames.attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime(platform))),
  );
});
