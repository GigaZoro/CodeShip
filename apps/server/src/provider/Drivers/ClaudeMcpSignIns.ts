import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { withClaudeLock } from "./ClaudeAccountHome.ts";

/** One account's saved Claude credentials: its login plus `mcpOAuth`, its MCP sign-ins. */
type ClaudeCredentials = Readonly<Record<string, unknown>>;
type ClaudeMcpSignInEntries = Readonly<Record<string, unknown>>;

class ClaudeCredentialStoreError extends Schema.TaggedError<ClaudeCredentialStoreError>()(
  "ClaudeCredentialStoreError",
  {
    store: Schema.String,
    operation: Schema.Literals(["read", "write"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude's saved sign-ins in ${this.store} could not be ${this.operation === "read" ? "read" : "saved"}.`;
  }
}

export interface ClaudeCredentialStore {
  /** The keychain item or file; stores with the same key hold the same account. */
  readonly key: string;
  /** Claude holds this lock while it changes the store. */
  readonly lockFile: string;
  /** None when the account has no saved credentials. */
  readonly read: Effect.Effect<Option.Option<ClaudeCredentials>, ClaudeCredentialStoreError>;
  readonly write: (
    credentials: ClaudeCredentials,
  ) => Effect.Effect<void, ClaudeCredentialStoreError>;
}

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const CredentialsJson = Schema.fromJsonString(JsonObject);
const decodeCredentials = Schema.decodeUnknownOption(CredentialsJson);
const encodeCredentials = Schema.encodeSync(CredentialsJson);
const decodeSignIns = Schema.decodeUnknownOption(Schema.UndefinedOr(JsonObject));

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/u;
const KEYCHAIN_ITEM_NOT_FOUND = 44;
// The longest command line Claude hands `security -i`; it passes longer payloads as arguments.
const SECURITY_STDIN_LIMIT = 4032;
const SECURITY = "/usr/bin/security";
const SECURITY_TIMEOUT = Duration.seconds(10);
// The stale time Claude gives its credential write lock.
const STORAGE_LOCK_STALE_MS = 15_000;

/** `security -w` prints the item as text, or as hex when it holds bytes text cannot show. */
function parseKeychainItem(text: string) {
  const trimmed = text.trim();
  return decodeCredentials(trimmed).pipe(
    Option.orElse(() =>
      Result.getSuccess(Hex.decodeString(trimmed)).pipe(Option.flatMap(decodeCredentials)),
    ),
  );
}

/** Claude's Windows Credential Manager store, rolled out behind a flag in its cached features. */
function usesWindowsCredentialManager(configText: string) {
  return decodeCredentials(configText).pipe(
    Option.map((config) => {
      const features = config.cachedGrowthBookFeatures;
      return (
        Predicate.isObject(features) && Reflect.get(features, "tengu_windows_credman") === true
      );
    }),
    Option.getOrElse(() => false),
  );
}

/** Finds an account's credentials the way Claude does for the same environment. */
export const makeClaudeCredentialStore = Effect.fn("makeClaudeCredentialStore")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ClaudeCredentialStore,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const configDir = environment.CLAUDE_CONFIG_DIR;
  const configHome = (configDir || path.join(home, ".claude")).normalize("NFC");
  const storageOverride = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const storageDir =
    storageOverride === undefined
      ? configHome
      : (storageOverride || path.join(home, ".claude")).normalize("NFC");
  const lockFile = path.join(storageDir, ".storage-write");
  const failure = (store: string, operation: "read" | "write") => (cause?: unknown) =>
    new ClaudeCredentialStoreError({
      store,
      operation,
      ...(cause === undefined ? {} : { cause }),
    });

  if (platform === "darwin") {
    const namedDir = storageOverride === undefined ? configDir : storageOverride;
    const service = namedDir
      ? `${KEYCHAIN_SERVICE}-${Hex.encode(
          yield* crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(
                storageOverride === undefined ? configHome : storageOverride.normalize("NFC"),
              ),
            )
            .pipe(Effect.orDie),
        ).slice(0, 8)}`
      : KEYCHAIN_SERVICE;
    const user = environment.USER || (yield* HostProcess.Username) || "";
    const account = KEYCHAIN_ACCOUNT.test(user) ? user : "claude-code-user";
    const security = (command: ChildProcess.Command) =>
      spawnAndCollect(SECURITY, command).pipe(
        Effect.timeout(SECURITY_TIMEOUT),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    return {
      key: `keychain:${service}`,
      lockFile,
      read: Effect.gen(function* () {
        const result = yield* security(
          ChildProcess.make(
            SECURITY,
            ["find-generic-password", "-a", account, "-w", "-s", service],
            {
              stdin: "ignore",
            },
          ),
        ).pipe(Effect.mapError(failure(service, "read")));
        if (result.code === KEYCHAIN_ITEM_NOT_FOUND) return Option.none<ClaudeCredentials>();
        const credentials = result.code === 0 ? parseKeychainItem(result.stdout) : Option.none();
        if (Option.isNone(credentials)) return yield* failure(service, "read")();
        return credentials;
      }),
      write: Effect.fn("ClaudeCredentialStore.writeKeychain")(function* (credentials) {
        const hex = Hex.encode(encodeCredentials(credentials));
        // Over stdin the token never shows in the process list. `security -i` skips a line without
        // its newline.
        const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
        const result = yield* security(
          line.length <= SECURITY_STDIN_LIMIT
            ? ChildProcess.make(SECURITY, ["-i"], {
                stdin: { stream: Stream.encodeText(Stream.make(line)) },
              })
            : ChildProcess.make(
                SECURITY,
                ["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex],
                { stdin: "ignore" },
              ),
        ).pipe(Effect.mapError(failure(service, "write")));
        if (result.code !== 0) return yield* failure(service, "write")();
      }),
    };
  }

  const file = path.join(storageDir, ".credentials.json");
  const credentialManager =
    platform !== "win32"
      ? Effect.succeed(false)
      : environment.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === "1"
        ? Effect.succeed(true)
        : fileSystem.readFileString(path.join(configHome, ".config.json")).pipe(
            Effect.filterOrFail((text) => text !== ""),
            Effect.catch(() =>
              fileSystem.readFileString(path.join(configDir || home, ".claude.json")),
            ),
            Effect.map(usesWindowsCredentialManager),
            Effect.orElseSucceed(() => false),
          );
  return {
    key: `file:${file}`,
    lockFile,
    // The Windows Credential Manager is out of reach, so an account using it shares nothing.
    read: Effect.gen(function* () {
      if (yield* credentialManager) return Option.none<ClaudeCredentials>();
      const text = yield* fileSystem.readFileString(file).pipe(
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        Effect.mapError(failure(file, "read")),
      );
      if (Option.isNone(text)) return Option.none<ClaudeCredentials>();
      const credentials = decodeCredentials(text.value);
      if (Option.isNone(credentials)) return yield* failure(file, "read")();
      return credentials;
    }),
    write: (credentials) => {
      const pending = `${file}.t3code-pending`;
      return fileSystem
        .writeFileString(pending, encodeCredentials(credentials), { mode: 0o600 })
        .pipe(
          Effect.andThen(fileSystem.rename(pending, file)),
          Effect.onError(() => fileSystem.remove(pending).pipe(Effect.ignore)),
          Effect.mapError(failure(file, "write")),
        );
    },
  };
});

const hasToken = (value: unknown) => typeof value === "string" && value.length > 0;

/** Signed in beats signed out, then the token that expires last; Claude blanks a token it cannot refresh. */
function signInRank(entry: unknown): readonly [number, number] {
  if (!Predicate.isObject(entry)) return [0, 0];
  const signedIn =
    hasToken(Reflect.get(entry, "accessToken")) || hasToken(Reflect.get(entry, "refreshToken"));
  const expiresAt = Reflect.get(entry, "expiresAt");
  return [signedIn ? 1 : 0, typeof expiresAt === "number" ? expiresAt : 0];
}

const outranks = (entry: unknown, current: unknown) => {
  const [signedIn, expiresAt] = signInRank(entry);
  const [currentSignedIn, currentExpiresAt] = signInRank(current);
  return signedIn !== currentSignedIn ? signedIn > currentSignedIn : expiresAt > currentExpiresAt;
};

/** Claude keys a sign-in `<server>|<config hash>` and stores the server's name in it. */
function serverNameOf(key: string, entry: unknown) {
  const name = Predicate.isObject(entry) ? Reflect.get(entry, "serverName") : undefined;
  return typeof name === "string" ? name : key.slice(0, key.lastIndexOf("|"));
}

interface ClaudeMcpSignInSource {
  readonly key: string;
  readonly signIns: ClaudeMcpSignInEntries;
}

/**
 * The sign-ins every store gets. A server one store had at the last merge and lacks now was
 * signed out, so it leaves every store; otherwise the best-ranked sign-in wins, the main store's
 * on a tie. A sign-in that just finished in `prefer.store` wins over both.
 */
export function mergeClaudeMcpSignIns(input: {
  /** The main store first, then the accounts that share it. */
  readonly stores: ReadonlyArray<ClaudeMcpSignInSource>;
  /** The servers each account held, matching the main store, at the last merge. */
  readonly synced: ReadonlyMap<string, ReadonlySet<string>>;
  readonly prefer?: { readonly store: string; readonly serverName: string } | undefined;
}): Record<string, unknown> {
  const [main] = input.stores;
  if (main === undefined) return {};
  const preferred = input.prefer
    ? input.stores.find((store) => store.key === input.prefer?.store)
    : undefined;
  const heldAtLastMerge = (store: ClaudeMcpSignInSource, key: string) =>
    store === main
      ? [...input.synced.values()].some((servers) => servers.has(key))
      : input.synced.get(store.key)?.has(key) === true;
  const merged: Record<string, unknown> = {};
  for (const key of new Set(input.stores.flatMap((store) => Object.keys(store.signIns)))) {
    const fresh = preferred?.signIns[key];
    if (fresh !== undefined && serverNameOf(key, fresh) === input.prefer?.serverName) {
      merged[key] = fresh;
      continue;
    }
    if (
      input.stores.some(
        (store) => !Object.hasOwn(store.signIns, key) && heldAtLastMerge(store, key),
      )
    )
      continue;
    let best: unknown;
    for (const store of input.stores) {
      const entry = store.signIns[key];
      if (entry !== undefined && (best === undefined || outranks(entry, best))) best = entry;
    }
    merged[key] = best;
  }
  return merged;
}

interface SignInGroup {
  readonly accounts: Map<string, ClaudeCredentialStore>;
  /** Per account, the servers it shared with the main store at the last merge. */
  readonly synced: Map<string, ReadonlySet<string>>;
}

interface ReadStore {
  readonly store: ClaudeCredentialStore;
  readonly credentials: ClaudeCredentials;
  readonly signIns: ClaudeMcpSignInEntries;
}

/**
 * Claude keeps an account's MCP sign-ins with its login, so each added account signs in to a
 * server on its own. Accounts that share a main Claude folder join that folder's login here, and
 * every merge gives them all the same sign-ins.
 */
export class ClaudeMcpSignIns extends Context.Service<
  ClaudeMcpSignIns,
  {
    /** Shares an added account's sign-ins with the main store until the scope closes. */
    readonly join: (
      main: ClaudeCredentialStore,
      account: ClaudeCredentialStore,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Merges the main store's sign-ins with every account that joined it. */
    readonly share: (
      main: ClaudeCredentialStore,
      prefer?: { readonly store: string; readonly serverName: string },
    ) => Effect.Effect<void>;
    /** Turning sharing back on then merges instead of reading old differences as sign-outs. */
    readonly forget: (main: ClaudeCredentialStore) => Effect.Effect<void>;
  }
>()("t3/provider/Drivers/ClaudeMcpSignIns") {}

export const make = Effect.gen(function* () {
  const groups = new Map<string, SignInGroup>();
  // One merge at a time: every merge rewrites the main store.
  const merges = yield* Semaphore.make(1);

  const readStore = Effect.fn("ClaudeMcpSignIns.readStore")(function* (
    store: ClaudeCredentialStore,
  ) {
    const credentials = yield* store.read;
    if (Option.isNone(credentials)) return Option.none<ReadStore>();
    const signIns = decodeSignIns(credentials.value.mcpOAuth);
    if (Option.isNone(signIns)) {
      return yield* new ClaudeCredentialStoreError({ store: store.key, operation: "read" });
    }
    return Option.some<ReadStore>({
      store,
      credentials: credentials.value,
      signIns: signIns.value ?? {},
    });
  });

  const merge = Effect.fn("ClaudeMcpSignIns.merge")(function* (
    main: ClaudeCredentialStore,
    group: SignInGroup,
    prefer: { readonly store: string; readonly serverName: string } | undefined,
  ) {
    const mainStore = yield* readStore(main);
    if (Option.isNone(mainStore)) {
      // A login saved later starts over instead of reading as signed out of everything.
      group.synced.clear();
      return;
    }
    const accounts: Array<ReadStore> = [];
    for (const account of group.accounts.values()) {
      const read = yield* readStore(account).pipe(
        Effect.catch((error) =>
          Effect.logWarning("A Claude account's MCP sign-ins could not be read.", {
            error,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (read === undefined) continue;
      if (Option.isNone(read)) {
        group.synced.delete(account.key);
        continue;
      }
      accounts.push(read.value);
    }
    if (accounts.length === 0) return;
    const signIns = mergeClaudeMcpSignIns({
      stores: [mainStore.value, ...accounts].map(({ store, signIns }) => ({
        key: store.key,
        signIns,
      })),
      synced: group.synced,
      prefer,
    });
    const servers = new Set(Object.keys(signIns));
    if (!Equal.equals(signIns, mainStore.value.signIns)) {
      yield* main.write({ ...mainStore.value.credentials, mcpOAuth: signIns });
    }
    for (const account of accounts) {
      if (!Equal.equals(signIns, account.signIns)) {
        const written = yield* account.store
          .write({ ...account.credentials, mcpOAuth: signIns })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("A Claude account's MCP sign-ins could not be saved.", {
                error,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!written) continue;
      }
      group.synced.set(account.store.key, servers);
    }
  });

  return ClaudeMcpSignIns.of({
    join: Effect.fn("ClaudeMcpSignIns.join")(function* (main, account) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const group = groups.get(main.key) ?? { accounts: new Map(), synced: new Map() };
          groups.set(main.key, group);
          group.accounts.set(account.key, account);
        }).pipe(merges.withPermits(1)),
        () =>
          Effect.sync(() => {
            const group = groups.get(main.key);
            group?.accounts.delete(account.key);
            group?.synced.delete(account.key);
          }).pipe(merges.withPermits(1)),
      );
    }),
    share: Effect.fn("ClaudeMcpSignIns.share")(
      function* (main, prefer) {
        const group = groups.get(main.key);
        if (group === undefined || group.accounts.size === 0) return;
        // Claude takes one of these locks per write; taking them in key order cannot deadlock.
        const lockFiles = [
          ...new Set([
            main.lockFile,
            ...[...group.accounts.values()]
              .toSorted((left, right) => left.key.localeCompare(right.key))
              .map((account) => account.lockFile),
          ]),
        ];
        yield* lockFiles.reduceRight<
          Effect.Effect<void, ClaudeCredentialStoreError | Cause.UnknownError>
        >(
          (task, lockFile) => withClaudeLock(lockFile, task, { stale: STORAGE_LOCK_STALE_MS }),
          merge(main, group, prefer),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Claude's MCP sign-ins were not shared between accounts.", {
              error,
            }),
          ),
          merges.withPermits(1),
        ),
    ),
    forget: Effect.fn("ClaudeMcpSignIns.forget")(function* (main) {
      yield* Effect.sync(() => groups.get(main.key)?.synced.clear()).pipe(merges.withPermits(1));
    }),
  });
});

export const layer = Layer.effect(ClaudeMcpSignIns, make);
