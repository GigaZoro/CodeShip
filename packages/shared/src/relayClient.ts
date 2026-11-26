// @effect-diagnostics-next-line nodeBuiltinImport:off -- rmdir removes only empty directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import type {
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isWindowsRenameLock } from "./atomicWrite.ts";
import * as HostProcess from "./HostProcess.ts";
import { isProcessAlive } from "./processProbe.ts";

export const CLOUDFLARED_VERSION = "2026.10.4";
// Minimum for --output support and the eMudhra fix, which 2026.10.2 macOS builds lack.
export const CLOUDFLARED_MIN_VERSION = "2026.10.3";
const CLOUDFLARED_PATH_ENV_NAME = "T3CODE_CLOUDFLARED_PATH";

const CLOUDFLARED_DOWNLOAD_TIMEOUT = "10 minutes";

export type RelayClientExecutableSource = "override" | "managed" | "path";

export type RelayClientStatus =
  | {
      readonly status: "available";
      readonly executablePath: string;
      readonly source: RelayClientExecutableSource;
      readonly version: string;
    }
  | {
      readonly status: "missing";
      readonly version: string;
    }
  | {
      readonly status: "unsupported";
      readonly platform: NodeJS.Platform;
      readonly arch: string;
      readonly version: string;
    };

export type AvailableRelayClient = Extract<RelayClientStatus, { readonly status: "available" }>;

class RelayClientDirectoryRemoveError extends Schema.TaggedError<RelayClientDirectoryRemoveError>()(
  "RelayClientDirectoryRemoveError",
  { directory: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not remove the relay client directory ${this.directory}.`;
  }
}

export class RelayClientInstallError extends Schema.TaggedError<RelayClientInstallError>()(
  "RelayClientInstallError",
  {
    reason: Schema.Literals([
      "download_failed",
      "invalid_checksum",
      "install_locked",
      "managed_by_policy",
      "override_missing",
      "unsupported_platform",
      "validation_failed",
      "write_failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isRelayClientInstallError = Schema.is(RelayClientInstallError);

class CloudflaredCommandError extends Schema.TaggedError<CloudflaredCommandError>()(
  "CloudflaredCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {}

export interface CloudflaredReleaseAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archive: "binary" | "tgz";
}

const CLOUDFLARED_RELEASE_ASSETS: Readonly<
  Partial<Record<`${NodeJS.Platform}-${string}`, CloudflaredReleaseAsset>>
> = {
  "darwin-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-darwin-arm64.tgz",
    sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
    archive: "tgz",
  },
  "darwin-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-darwin-amd64.tgz",
    sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d",
    archive: "tgz",
  },
  "linux-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-arm64",
    sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6",
    archive: "binary",
  },
  "linux-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64",
    sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
    archive: "binary",
  },
  "win32-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    archive: "binary",
  },
  // Cloudflare publishes no Windows ARM64 build; Windows 11 on ARM runs x64 under emulation.
  "win32-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    archive: "binary",
  },
};

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
// Legacy installers write elsewhere. Give an unidentified older install time to publish its pin.
const LEGACY_LOCK_WAIT_MS = 30 * 60 * 1_000;
const EXTRACT_TIMEOUT = "2 minutes";
const VERSION_PROBE_TIMEOUT = "10 seconds";
// Antivirus scans can hold the first launch of a freshly downloaded binary for 20-30 s.
const INSTALL_VALIDATION_TIMEOUT = "2 minutes";

const ACTIVATE_RETRY_COUNT = 40;
const ACTIVATE_RETRY_DELAY = "250 millis";

const trimmedString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const CloudflaredConfig = Config.all({
  executableOverride: trimmedString(CLOUDFLARED_PATH_ENV_NAME),
});

export interface CloudflaredRelayClientOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CloudflaredReleaseAsset;
}

export interface RelayClientShape {
  readonly resolve: Effect.Effect<RelayClientStatus>;
  readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  readonly installWithProgress: (
    report: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  /** Returns true once the cache was scanned and every eligible obsolete binary was removed. */
  readonly pruneManagedVersions: Effect.Effect<boolean>;
}

export function isPinnedManagedRelayClient(client: AvailableRelayClient): boolean {
  return client.source === "managed" && client.version === CLOUDFLARED_VERSION;
}

export class RelayClient extends Context.Service<RelayClient, RelayClientShape>()(
  "@t3tools/shared/relayClient",
) {}

function executableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function resolveReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): CloudflaredReleaseAsset | null {
  return CLOUDFLARED_RELEASE_ASSETS[`${platform}-${arch}`] ?? null;
}

const VERSION_PATTERN = /\b(\d{4})\.(\d{1,2})\.(\d+)\b/u;

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareCloudflaredVersions(left: string, right: string): number {
  const a = parseVersion(left) ?? [0, 0, 0];
  const b = parseVersion(right) ?? [0, 0, 0];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function parseCloudflaredVersionOutput(output: string): string | null {
  const version = parseVersion(output);
  return version ? version.join(".") : null;
}

class VersionProbeKey extends Data.Class<{
  readonly executablePath: string;
  readonly size: number;
  readonly mtimeMillis: number;
}> {}

function parseLockOwnerPid(owner: string): number | null {
  const match = /^(\d+)-.+$/u.exec(owner);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : null;
}

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const wrapInstallFailure =
  (
    reason: RelayClientInstallError["reason"],
    message: string,
  ): (<E, R>(
    effect: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, RelayClientInstallError, R>) =>
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason,
            message,
            cause,
          }),
      ),
    );

export const makeCloudflaredRelayClient = Effect.fn("cloudflared.make")(function* (
  options: CloudflaredRelayClientOptions,
): Effect.fn.Return<
  RelayClientShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Digest.Digest
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installSemaphore = yield* Semaphore.make(1);
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const releaseAsset = options.releaseAsset ?? resolveReleaseAsset(platform, arch);
  const loadCloudflaredConfig = Effect.suspend(() => CloudflaredConfig).pipe(Effect.orDie);
  const managedRoot = path.join(options.baseDir, "tools", "cloudflared");
  const installRoot = path.join(managedRoot, "install");
  const legacyPathFor = (version: string) =>
    path.join(managedRoot, version, `${platform}-${arch}`, executableFileName(platform));
  const previousInstallPathFor = (version: string) =>
    path.join(managedRoot, version, `${platform}-${arch}`, "install", executableFileName(platform));
  // Older servers can recursively prune version directories. Keep all current writes outside them.
  const managedPathFor = (version: string) =>
    path.join(installRoot, version, `${platform}-${arch}`, executableFileName(platform));
  const managedPath = managedPathFor(CLOUDFLARED_VERSION);
  const legacyLockPath = `${legacyPathFor(CLOUDFLARED_VERSION)}.lock`;
  // Never unlink this file. Its OS-held transaction ends on scope close or process exit.
  const installLockPath = path.join(managedRoot, `install-${platform}-${arch}.sqlite`);

  const isExecutableFile = Effect.fn("cloudflared.isExecutableFile")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
  });

  const readVersion = Effect.fn("cloudflared.readVersion")(
    function* (executable: string, _timeout: Duration.Input) {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["version"], { stdin: "ignore", stderr: "ignore" }),
      );
      const [output, exitCode] = yield* Effect.all(
        [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: 2 },
      );
      if (exitCode !== 0) {
        return yield* new CloudflaredCommandError({ command: executable, exitCode });
      }
      return parseCloudflaredVersionOutput(output);
    },
    Effect.scoped,
    (effect, _executable, timeout) => Effect.timeout(effect, timeout),
  );

  // Cache successful version probes per file revision; do not let transient failures hide valid binaries.
  const versionCache = yield* Cache.makeWith(
    (key: VersionProbeKey) => readVersion(key.executablePath, VERSION_PROBE_TIMEOUT),
    {
      capacity: 16,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : Duration.zero,
    },
  );
  const probeVersion = Effect.fn("cloudflared.probeVersion")(function* (executablePath: string) {
    const info = yield* fileSystem.stat(executablePath);
    if (info.type !== "File") return null;
    if (platform !== "win32" && (info.mode & 0o111) === 0) return null;
    return yield* Cache.get(
      versionCache,
      new VersionProbeKey({
        executablePath,
        size: Number(info.size),
        mtimeMillis: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
      }),
    );
  });

  const compatibleCandidate = Effect.fn("cloudflared.compatibleCandidate")(function* (
    executablePath: string,
    source: RelayClientExecutableSource,
  ) {
    const version = yield* probeVersion(executablePath).pipe(Effect.orElseSucceed(() => null));
    if (version === null || compareCloudflaredVersions(version, CLOUDFLARED_MIN_VERSION) < 0) {
      return null;
    }
    return { status: "available", executablePath, source, version } satisfies AvailableRelayClient;
  });

  const managedCandidate = Effect.fn("cloudflared.managedCandidate")(function* (version: string) {
    let folderMatch: AvailableRelayClient | null = null;
    let fallback: AvailableRelayClient | null = null;
    for (const candidatePath of [managedPathFor, previousInstallPathFor, legacyPathFor]) {
      const candidate = yield* compatibleCandidate(candidatePath(version), "managed");
      if (!candidate) continue;
      if (candidate.version === CLOUDFLARED_VERSION) return candidate;
      if (candidate.version === version) folderMatch ??= candidate;
      fallback ??= candidate;
    }
    return folderMatch ?? fallback;
  });

  // A newer release directory belongs to another server version.
  const olderVersionsIn = Effect.fn("cloudflared.olderVersionsIn")(function* (root: string) {
    const entries = yield* fileSystem.readDirectory(root);
    return entries.filter(
      (entry) =>
        /^\d{4}\.\d{1,2}\.\d+$/u.test(entry) &&
        compareCloudflaredVersions(entry, CLOUDFLARED_VERSION) < 0,
    );
  });

  const bestManagedClient = Effect.gen(function* () {
    let fallback = yield* managedCandidate(CLOUDFLARED_VERSION);
    if (fallback?.version === CLOUDFLARED_VERSION) return fallback;
    const versions = new Set([
      ...(yield* olderVersionsIn(installRoot).pipe(Effect.orElseSucceed(() => []))),
      ...(yield* olderVersionsIn(managedRoot).pipe(Effect.orElseSucceed(() => []))),
    ]);
    for (const version of [...versions].sort((a, b) => compareCloudflaredVersions(b, a))) {
      const candidate = yield* managedCandidate(version);
      if (candidate?.version === CLOUDFLARED_VERSION) return candidate;
      fallback ??= candidate;
    }
    return fallback;
  });

  const resolvePathExecutable = Effect.gen(function* () {
    // Read hydrated PATH directly; ConfigProvider may have cached it before fixPath.
    const rawPathValue = (yield* HostProcess.Environment).PATH;
    // POSIX keeps the raw value, so trimming never turns " :/bin" into an empty entry.
    const pathValue = platform === "win32" ? rawPathValue?.trim() : rawPathValue;
    if (!pathValue) return null;
    const delimiter = platform === "win32" ? ";" : ":";
    const cwd = yield* HostProcess.WorkingDirectory;
    for (const directory of pathValue.split(delimiter)) {
      // POSIX shells search the working directory for an empty entry. Resolve it now: the
      // connector may be launched from elsewhere.
      const workingDirectoryEntry = directory === "" && platform !== "win32";
      const trimmed = directory.trim().replace(/^"|"$/gu, "");
      if (trimmed.length === 0 && !workingDirectoryEntry) continue;
      const candidate = workingDirectoryEntry
        ? path.resolve(cwd, executableFileName(platform))
        : path.join(trimmed, executableFileName(platform));
      if (!(yield* isExecutableFile(candidate))) continue;
      const available = yield* compatibleCandidate(candidate, "path");
      if (available) return available;
      yield* Effect.logWarning("Skipping an incompatible relay client on PATH", {
        executablePath: candidate,
        minimumVersion: CLOUDFLARED_MIN_VERSION,
      });
    }
    return null;
  });

  const missingStatus: RelayClientStatus = { status: "missing", version: CLOUDFLARED_VERSION };
  const unsupportedStatus: RelayClientStatus = {
    status: "unsupported",
    platform,
    arch,
    version: CLOUDFLARED_VERSION,
  };
  const resolve: RelayClientShape["resolve"] = Effect.gen(function* () {
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      const override = yield* compatibleCandidate(config.executableOverride.value, "override");
      if (override) return override;
      yield* Effect.logWarning(
        `${CLOUDFLARED_PATH_ENV_NAME} must point to cloudflared ${CLOUDFLARED_MIN_VERSION} or newer`,
        { executablePath: config.executableOverride.value },
      );
      return missingStatus;
    }
    const managed = yield* bestManagedClient;
    if (managed) return managed;
    const pathExecutable = yield* resolvePathExecutable;
    if (pathExecutable) return pathExecutable;
    return releaseAsset ? missingStatus : unsupportedStatus;
  }).pipe(Effect.withSpan("cloudflared.resolve"));

  const retryWhileWindowsLocked = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
    effect.pipe(
      Effect.retry({
        times: ACTIVATE_RETRY_COUNT,
        schedule: Schedule.spaced(ACTIVATE_RETRY_DELAY),
        while: (error) => platform === "win32" && isWindowsRenameLock(error),
      }),
    );

  const renameWhenUnlocked = (from: string, to: string) =>
    retryWhileWindowsLocked(Effect.uninterruptible(fileSystem.rename(from, to)));

  const runCommand = Effect.fn("cloudflared.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        shell: false,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new CloudflaredCommandError({ command, exitCode });
    }
  });

  const downloadAsset = Effect.fn("cloudflared.downloadAsset")(function* (
    asset: CloudflaredReleaseAsset,
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("downloading");
    const response = yield* httpClient.execute(HttpClientRequest.get(asset.url)).pipe(
      Effect.timeout(CLOUDFLARED_DOWNLOAD_TIMEOUT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "download_failed",
            message: "Could not download the relay client.",
            cause,
          }),
      ),
    );
    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.timeout(CLOUDFLARED_DOWNLOAD_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new RelayClientInstallError({
              reason: "download_failed",
              message: "Could not read the downloaded relay client binary.",
              cause,
            }),
        ),
      ),
    );
    yield* report("verifying");
    const checksum = yield* digest.digest(Digest.sha256, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "validation_failed",
            message: "Could not verify the downloaded relay client checksum.",
            cause,
          }),
      ),
    );
    if (Hex.encode(checksum) !== asset.sha256) {
      return yield* new RelayClientInstallError({
        reason: "invalid_checksum",
        message: "Downloaded relay client checksum did not match the pinned release.",
      });
    }
    return bytes;
  });

  const legacyInstallPending = Effect.gen(function* () {
    const info = yield* fileSystem.stat(legacyLockPath).pipe(
      Effect.asSome,
      Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<FileSystem.File.Info>())),
    );
    if (Option.isNone(info)) return false;
    const { mtime, type } = info.value;
    if (
      Option.isSome(mtime) &&
      (yield* Clock.currentTimeMillis) - mtime.value.getTime() > LEGACY_LOCK_WAIT_MS
    ) {
      return false;
    }
    if (type !== "Directory") return true;
    const owners = yield* fileSystem.readDirectory(legacyLockPath).pipe(
      // A predecessor may release or replace its directory during this read. Recheck on the next attempt.
      Effect.catchIf(
        (error) => isNotFound(error) || error.reason._tag === "BadResource",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
    );
    return (
      owners.length === 0 ||
      owners.some((owner) => {
        const pid = parseLockOwnerPid(owner);
        return pid === null || isProcessAlive(pid);
      })
    );
  });

  const lockWriteFailure = (cause: unknown) =>
    new RelayClientInstallError({
      reason: "write_failed",
      message: "Could not acquire the relay client installation lock.",
      cause,
    });
  const openInstallDatabase = Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(installLockPath, { timeout: 0 }),
      catch: lockWriteFailure,
    }),
    (db) => Effect.sync(() => db.close()),
  );
  const installLocked = () =>
    new RelayClientInstallError({
      reason: "install_locked",
      message: "Another relay client installation is still in progress.",
    });
  const isSqliteBusy = (cause: unknown) =>
    cause instanceof Error &&
    (("errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 0xff) === 5) ||
      ("code" in cause && cause.code === "SQLITE_BUSY"));
  const tryBeginInstallTransaction = (db: NodeSqlite.DatabaseSync) =>
    Effect.try({
      try: () => db.exec("BEGIN EXCLUSIVE"),
      catch: (cause) => (isSqliteBusy(cause) ? installLocked() : lockWriteFailure(cause)),
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason === "install_locked",
        () => Effect.succeed(false),
      ),
    );

  const acquireInstallLock = Effect.fn("cloudflared.acquireInstallLock")(function* () {
    const db = yield* openInstallDatabase;
    yield* Effect.gen(function* () {
      if ((yield* legacyInstallPending) || !(yield* tryBeginInstallTransaction(db))) {
        return yield* installLocked();
      }
    }).pipe(
      Effect.retry({
        times: INSTALL_LOCK_RETRY_COUNT - 1,
        schedule: Schedule.spaced(INSTALL_LOCK_RETRY_DELAY),
        while: (error) =>
          error._tag === "RelayClientInstallError" && error.reason === "install_locked",
      }),
    );
  });

  const removeDirectoryIfEmpty = (directory: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.rmdir(directory),
      catch: (cause) => new RelayClientDirectoryRemoveError({ directory, cause }),
    }).pipe(
      Effect.catch(({ cause }) => {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return Effect.void;
        return Effect.logDebug("Could not remove an empty relay client directory", {
          directory,
          cause,
        });
      }),
    );

  const pruneManagedVersions: RelayClientShape["pruneManagedVersions"] = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(installRoot))) return true;
    const db = yield* openInstallDatabase;
    if (!(yield* tryBeginInstallTransaction(db))) return false;
    const realRoot = yield* fileSystem.realPath(managedRoot);
    const obsolete: Array<{ executable: string; reportedVersion: string }> = [];
    for (const folder of yield* olderVersionsIn(installRoot)) {
      const executable = managedPathFor(folder);
      // Limit deletion to this namespace and architecture, including when the cache uses links.
      const real = yield* fileSystem.realPath(executable).pipe(
        Effect.asSome,
        Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
      );
      if (
        Option.isNone(real) ||
        path.relative(realRoot, real.value) !== path.relative(managedRoot, executable)
      )
        continue;
      const reportedVersion = yield* probeVersion(executable);
      if (
        reportedVersion !== null &&
        compareCloudflaredVersions(reportedVersion, CLOUDFLARED_VERSION) < 0
      ) {
        obsolete.push({ executable, reportedVersion });
      }
    }
    obsolete.sort((a, b) => compareCloudflaredVersions(b.reportedVersion, a.reportedVersion));
    const rollback = obsolete.find(
      ({ reportedVersion }) =>
        compareCloudflaredVersions(reportedVersion, CLOUDFLARED_MIN_VERSION) >= 0,
    );
    let complete = true;
    for (const entry of obsolete) {
      if (entry === rollback) continue;
      const { executable } = entry;
      yield* Effect.gen(function* () {
        yield* fileSystem.remove(executable, { force: true });
        const directory = path.dirname(executable);
        yield* removeDirectoryIfEmpty(directory);
        yield* removeDirectoryIfEmpty(path.dirname(directory));
        yield* Effect.logInfo("Removed an older managed relay client", { executable });
      }).pipe(
        Effect.catch((cause) => {
          complete = false;
          return Effect.logDebug("Could not prune a relay client", { executable, cause });
        }),
      );
    }
    return complete;
  }).pipe(
    Effect.scoped,
    Effect.catch((cause) =>
      Effect.logDebug("Could not prune managed relay clients", { cause }).pipe(Effect.as(false)),
    ),
    Effect.withSpan("cloudflared.pruneManagedVersions"),
  );

  const installUnlocked = Effect.fn("cloudflared.installUnlocked")(function* (
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("checking");
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      const override = yield* compatibleCandidate(config.executableOverride.value, "override");
      if (override) return override;
      return yield* new RelayClientInstallError({
        reason: "override_missing",
        message: `${CLOUDFLARED_PATH_ENV_NAME} must point to cloudflared ${CLOUDFLARED_MIN_VERSION} or newer.`,
      });
    }
    const existing = yield* bestManagedClient;
    if (existing && isPinnedManagedRelayClient(existing)) return existing;
    if (!releaseAsset) {
      return yield* new RelayClientInstallError({
        reason: "unsupported_platform",
        message: `T3.CodeShip does not provide a managed relay client binary for ${platform}-${arch}.`,
      });
    }

    const managedDirectory = path.dirname(managedPath);
    yield* fileSystem
      .makeDirectory(managedRoot, { recursive: true })
      .pipe(
        wrapInstallFailure("write_failed", "Could not create the relay client tool directory."),
      );
    yield* report("waiting_for_lock");
    yield* acquireInstallLock().pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            new RelayClientInstallError({
              reason: "write_failed",
              message: "Could not acquire the relay client installation lock.",
              cause,
            }),
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      const afterLock = yield* bestManagedClient;
      if (afterLock && isPinnedManagedRelayClient(afterLock)) return afterLock;

      yield* fileSystem.makeDirectory(managedDirectory, { recursive: true });
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(
        tempDirectory,
        releaseAsset.archive === "tgz" ? "cloudflared.tgz" : executableFileName(platform),
      );
      const download = yield* downloadAsset(releaseAsset, report);
      yield* report("installing");
      yield* fileSystem
        .writeFile(archivePath, download)
        .pipe(wrapInstallFailure("write_failed", "Could not write the relay client download."));

      const executablePath = path.join(tempDirectory, executableFileName(platform));
      if (releaseAsset.archive === "tgz") {
        yield* runCommand("tar", ["-xzf", archivePath, "-C", tempDirectory]).pipe(
          Effect.timeout(EXTRACT_TIMEOUT),
          wrapInstallFailure("write_failed", "Could not extract the relay client."),
        );
      }
      if (platform !== "win32") {
        yield* fileSystem
          .chmod(executablePath, 0o755)
          .pipe(wrapInstallFailure("write_failed", "Could not make the relay client executable."));
      }
      yield* report("validating");
      // Verify the pin so mislabeled assets cannot cause repeated redownloads.
      const installedVersion = yield* readVersion(executablePath, INSTALL_VALIDATION_TIMEOUT).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (installedVersion !== CLOUDFLARED_VERSION) {
        return yield* new RelayClientInstallError({
          reason: "validation_failed",
          message:
            installedVersion === null
              ? "The downloaded relay client binary did not run."
              : `The downloaded relay client reports version ${installedVersion}, not ${CLOUDFLARED_VERSION}.`,
        });
      }

      const stagedPath = `${managedPath}.${yield* random.uuidV4()}.tmp`;
      yield* report("activating");
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore),
      );
      yield* renameWhenUnlocked(executablePath, stagedPath).pipe(
        wrapInstallFailure("write_failed", "Could not stage the relay client."),
      );
      yield* renameWhenUnlocked(stagedPath, managedPath).pipe(
        wrapInstallFailure("write_failed", "Could not activate the relay client."),
      );
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      } satisfies AvailableRelayClient;
    }).pipe(
      Effect.scoped,
      Effect.catchIf(
        (cause) => !isRelayClientInstallError(cause),
        (cause) =>
          Effect.fail(
            new RelayClientInstallError({
              reason: "write_failed",
              message: "Could not install the relay client.",
              cause,
            }),
          ),
      ),
    );
  });
  const installWithProgress: RelayClientShape["installWithProgress"] = (report) =>
    installSemaphore.withPermit(
      installUnlocked((stage) =>
        report({
          type: "progress",
          stage,
        }),
      ).pipe(Effect.scoped),
    );
  const install = installWithProgress(() => Effect.void);

  return RelayClient.of({ resolve, install, installWithProgress, pruneManagedVersions });
});

export const layerCloudflared = (options: CloudflaredRelayClientOptions) =>
  Layer.effect(RelayClient, makeCloudflaredRelayClient(options));
