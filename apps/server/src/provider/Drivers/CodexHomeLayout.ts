// @effect-diagnostics-next-line nodeBuiltinImport:off - Linking without elevation on Windows needs junctions and exact file IDs, which Effect's FileSystem lacks.
import * as NodeFSP from "node:fs/promises";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

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
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
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

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "stat",
    ]),
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

// An account's own copy moves to `<name>.t3-backup-<time>` beside it rather than being deleted.
const backUpEntry = Effect.fn("CodexHomeLayout.backUpEntry")(function* (
  fileSystem: FileSystem.FileSystem,
  entryPath: string,
): Effect.fn.Return<string, PlatformError.PlatformError> {
  const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(/[:.]/g, "-");
  let backupPath = `${entryPath}.t3-backup-${stamp}`;
  for (let copy = 2; yield* fileSystem.exists(backupPath); copy += 1) {
    backupPath = `${entryPath}.t3-backup-${stamp}-${copy}`;
  }
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

// Windows symlinks need Developer Mode or elevation; hard links do not. Codex may replace a shared
// file, so re-link whenever the account's copy is no longer the same file.
const shareFileOnWindows = (target: string, link: string) =>
  Effect.tryPromise(async () => {
    const [shared, current] = await Promise.all([
      NodeFSP.stat(target, { bigint: true }),
      NodeFSP.lstat(link, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    ]);
    if (current?.ino === shared.ino && current.dev === shared.dev) return;
    const pending = `${link}.t3-link`;
    await NodeFSP.rm(pending, { force: true });
    await NodeFSP.link(target, pending);
    // Windows refuses to replace a file Codex holds open; the next setup retries.
    await NodeFSP.rename(pending, link).catch(async (error: unknown) => {
      await NodeFSP.rm(pending, { force: true });
      throw error;
    });
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
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : new CodexShadowHomeFileSystemError({
                sharedHomePath: input.sharedHomePath,
                effectiveHomePath: input.effectiveHomePath,
                operation: "stat",
                path: target,
                entryName: input.entryName,
                cause,
              }),
      }),
    );
    // Codex's temporary files can vanish between listing the home and linking them.
    if (targetType === undefined) return;
    if (targetType !== "Directory") {
      if (state._tag === "Symlink" && path.resolve(path.dirname(link), state.target) === target) {
        return;
      }
      return yield* shareFileOnWindows(target, link).pipe(
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
    if (windows) return yield* Effect.tryPromise(() => NodeFSP.symlink(target, link, "junction"));
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

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
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

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (
      !PRIVATE_ENTRY_NAMES.has(entryName) &&
      !SHADOW_LOCAL_ENTRY_NAMES.has(entryName) &&
      !isSqliteSidecar(entryName)
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
    windows: yield* HostProcess.isWindows,
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
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
