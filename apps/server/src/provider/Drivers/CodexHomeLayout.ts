// @effect-diagnostics-next-line nodeBuiltinImport:off - Linking without elevation on Windows needs junctions and exact file IDs, which Effect's FileSystem lacks.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - SHA-256 fingerprints compare bounded file contents, not filesystem timestamps.
import * as NodeCrypto from "node:crypto";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { acquireFileLock } from "../FileLock.ts";
import { fileSystemFailure } from "../fileSystemFailure.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
] as const;

// auth.lock guards the shadow home's private auth.json. .credentials.json holds the account's MCP
// sign-ins: copies of a rotating refresh token in two homes sign each other out. secrets/ holds the
// account's encrypted login and sign-ins, keyed in the OS keyring for each home.
const PRIVATE_ENTRY_NAMES = new Set([
  "auth.json",
  "auth.lock",
  ".credentials.json",
  "secrets",
  "models_cache.json",
  "cloud-config-bundle-cache.json",
]);
const WINDOWS_LINK_STATE_DIRECTORY = ".t3-shared-files";
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set([
  "log",
  "memories",
  "tmp",
  ".DS_Store",
  WINDOWS_LINK_STATE_DIRECTORY,
]);
// Driver starts and managed refreshes can reconcile the same files through different accounts.
const windowsMaterializations = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number }
>();
const WINDOWS_CONTENT_FINGERPRINT_LIMIT = 1024n * 1024n;
const WINDOWS_RECONCILIATION_ENTRY = /\.t3-(?:backup-|aside-|link|shared-files\.lock)/;
// Setup moves a file aside to `<name>.t3-aside-<uuid>` and prepares an account file's link at
// `<name>.t3-link-<uuid>`; only that random v4 UUID marks a name as setup's own. An aside stays
// until it is linked back, discarded as the recorded shared copy or backed up.
const WINDOWS_LEFTOVER =
  /^(.+)\.t3-(aside|link)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set([
  "mcp-oauth-locks",
  "thread-writer-locks",
  ".sqlite-maintenance.lock",
]);

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

// Codex accepts bundled plugins only from this path under CODEX_HOME. The shared
// config names the original home, so shadow homes must override it through their .tmp link.
const BUNDLED_MARKETPLACE = "openai-bundled";

const quoteCliArg = (value: string) => `"${value.replace(/["\\$`]/g, "\\$&")}"`;

export function codexHomeLaunchArgs(path: Path.Path, layout: CodexHomeLayout, launchArgs: string) {
  const homePath = layout.effectiveHomePath;
  if (layout.mode !== "authOverlay" || homePath === undefined) return launchArgs;
  const source = path.join(homePath, ".tmp", "bundled-marketplaces", BUNDLED_MARKETPLACE);
  const setting = `marketplaces.${BUNDLED_MARKETPLACE}.source=${JSON.stringify(source)}`;
  const override = `-c ${quoteCliArg(setting)}`;
  // User launch args come last so an explicit source still wins.
  return launchArgs.length > 0 ? `${override} ${launchArgs}` : override;
}

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

class CodexSharedFileChangedError extends Schema.TaggedError<CodexSharedFileChangedError>()(
  "CodexSharedFileChangedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Codex file '${this.path}' changed while it was being moved aside.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

// SQLite keeps -wal and -shm beside the path it opened: beside the shared database when POSIX
// follows a link, beside the link on Windows, where databases therefore stay private per account.
const SQLITE_FILE = /\.(?:sqlite|db)(?:-wal|-shm|-journal)?$/i;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SQLITE_SIDECAR = /-(?:wal|shm|journal)$/i;
const isSqliteSidecar = (name: string) => SQLITE_FILE.test(name) && SQLITE_SIDECAR.test(name);

// The id keeps backups made at the same moment, even by different servers, from replacing each other.
const backupPathFor = (basePath: string) =>
  DateTime.now.pipe(
    Effect.map(
      (now) =>
        `${basePath}.t3-backup-${DateTime.formatIso(now).replaceAll(/[:.]/g, "-")}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    ),
  );

// An account's own copy moves to `<name>.t3-backup-<time>-<id>` beside it rather than being deleted.
const backUpEntry = Effect.fn("CodexHomeLayout.backUpEntry")(function* (
  fileSystem: FileSystem.FileSystem,
  entryPath: string,
): Effect.fn.Return<string, PlatformError.PlatformError> {
  const backupPath = yield* backupPathFor(entryPath);
  yield* fileSystem.rename(entryPath, backupPath);
  return backupPath;
});

// A -shm only indexes its log and an empty log holds nothing; a log with frames moves aside.
const settleOwnSqliteLog = Effect.fn("CodexHomeLayout.settleOwnSqliteLog")(function* (
  fileSystem: FileSystem.FileSystem,
  logPath: string,
): Effect.fn.Return<void, PlatformError.PlatformError> {
  const info = yield* fileSystem.stat(logPath);
  if (/-shm$/i.test(logPath) || info.size === 0n) return yield* fileSystem.remove(logPath);
  const backupPath = yield* backUpEntry(fileSystem, logPath);
  yield* Effect.logError("Moved a Codex account's own SQLite log aside; its database is shared.", {
    path: logPath,
    backupPath,
  });
});

// No setup links SQLite logs. Logs left beside a linked database are stale on POSIX and split from
// the shared log on Windows, as are links to shared databases there from older setups. Codex holds
// files open locked on Windows, and the group is retried on a later setup.
const settleSqliteFiles = Effect.fn("CodexHomeLayout.settleSqliteFiles")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly windows: boolean;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const names = yield* input.fileSystem.readDirectory(input.effectiveHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readDirectory",
          path: input.effectiveHomePath,
          cause,
        }),
    }),
  );
  const sqliteNames = new Set(names.filter((name) => SQLITE_FILE.test(name)));
  const linked = new Set<string>();
  for (const entryName of sqliteNames) {
    const linkPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({ ...input, entryName, linkPath });
    if (state._tag === "Symlink") linked.add(entryName);
  }
  const databases = new Set([...linked].map((name) => name.replace(SQLITE_SIDECAR, "")));
  yield* Effect.forEach(
    databases,
    (database) =>
      Effect.gen(function* () {
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          const sidecar = `${database}${suffix}`;
          const sidecarPath = path.join(input.effectiveHomePath, sidecar);
          if (linked.has(sidecar)) yield* input.fileSystem.remove(sidecarPath);
          // Logs beside the account's own database may belong to a live connection.
          else if (sqliteNames.has(sidecar) && linked.has(database)) {
            yield* settleOwnSqliteLog(input.fileSystem, sidecarPath);
          }
        }
        if (input.windows && linked.has(database)) {
          yield* input.fileSystem.remove(path.join(input.effectiveHomePath, database));
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("A Codex database is in use; a later setup settles its files.", {
            path: path.join(input.effectiveHomePath, database),
            error,
          }),
        ),
      ),
    { discard: true },
  );
});

// Codex creates entries that the main home may only gain later, such as a new database. Launches
// go on with the shared entry while the account's copy is kept aside. A database with a log beside
// it is open or was not closed cleanly, so it stays until a later setup.
const replaceOwnCopy = Effect.fn("CodexHomeLayout.replaceOwnCopy")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly entryName: string;
  readonly link: string;
  readonly createLink: Effect.Effect<void, CodexShadowHomeError>;
}): Effect.fn.Return<void, CodexShadowHomeError> {
  if (SQLITE_FILE.test(input.entryName)) {
    const logs = yield* Effect.forEach(SQLITE_SIDECAR_SUFFIXES, (suffix) =>
      input.fileSystem.exists(`${input.link}${suffix}`).pipe(Effect.orElseSucceed(() => true)),
    );
    if (logs.some(Boolean)) {
      return yield* Effect.logWarning(
        "A Codex account's own database is in use; a later setup shares the main one.",
        { path: input.link },
      );
    }
  }
  return yield* backUpEntry(input.fileSystem, input.link).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning("A Codex account keeps its own copy of a shared entry for now.", {
          path: input.link,
          error,
        }),
      onSuccess: (backupPath) =>
        Effect.logError("Moved a Codex account's own copy of a shared entry aside to share it.", {
          entryName: input.entryName,
          backupPath,
        }).pipe(Effect.andThen(input.createLink)),
    }),
  );
});

const WindowsLinkRecord = Schema.Struct({
  target: Schema.String,
  identity: Schema.String,
  version: Schema.String,
  fingerprint: Schema.optional(Schema.String),
});
const decodeWindowsLinkRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WindowsLinkRecord),
);
const encodeWindowsLinkRecord = Schema.encodeSync(Schema.fromJsonString(WindowsLinkRecord));

const windowsFileVersion = Effect.fn("CodexHomeLayout.windowsFileVersion")(function* (
  filePath: string,
) {
  const info = yield* Effect.tryPromise({
    try: () => NodeFSP.lstat(filePath, { bigint: true }),
    catch: fileSystemFailure("lstat", filePath),
  });
  return {
    identity: `${info.dev}:${info.ino}`,
    version: `${info.size}:${info.mtimeNs}`,
    size: info.size,
    links: info.nlink,
    regular: info.isFile(),
    symlink: info.isSymbolicLink(),
  };
});

const windowsFileFingerprint = Effect.fn("CodexHomeLayout.windowsFileFingerprint")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const before = yield* windowsFileVersion(filePath);
  if (!before.regular || before.size > WINDOWS_CONTENT_FINGERPRINT_LIMIT) {
    return { ...before, fingerprint: `metadata:${before.identity}:${before.version}` };
  }
  const bytes = yield* fileSystem.readFile(filePath);
  const after = yield* windowsFileVersion(filePath);
  return {
    ...after,
    fingerprint:
      before.identity === after.identity &&
      before.version === after.version &&
      BigInt(bytes.length) <= WINDOWS_CONTENT_FINGERPRINT_LIMIT
        ? `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`
        : undefined,
  };
});

const isMissingPath = (error: { readonly cause?: unknown }) =>
  error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT";

// link never replaces a path, so a file a writer recreated between our checks is kept.
const linkUnlessPresent = (fileSystem: FileSystem.FileSystem, existing: string, newPath: string) =>
  fileSystem.link(existing, newPath).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
  );

const windowsLeftoverPath = (entryPath: string, kind: "aside" | "link") =>
  `${entryPath}.t3-${kind}-${NodeCrypto.randomUUID()}`;

// lstat reports Windows junctions as symbolic links too.
const isWindowsSymlink = (entryPath: string) =>
  windowsFileVersion(entryPath).pipe(
    Effect.map((info) => info.symlink),
    Effect.catchIf(isMissingPath, () => Effect.succeed(false)),
  );

const windowsContentHash = Effect.fn("CodexHomeLayout.windowsContentHash")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hash = yield* fileSystem.stream(filePath).pipe(
    Stream.runFold(
      () => NodeCrypto.createHash("sha256"),
      (hash, chunk) => hash.update(chunk),
    ),
  );
  return hash.digest("hex");
});

// A backup still linked to other accounts would change with their later writes, so a linked file
// is duplicated, and it leaves its aside path only once the duplicate is published.
const backUpWindowsAside = Effect.fn("CodexHomeLayout.backUpWindowsAside")(function* (
  aside: string,
  entryPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const backupPath = yield* backupPathFor(entryPath);
  const before = yield* windowsFileVersion(aside);
  if (!before.regular || before.links === 1n) {
    yield* fileSystem.rename(aside, backupPath);
    return backupPath;
  }
  const copy = `${aside}.t3-copy`;
  yield* Effect.gen(function* () {
    yield* fileSystem.copyFile(aside, copy);
    // Windows may leave a file's write time unchanged until its writer closes it, so only content
    // shows the duplicate holds what the aside does.
    const [copied, current] = yield* Effect.forEach([copy, aside], (file) =>
      windowsContentHash(file),
    );
    if ((yield* windowsFileVersion(aside)).identity !== before.identity || copied !== current) {
      return yield* new CodexSharedFileChangedError({ path: entryPath });
    }
    yield* fileSystem.rename(copy, backupPath);
  }).pipe(
    Effect.ensuring(fileSystem.remove(copy, { force: true }).pipe(Effect.ignore({ log: true }))),
  );
  yield* fileSystem.remove(aside);
  return backupPath;
});

const recoverWindowsAside = Effect.fn("CodexHomeLayout.recoverWindowsAside")(function* (
  entryPath: string,
  aside: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  // An unfinished duplicate exists only beside its aside, which keeps the content until a duplicate
  // is published, so it is redundant.
  yield* fileSystem.remove(`${aside}.t3-copy`, { force: true });
  const info = yield* windowsFileVersion(aside);
  // Windows hard-links a symlink itself, so a symlink goes back as it was. One Windows cannot link,
  // such as a junction, is backed up like a folder so it cannot block later setups.
  const linkedBack = info.regular
    ? yield* linkUnlessPresent(fileSystem, aside, entryPath)
    : info.symlink
      ? yield* linkUnlessPresent(fileSystem, aside, entryPath).pipe(
          Effect.catch((error) =>
            Effect.logWarning("A Codex link setup had moved aside could not be put back.", {
              path: entryPath,
              error,
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;
  // A setup stopped right after linking one back leaves both paths on the same file.
  if (
    linkedBack === true ||
    (linkedBack === false && info.identity === (yield* windowsFileVersion(entryPath)).identity)
  ) {
    return yield* fileSystem.remove(aside);
  }
  const backupPath = yield* backUpWindowsAside(aside, entryPath);
  yield* Effect.logWarning("Backed up a Codex file that setup had moved aside.", {
    path: entryPath,
    backupPath,
  });
}, Effect.uninterruptible);

// Servers sharing a Codex home reconcile its files one at a time, so none restores a file another
// has just moved aside. A crashed or stalled holder's lock goes stale; a stalled holder taken over
// that way fails its setup, and what it moved aside stays recoverable.
const withSharedFileLock = <A, E, R>(lockPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* acquireFileLock(lockPath, {
        lockfilePath: `${lockPath}.lock`,
        realpath: false,
        stale: 10_000,
        retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100 },
        onCompromised: (error) =>
          Effect.logWarning("A Codex shared-file lock was taken over during setup.", {
            path: lockPath,
            error,
          }),
      });
      return yield* effect;
    }),
  );

// Under the shared-file lock, any leftover was left by a setup that never finished. A prepared link
// is only a second name setup gave a file it was linking.
const recoverWindowsLeftovers = Effect.fn("CodexHomeLayout.recoverWindowsLeftovers")(function* (
  entryPath: string,
  preparedLinks: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(entryPath);
  yield* Effect.forEach(
    yield* fileSystem.readDirectory(directory),
    (name) => {
      const leftover = WINDOWS_LEFTOVER.exec(name);
      if (leftover?.[1] !== path.basename(entryPath)) return Effect.void;
      const leftoverPath = path.join(directory, name);
      if (leftover[2] === "aside") return recoverWindowsAside(entryPath, leftoverPath);
      return preparedLinks ? fileSystem.remove(leftoverPath) : Effect.void;
    },
    { discard: true },
  );
});

// Metadata skips redundant hashes; only captured content can authorize discarding a copy.
const shareFileOnWindows = Effect.fn("CodexHomeLayout.shareFileOnWindows")(function* (
  sharedPath: string,
  link: string,
  accountSymlinked: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Each side gets its file back even when the other side's leftovers cannot be recovered or the
  // shared path no longer resolves; reconciling waits until both sides are recovered.
  const accountRecovered = yield* recoverWindowsLeftovers(link, true).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning(
        "What a stopped setup left beside a Codex account file could not be recovered yet.",
        { path: link, error },
      ).pipe(Effect.as(false)),
    ),
  );
  const resolved = yield* resolveSymlinkTarget(sharedPath);
  const target = path.join(
    yield* fileSystem.realPath(path.dirname(resolved)),
    path.basename(resolved),
  );
  const pending = windowsLeftoverPath(link, "link");
  // The account's path can change at any moment, so an adoption installs a name setup owns.
  const source = windowsLeftoverPath(link, "link");
  yield* recoverWindowsLeftovers(target, false);
  // An account that links to the shared path needs only the shared file back.
  if (!accountRecovered || accountSymlinked || !(yield* fileSystem.exists(target))) return;
  const recordPath = path.join(
    path.dirname(link),
    WINDOWS_LINK_STATE_DIRECTORY,
    `${path.basename(link)}.json`,
  );
  // A record is setup's own file; one behind a link could describe or overwrite anything.
  const recordLinked =
    (yield* isWindowsSymlink(path.dirname(recordPath))) || (yield* isWindowsSymlink(recordPath));
  if (recordLinked) {
    yield* Effect.logWarning(
      "A Codex shared-file record is behind a link, so it is not used; unrecognized copies will be kept aside.",
      { path: recordPath },
    );
  }
  const recordText = recordLinked
    ? undefined
    : yield* fileSystem
        .readFileString(recordPath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  const record =
    recordText === undefined
      ? undefined
      : yield* decodeWindowsLinkRecord(recordText).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "A Codex shared-file record is invalid; unrecognized copies will be kept aside.",
              {
                path: recordPath,
                error,
              },
            ).pipe(Effect.as(undefined)),
          ),
        );
  const shared = yield* windowsFileVersion(target);
  // exists follows links, so a dangling symlink here would never be replaced.
  const current = yield* windowsFileVersion(link).pipe(
    Effect.catchIf(isMissingPath, () => Effect.void),
  );
  const matchesContent = (info: { readonly fingerprint: string | undefined }) =>
    record?.target === target &&
    record.fingerprint?.startsWith("sha256:") === true &&
    record.fingerprint === info.fingerprint;
  const recordInstalled = Effect.gen(function* () {
    if (recordLinked) return;
    const installed = yield* windowsFileFingerprint(link);
    const sharedNow = yield* windowsFileVersion(target);
    if (installed.identity !== sharedNow.identity || installed.fingerprint === undefined) return;
    yield* writeFileStringAtomically({
      filePath: recordPath,
      contents: encodeWindowsLinkRecord({
        target,
        identity: installed.identity,
        version: installed.version,
        fingerprint: installed.fingerprint,
      }),
    });
  });
  if (current?.identity === shared.identity) {
    if (
      record?.target !== target ||
      record.identity !== current.identity ||
      record.version !== current.version ||
      record.fingerprint === undefined
    ) {
      yield* recordInstalled;
    }
    return;
  }

  // Windows links a symlink itself, so a shared path that became one after it was resolved is left
  // for the next setup to resolve again.
  const preparePending = () =>
    fileSystem.link(target, pending).pipe(
      Effect.andThen(windowsFileVersion(pending)),
      Effect.map((info) => info.regular),
    );
  yield* Effect.gen(function* () {
    // Cross-volume or denied links fail here, before either user's path is moved.
    if (!(yield* preparePending())) return;
    if (current !== undefined) {
      const own = yield* windowsFileFingerprint(link);
      const stale = own.identity === record?.identity && matchesContent(own);
      if (
        !stale &&
        own.regular &&
        own.size <= WINDOWS_CONTENT_FINGERPRINT_LIMIT &&
        matchesContent(yield* windowsFileFingerprint(target))
      ) {
        yield* fileSystem.link(link, source);
        const held = yield* windowsFileVersion(source);
        // Windows links a symlink itself, so only the regular file fingerprinted above is adopted; a
        // file put in its place since is reconciled by the next setup.
        if (!held.regular || held.identity !== own.identity) return;
        const adopting = windowsLeftoverPath(target, "aside");
        const adoptMoved = Effect.gen(function* () {
          const installed =
            matchesContent(yield* windowsFileFingerprint(adopting)) &&
            (yield* linkUnlessPresent(fileSystem, source, target));
          if (!installed) {
            yield* recoverWindowsAside(target, adopting);
            return false;
          }
          // Node cannot deny other Windows handles, so a writer that opened the old file can still
          // change it; only a copy that still matches its record is discarded.
          if (matchesContent(yield* windowsFileFingerprint(adopting))) {
            yield* fileSystem.remove(adopting);
            return true;
          }
          const backupPath = yield* backUpWindowsAside(adopting, target);
          yield* Effect.logWarning("Kept a Codex shared file that changed while it was replaced.", {
            path: target,
            backupPath,
          });
          return true;
        }).pipe(
          // Other accounts and the shared home read this path, so it must not stay moved aside.
          Effect.onError(() =>
            recoverWindowsAside(target, adopting).pipe(Effect.ignore({ log: true })),
          ),
        );
        // A refused move leaves nothing to recover.
        const adopted = yield* fileSystem
          .rename(target, adopting)
          .pipe(Effect.andThen(adoptMoved), Effect.uninterruptible);
        if (adopted) {
          yield* recordInstalled;
          return yield* Effect.logInfo(
            "Adopted a Codex account's shared-file change into the shared home.",
            { path: link, targetPath: target },
          );
        }
        yield* fileSystem.remove(source);
        yield* fileSystem.remove(pending);
        if (!(yield* preparePending())) return;
      }

      const aside = windowsLeftoverPath(link, "aside");
      const settle = Effect.gen(function* () {
        const info = yield* windowsFileFingerprint(aside);
        const installed = yield* linkUnlessPresent(fileSystem, pending, link);
        const verified = stale && info.identity === record?.identity && matchesContent(info);
        if (verified && installed && matchesContent(yield* windowsFileFingerprint(aside))) {
          yield* fileSystem.remove(aside);
          return installed;
        }
        const backupPath = yield* backUpWindowsAside(aside, link);
        yield* Effect.logWarning("Moved an unrecognized Codex account's shared-file copy aside.", {
          path: link,
          backupPath,
        });
        return installed;
      }).pipe(
        Effect.onError(() => recoverWindowsAside(link, aside).pipe(Effect.ignore({ log: true }))),
      );
      // A refused move leaves nothing to recover; cancellation after it could leave the account
      // without the file.
      const installed = yield* fileSystem
        .rename(link, aside)
        .pipe(Effect.andThen(settle), Effect.uninterruptible);
      if (!installed) return;
    } else {
      const installed = yield* linkUnlessPresent(fileSystem, pending, link);
      if (!installed) return;
    }
    yield* recordInstalled;
  }).pipe(
    Effect.ensuring(
      Effect.forEach(
        [pending, source],
        (leftover) =>
          fileSystem.remove(leftover, { force: true }).pipe(Effect.ignore({ log: true })),
        { discard: true },
      ),
    ),
  );
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const windows = yield* HostProcess.isWindows;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  if (windows) {
    if (SQLITE_FILE.test(input.entryName)) return;
    const targetType = yield* input.fileSystem.stat(target).pipe(
      Effect.map((info) => info.type),
      // A shared path that cannot be inspected is still reconciled as a file, so what a stopped
      // setup left beside it and beside the account file is recovered.
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : Effect.logWarning(
                "A shared Codex path could not be inspected; it is reconciled as a file.",
                { path: target, error: cause },
              ),
      }),
    );
    if (targetType !== "Directory") {
      return yield* withSharedFileLock(
        path.join(input.sharedHomePath, WINDOWS_LINK_STATE_DIRECTORY),
        shareFileOnWindows(
          target,
          link,
          state._tag === "Symlink" && path.resolve(path.dirname(link), state.target) === target,
        ),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, input.fileSystem),
        Effect.catch((error) =>
          Effect.logWarning(
            "A shared Codex file could not be linked; this account keeps its own.",
            {
              path: link,
              error,
            },
          ),
        ),
      );
    }
  }

  // Junctions link folders on Windows without Developer Mode or elevation.
  const createLink = Effect.gen(function* () {
    if (windows) {
      return yield* Effect.tryPromise({
        try: () => NodeFSP.symlink(target, link, "junction"),
        catch: fileSystemFailure("symlink", link),
      });
    }
    return yield* input.fileSystem.symlink(target, link);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    ),
  );

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(input.entryName)) {
      return yield* replaceOwnCopy({ ...input, link, createLink });
    }

    if (input.entryName === "thread-writer-locks") {
      const lockNames = yield* input.fileSystem.readDirectory(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "readDirectory",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      if (lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock")) {
        return yield* Effect.logWarning(
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
          { path: link },
        );
      }
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(
  function* (layout: CodexHomeLayout) {
    if (layout.mode !== "authOverlay") return;
    const effectiveHomePath = layout.effectiveHomePath;
    if (!effectiveHomePath) return;
    if (layout.sharedHomePath === effectiveHomePath) {
      return yield* new CodexShadowHomePathConflictError({
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const makeDirectory = (directoryPath: string) =>
      fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              operation: "makeDirectory",
              path: directoryPath,
              cause,
            }),
        }),
      );

    yield* Effect.all(
      [
        makeDirectory(layout.sharedHomePath),
        makeDirectory(effectiveHomePath),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          makeDirectory(path.join(layout.sharedHomePath, directory)),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const readEntryNames = (directory: string) =>
      fileSystem.readDirectory(directory).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              operation: "readDirectory",
              path: directory,
              cause,
            }),
        }),
      );
    const windows = yield* HostProcess.isWindows;
    // What a stopped Windows setup left behind is recovered even if the file it belongs to is gone.
    const leftoverEntry = (name: string, preparedLinks: boolean) => {
      const leftover = windows ? WINDOWS_LEFTOVER.exec(name) : null;
      return leftover?.[2] === "aside" || preparedLinks ? leftover?.[1] : undefined;
    };
    const sharedEntryNames = yield* readEntryNames(layout.sharedHomePath);
    const accountLeftoverNames = windows
      ? (yield* readEntryNames(effectiveHomePath)).flatMap(
          (name) => leftoverEntry(name, true) ?? [],
        )
      : [];
    const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
    for (const entryName of [
      ...sharedEntryNames.map((name) => leftoverEntry(name, false) ?? name),
      ...accountLeftoverNames,
    ]) {
      if (
        !PRIVATE_ENTRY_NAMES.has(entryName) &&
        !SHADOW_LOCAL_ENTRY_NAMES.has(entryName) &&
        !isSqliteSidecar(entryName) &&
        !WINDOWS_RECONCILIATION_ENTRY.test(entryName)
      ) {
        entries.add(entryName);
      }
    }

    yield* Effect.forEach(
      PRIVATE_ENTRY_NAMES,
      (entryName) =>
        entryName === "auth.json"
          ? Effect.void
          : removePrivateSymlink({
              fileSystem,
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              entryName,
            }),
      { discard: true },
    );

    yield* settleSqliteFiles({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      windows,
    });

    yield* Effect.forEach(
      entries,
      (entryName) => {
        if (PRIVATE_ENTRY_NAMES.has(entryName)) {
          return Effect.void;
        }
        return ensureSymlink({
          fileSystem,
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          entryName,
        });
      },
      { discard: true },
    );

    yield* ensureShadowAuthIsPrivate({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  },
  (effect, layout) =>
    Effect.gen(function* () {
      const effectiveHomePath = layout.effectiveHomePath;
      if (layout.mode !== "authOverlay" || !effectiveHomePath || !(yield* HostProcess.isWindows)) {
        return yield* effect;
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const sharedHome = yield* fileSystem
        .makeDirectory(layout.sharedHomePath, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.realPath(layout.sharedHomePath)),
          Effect.mapError(
            (cause) =>
              new CodexShadowHomeFileSystemError({
                sharedHomePath: layout.sharedHomePath,
                effectiveHomePath,
                operation: "makeDirectory",
                path: layout.sharedHomePath,
                cause,
              }),
          ),
        );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = windowsMaterializations.get(sharedHome) ?? {
            semaphore: Semaphore.makeUnsafe(1),
            users: 0,
          };
          entry.users += 1;
          windowsMaterializations.set(sharedHome, entry);
          return entry;
        }),
        (entry) => entry.semaphore.withPermit(effect),
        (entry) =>
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0) windowsMaterializations.delete(sharedHome);
          }),
      );
    }),
);

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
