import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off - expectations use the host platform path and delimiter, which Effect Path does not expose.
import * as NodePath from "node:path";
import * as ModelManifest from "./ModelManifest.ts";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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
const latestReleaseUrl = "https://api.github.com/repos/openai/codex/releases/latest";
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
    latestRelease?: (checks: number, sha256: string) => Effect.Effect<Response>;
    baseDir?: string;
    local?: LocalCodex;
    platform?: NodeJS.Platform;
    spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    runtimeRenameFailures?: number;
    /** Served by URL instead of the pinned package. */
    responses?: Readonly<Record<string, () => Response>>;
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
  // A restarted harness on the same baseDir keeps the existing binary, and with it its fingerprint.
  if (input.local && !(yield* fs.exists(localBinaryPath))) {
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
  let releaseChecks = 0;
  const downloadUrls: Array<string> = [];
  const digest = yield* Digest.Digest;
  const sha256 = Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie));
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
      const content = yield* fs
        .readFileString(localBinaryPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const [header, payload] = content.split("\n");
      if (
        (header !== "#!fake-codex" && header !== "\x7fELF") ||
        !payload ||
        !payload.startsWith("{")
      ) {
        return yield* realSpawner.spawn(command);
      }
      const fixture = JSON.parse(payload) as {
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
      refreshOnDemand: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
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
        Effect.gen(function* () {
          if (request.url === latestReleaseUrl) {
            releaseChecks++;
            const response = yield* (
              input.latestRelease?.(releaseChecks, sha256) ??
              Effect.succeed(new Response(null, { status: 404 }))
            );
            return HttpClientResponse.fromWeb(request, response);
          }
          downloads++;
          const respond = input.responses?.[request.url];
          if (respond) return HttpClientResponse.fromWeb(request, respond());
          downloadUrls.push(request.url);
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
    releaseChecks: () => releaseChecks,
    downloadUrls,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const seedOlderRelease = Effect.fn("test.seedOlderCodexRelease")(function* () {
  const first = yield* makeHarness();
  yield* first.installation.start;
  yield* terminalState(first.installation);
  const executable = yield* first.installation.resolve();
  const oldVersion = "0.156.0";
  const oldDirectory = `${first.installation.managedDirectory}/${oldVersion}`;
  yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
  for (const name of ["codex-package.json", ".install-complete.json"]) {
    const file = `${oldDirectory}/${name}`;
    yield* first.fs.writeFileString(
      file,
      (yield* first.fs.readFileString(file)).replaceAll(asset.version, oldVersion),
    );
  }
  yield* first.fs.writeFileString(
    `${first.installation.managedDirectory}/active.json`,
    JSON.stringify({ version: oldVersion }),
  );
  return { baseDir: first.baseDir, oldVersion, fs: first.fs };
});

function githubRelease(sha256: string, version = asset.version) {
  return {
    tag_name: `rust-v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `codex-package-${asset.target}.tar.gz`,
        state: "uploaded",
        size: archive.length,
        digest: `sha256:${sha256}`,
        browser_download_url: "https://untrusted.example/runtime.tar.gz",
      },
    ],
  };
}

function manifestBlockingVersion(version: string): ModelManifest.ModelManifestData {
  return {
    ...ModelManifest.BUNDLED_MODEL_MANIFEST,
    compatibility: (ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility ?? []).map((policy) =>
      policy.driver === "codex"
        ? {
            ...policy,
            ranges: [{ range: version, status: "broken" }, ...policy.ranges],
          }
        : policy,
    ),
  };
}

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
        expect(yield* h.installation.checkManagedUpdate).toBeNull();
        expect(h.releaseChecks()).toBe(0);
        expect(h.downloads()).toBe(0);
        expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
        expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
          "--version",
          "app-server --help",
        ]);
        yield* h.installation.remove();
        expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
        expect((yield* h.installation.state).source).toBe("local");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  const compileNative = Effect.fn("test.compileNative")(function* (
    executablePath: string,
    source: string,
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const compiler = yield* spawner.spawn(
      ChildProcess.make("cc", ["-x", "c", "-", "-o", executablePath], {
        stdin: Stream.make(new TextEncoder().encode(source)),
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    expect(yield* compiler.exitCode).toBe(0);
  }, Effect.scoped);

  it.effect.each([
    { layout: "npm bin symlink", persists: true },
    { layout: "npm shim", persists: true },
    { layout: "wrapper script", persists: false },
  ])(
    "re-probes a $layout Codex after a restart only when its payload can change",
    ({ layout, persists }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" });
        const packageDirectory =
          layout === "npm shim"
            ? `${baseDir}/local/node_modules/@openai/codex`
            : `${baseDir}/npm/lib/node_modules/@openai/codex`;
        const payload =
          layout === "wrapper script" ? `${baseDir}/payload` : `${packageDirectory}/bin/codex.js`;
        const install = Effect.fn("test.installPayload")(function* (version: string) {
          yield* fs.makeDirectory(`${packageDirectory}/bin`, { recursive: true });
          if (layout !== "wrapper script")
            yield* fs.writeFileString(
              `${packageDirectory}/package.json`,
              JSON.stringify({ name: "@openai/codex", version }),
            );
          yield* fs.writeFileString(
            payload,
            `#!/bin/sh\nprintf '%s\\n' "$*" >> '${baseDir}/local-probes.txt'\ncase "$1" in --version) printf 'codex-cli ${version}\\n';; esac\n`,
            { mode: 0o755 },
          );
        });
        yield* install("0.156.1");
        yield* fs.makeDirectory(`${baseDir}/local`, { recursive: true });
        if (layout === "npm bin symlink") yield* fs.symlink(payload, `${baseDir}/local/codex`);
        else
          yield* fs.writeFileString(
            `${baseDir}/local/codex`,
            `#!/bin/sh\nexec '${payload}' "$@"\n`,
            {
              mode: 0o755,
            },
          );
        const first = yield* makeHarness({ baseDir, local: { version: "0.156.1" } });
        expect((yield* first.installation.resolve()).source).toBe("local");
        const restarted = yield* makeHarness({ baseDir, local: { version: "0.156.1" } });
        expect((yield* restarted.installation.resolve()).source).toBe("local");
        expect((yield* fs.readFileString(first.probeLog)).trim().split("\n")).toHaveLength(
          persists ? 2 : 4,
        );
        yield* install("0.128.9");
        const upgraded = yield* makeHarness({ baseDir, local: { version: "0.156.1" } });
        expect((yield* upgraded.installation.state).installedVersion).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // A native launcher has no adjacent codex-code-mode-host; only its name lets it run.

  it.effect.each([
    { kind: "script", name: "volta-shim" },
    { kind: "native", name: "volta-shim" },
    { kind: "native", name: "mise" },
    { kind: "native", name: "aqua-proxy" },
  ])("preserves the invoked name of $kind $name launcher symlinks", ({ kind, name }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version: "0.156.1" } });
      const launcher = `${h.baseDir}/${name}`;
      if (kind === "native") {
        const payload = `${h.baseDir}/codex.js`;
        yield* h.fs.writeFileString(
          payload,
          '#!/bin/sh\ncase "$1" in --version) printf "codex-cli 0.156.1\\n";; app-server) exit 0;; esac\n',
          { mode: 0o755 },
        );
        yield* h.fs.remove(h.localBinaryPath);
        yield* compileNative(
          launcher,
          `#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  if (strcmp(name ? name + 1 : argv[0], "codex") != 0) return 1;
  execv(${JSON.stringify(payload)}, argv);
  return 1;
}
`,
        );
      } else {
        yield* h.fs.writeFileString(
          launcher,
          '#!/bin/sh\ncase "$0" in */codex) ;; *) exit 1;; esac\ncase "$1" in --version) printf "codex-cli 0.156.1\\n";; app-server) exit 0;; esac\n',
          { mode: 0o755 },
        );
        yield* h.fs.remove(h.localBinaryPath);
      }
      yield* h.fs.symlink(launcher, h.localBinaryPath);
      expect(yield* h.installation.start).toMatchObject({ source: "local", phase: "succeeded" });
      expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
      expect(h.downloads()).toBe(0);
      expect(yield* h.fs.exists(`${h.baseDir}/caches/codex-local-probe.json`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["verified", "corrupt download", "policy changes after startup"] as const)(
    "upgrades an older managed installation when CodeShip starts: %s",
    (scenario) =>
      Effect.gen(function* () {
        const first = yield* seedOlderRelease();
        const { oldVersion } = first;
        const finishDownload = yield* Deferred.make<void>();
        const corrupt = scenario === "corrupt download";
        const manifest = yield* Ref.make(ModelManifest.BUNDLED_MODEL_MANIFEST);
        const restarted = yield* makeHarness({
          baseDir: first.baseDir,
          manifestCurrent: Ref.get(manifest),
          body: Stream.fromEffect(
            Deferred.await(finishDownload).pipe(Effect.as(corrupt ? archive.subarray(1) : archive)),
          ),
        });
        const pending = yield* restarted.installation.state;
        expect(pending).toMatchObject({ phase: "downloading", installedVersion: oldVersion });
        expect((yield* restarted.installation.start).operationId).toBe(pending.operationId);
        const oldLease = yield* restarted.installation.acquire();
        expect(oldLease.version).toBe(oldVersion);
        if (scenario === "policy changes after startup")
          yield* Ref.set(manifest, manifestBlockingVersion(asset.version));
        yield* Deferred.succeed(finishDownload, undefined);
        const succeeded = scenario === "verified";
        const activeVersion = succeeded ? asset.version : oldVersion;
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: succeeded ? "succeeded" : "failed",
          source: "managed",
          installedVersion: activeVersion,
        });
        expect((yield* restarted.installation.resolve()).version).toBe(activeVersion);
        expect(yield* first.fs.exists(oldLease.executablePath)).toBe(true);
        expect(restarted.downloads()).toBe(1);
        if (succeeded) {
          const reopened = yield* makeHarness({
            baseDir: first.baseDir,
            options: {
              releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) },
            },
          });
          expect(yield* reopened.installation.state).toMatchObject({
            phase: "idle",
            version: activeVersion,
            installedVersion: activeVersion,
          });
          expect(reopened.downloads()).toBe(0);
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not download a blocked bundled Codex while upgrading at startup", () =>
    Effect.gen(function* () {
      const { baseDir, oldVersion } = yield* seedOlderRelease();
      const { installation, downloads } = yield* makeHarness({
        baseDir,
        manifestCurrent: Effect.succeed(manifestBlockingVersion(asset.version)),
      });
      expect(yield* installation.state).toMatchObject({
        phase: "failed",
        installedVersion: oldVersion,
      });
      expect((yield* installation.resolve()).version).toBe(oldVersion);
      expect(downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports a blocked bundled Codex before a first install", () =>
    Effect.gen(function* () {
      const { installation, downloads, fs } = yield* makeHarness({
        manifestCurrent: Effect.succeed(manifestBlockingVersion(asset.version)),
      });
      expect(yield* Effect.flip(installation.start)).toMatchObject({ operation: "start" });
      expect(downloads()).toBe(0);
      expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["verified", "corrupt"] as const)(
    "updates a managed runtime through the verified latest stable asset: %s",
    (packageResult) =>
      Effect.gen(function* () {
        const { baseDir, oldVersion } = yield* seedOlderRelease();
        const corrupt = packageResult === "corrupt";
        const { installation, downloads, releaseChecks, downloadUrls } = yield* makeHarness({
          baseDir,
          options: { releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) } },
          latestRelease: (_, sha256) => Effect.sync(() => Response.json(githubRelease(sha256))),
          ...(corrupt ? { body: Stream.succeed(Uint8Array.from(archive).fill(0, 0, 1)) } : {}),
        });
        const expected = { installedVersion: oldVersion, latestVersion: asset.version };
        expect(releaseChecks()).toBe(0);
        expect(
          yield* Effect.all([installation.checkManagedUpdate, installation.checkManagedUpdate], {
            concurrency: "unbounded",
          }),
        ).toEqual([expected, expected]);
        expect(releaseChecks()).toBe(1);
        expect(downloads()).toBe(0);
        const results = yield* Effect.forEach(
          [asset.version, asset.version],
          (version) => Effect.exit(installation.startUpdate(version)),
          { concurrency: "unbounded" },
        );
        expect(results.every(corrupt ? Exit.isFailure : Exit.isSuccess)).toBe(true);
        expect(yield* installation.state).toMatchObject({
          phase: corrupt ? "failed" : "succeeded",
          installedVersion: corrupt ? oldVersion : asset.version,
        });
        expect((yield* installation.resolve()).version).toBe(corrupt ? oldVersion : asset.version);
        expect(downloadUrls).toEqual([
          `https://github.com/openai/codex/releases/download/rust-v${asset.version}/codex-package-${asset.target}.tar.gz`,
        ]);
        if (!corrupt) {
          yield* installation.start;
          expect(yield* terminalState(installation)).toMatchObject({
            phase: "succeeded",
            installedVersion: asset.version,
          });
        }
        expect(downloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each([
    { name: "draft", override: { draft: true } },
    { name: "prerelease flag", override: { prerelease: true } },
    { name: "prerelease tag", override: { tag_name: `rust-v${asset.version}-alpha.1` } },
    { name: "unsafe tag", override: { tag_name: `rust-v${asset.version}/../other` } },
    { name: "older than the bundled pin", override: { tag_name: "rust-v0.155.0" } },
    { name: "missing target asset", override: { assets: [] } },
    {
      name: "bad checksum",
      override: { assets: [{ ...githubRelease("").assets[0], digest: "unknown" }] },
    },
    {
      name: "invalid size",
      override: { assets: [{ ...githubRelease("0".repeat(64)).assets[0], size: 0 }] },
    },
  ])("ignores unusable Codex release metadata: $name", ({ override }) =>
    Effect.gen(function* () {
      const { baseDir, oldVersion } = yield* seedOlderRelease();
      const { installation, downloads } = yield* makeHarness({
        baseDir,
        options: { releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) } },
        latestRelease: (_, sha256) =>
          Effect.sync(() => Response.json({ ...githubRelease(sha256), ...override })),
      });
      expect(yield* installation.checkManagedUpdate).toEqual({
        installedVersion: oldVersion,
        latestVersion: null,
      });
      expect(yield* Effect.flip(installation.startUpdate(asset.version))).toMatchObject({
        operation: "update",
      });
      expect((yield* installation.resolve()).version).toBe(oldVersion);
      expect(downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("recovers from a rate-limited release metadata check", () =>
    Effect.gen(function* () {
      const { baseDir, oldVersion } = yield* seedOlderRelease();
      const { installation, releaseChecks, downloads } = yield* makeHarness({
        baseDir,
        options: { releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) } },
        latestRelease: (checks, sha256) =>
          Effect.sync(() =>
            checks === 1
              ? new Response(null, { status: 429 })
              : Response.json(githubRelease(sha256)),
          ),
      });
      expect((yield* installation.checkManagedUpdate)?.latestVersion).toBeNull();
      expect((yield* installation.checkManagedUpdate)?.latestVersion).toBeNull();
      expect(releaseChecks()).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect((yield* installation.checkManagedUpdate)?.latestVersion).toBe(asset.version);
      expect(releaseChecks()).toBe(2);
      expect(downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("applies a changed compatibility policy to cached release metadata", () =>
    Effect.gen(function* () {
      const { baseDir, oldVersion } = yield* seedOlderRelease();
      const manifest = yield* Ref.make(ModelManifest.BUNDLED_MODEL_MANIFEST);
      const { installation, releaseChecks, downloads } = yield* makeHarness({
        baseDir,
        options: { releaseAsset: { ...asset, version: oldVersion, sha256: "0".repeat(64) } },
        latestRelease: (_, sha256) => Effect.sync(() => Response.json(githubRelease(sha256))),
        manifestCurrent: Ref.get(manifest),
      });
      expect((yield* installation.checkManagedUpdate)?.latestVersion).toBe(asset.version);
      yield* Ref.set(manifest, manifestBlockingVersion(asset.version));
      expect((yield* installation.checkManagedUpdate)?.latestVersion).toBeNull();
      expect(yield* Effect.flip(installation.startUpdate(asset.version))).toMatchObject({
        operation: "update",
      });
      expect(releaseChecks()).toBe(1);
      expect(downloads()).toBe(0);
      yield* Ref.set(manifest, manifestBlockingVersion(oldVersion));
      expect(yield* Effect.flip(installation.resolve())).toMatchObject({ operation: "resolve" });
      expect(yield* installation.installedManagedVersion).toBe(oldVersion);
      expect(yield* installation.startUpdate(asset.version)).toMatchObject({
        phase: "succeeded",
        installedVersion: asset.version,
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("requires an update before running an older activated managed installation", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.installation.start;
      yield* terminalState(first.installation);
      const executable = yield* first.installation.resolve();
      const oldDirectory = `${first.installation.managedDirectory}/0.155.1`;
      yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
      for (const name of ["codex-package.json", ".install-complete.json"]) {
        const file = `${oldDirectory}/${name}`;
        yield* first.fs.writeFileString(
          file,
          (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.155.1"),
        );
      }
      yield* first.fs.writeFileString(
        `${first.installation.managedDirectory}/active.json`,
        '{"version":"0.155.1"}',
      );
      const restarted = yield* makeHarness({ baseDir: first.baseDir });
      expect((yield* Effect.flip(restarted.installation.resolve())).detail).toContain(
        "outside the supported range",
      );
      yield* restarted.installation.start;
      expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
      expect(restarted.downloads()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "updates an older supported managed installation to the pinned release on startup",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        yield* first.installation.start;
        yield* terminalState(first.installation);
        const executable = yield* first.installation.resolve();
        const oldDirectory = `${first.installation.managedDirectory}/0.156.0`;
        yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
        for (const name of ["codex-package.json", ".install-complete.json"]) {
          const file = `${oldDirectory}/${name}`;
          yield* first.fs.writeFileString(
            file,
            (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.156.0"),
          );
        }
        yield* first.fs.writeFileString(
          `${first.installation.managedDirectory}/active.json`,
          '{"version":"0.156.0"}',
        );
        const restarted = yield* makeHarness({ baseDir: first.baseDir });
        expect((yield* restarted.installation.state).operationId).not.toBeNull();
        expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
        expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
        expect(restarted.downloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["cached update", "reverify"] as const)(
    "reports a verification timeout during %s and preserves the managed runtime",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-verify-test-" });
        const managed = `${baseDir}/tools/codex`;
        const installedVersion = operation === "cached update" ? "0.156.0" : asset.version;
        const target = "aarch64-pc-windows-msvc";
        const checksum = "a".repeat(64);
        for (const version of new Set([installedVersion, asset.version])) {
          const directory = `${managed}/${version}`;
          yield* fs.makeDirectory(`${directory}/bin`, { recursive: true });
          yield* fs.makeDirectory(`${directory}/codex-path`, { recursive: true });
          for (const name of [
            "bin/codex.exe",
            "bin/codex-code-mode-host.exe",
            "codex-path/rg.exe",
          ]) {
            yield* fs.writeFileString(`${directory}/${name}`, "fixture executable");
          }
          yield* fs.writeFileString(
            `${directory}/codex-package.json`,
            JSON.stringify({ layoutVersion: 1, version, target, entrypoint: "bin/codex.exe" }),
          );
          yield* fs.writeFileString(
            `${directory}/.install-complete.json`,
            JSON.stringify({ version, target, sha256: checksum }),
          );
        }
        const pointer = JSON.stringify({ version: installedVersion });
        yield* fs.writeFileString(`${managed}/active.json`, pointer);
        const entered = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          baseDir,
          platform: "win32",
          manifestCurrent: Effect.succeed({
            ...ModelManifest.BUNDLED_MODEL_MANIFEST,
            compatibility: [
              {
                driver: "codex",
                t3CodeRange: ">=0.0.0",
                ranges: [{ range: ">=0.156.0", status: "supported" }],
              },
            ],
          }),
          options: {
            releaseAsset: operation === "reverify" ? null : { ...asset, target, sha256: checksum },
            validate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          },
        });
        yield* h.installation.start;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("90 seconds");
        expect(yield* terminalState(h.installation)).toMatchObject({
          phase: "failed",
          installedVersion,
          message:
            "Codex runtime verification timed out after 90 seconds. Check this environment's server logs for startup errors, then retry installation.",
        });
        expect(yield* fs.readFileString(`${managed}/active.json`)).toBe(pointer);
        expect((yield* h.installation.resolve()).version).toBe(installedVersion);
        expect(h.downloads()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  const upstreamVersion = "0.163.0";
  const upstreamArchive = Buffer.from(
    "H4sIAAAAAAACA+3WzY7CIBQF4D5Kw1oqtNQmPoh7rKStP9BQdMaYefcBE43T9RQ1nm8B7Q1Jk94cYN3peW026juZDvOqsrzO3nj2yofnUK9KwZKUJREcByet/2TymabuPby29S3/NIz0EIbWDC5u/sXf/PO8EAL5j+G/ew1vuP/TXrp2bpunnf/5KP+syCvkP4bJmg5vlf96JxuVbQej4+efi2qUf17g/h/Hhezl2RzdStmhM5osUz5Lyen+RljGF0XGiK/6H9UoF4pS2rpdCCr7fq/oRtqvTocVSjt77k2nr6vud0vyg6ABAAAAAAAAAAAAAABE8gvVbjvaACgAAA==",
    "base64",
  );
  const upstreamReleaseUrl = `https://github.com/openai/codex/releases/download/rust-v${upstreamVersion}`;
  const upstreamResponses = (checksum: string) => ({
    "https://registry.npmjs.org/@openai/codex/latest": () =>
      Response.json({ version: upstreamVersion }),
    [`${upstreamReleaseUrl}/codex-package_SHA256SUMS`]: () =>
      new Response(
        `${"0".repeat(64)}  codex-package-x86_64-apple-darwin.tar.gz\n${checksum}  codex-package-aarch64-apple-darwin.tar.gz\n`,
      ),
    [`${upstreamReleaseUrl}/codex-package-aarch64-apple-darwin.tar.gz`]: () =>
      new Response(upstreamArchive),
  });

  it.effect("updates a managed install to OpenAI's newest release and never downgrades it", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const checksum = Hex.encode(
        yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
      );
      const h = yield* makeHarness({ responses: upstreamResponses(checksum) });
      yield* h.installation.checkForUpdate;
      // A fresh install still gets the pinned release.
      expect((yield* h.installation.state).version).toBe("0.156.1");
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "0.156.1",
        version: upstreamVersion,
      });

      const sessionScope = yield* Scope.make();
      const previous = yield* h.installation.acquire().pipe(Scope.provide(sessionScope));
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: upstreamVersion,
        version: upstreamVersion,
      });
      expect((yield* h.installation.resolve()).version).toBe(upstreamVersion);
      // The running session keeps its release until the next start prunes it.
      expect(yield* h.fs.exists(previous.managedVersionDirectory!)).toBe(true);
      yield* Scope.close(sessionScope, Exit.void);

      // Without upstream information the older pin is not offered as a reinstall.
      const restarted = yield* makeHarness({ baseDir: h.baseDir });
      expect(yield* h.fs.exists(previous.managedVersionDirectory!)).toBe(false);
      expect(yield* restarted.installation.state).toMatchObject({
        installedVersion: upstreamVersion,
        version: upstreamVersion,
      });
      yield* restarted.installation.start;
      expect(yield* terminalState(restarted.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: upstreamVersion,
      });
      expect(restarted.downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps the managed install when an update fails its published checksum", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ responses: upstreamResponses("f".repeat(64)) });
      yield* h.installation.start;
      yield* terminalState(h.installation);
      yield* h.installation.checkForUpdate;
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        installedVersion: "0.156.1",
        message: expect.stringContaining("SHA-256"),
      });
      expect((yield* h.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not install a cached update the manifest has since withdrawn", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const checksum = Hex.encode(
        yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
      );
      let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
      const h = yield* makeHarness({
        responses: upstreamResponses(checksum),
        manifestCurrent: Effect.sync(() => manifest),
      });
      yield* h.installation.start;
      yield* terminalState(h.installation);
      yield* h.installation.checkForUpdate;
      expect((yield* h.installation.state).version).toBe(upstreamVersion);
      manifest = {
        ...manifest,
        compatibility: [
          {
            driver: "codex",
            t3CodeRange: ">=0.0.42",
            ranges: [
              { range: ">=0.160.0", status: "unsupported" },
              { range: ">=0.156.0 <0.160.0", status: "supported" },
            ],
          },
        ],
      };
      const downloads = h.downloads();
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "0.156.1",
        version: "0.156.1",
      });
      expect(h.downloads()).toBe(downloads);
      expect((yield* h.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns a managed install the manifest withdraws to the pinned release", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const checksum = Hex.encode(
        yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
      );
      let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
      const h = yield* makeHarness({
        responses: upstreamResponses(checksum),
        manifestCurrent: Effect.sync(() => manifest),
      });
      yield* h.installation.checkForUpdate;
      yield* h.installation.start;
      yield* terminalState(h.installation);
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        installedVersion: upstreamVersion,
      });

      manifest = {
        ...manifest,
        compatibility: [
          {
            driver: "codex",
            t3CodeRange: ">=0.0.42",
            ranges: [
              { range: ">=0.160.0", status: "unsupported" },
              { range: ">=0.156.0 <0.160.0", status: "supported" },
            ],
          },
        ],
      };
      yield* h.installation.checkForUpdate;
      expect(yield* h.installation.state).toMatchObject({
        installedVersion: upstreamVersion,
        version: "0.156.1",
      });
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "0.156.1",
        version: "0.156.1",
      });
      expect((yield* h.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["update", "reinstall"] as const)(
    "rejects withdrawal during $0 validation",
    (operation) =>
      Effect.gen(function* () {
        const digest = yield* Digest.Digest;
        const checksum = Hex.encode(
          yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
        );
        let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
        let withdraw = operation === "update";
        const h = yield* makeHarness({
          responses: upstreamResponses(checksum),
          manifestCurrent: Effect.sync(() => manifest),
          options: {
            validate: (_executable, version) =>
              Effect.sync(() => {
                if (withdraw && version === upstreamVersion)
                  manifest = {
                    ...ModelManifest.BUNDLED_MODEL_MANIFEST,
                    compatibility: [
                      {
                        driver: "codex",
                        t3CodeRange: ">=0.0.42",
                        ranges: [
                          { range: ">=0.160.0", status: "unsupported" },
                          { range: ">=0.156.0 <0.160.0", status: "supported" },
                        ],
                      },
                    ],
                  };
              }),
          },
        });
        yield* h.installation.start;
        yield* terminalState(h.installation);
        yield* h.installation.checkForUpdate;
        if (operation === "reinstall") {
          yield* h.installation.start;
          expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
          withdraw = true;
        }
        yield* h.installation.start;
        expect((yield* terminalState(h.installation)).phase).toBe("failed");
        if (operation === "update") {
          expect((yield* h.installation.resolve()).version).toBe("0.156.1");
        } else {
          expect((yield* h.installation.state).version).toBe("0.156.1");
          yield* Effect.flip(h.installation.resolve());
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
