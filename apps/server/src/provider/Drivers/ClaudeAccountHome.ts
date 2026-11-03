// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction or a hard link to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { lock } from "proper-lockfile";

/** An added Claude account keeps its own login here; CodeShip creates the folder and links the rest. */
export const claudeAccountHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
) => path.join(stateDir, "providers", "claudeAgent", instanceId, "home");

// The login, account state and Anthropic-managed settings belong to one account.
const PRIVATE_ENTRIES = new Set([
  ".credentials.json",
  ".claude.json",
  "backups",
  "remote-settings.json",
  ".DS_Store",
]);
// Claude's locks and pending writes beside its config and login belong to that account.
const isPrivateEntry = (entry: string) =>
  PRIVATE_ENTRIES.has(entry) ||
  entry.startsWith(".claude.json.") ||
  entry.startsWith(".storage-write");
// Created in the shared folder first, so every account's sessions land in one place and threads can move between accounts.
const SHARED_DIRECTORIES = ["projects"];

/** Windows links folders with a junction, and files with a hard link when symlinks need elevation. */
export const linkPath = (
  target: string,
  link: string,
  platform: NodeJS.Platform,
  directory: boolean,
) =>
  Effect.tryPromise(async () => {
    if (directory) {
      await NodeFSP.symlink(target, link, platform === "win32" ? "junction" : "dir");
      return;
    }
    try {
      await NodeFSP.symlink(target, link, "file");
    } catch (error) {
      if (platform !== "win32") throw error;
      await NodeFSP.link(target, link);
    }
  });

/** Links everything in the shared Claude folder into the account's folder, except its login. */
export const materializeClaudeAccountHome = Effect.fn("materializeClaudeAccountHome")(
  function* (input: {
    readonly sharedHome: string;
    readonly accountHome: string;
  }): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const linkEntry = Effect.fn("ClaudeAccountHome.linkEntry")(function* (entry: string) {
      const target = path.join(input.sharedHome, entry);
      const link = path.join(input.accountHome, entry);
      const [current, expected] = yield* Effect.all([
        fileSystem.realPath(link).pipe(Effect.option),
        fileSystem.realPath(target).pipe(Effect.option),
      ]);
      if (Option.isSome(current) && Option.isSome(expected) && current.value === expected.value)
        return;
      const isLink = yield* fileSystem.readLink(link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      // A real entry here was written by this account (or is a Windows hard link); keep it.
      if (Option.isSome(current) && !isLink) return;
      if (isLink) yield* fileSystem.remove(link);
      const info = yield* fileSystem.stat(target);
      yield* linkPath(target, link, platform, info.type === "Directory");
    });
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(input.accountHome, { recursive: true });
      for (const directory of SHARED_DIRECTORIES) {
        yield* fileSystem.makeDirectory(path.join(input.sharedHome, directory), {
          recursive: true,
        });
      }
      for (const entry of yield* fileSystem.readDirectory(input.sharedHome)) {
        if (isPrivateEntry(entry)) continue;
        yield* linkEntry(entry).pipe(
          Effect.catch((error) =>
            Effect.logWarning("A shared Claude file is not linked into the account's folder.", {
              entry,
              error,
            }),
          ),
        );
      }
      // Older builds linked in a lock Claude held at the time; once released, the dangling link
      // keeps Claude from ever taking that lock for this account.
      for (const entry of yield* fileSystem.readDirectory(input.accountHome)) {
        if (!isPrivateEntry(entry) || !entry.endsWith(".lock")) continue;
        const lockPath = path.join(input.accountHome, entry);
        const isLink = yield* fileSystem.readLink(lockPath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (isLink) yield* fileSystem.remove(lockPath);
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("The Claude account's folder could not be prepared.", {
          accountHome: input.accountHome,
          error,
        }),
      ),
    );
  },
);

const ClaudeConfigObject = Schema.Record(Schema.String, Schema.Unknown);
// Claude indents its config the same way.
const ClaudeConfigJson = Schema.fromJsonString(ClaudeConfigObject, { space: 2 });
const CopiedNamesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeClaudeConfig = Schema.decodeUnknownOption(ClaudeConfigJson);
const encodeClaudeConfig = Schema.encodeSync(ClaudeConfigJson);
const decodeMcpServers = Schema.decodeUnknownOption(Schema.UndefinedOr(ClaudeConfigObject));
const decodeCopiedNames = Schema.decodeUnknownOption(CopiedNamesJson);
const encodeCopiedNames = Schema.encodeSync(CopiedNamesJson);

// Beside the account's folder, where Claude never looks.
const COPIED_MCP_SERVERS_FILE = "shared-mcp-servers.json";

interface ClaudeConfigFile {
  readonly config: Readonly<Record<string, unknown>>;
  readonly servers: Readonly<Record<string, unknown>>;
}

const parseClaudeConfig = (text: string): Option.Option<ClaudeConfigFile> =>
  decodeClaudeConfig(text).pipe(
    Option.flatMap((config) =>
      decodeMcpServers(config.mcpServers).pipe(
        Option.map((servers) => ({ config, servers: servers ?? {} })),
      ),
    ),
  );

/** A missing config has no servers; one that is not valid JSON is none. */
const readClaudeConfig = Effect.fn("ClaudeAccountHome.readClaudeConfig")(function* (
  configPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(configPath).pipe(
    Effect.map(parseClaudeConfig),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeedSome<ClaudeConfigFile>({ config: {}, servers: {} }),
    ),
  );
});

/** The user MCP servers in a Claude config, or none when it cannot be read. */
export const readClaudeMcpServerNames = Effect.fn("readClaudeMcpServerNames")(function* (
  configPath: string,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem> {
  const config = yield* readClaudeConfig(configPath).pipe(
    Effect.catch((error) =>
      Effect.logWarning("The Claude config could not be read.", { path: configPath, error }).pipe(
        Effect.as(Option.none<ClaudeConfigFile>()),
      ),
    ),
  );
  return new Set(Option.isSome(config) ? Object.keys(config.value.servers) : []);
});

const readCopiedNames = Effect.fn("ClaudeAccountHome.readCopiedNames")(function* (
  copiedNamesPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(copiedNamesPath).pipe(
    Effect.map((text) => new Set(Option.getOrElse(decodeCopiedNames(text), () => []))),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(new Set<string>())),
  );
});

/** Renames over the config so Claude never reads half of it; a linked config keeps its link. */
const writeClaudeConfig = Effect.fn("ClaudeAccountHome.writeClaudeConfig")(function* (
  configPath: string,
  config: Readonly<Record<string, unknown>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const target = yield* fileSystem.realPath(configPath);
  const pending = `${target}.t3code-pending`;
  yield* fileSystem.writeFileString(pending, encodeClaudeConfig(config), { mode: 0o600 });
  yield* fileSystem
    .rename(pending, target)
    .pipe(Effect.onError(() => fileSystem.remove(pending).pipe(Effect.ignore)));
});

/**
 * Claude holds `<file>.lock` to read and rewrite a file, so a copy never lands between the two.
 * `stale` matches the one Claude uses for that lock.
 */
export const withClaudeLock = <A, E, R>(
  file: string,
  task: Effect.Effect<A, E, R>,
  options: { readonly stale?: number } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          lock(file, {
            lockfilePath: `${file}.lock`,
            realpath: false,
            ...options,
            retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100 },
            onCompromised: (error) =>
              Effect.runSyncWith(services)(
                Effect.logWarning("A Claude lock was taken during a copy.", { file, error }),
              ),
          }),
        ),
        (release) => Effect.tryPromise(() => release()).pipe(Effect.ignoreCause({ log: true })),
      );
      return yield* task;
    }),
  );

/**
 * Claude keeps user MCP servers in `.claude.json` with the account's login, so an added account
 * gets a copy of the shared config's servers instead of a link. A server only the account has
 * stays; one that left the shared config leaves the account too.
 */
export const shareClaudeMcpServers = Effect.fn("shareClaudeMcpServers")(function* (input: {
  readonly sharedConfigPath: string;
  readonly accountHome: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const accountConfigPath = path.join(input.accountHome, ".claude.json");
  const copiedNamesPath = path.join(path.dirname(input.accountHome), COPIED_MCP_SERVERS_FILE);
  yield* Effect.gen(function* () {
    const shared = yield* readClaudeConfig(input.sharedConfigPath);
    if (Option.isNone(shared)) {
      return yield* Effect.logWarning(
        "The shared Claude config is not valid JSON, so its MCP servers are not copied.",
        { path: input.sharedConfigPath },
      );
    }
    // Claude writes the account's config on its first run; until then there is nothing to copy into.
    if (!(yield* fileSystem.exists(accountConfigPath))) return;
    yield* withClaudeLock(
      accountConfigPath,
      Effect.gen(function* () {
        const account = parseClaudeConfig(yield* fileSystem.readFileString(accountConfigPath));
        if (Option.isNone(account)) {
          return yield* Effect.logWarning(
            "The Claude account's config is not valid JSON, so MCP servers are not copied into it.",
            { path: accountConfigPath },
          );
        }
        const copied = yield* readCopiedNames(copiedNamesPath);
        const sharedServers = shared.value.servers;
        const servers = Object.fromEntries([
          ...Object.entries(sharedServers),
          ...Object.entries(account.value.servers).filter(
            ([name]) => !Object.hasOwn(sharedServers, name) && !copied.has(name),
          ),
        ]);
        if (!Equal.equals(servers, account.value.servers)) {
          yield* writeClaudeConfig(accountConfigPath, {
            ...account.value.config,
            mcpServers: servers,
          });
        }
        const names = Object.keys(sharedServers);
        if (names.length !== copied.size || names.some((name) => !copied.has(name))) {
          yield* fileSystem.writeFileString(copiedNamesPath, encodeCopiedNames(names));
        }
      }),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        "The shared Claude MCP servers were not copied into the account's config.",
        {
          accountHome: input.accountHome,
          error,
        },
      ),
    ),
  );
});
