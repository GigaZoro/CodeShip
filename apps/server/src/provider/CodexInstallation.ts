// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";

const DRIVER = ProviderDriverKind.make("codex");
const STAGING_STALE_AFTER_MS = 24 * 60 * 60_000;
const LATEST_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const STABLE_RELEASE_TAG = /^rust-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u));
const ActiveRelease = Schema.Struct({ version: Version });
const InstalledRelease = Schema.Struct({
  version: Version,
  target: Schema.String,
  sha256: Schema.String,
});
const PackageManifest = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  version: Version,
  target: Schema.String,
  entrypoint: Schema.String,
});
const decodeLatestRelease = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tag_name: Schema.String,
      draft: Schema.Literal(false),
      prerelease: Schema.Literal(false),
      assets: Schema.Array(Schema.Unknown),
    }),
  ),
);
const isNamedAsset = Schema.is(Schema.Struct({ name: Schema.String }));
const decodeUploadedAsset = Schema.decodeUnknownEffect(
  Schema.Struct({
    state: Schema.Literal("uploaded"),
    size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 * 1024 ** 3 })),
    digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  }),
);
const decodeVersion = Schema.decodeUnknownEffect(Version);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));
const encodeActive = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
export interface CodexReleaseAsset {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
}
const MANAGED_VERSION = "0.172.0";
const archiveName = (target: string) => `codex-package-${target}.tar.gz`;
function releaseAsset(
  target: string,
  sha256: string,
  archiveBytes: number,
  version = MANAGED_VERSION,
): CodexReleaseAsset {
  return {
    version,
    target,
    url: `https://github.com/openai/codex/releases/download/rust-v${version}/${archiveName(target)}`,
    sha256,
    archiveBytes,
  };
}
const RELEASES: Readonly<Record<string, CodexReleaseAsset>> = {
  "darwin-arm64": releaseAsset(
    "aarch64-apple-darwin",
    "0970016d48209a09c4039139629ed79b4a31c5e3d864e792c043419d98fa6466",
    179280925,
  ),
  "darwin-x64": releaseAsset(
    "x86_64-apple-darwin",
    "b5e94828f45171f13d81de2b96cae05c0b7e6a7f2f7d3c9d4e748be3d3906c02",
    194297241,
  ),
  "linux-arm64": releaseAsset(
    "aarch64-unknown-linux-musl",
    "faf17b8071927f33346a805dc8cb45de4e08c0d75cf0e5e68cecddca28b8861e",
    201917755,
  ),
  "linux-x64": releaseAsset(
    "x86_64-unknown-linux-musl",
    "63e3b00065ed7f62166d0522e17f663cb866a31d80d03e63365482ed34a1d991",
    200434347,
  ),
  "win32-arm64": releaseAsset(
    "aarch64-pc-windows-msvc",
    "6aa686d9ac16cc171b8207273ac20eb9321bf3963f2801722045e906c00ea804",
    201213323,
  ),
  "win32-x64": releaseAsset(
    "x86_64-pc-windows-msvc",
    "b723674d7caf26a3f55121a02d6cad8f3ac8ddf5860747a6edde1c904cf593af",
    218274372,
  ),
};
const resolveCodexReleaseAsset = (platform: NodeJS.Platform, arch: string) =>
  RELEASES[`${platform}-${arch}`] ?? null;
export class CodexInstallationError extends Schema.TaggedError<CodexInstallationError>()(
  "CodexInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(CodexInstallationError);
const installationError = (operation: string, detail: string, cause?: unknown) =>
  new CodexInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);
export interface CodexExecutable {
  readonly executablePath: string;
  readonly source: "managed" | "local";
  readonly version: string;
  readonly managedVersionDirectory: string | null;
}
export const resolveExternalCodexPath = Effect.fn("resolveExternalCodexPath")(
  function* (managedDirectory: string, environment: NodeJS.ProcessEnv) {
    const executablePath = yield* resolveCommandPath("codex", { env: environment });
    if (executablePath === null) return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const realExecutablePath = yield* fs.realPath(executablePath);
    const realManaged = yield* fs
      .realPath(managedDirectory)
      .pipe(Effect.orElseSucceed(() => managedDirectory));
    const relative = path.relative(realManaged, realExecutablePath);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      return null;
    return { executablePath, realExecutablePath };
  },
  Effect.orElseSucceed(() => null),
);
interface CodexInstallationService {
  readonly managedDirectory: string;
  readonly resolve: () => Effect.Effect<CodexExecutable, CodexInstallationError>;
  readonly acquire: () => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  readonly compatibility: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  readonly start: Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly installedManagedVersion: Effect.Effect<string | null>;
  readonly checkForUpdate: Effect.Effect<{
    readonly installedVersion: string;
    readonly latestVersion: string | null;
  } | null>;
  readonly startUpdate: (
    version: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CodexInstallationError>;
}
export class CodexInstallation extends Context.Service<
  CodexInstallation,
  CodexInstallationService
>()("t3/provider/CodexInstallation") {
  static readonly layer = Layer.effect(
    CodexInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeCodexInstallation({ baseDir: config.baseDir });
    }),
  );
}
export interface CodexInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CodexReleaseAsset | null;
  readonly validate?: (
    executable: CodexExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, CodexInstallationError, Scope.Scope>;
}
const isRunning = (state: ProviderInstallState) =>
  ["downloading", "extracting", "verifying"].includes(state.phase);
export const makeCodexInstallation = Effect.fn("makeCodexInstallation")(function* (
  options: CodexInstallationOptions,
) {
  const manifestService = yield* ModelManifest.ModelManifest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const arch = yield* HostProcess.Architecture;
  const asset =
    options.releaseAsset === undefined
      ? resolveCodexReleaseAsset(platform, arch)
      : options.releaseAsset;
  const managedDirectory = path.join(options.baseDir, "tools", "codex");
  const activePath = path.join(managedDirectory, "active.json");
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const gate = yield* Semaphore.make(1);
  let leases = 0;
  let running:
    | {
        readonly operationId: string;
        readonly version: string;
        readonly fiber: Fiber.Fiber<void>;
        readonly completion: Deferred.Deferred<ProviderInstallState>;
      }
    | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: asset?.archiveBytes ?? null,
    version: asset?.version ?? null,
    installedVersion: null,
    executablePath: null,
    canRemove: false,
    message: null,
  });
  const readRecord = Effect.fn("CodexInstallation.readRecord")(function* <A>(
    file: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(file);
    if (info.type !== "File" || Number(info.size) > 8192)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record is invalid. Reinstall Codex.",
      );
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      yield* fs.readFileString(file),
    );
  });
  const fromDirectory = Effect.fn("CodexInstallation.fromDirectory")(function* (
    directory: string,
    version: string,
    target: string,
  ) {
    const manifest = yield* readRecord(path.join(directory, "codex-package.json"), PackageManifest);
    if (
      manifest.version !== version ||
      manifest.target !== target ||
      manifest.entrypoint !== `bin/${executableName}`
    )
      return yield* installationError(
        "verify",
        "The downloaded Codex package does not match the expected release.",
      );
    for (const name of [
      `bin/${executableName}`,
      `bin/codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
      `codex-path/rg${platform === "win32" ? ".exe" : ""}`,
    ]) {
      const info = yield* fs.stat(path.join(directory, name));
      if (
        info.type !== "File" ||
        Number(info.size) === 0 ||
        (platform !== "win32" && (info.mode & 0o111) === 0)
      )
        return yield* installationError(
          "verify",
          "The managed Codex package is incomplete. Reinstall Codex.",
        );
    }
    return {
      executablePath: path.join(directory, "bin", executableName),
      source: "managed",
      version,
      managedVersionDirectory: directory,
    } satisfies CodexExecutable;
  });
  const completedRelease = Effect.fn("CodexInstallation.completedRelease")(function* (
    version: string,
  ) {
    yield* decodeVersion(version);
    const directory = path.join(managedDirectory, version);
    const record = yield* readRecord(
      path.join(directory, ".install-complete.json"),
      InstalledRelease,
    );
    if (record.version !== version)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record has the wrong version.",
      );
    return yield* fromDirectory(directory, version, record.target);
  });
  const compatibility = Effect.fn("CodexInstallation.compatibility")(function* (version: string) {
    const manifest = yield* manifestService.current;
    return (
      resolveProviderCompatibility(manifest.compatibility, DRIVER, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        DRIVER,
        version,
      )
    );
  });
  const requireInstallCompatibility = Effect.fn("CodexInstallation.requireInstallCompatibility")(
    function* (version: string, operation: "start" | "verify") {
      const advisory = yield* compatibility(version);
      if (advisory?.status !== "supported")
        return yield* installationError(
          operation,
          advisory?.message ??
            "This Codex release is outside the supported range for this T3.CodeShip release.",
        );
    },
  );
  const readActiveRelease = Effect.fn("CodexInstallation.readActiveRelease")(function* () {
    const active = yield* readRecord(activePath, ActiveRelease);
    return yield* completedRelease(active.version);
  });
  const resolveManaged = Effect.fn("CodexInstallation.resolveManaged")(
    function* () {
      const executable = yield* readActiveRelease();
      const advisory = yield* compatibility(executable.version);
      if (advisory?.status !== "supported")
        return yield* installationError(
          "resolve",
          advisory?.message ?? "Update the managed Codex installation to continue.",
        );
      return executable;
    },
    Effect.mapError(
      wrapFailure("resolve", "Codex is not installed in T3.CodeShip. Install it to continue."),
    ),
  );
  const acquire = Effect.fn("CodexInstallation.acquire")(function* () {
    return yield* Effect.acquireRelease(
      gate.withPermit(
        resolve().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leases += 1;
            }),
          ),
        ),
      ),
      () =>
        Effect.sync(() => {
          leases -= 1;
        }),
    );
  });
  const runCommand = Effect.fn("CodexInstallation.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(command, args).pipe(
      Effect.provideService(HostProcess.Platform, platform),
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
    );
    const [output, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* installationError(
        "verify",
        "Could not unpack or start the downloaded Codex package.",
      );
    return output;
  }, Effect.scoped);
  // Native Codex needs its adjacent host; launchers resolve their own payloads.
  const hasCodeModeHost = Effect.fn("CodexInstallation.hasCodeModeHost")(
    function* (realExecutablePath: string) {
      if (/^(?:volta-shim|mise|aqua-proxy)(?:\.exe)?$/iu.test(path.basename(realExecutablePath)))
        return true;
      if (platform === "win32") {
        if (path.extname(realExecutablePath).toLowerCase() !== ".exe") return true;
        for (const extension of [".bunx", ".shim"]) {
          const marker = yield* fs
            .stat(realExecutablePath.slice(0, -4) + extension)
            .pipe(Effect.option);
          if (
            Option.isSome(marker) &&
            marker.value.type === "File" &&
            Number(marker.value.size) > 0
          )
            return true;
        }
      } else {
        const header = yield* fs.open(realExecutablePath, { flag: "r" }).pipe(
          Effect.flatMap((file) => file.readAlloc(2)),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(header) && header.value[0] === 0x23 && header.value[1] === 0x21)
          return true;
      }
      const info = yield* fs.stat(
        path.join(
          path.dirname(realExecutablePath),
          `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
        ),
      );
      return (
        info.type === "File" &&
        Number(info.size) > 0 &&
        (platform === "win32" || (info.mode & 0o111) !== 0)
      );
    },
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
  const localCache = new Map<string, { fingerprint: string; executable: CodexExecutable | null }>();
  const resolveLocal = Effect.fn("CodexInstallation.resolveLocal")(
    function* () {
      const external = yield* resolveExternalCodexPath(managedDirectory, environment).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (external === null) return null;
      // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
      const { executablePath, realExecutablePath } = external;
      if (!(yield* hasCodeModeHost(realExecutablePath))) return null;
      const info = yield* fs.stat(executablePath);
      const fingerprint = `${realExecutablePath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`;
      const cached = localCache.get(executablePath);
      const executable =
        cached?.fingerprint === fingerprint
          ? cached.executable
          : yield* Effect.gen(function* () {
              const output = yield* runCommand(executablePath, ["--version"]);
              const version = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(output.trim())?.[1];
              if (!version) return null;
              yield* runCommand(executablePath, ["app-server", "--help"]);
              return {
                executablePath,
                source: "local",
                version,
                managedVersionDirectory: null,
              } satisfies CodexExecutable;
            }).pipe(
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() => null),
            );
      localCache.set(executablePath, { fingerprint, executable });
      if (!executable) return null;
      const advisory = yield* compatibility(executable.version);
      return advisory?.status === "supported" ? executable : null;
    },
    Effect.orElseSucceed(() => null),
  );
  const resolve = Effect.fn("CodexInstallation.resolve")(function* () {
    const local = yield* resolveLocal();
    return local ?? (yield* resolveManaged());
  });
  const selectedManagedRelease = Effect.fn("CodexInstallation.selectedManagedRelease")(
    function* () {
      if (yield* resolveLocal()) return null;
      return yield* readActiveRelease().pipe(Effect.orElseSucceed(() => null));
    },
  );
  const installedManagedVersion = selectedManagedRelease().pipe(
    Effect.map((release) => release?.version ?? null),
  );
  const lookupLatestRelease = Effect.fn("CodexInstallation.lookupLatestRelease")(
    function* () {
      if (!asset) return null;
      const response = yield* http
        .execute(
          HttpClientRequest.get(LATEST_RELEASE_URL, {
            headers: { accept: "application/vnd.github+json", "user-agent": "T3.CodeShip" },
          }),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const body = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: MAX_RELEASE_METADATA_BYTES,
      });
      if (body.truncated || body.invalidUtf8) return null;
      const latest = yield* decodeLatestRelease(body.text);
      const version = STABLE_RELEASE_TAG.exec(latest.tag_name)?.[1];
      if (!version || !version.split(".").every((part) => Number.isSafeInteger(Number(part))))
        return null;
      const comparison = compareSemverVersions(version, asset.version);
      if (comparison < 0) return null;
      const matching = latest.assets.filter(
        (entry) => isNamedAsset(entry) && entry.name === archiveName(asset.target),
      );
      if (matching.length !== 1) return null;
      const uploaded = yield* decodeUploadedAsset(matching[0]);
      if (comparison === 0) return asset;
      return releaseAsset(
        asset.target,
        uploaded.digest.slice("sha256:".length),
        uploaded.size,
        version,
      );
    },
    Effect.timeout("10 seconds"),
    Effect.catch((error) =>
      Effect.logDebug("Could not check for a managed Codex release", { reason: error._tag }).pipe(
        Effect.as(null),
      ),
    ),
  );
  const latestRelease = yield* Effect.cachedWithTTL(lookupLatestRelease(), (exit) =>
    Exit.isSuccess(exit) && exit.value !== null ? "1 hour" : "1 minute",
  );
  const supportedLatestRelease = Effect.fn("CodexInstallation.supportedLatestRelease")(
    function* () {
      const latest = yield* latestRelease;
      return latest && (yield* compatibility(latest.version))?.status === "supported"
        ? latest
        : null;
    },
  );
  const checkForUpdate = Effect.gen(function* () {
    if (!asset || !(yield* installedManagedVersion)) return null;
    const latest = yield* supportedLatestRelease();
    const installedVersion = yield* installedManagedVersion;
    return installedVersion ? { installedVersion, latestVersion: latest?.version ?? null } : null;
  }).pipe(Effect.withSpan("CodexInstallation.checkForUpdate"));
  const reuseLocal = Effect.fn("CodexInstallation.reuseLocal")(function* () {
    const local = yield* resolveLocal();
    if (!local) return false;
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          phase: "succeeded",
          source: "local",
          operationId: null,
          installedVersion: local.version,
          executablePath: local.executablePath,
          downloadedBytes: 0,
          totalBytes: null,
          message: null,
        }) satisfies ProviderInstallState,
    );
    return true;
  });
  const validate =
    options.validate ??
    Effect.fn("CodexInstallation.validate")(
      function* (executable: CodexExecutable, version: string) {
        const output = yield* runCommand(executable.executablePath, ["--version"]);
        if (output.trim() !== `codex-cli ${version}`)
          return yield* installationError(
            "verify",
            "The downloaded Codex executable has the wrong version.",
          );
      },
      Effect.mapError(wrapFailure("verify", "The downloaded Codex runtime could not start.")),
    );
  const install = Effect.fn("CodexInstallation.install")(
    function* (release: CodexReleaseAsset, completion: Deferred.Deferred<ProviderInstallState>) {
      yield* decodeVersion(release.version);
      yield* fs.makeDirectory(managedDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(managedDirectory, release.version);
      const activate = Effect.fn("CodexInstallation.activate")(
        function* () {
          const executable = yield* completedRelease(release.version);
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: ".active-",
          });
          const pointer = path.join(temporary, "active.json");
          yield* fs.writeFileString(pointer, yield* encodeActive({ version: release.version }), {
            mode: 0o600,
            flag: "wx",
          });
          yield* requireInstallCompatibility(release.version, "verify");
          yield* fs.rename(pointer, activePath);
          const terminal = yield* SubscriptionRef.updateAndGet(
            state,
            (current) =>
              ({
                ...current,
                phase: "succeeded",
                source: "managed",
                installedVersion: release.version,
                executablePath: executable.executablePath,
                message: null,
              }) satisfies ProviderInstallState,
          );
          yield* Deferred.succeed(completion, terminal);
        },
        Effect.scoped,
        Effect.uninterruptible,
      );
      if (yield* fs.exists(destination)) {
        const existing = yield* completedRelease(release.version);
        const record = yield* readRecord(
          path.join(destination, ".install-complete.json"),
          InstalledRelease,
        );
        if (record.sha256 !== release.sha256 || record.target !== release.target)
          return yield* installationError(
            "verify",
            "The existing managed Codex release differs from the official package. Remove it and reinstall.",
          );
        yield* validate(existing, release.version).pipe(
          Effect.scoped,
          Effect.timeout("90 seconds"),
        );
        yield* activate();
        return;
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.tar.gz");
      const runtime = path.join(staging, "runtime");
      yield* fs.makeDirectory(runtime);
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > release.archiveBytes)
              return yield* installationError(
                "download",
                "The Codex download exceeded the expected release size.",
              );
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250 || downloadedBytes === release.archiveBytes) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        Effect.timeout("45 minutes"),
        Effect.catchTags({
          TimeoutError: (cause) =>
            installationError(
              "download",
              "The Codex download timed out. Retry installation.",
              cause,
            ),
        }),
      );
      if (downloadedBytes !== release.archiveBytes || hash.digest("hex") !== release.sha256)
        return yield* installationError(
          "download",
          "The Codex download failed its size or SHA-256 check. Nothing was installed.",
        );
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "extracting",
            message: "Extracting Codex.",
          }) satisfies ProviderInstallState,
      );
      // Bare `tar` on Windows can resolve to Git's MSYS tar, which reads `C:\...` as a remote host.
      const tarCommand = cliArchiveTarCommand(platform, environment);
      const entries = (yield* runCommand(tarCommand, ["-tzf", archivePath])).trim().split(/\r?\n/u);
      const types = (yield* runCommand(tarCommand, ["-tvzf", archivePath])).trim().split(/\r?\n/u);
      if (
        entries.length > 10000 ||
        entries.length !== types.length ||
        types.some((line) => !["-", "d"].includes(line[0] ?? "")) ||
        entries.some((entry) => {
          const parts = entry.replace(/\/$/u, "").split("/");
          return (
            !entry ||
            entry.includes("\\") ||
            entry.startsWith("/") ||
            parts.some((part) => part === ".." || part === "." || part === "" || part.includes(":"))
          );
        })
      )
        return yield* installationError("extract", "The Codex archive contains unsafe entries.");
      yield* runCommand(tarCommand, ["-xzf", archivePath, "-C", runtime]);
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "verifying",
            message: "Checking Codex.",
          }) satisfies ProviderInstallState,
      );
      const executable = yield* fromDirectory(runtime, release.version, release.target);
      yield* validate(executable, release.version).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
      );
      yield* fs.writeFileString(
        path.join(runtime, ".install-complete.json"),
        yield* encodeRecord({
          version: release.version,
          target: release.target,
          sha256: release.sha256,
        }),
        { flag: "wx", mode: 0o600 },
      );
      // Windows Defender or process rundown may retain codex.exe handles briefly after --version exits.
      const renameRuntime = fs.rename(runtime, destination);
      yield* platform === "win32"
        ? renameRuntime.pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("100 millis") }))
        : renameRuntime;
      yield* activate();
    },
    Effect.scoped,
    Effect.catchTags({
      HttpClientError: (cause) => {
        const httpStatus =
          cause.reason._tag === "StatusCodeError" ? cause.reason.response.status : undefined;
        return new CodexInstallationError({
          operation: "download",
          detail:
            httpStatus === undefined
              ? "The Codex download was interrupted. Check your internet connection, then retry installation."
              : `The Codex download server returned HTTP ${httpStatus}. Try again later.`,
          cause,
        });
      },
    }),
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Codex. Check disk space and directory access, then try again.",
      ),
    ),
  );
  const beginInstall = Effect.fn("CodexInstallation.beginInstall")(function* (
    release: CodexReleaseAsset,
    current: ProviderInstallState,
    installed: CodexExecutable | null,
  ) {
    yield* requireInstallCompatibility(release.version, "start");
    const operationId = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(wrapFailure("start", "Could not start the Codex installation.")));
    const completion = yield* Deferred.make<ProviderInstallState>();
    const next: ProviderInstallState = {
      driver: DRIVER,
      operationId,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: release.archiveBytes,
      version: release.version,
      installedVersion: installed?.version ?? null,
      ...(installed ? { source: installed.source, executablePath: installed.executablePath } : {}),
      canRemove: current.canRemove,
      message: "Downloading Codex.",
    };
    yield* SubscriptionRef.set(state, next);
    const work = install(release, completion).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        return SubscriptionRef.updateAndGet(state, (value) => {
          if (value.operationId !== operationId || value.phase === "succeeded") return value;
          const error = Cause.findErrorOption(exit.cause);
          const cancelled = Cause.hasInterruptsOnly(exit.cause);
          return {
            ...value,
            phase: cancelled ? "cancelled" : "failed",
            message: cancelled
              ? "Installation cancelled. The previous runtime is unchanged."
              : Option.isSome(error)
                ? error.value.detail
                : "Could not finish the Codex installation. Check disk space and directory access.",
          } satisfies ProviderInstallState;
        }).pipe(Effect.flatMap((terminal) => Deferred.succeed(completion, terminal)));
      }),
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          if (running?.operationId === operationId) running = undefined;
        }),
      ),
    );
    const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
    const operation = { operationId, version: release.version, completion, fiber };
    running = operation;
    return { state: next, operation };
  });

  const alreadyInstalled = (current: ProviderInstallState, installed: CodexExecutable) =>
    ({
      ...current,
      operationId: null,
      phase: "succeeded",
      downloadedBytes: 0,
      totalBytes: null,
      version: installed.version,
      installedVersion: installed.version,
      executablePath: installed.executablePath,
      source: "managed",
      message: null,
    }) satisfies ProviderInstallState;

  const start = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        if (yield* reuseLocal()) return yield* SubscriptionRef.get(state);
        if (!asset) {
          return yield* installationError(
            "start",
            `OpenAI does not publish a Codex runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
          );
        }
        const installed = yield* readActiveRelease().pipe(Effect.orElseSucceed(() => null));
        if (installed && compareSemverVersions(installed.version, asset.version) > 0) {
          const next = alreadyInstalled(current, installed);
          yield* SubscriptionRef.set(state, next);
          return next;
        }
        return (yield* beginInstall(asset, current, installed)).state;
      }).pipe(Effect.uninterruptible),
    )
    .pipe(Effect.mapError(wrapFailure("start", "Could not start the Codex installation.")));

  const startUpdate = Effect.fn("CodexInstallation.startUpdate")(
    function* (version: string): Effect.fn.Return<ProviderInstallState, CodexInstallationError> {
      const noManagedRelease = () =>
        installationError("update", "There is no active T3.CodeShip-managed Codex to update.");
      if (!(yield* selectedManagedRelease())) return yield* noManagedRelease();
      const release = yield* supportedLatestRelease();
      if (!release || release.version !== version)
        return yield* installationError(
          "update",
          "This Codex update is no longer available. Refresh provider status and try again.",
        );
      const next = yield* gate.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const installed = yield* selectedManagedRelease();
          if (!installed) return yield* noManagedRelease();
          if (running && isRunning(current)) return { state: current, operation: running };
          const comparison = compareSemverVersions(installed.version, release.version);
          if (comparison >= 0)
            return { state: alreadyInstalled(current, installed), operation: null };
          return yield* beginInstall(release, current, installed);
        }).pipe(Effect.uninterruptible),
      );
      if (!next.operation) return next.state;
      const result = yield* Deferred.await(next.operation.completion);
      if (next.operation.version !== version) return yield* startUpdate(version);
      if (result.phase !== "succeeded")
        return yield* installationError(
          "update",
          result.message ?? "Could not finish the managed Codex update. Try again.",
        );
      return result;
    },
    Effect.mapError(wrapFailure("update", "Could not start the Codex update.")),
  );

  const cancel = Effect.fn("CodexInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId) {
          return yield* installationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        }
        if (running?.operationId === operationId && isRunning(current)) {
          yield* Fiber.interrupt(running.fiber);
        }
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("CodexInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases > 0) {
            return yield* installationError(
              "remove",
              "Stop Codex sessions and sign-in flows before removing its managed runtime.",
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binary of protectedBinaryPaths) {
              const resolved = yield* fs.realPath(binary).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binary));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`))
                return yield* installationError(
                  "remove",
                  "A provider instance uses a custom path inside managed Codex. Clear that path before removing it.",
                );
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                totalBytes: asset?.archiveBytes ?? null,
                version: asset?.version ?? null,
                installedVersion: null,
                executablePath: null,
                source: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
          yield* reuseLocal();
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Codex runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    // Shared-home installs do not refresh parent mtimes; remove only staging directories far older than the 45-minute download cap.
    let canRemove = false;
    if (yield* fs.exists(managedDirectory)) {
      const entries = yield* fs
        .readDirectory(managedDirectory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries) {
        if (!entry.startsWith(".install-") && !entry.startsWith(".active-")) continue;
        const target = path.join(managedDirectory, entry);
        const info = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const modifiedAt = Option.match(info.value.mtime, {
          onNone: () => now,
          onSome: (date) => date.getTime(),
        });
        if (now - modifiedAt < STAGING_STALE_AFTER_MS) continue;
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
      }
      // Keep the empty root to avoid racing new staging directories; unreadable roots remain removable.
      const remaining = yield* fs.readDirectory(managedDirectory).pipe(Effect.option);
      canRemove = Option.isNone(remaining) || remaining.value.length > 0;
    }
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (yield* reuseLocal()) return;
    if (!(yield* fs.exists(activePath))) return;
    const installed = yield* readActiveRelease();
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          version:
            asset && compareSemverVersions(installed.version, asset.version) < 0
              ? asset.version
              : installed.version,
          installedVersion: installed.version,
          executablePath: installed.executablePath,
          source: "managed",
        }) satisfies ProviderInstallState,
    );
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Codex runtime is incomplete. Remove it and reinstall.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  const current = yield* SubscriptionRef.get(state);
  // An existing CodeShip-owned copy follows the release pinned by the app.
  if (
    asset &&
    current.source === "managed" &&
    current.installedVersion &&
    compareSemverVersions(current.installedVersion, asset.version) < 0
  ) {
    yield* start.pipe(
      Effect.catch((error) =>
        SubscriptionRef.update(state, (value) => ({
          ...value,
          phase: "failed" as const,
          message: error.detail,
        })),
      ),
    );
  }

  return CodexInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    compatibility,
    start,
    installedManagedVersion,
    checkForUpdate,
    startUpdate,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});
