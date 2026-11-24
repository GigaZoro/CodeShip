import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off - expectations use the host platform path and delimiter, which Effect Path does not expose.
import * as NodePath from "node:path";
import * as ModelManifest from "./ModelManifest.ts";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as CodexInstallation from "./CodexInstallation.ts";

const archive = Buffer.from(
  "H4sIAAAAAAAC/+3W0W6DIBQGYB/FcD0sKNSkD7J7aom6tmAQtzXL3n3QZM3qdWVt+n8XoCckJp78wLY3q8bu9Ge2HBbUUp7nYD4H8s9zrNdSsCxnWQLT6JULn8ye09K9h/u2/c0/jSM9xqGzo0+bf3Gdf15WQiD/Kdy61/CA+z8dlO9Wrv2387+c5Z9VZY38p7BY0+Gh8t/sVauLt9Ga9Pnnop7ln1e4/6fxRQ7qZCf/qt3YW0M2OX/JyfvljbCCy3XBSaiGH9VqH4tKuaZbC6qG4aDpTrmP3sQV2nh3Gmxvzqsud0vyjaABAAAAAAAAAAAAAAAk8gOq19rvACgAAA==",
  "base64",
);
const asset = {
  version: "0.156.1",
  target: "aarch64-apple-darwin",
  url: "https://github.com/openai/codex/releases/download/test/package.tar.gz",
  archiveBytes: archive.length,
};
// A host-runnable stand-in: the file is data the fake spawner below reads, because a shell script
// cannot be executed on Windows and a compiled binary cannot be built on every host.
// A "#!" header makes it a script launcher; an ELF header stands for a native binary, which runs only
// with its codex-code-mode-host beside it.
type LocalCodex = {
  version: string;
  appServerFails?: boolean;
  versionFails?: boolean;
  native?: boolean;
  codeModeHost?: boolean;
};
const localFixture = (local: LocalCodex) =>
  `${local.native ? "\x7fELF" : "#!fake-codex"}\n${JSON.stringify(local)}`;
const makeHarness = Effect.fn("test.makeCodexInstallation")(function* (
  input: {
    options?: Partial<CodexInstallation.CodexInstallationOptions>;
    manifestCurrent?: Effect.Effect<ModelManifest.ModelManifestData>;
    body?: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
    downloadStatus?: number;
    baseDir?: string;
    local?: LocalCodex;
    platform?: NodeJS.Platform;
    spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    runtimeRenameFailures?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" }));
  const localDirectory = NodePath.join(baseDir, "local");
  const localBinaryPath = NodePath.join(
    localDirectory,
    `codex${input.platform === "win32" ? ".exe" : ""}`,
  );
  const probeLog = `${baseDir}/local-probes.txt`;
  if (input.local) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* fs.writeFileString(localBinaryPath, localFixture(input.local), { mode: 0o755 });
    if (input.local.codeModeHost)
      yield* fs.writeFileString(
        `${localDirectory}/codex-code-mode-host${input.platform === "win32" ? ".exe" : ""}`,
        "host",
        { mode: 0o755 },
      );
  }
  let downloads = 0;
  const crypto = yield* Crypto.Crypto;
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie));
  let runtimeRenameFailures = input.runtimeRenameFailures ?? 0;
  const failedRenames = yield* Queue.unbounded<void>();
  const lockingFs: FileSystem.FileSystem = {
    ...fs,
    // Suspended so each retry of the same effect is a fresh attempt, like the real rename.
    rename: (from, to) =>
      Effect.suspend(() =>
        /[/\\]runtime$/u.test(from) && runtimeRenameFailures-- > 0
          ? Queue.offer(failedRenames, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                ),
              ),
            )
          : fs.rename(from, to),
      ),
  };
  const realSpawner = input.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || command.command !== localBinaryPath) {
      return realSpawner.spawn(command);
    }
    return Effect.gen(function* () {
      const fixture = JSON.parse(
        (yield* fs.readFileString(localBinaryPath)).split("\n")[1] ?? "",
      ) as {
        version: string;
        appServerFails?: boolean;
        versionFails?: boolean;
      };
      yield* fs.writeFileString(probeLog, `${command.args.join(" ")}\n`, { flag: "a" });
      const [subcommand] = command.args;
      const failed =
        subcommand === "--version"
          ? fixture.versionFails === true
          : subcommand === "app-server"
            ? fixture.appServerFails === true
            : false;
      const stdout = subcommand === "--version" && !failed ? `codex-cli ${fixture.version}\n` : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(failed ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  });
  const installation = yield* CodexInstallation.makeCodexInstallation({
    baseDir,
    releaseAsset: { ...asset, sha256 },
    validate: () => Effect.void,
    ...input.options,
  }).pipe(
    Effect.provideService(ModelManifest.ModelManifest, {
      current: input.manifestCurrent ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(HostProcess.Platform, input.platform ?? "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provideService(HostProcess.Environment, {
      PATH: input.local ? localDirectory : "",
      SystemRoot: "C:\\Windows",
    }),
    Effect.provideService(FileSystem.FileSystem, lockingFs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: input.downloadStatus ?? 200 }),
            ),
            "stream",
            {
              value: input.body ?? Stream.succeed(archive),
            },
          );
        }),
      ),
    ),
  );
  return {
    installation,
    fs,
    baseDir,
    localBinaryPath,
    probeLog,
    failedRenames,
    downloads: () => downloads,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

// These tests emulate POSIX hosts; a Windows filesystem reports no executable mode bits.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("CodexInstallation", () => {
  it.effect.each([
    { version: "0.156.0" },
    { version: "0.156.1" },
    { version: "0.156.2" },
    { version: "0.157.0" },
    { version: "0.156.1", native: true, codeModeHost: true },
  ])(
    "reuses installed Codex %j without downloading or taking ownership of it",
    ({ version, ...local }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ local: { version, ...local } });
        expect(yield* h.installation.start).toMatchObject({
          source: "local",
          phase: "succeeded",
          installedVersion: version,
          executablePath: h.localBinaryPath,
          canRemove: false,
        });
        expect(yield* h.installation.resolve()).toMatchObject({
          source: "local",
          executablePath: h.localBinaryPath,
          managedVersionDirectory: null,
          version,
        });
        yield* h.installation.acquire().pipe(Effect.scoped);
        expect(h.downloads()).toBe(0);
        expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
        expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
          "--version",
          "app-server --help",
        ]);
        yield* h.installation.remove();
        expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
        expect((yield* h.installation.state).source).toBe("local");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect.each([
    { version: "0.128.9" },
    { version: "0.145.0" },
    { version: "0.155.1" },
    { version: "0.155.9" },
    { version: "0.156.1-alpha.1" },
    { version: "unknown" },
    { version: "0.156.1", appServerFails: true },
    { version: "0.156.1", versionFails: true },
    { version: "0.156.1", native: true },
  ])("downloads the pinned release when the local CLI is unsupported or broken: %j", (local) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local });
      expect((yield* h.installation.state).installedVersion).toBeNull();
      yield* h.installation.start;
      const installed = yield* terminalState(h.installation);
      expect(installed.phase).toBe("succeeded");
      const executable = yield* h.installation.resolve();
      expect(executable.source).toBe("managed");
      expect(installed.executablePath).toBe(executable.executablePath);
      expect(h.downloads()).toBe(1);
      expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rechecks compatibility after the local executable is replaced", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version: "0.156.1" } });
      expect((yield* h.installation.resolve()).source).toBe("local");
      yield* h.fs.remove(h.localBinaryPath);
      yield* h.fs.writeFileString(h.localBinaryPath, localFixture({ version: "0.128.9" }), {
        mode: 0o755,
      });
      yield* h.installation.start;
      expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
      expect((yield* h.installation.resolve()).source).toBe("managed");
      expect(h.downloads()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rechecks a cached local executable when the shared manifest policy changes", () =>
    Effect.gen(function* () {
      let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
      const h = yield* makeHarness({
        local: { version: "0.156.0" },
        manifestCurrent: Effect.sync(() => manifest),
      });
      expect((yield* h.installation.resolve()).source).toBe("local");
      manifest = {
        ...manifest,
        compatibility: [
          {
            driver: "codex",
            t3CodeRange: ">=0.0.42",
            ranges: [
              { range: ">=0.156.1", status: "supported" },
              { range: "<0.156.1", status: "broken" },
            ],
          },
        ],
      };
      yield* h.installation.start;
      expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
      expect((yield* h.installation.resolve()).source).toBe("managed");
      expect(h.downloads()).toBe(1);
      expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
        "--version",
        "app-server --help",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses bundled Codex compatibility when the remote manifest omits its policy", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        local: { version: "0.156.0" },
        manifestCurrent: Effect.succeed({
          ...ModelManifest.BUNDLED_MODEL_MANIFEST,
          compatibility: [],
        }),
      });
      expect((yield* h.installation.start).source).toBe("local");
      expect(h.downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // A native launcher has no adjacent codex-code-mode-host; only its name lets it run.
  it.effect.each([
    { kind: "script", name: "codex-wrapper" },
    { kind: "native", name: "volta-shim" },
    { kind: "native", name: "mise" },
    { kind: "native", name: "aqua-proxy" },
  ] as const)(
    "runs a $kind $name launcher symlink as codex without resolving it",
    ({ kind, name }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ local: { version: "0.156.1" } });
        const launcher = NodePath.join(h.baseDir, name);
        const local = { version: "0.156.1", native: kind === "native" };
        yield* h.fs.writeFileString(launcher, localFixture(local), { mode: 0o755 });
        yield* h.fs.remove(h.localBinaryPath);
        yield* h.fs.symlink(launcher, h.localBinaryPath);
        expect(yield* h.installation.start).toMatchObject({ source: "local", phase: "succeeded" });
        expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
        expect(h.downloads()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "installs the complete verified package in tools/codex/version and survives a restart",
    () =>
      Effect.gen(function* () {
        const { installation, fs, baseDir } = yield* makeHarness();
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        const executable = yield* installation.resolve();
        expect(executable.executablePath).toBe(
          NodePath.join(baseDir, "tools", "codex", "0.156.1", "bin", "codex"),
        );
        expect(
          yield* fs.readFileString(
            `${executable.managedVersionDirectory}/bin/codex-code-mode-host`,
          ),
        ).toBe("host");
        expect(
          yield* fs.readFileString(`${executable.managedVersionDirectory}/codex-path/rg`),
        ).toBe("rg");
        const restarted = yield* makeHarness({ baseDir });
        expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["verified", "corrupt download"] as const)(
    "upgrades an older managed installation when CodeShip starts: %s",
    (scenario) =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        yield* first.installation.start;
        yield* terminalState(first.installation);
        const executable = yield* first.installation.resolve();
        const oldVersion = "0.156.0";
        const oldDirectory = `${first.installation.managedDirectory}/${oldVersion}`;
        const activePath = `${first.installation.managedDirectory}/active.json`;
        yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
        for (const name of ["codex-package.json", ".install-complete.json"]) {
          const file = `${oldDirectory}/${name}`;
          yield* first.fs.writeFileString(
            file,
            (yield* first.fs.readFileString(file)).replaceAll(asset.version, oldVersion),
          );
        }
        yield* first.fs.writeFileString(activePath, JSON.stringify({ version: oldVersion }));
        const finishDownload = yield* Deferred.make<void>();
        const corrupt = scenario === "corrupt download";
        const restarted = yield* makeHarness({
          baseDir: first.baseDir,
          body: Stream.fromEffect(
            Deferred.await(finishDownload).pipe(Effect.as(corrupt ? archive.subarray(1) : archive)),
          ),
        });
        const pending = yield* restarted.installation.state;
        expect(pending).toMatchObject({ phase: "downloading", installedVersion: oldVersion });
        expect((yield* restarted.installation.start).operationId).toBe(pending.operationId);
        const oldLease = yield* restarted.installation.acquire();
        expect(oldLease.version).toBe(oldVersion);
        yield* Deferred.succeed(finishDownload, undefined);
        const activeVersion = corrupt ? oldVersion : asset.version;
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: corrupt ? "failed" : "succeeded",
          source: "managed",
          installedVersion: activeVersion,
        });
        expect((yield* restarted.installation.resolve()).version).toBe(activeVersion);
        expect(yield* first.fs.exists(oldLease.executablePath)).toBe(true);
        expect(restarted.downloads()).toBe(1);
        if (!corrupt) {
          const reopened = yield* makeHarness({
            baseDir: first.baseDir,
            options: {
              releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) },
            },
          });
          expect(yield* reopened.installation.state).toMatchObject({
            phase: "idle",
            installedVersion: activeVersion,
          });
          expect(reopened.downloads()).toBe(0);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects corrupted downloads without publishing a runtime", () =>
    Effect.gen(function* () {
      const { installation, fs } = yield* makeHarness({
        options: { releaseAsset: { ...asset, sha256: "0".repeat(64) } },
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toContain("SHA-256");
      expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
      expect(yield* fs.exists(`${installation.managedDirectory}/0.156.1`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["interrupted body", "HTTP 404"] as const)(
    "reports a download failure for %s without blaming disk access",
    (failure) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(asset.url);
        const response = HttpClientResponse.fromWeb(request, new Response(null));
        const h = yield* makeHarness(
          failure === "HTTP 404"
            ? { downloadStatus: 404 }
            : {
                body: Stream.concat(
                  Stream.succeed(archive.subarray(0, 10)),
                  Stream.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.DecodeError({
                        request,
                        response,
                        cause: new TypeError("terminated"),
                      }),
                    }),
                  ),
                ),
              },
        );
        yield* h.installation.start;
        expect(yield* terminalState(h.installation)).toMatchObject({
          phase: "failed",
          message:
            failure === "HTTP 404"
              ? "The Codex download server returned HTTP 404. Try again later."
              : "The Codex download was interrupted. Check your internet connection, then retry installation.",
        });
        expect(h.downloads()).toBe(1);
        expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves the filesystem failure message when installation cannot create its directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" });
        const baseDir = `${directory}/not-a-directory`;
        yield* fs.writeFileString(baseDir, "existing file");
        const h = yield* makeHarness({ baseDir });
        yield* h.installation.start;
        expect(yield* terminalState(h.installation)).toMatchObject({
          phase: "failed",
          message:
            "Could not install Codex. Check disk space and directory access, then try again.",
        });
        expect(h.downloads()).toBe(0);
        expect(yield* fs.readFileString(baseDir)).toBe("existing file");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a download timeout and cleans the staging directory", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stall = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const h = yield* makeHarness({
        body: Stream.concat(Stream.succeed(archive.subarray(0, 10)), Stream.fromEffect(stall)),
      });
      yield* h.installation.start;
      yield* Deferred.await(started);
      yield* TestClock.adjust("45 minutes");
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        message: "The Codex download timed out. Retry installation.",
      });
      expect(h.downloads()).toBe(1);
      expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels an in-flight download and cleans the staging directory", () =>
    Effect.gen(function* () {
      const downloading = yield* Deferred.make<void>();
      const body = Stream.fromEffect(
        Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const { installation, fs } = yield* makeHarness({ body });
      const started = yield* installation.start;
      yield* Deferred.await(downloading);
      expect((yield* installation.cancel(started.operationId!)).phase).toBe("cancelled");
      expect(
        (yield* fs.readDirectory(installation.managedDirectory)).filter((name) =>
          name.startsWith(".install-"),
        ),
      ).toEqual([]);
      expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects active process leases and removes the runtime after release", () =>
    Effect.gen(function* () {
      const { installation, fs } = yield* makeHarness();
      yield* installation.start;
      yield* terminalState(installation);
      const leaseScope = yield* Scope.make();
      yield* installation.acquire().pipe(Effect.provideService(Scope.Scope, leaseScope));
      expect((yield* Effect.flip(installation.remove())).detail).toContain("Stop Codex sessions");
      yield* Scope.close(leaseScope, Exit.void);
      yield* installation.remove();
      expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
      expect((yield* installation.state).installedVersion).toBeNull();
      expect((yield* installation.state).executablePath).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an activated runtime when a later update fails verification", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.installation.start;
      yield* terminalState(first.installation);
      const update = yield* makeHarness({
        baseDir: first.baseDir,
        options: { releaseAsset: { ...asset, version: "0.156.2", sha256: "0".repeat(64) } },
      });
      expect((yield* update.installation.state).executablePath).toBe(
        (yield* first.installation.resolve()).executablePath,
      );
      yield* update.installation.start;
      expect((yield* terminalState(update.installation)).phase).toBe("failed");
      expect((yield* update.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Stands in for Windows' bsdtar: CRLF listings, and extraction writes the Windows layout.
