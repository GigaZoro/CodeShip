import * as NodeSqlite from "node:sqlite";
// @effect-diagnostics-next-line nodeBuiltinImport:off - These tests verify exact hard-link identities on every host OS.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { lock } from "proper-lockfile";

import { CodexSettings } from "@t3tools/contracts/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const SQLITE_LOG = /\.sqlite-(?:wal|shm|journal)$/;

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .makeTempDirectoryScoped({ prefix })
    .pipe(Effect.flatMap(fileSystem.realPath));
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const backupsOf = Effect.fn("CodexHomeLayout.test.backupsOf")(function* (
  directory: string,
  entryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const names = yield* fileSystem.readDirectory(directory);
  return names.filter((name) => name.startsWith(`${entryName}.t3-backup-`));
});

// Setup names what it leaves beside a file with a random v4 UUID; tests number theirs in the same
// shape.
const setupId = (id: number) => `${id.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const asideOf = (entryPath: string, id = 0) => `${entryPath}.t3-aside-${setupId(id)}`;
const pendingLinkOf = (entryPath: string) => `${entryPath}.t3-link-${setupId(0)}`;

const makeWindowsHome = Effect.fn("CodexHomeLayout.test.makeWindowsHome")(function* (
  sharedHome: string,
) {
  const path = yield* Path.Path;
  const home = yield* makeTempDir("t3code-codex-shadow-");
  const layout = yield* resolveCodexHomeLayout(
    decodeCodexSettings({ homePath: sharedHome, shadowHomePath: home }),
  );
  return {
    home,
    config: path.join(home, "config.toml"),
    materialize: materializeCodexShadowHome(layout).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  };
});

const replaceFile = Effect.fn("CodexHomeLayout.test.replaceFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* writeTextFile(`${filePath}.tmp`, contents);
  yield* fileSystem.rename(`${filePath}.tmp`, filePath);
});

const fileIdentity = (filePath: string) =>
  Effect.promise(async () => {
    const info = await NodeFSP.stat(filePath, { bigint: true });
    return `${info.dev}:${info.ino}`;
  });

// Setup hard-links shared files on Windows and symlinks them elsewhere.
const expectSharedFileLink = Effect.fn("CodexHomeLayout.test.expectSharedFileLink")(function* (
  link: string,
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const linked = windowsHost ? yield* fileIdentity(link) : yield* fileSystem.readLink(link);
  expect(linked).toBe(windowsHost ? yield* fileIdentity(target) : target);
});

// Windows hard-links a symlink itself, where Node on macOS links the file it points to.
const windowsLink = (fileSystem: FileSystem.FileSystem) => (from: string, to: string) =>
  fileSystem.readLink(from).pipe(
    Effect.matchEffect({
      onFailure: () => fileSystem.link(from, to),
      onSuccess: (linked) => fileSystem.symlink(linked, to),
    }),
  );

const refused = (method: string, code: string) =>
  Effect.fail(
    PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, cause: { code } }),
  );

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps MCP sign-ins in the shadow home and unlinks the shared ones",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedSignIns = path.join(sharedHome, ".credentials.json");
          const ownSignIns = path.join(shadowHome, ".credentials.json");
          yield* writeTextFile(sharedSignIns, "shared sign-ins");
          yield* fileSystem.symlink(sharedSignIns, ownSignIns);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(ownSignIns)).toBe(false);
          yield* writeTextFile(ownSignIns, "own sign-ins");
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(ownSignIns)).toBe("own sign-ins");
          expect(yield* fileSystem.readFileString(sharedSignIns)).toBe("shared sign-ins");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(sharedHome, "auth.lock"), "");
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "auth.lock"), "");
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));
          const authLockLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.lock"))
            .pipe(Effect.result);

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          yield* expectSharedFileLink(
            path.join(shadowHome, "config.toml"),
            path.join(sharedHome, "config.toml"),
          );
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
          expect(authLockLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a shadow home's own cloud config bundle cache",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const shadowCache = path.join(shadowHome, "cloud-config-bundle-cache.json");

          yield* writeTextFile(
            path.join(sharedHome, "cloud-config-bundle-cache.json"),
            '{"account_id":"shared"}\n',
          );
          yield* writeTextFile(shadowCache, '{"account_id":"shadow"}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(shadowCache)).toBe('{"account_id":"shadow"}\n');
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "does not share the cloud config bundle cache with shadow homes",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const freshShadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const linkedShadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedCache = path.join(sharedHome, "cloud-config-bundle-cache.json");

          yield* writeTextFile(sharedCache, '{"account_id":"shared"}\n');
          yield* fileSystem.symlink(
            sharedCache,
            path.join(linkedShadowHome, "cloud-config-bundle-cache.json"),
          );

          for (const shadowHome of [freshShadowHome, linkedShadowHome]) {
            yield* materializeCodexShadowHome(
              yield* resolveCodexHomeLayout(
                decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
              ),
            );
          }

          expect(
            yield* fileSystem.exists(path.join(freshShadowHome, "cloud-config-bundle-cache.json")),
          ).toBe(false);
          expect(
            yield* fileSystem.exists(path.join(linkedShadowHome, "cloud-config-bundle-cache.json")),
          ).toBe(false);
          expect(yield* fileSystem.readFileString(sharedCache)).toBe('{"account_id":"shared"}\n');
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          yield* expectSharedFileLink(shadowLock, sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shares local thread writer locks once no writer still holds one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const shadowLocks = path.join(shadowHome, "thread-writer-locks");
          const threadLock = path.join(shadowLocks, "019a0000-0000-7000-8000-000000000000.lock");

          yield* writeTextFile(path.join(shadowLocks, ".coordination.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, ".DS_Store"), "");
          yield* writeTextFile(threadLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readLink(shadowLocks)).toBe(
            path.join(sharedHome, "thread-writer-locks"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          yield* expectSharedFileLink(
            path.join(shadowHome, "config.toml"),
            path.join(sharedHome, "config.toml"),
          );
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves an account's own copy of a shared entry aside and links the shared one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
          );

          expect(yield* fileSystem.readLink(path.join(shadowHome, "config.toml"))).toBe(
            path.join(sharedHome, "config.toml"),
          );
          const [backup, ...others] = yield* backupsOf(shadowHome, "config.toml");
          expect(others).toEqual([]);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, backup!))).toBe(
            'model = "local"\n',
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("keeps each account's own Codex secrets store", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const sharedSecrets = path.join(sharedHome, "secrets");
        yield* writeTextFile(path.join(sharedSecrets, "local.age"), "shared key");

        for (const platform of ["linux", "win32"] as const) {
          const ownHome = yield* makeTempDir("t3code-codex-shadow-");
          const linkedHome = yield* makeTempDir("t3code-codex-shadow-");
          yield* writeTextFile(path.join(ownHome, "secrets", "local.age"), "account key");
          yield* fileSystem.symlink(sharedSecrets, path.join(linkedHome, "secrets"));
          for (const shadowHome of [ownHome, linkedHome]) {
            yield* materializeCodexShadowHome(
              yield* resolveCodexHomeLayout(
                decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
              ),
            ).pipe(Effect.provideService(HostProcess.Platform, platform));
          }

          expect(yield* fileSystem.readFileString(path.join(ownHome, "secrets", "local.age"))).toBe(
            "account key",
          );
          expect(yield* fileSystem.exists(path.join(linkedHome, "secrets"))).toBe(false);
        }
        expect(yield* fileSystem.readFileString(path.join(sharedSecrets, "local.age"))).toBe(
          "shared key",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "settles an account's own SQLite logs beside a linked database",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const shared = (name: string) => path.join(sharedHome, name);
          const shadow = (name: string) => path.join(shadowHome, name);
          for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
            yield* writeTextFile(shared(name), "shared");
          }
          for (const name of ["goals_1.sqlite", "goals_1.sqlite-shm"]) {
            yield* writeTextFile(shared(name), "shared");
          }
          yield* fileSystem.symlink(shared("state_5.sqlite"), shadow("state_5.sqlite"));
          yield* writeTextFile(shadow("state_5.sqlite-wal"), "account frames");
          yield* writeTextFile(shadow("state_5.sqlite-shm"), "account index");
          yield* fileSystem.symlink(shared("goals_1.sqlite"), shadow("goals_1.sqlite"));
          yield* fileSystem.symlink(shared("goals_1.sqlite-shm"), shadow("goals_1.sqlite-shm"));
          yield* writeTextFile(shadow("goals_1.sqlite-wal"), "");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
          );

          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          expect(shadowEntries.filter((name) => SQLITE_LOG.test(name))).toEqual([]);
          expect(yield* fileSystem.readLink(shadow("state_5.sqlite"))).toBe(
            shared("state_5.sqlite"),
          );
          const [backup, ...others] = yield* backupsOf(shadowHome, "state_5.sqlite-wal");
          expect(others).toEqual([]);
          expect(yield* fileSystem.readFileString(shadow(backup!))).toBe("account frames");
          expect(yield* backupsOf(shadowHome, "goals_1.sqlite-wal")).toEqual([]);
          expect(yield* fileSystem.readFileString(shared("state_5.sqlite-wal"))).toBe("shared");
          expect(yield* fileSystem.readFileString(shared("goals_1.sqlite-shm"))).toBe("shared");
        }),
    );

    it.effect.skipIf(!symlinksSupported || windowsHost)(
      "keeps an account's own database while a connection has it open",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedDatabase = path.join(sharedHome, "goals_1.sqlite");
          const ownDatabase = path.join(shadowHome, "goals_1.sqlite");
          yield* writeTextFile(sharedDatabase, "");
          const connection = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(ownDatabase)),
            (database) => Effect.sync(() => database.isOpen && database.close()),
          );
          connection.exec(
            "PRAGMA journal_mode = WAL; CREATE TABLE goals (title TEXT); INSERT INTO goals VALUES ('own');",
          );
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          const materializeOnLinux = materializeCodexShadowHome(layout).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
          );

          yield* materializeOnLinux;
          connection.exec("INSERT INTO goals VALUES ('later');");
          expect(connection.prepare("SELECT count(*) AS goals FROM goals").get()).toEqual({
            goals: 2,
          });
          expect(yield* fileSystem.exists(`${ownDatabase}-wal`)).toBe(true);
          expect(yield* backupsOf(shadowHome, "goals_1.sqlite")).toEqual([]);

          connection.close();
          yield* materializeOnLinux;

          expect(yield* fileSystem.readLink(ownDatabase)).toBe(sharedDatabase);
          const [backup] = yield* backupsOf(shadowHome, "goals_1.sqlite");
          const restored = new NodeSqlite.DatabaseSync(path.join(shadowHome, backup!));
          expect(restored.prepare("SELECT count(*) AS goals FROM goals").get()).toEqual({
            goals: 2,
          });
          restored.close();
        }),
    );

    it.effect(
      "adopts Windows account config writes and refreshes other accounts' stale links",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const sharedConfig = path.join(sharedHome, "config.toml");
          yield* writeTextFile(sharedConfig, 'model = "shared"\n');
          const first = yield* makeWindowsHome(sharedHome);
          const second = yield* makeWindowsHome(sharedHome);
          yield* first.materialize;
          yield* second.materialize;
          const originalIdentity = yield* fileIdentity(first.config);
          expect(yield* fileIdentity(second.config)).toBe(originalIdentity);
          expect(yield* fileIdentity(sharedConfig)).toBe(originalIdentity);

          const updated = '[[skills.config]]\npath = "skills/example"\nenabled = false\n';
          yield* replaceFile(first.config, updated);
          const updatedIdentity = yield* fileIdentity(first.config);
          expect(updatedIdentity).not.toBe(originalIdentity);
          const messages: unknown[] = [];
          yield* first.materialize.pipe(
            Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
          );
          expect(yield* fileSystem.readFileString(sharedConfig)).toBe(updated);
          expect(yield* fileIdentity(sharedConfig)).toBe(updatedIdentity);
          expect(JSON.stringify(messages)).toContain("Adopted");

          yield* second.materialize;
          yield* first.materialize;
          for (const account of [first, second]) {
            expect(yield* fileSystem.readFileString(account.config)).toBe(updated);
            expect(yield* fileIdentity(account.config)).toBe(updatedIdentity);
            expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
          }
        }),
    );

    it.effect.each([
      "atomic",
      "in-place",
      "shared-in-place",
      "missing-record",
      "invalid-record",
      "stale-mtime",
    ] as const)("backs up Windows config copies when neither side matches: %s", (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const sharedConfig = path.join(sharedHome, "config.toml");
        yield* writeTextFile(sharedConfig, "original");
        if (change === "stale-mtime") {
          yield* Effect.promise(() => NodeFSP.utimes(sharedConfig, 1, 1));
        }
        const account = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        const other = yield* makeWindowsHome(sharedHome);
        yield* other.materialize;
        if (change === "stale-mtime") {
          yield* replaceFile(account.config, "own changed config");
          yield* writeTextFile(sharedConfig, "modified");
          yield* Effect.promise(() => NodeFSP.utimes(sharedConfig, 1, 1));
        } else if (change === "shared-in-place") yield* writeTextFile(sharedConfig, "new shared");
        else yield* replaceFile(sharedConfig, "new shared");
        if (change === "in-place") yield* writeTextFile(account.config, "own changed config");
        else yield* replaceFile(account.config, "own changed config");
        const stateDirectory = path.join(account.home, ".t3-shared-files");
        if (change === "missing-record") {
          yield* fileSystem.remove(stateDirectory, { recursive: true, force: true });
        } else if (change === "invalid-record") {
          yield* writeTextFile(path.join(stateDirectory, "config.toml.json"), "{invalid");
        }
        if (change === "in-place") {
          const fullFs = FileSystem.FileSystem.of({
            ...fileSystem,
            // The account's own file is back at its path when its backup copy fails.
            copyFile: () =>
              fileSystem.remove(account.config, { force: true }).pipe(
                Effect.andThen(fileSystem.link(other.config, account.config)),
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "copyFile",
                      cause: { code: "ENOSPC" },
                    }),
                  ),
                ),
              ),
          });
          yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, fullFs));
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
          expect(yield* fileSystem.readFileString(account.config)).toBe("own changed config");
        }
        const messages: unknown[] = [];
        yield* account.materialize.pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
        );

        const backups = yield* backupsOf(account.home, "config.toml");
        expect(backups).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
          "own changed config",
        );
        expect(JSON.stringify(messages)).toContain(backups[0]);
        expect(yield* fileSystem.readFileString(sharedConfig)).toBe(
          change === "stale-mtime" ? "modified" : "new shared",
        );
        expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(sharedConfig));
        if (change === "in-place") {
          yield* writeTextFile(other.config, "later write through another account");
          expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
            "own changed config",
          );
        }
        yield* account.materialize;
        expect(yield* backupsOf(account.home, "config.toml")).toEqual(backups);
      }),
    );

    it.effect(
      "keeps Windows config copies when rename is denied and reconciles on a later setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const reconciliation of ["adopt", "backup", "relink"] as const) {
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const sharedConfig = path.join(sharedHome, "config.toml");
            yield* writeTextFile(sharedConfig, "original");
            const account = yield* makeWindowsHome(sharedHome);
            yield* account.materialize;
            if (reconciliation !== "relink") yield* replaceFile(account.config, "account edit");
            if (reconciliation !== "adopt") yield* replaceFile(sharedConfig, "shared edit");
            const identity = yield* fileIdentity(account.config);
            const lockedFs = FileSystem.FileSystem.of({
              ...fileSystem,
              rename: (from, to) =>
                from === account.config || to === account.config || from === sharedConfig
                  ? Effect.fail(
                      new PlatformError.PlatformError(
                        new PlatformError.SystemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "rename",
                          cause: { code: "EPERM" },
                        }),
                      ),
                    )
                  : fileSystem.rename(from, to),
            });
            const messages: unknown[] = [];
            yield* account.materialize.pipe(
              Effect.provideService(FileSystem.FileSystem, lockedFs),
              Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
            );
            expect(yield* fileIdentity(account.config)).toBe(identity);
            expect(yield* fileSystem.readFileString(account.config)).toBe(
              reconciliation === "relink" ? "original" : "account edit",
            );
            expect(yield* fileSystem.readFileString(sharedConfig)).toBe(
              reconciliation === "adopt" ? "original" : "shared edit",
            );
            expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
            expect(JSON.stringify(messages)).toContain("could not be linked");
            expect(
              (yield* fileSystem.readDirectory(account.home)).filter((name) =>
                name.includes(".t3-link"),
              ),
            ).toEqual([]);

            yield* account.materialize;
            expect(yield* fileSystem.readFileString(sharedConfig)).toBe(
              reconciliation === "adopt" ? "account edit" : "shared edit",
            );
            expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(sharedConfig));
            const backups = yield* backupsOf(account.home, "config.toml");
            expect(backups).toHaveLength(reconciliation === "backup" ? 1 : 0);
            if (reconciliation === "backup") {
              expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
                "account edit",
              );
            }
          }
        }),
    );

    it.effect.each([
      { side: "shared", stage: "capture" },
      { side: "shared", stage: "install" },
      { side: "account", stage: "capture" },
      { side: "account", stage: "install" },
    ] as const)("preserves a $side save immediately before Windows $stage", ({ side, stage }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "original");
        const account = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        yield* replaceFile(side === "shared" ? account.config : shared, "first edit");
        const destination = side === "shared" ? shared : account.config;
        let saved = false;
        const save = Effect.gen(function* () {
          if (saved) return;
          saved = true;
          yield* replaceFile(destination, "concurrent save").pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        });
        const racingFs = FileSystem.FileSystem.of({
          ...fileSystem,
          link: (from, to) =>
            stage === "install" && to === destination
              ? save.pipe(Effect.andThen(fileSystem.link(from, to)))
              : fileSystem.link(from, to),
          rename: (from, to) =>
            (stage === "capture" && from === destination) ||
            (stage === "install" && to === destination)
              ? save.pipe(Effect.andThen(fileSystem.rename(from, to)))
              : fileSystem.rename(from, to),
        });
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, racingFs));
        expect(saved).toBe(true);
        expect(yield* fileSystem.readFileString(destination)).toBe(
          side === "account" && stage === "capture" ? "first edit" : "concurrent save",
        );
        expect(yield* fileSystem.readFileString(shared)).toBe(
          side === "shared" ? "concurrent save" : "first edit",
        );
        const backups = yield* backupsOf(account.home, "config.toml");
        expect(backups).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
          side === "shared" ? "first edit" : stage === "capture" ? "concurrent save" : "original",
        );
        yield* account.materialize;
        expect(yield* fileSystem.readFileString(shared)).toBe(
          side === "shared" ? "concurrent save" : "first edit",
        );
      }),
    );

    it.effect.each(["prepare a link", "adopt the account copy", "move the shared file"] as const)(
      "keeps Windows account and shared files in place when setup cannot %s",
      (stage) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "shared");
          const account = yield* makeWindowsHome(sharedHome);
          if (stage === "prepare a link") yield* writeTextFile(account.config, "account");
          else {
            yield* account.materialize;
            yield* replaceFile(account.config, "account");
          }
          const failingFs = FileSystem.FileSystem.of({
            ...fileSystem,
            link: (from, to) =>
              stage === "prepare a link" ||
              (from.startsWith(`${account.config}.t3-link-`) && to === shared)
                ? refused("link", "EXDEV")
                : fileSystem.link(from, to),
            rename: (from, to) =>
              stage === "move the shared file" && from === shared
                ? refused("rename", "EPERM")
                : fileSystem.rename(from, to),
          });
          const messages: unknown[] = [];
          yield* account.materialize.pipe(
            Effect.provideService(FileSystem.FileSystem, failingFs),
            Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
          );
          // The refusal is reported once, with no failed recovery of a move that never happened.
          expect(messages).toHaveLength(1);
          expect(yield* fileSystem.readFileString(account.config)).toBe("account");
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
          expect(yield* fileSystem.readFileString(shared)).toBe("shared");
          expect(
            (yield* fileSystem.readDirectory(sharedHome)).filter((name) =>
              name.includes(".t3-aside"),
            ),
          ).toEqual([]);
        }),
    );

    it.effect.each(["late write", "another server", "interrupted", "taken over"] as const)(
      "keeps the shared Windows file when an adoption races: %s",
      (race) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "original");
          const account = yield* makeWindowsHome(sharedHome);
          yield* account.materialize;
          yield* replaceFile(account.config, "account edit");
          const markers = fileSystem
            .readDirectory(sharedHome)
            .pipe(
              Effect.map((names) =>
                names.filter((name) => name.startsWith("config.toml.t3-aside")),
              ),
            );
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const otherServerAttempts: string[] = [];
          const otherServer = Effect.promise(() =>
            lock(path.join(sharedHome, ".t3-shared-files"), {
              lockfilePath: path.join(sharedHome, ".t3-shared-files.lock"),
              realpath: false,
            }).then(
              (unlock) => unlock().then(() => "acquired"),
              (error: NodeJS.ErrnoException) =>
                error.code === "ELOCKED" ? "blocked" : Promise.reject(error),
            ),
          ).pipe(Effect.flatMap((attempt) => Effect.sync(() => otherServerAttempts.push(attempt))));
          const racingFs = FileSystem.FileSystem.of({
            ...fileSystem,
            link: (from, to) =>
              fileSystem
                .link(from, to)
                .pipe(
                  Effect.tap(() =>
                    race !== "late write" ||
                    !from.startsWith(`${account.config}.t3-link-`) ||
                    to !== shared
                      ? Effect.void
                      : markers.pipe(
                          Effect.flatMap(([marker]) =>
                            fileSystem.writeFileString(
                              path.join(sharedHome, marker!),
                              "late write",
                            ),
                          ),
                        ),
                  ),
                ),
            rename: (from, to) =>
              race === "late write" || from !== shared || !to.includes(".t3-aside")
                ? fileSystem.rename(from, to)
                : race === "another server"
                  ? otherServer.pipe(Effect.andThen(fileSystem.rename(from, to)))
                  : race === "taken over"
                    ? // A server that took over a stale lock puts back what this live setup moved aside.
                      fileSystem
                        .rename(from, to)
                        .pipe(
                          Effect.andThen(fileSystem.link(to, from)),
                          Effect.andThen(fileSystem.remove(to)),
                        )
                    : fileSystem
                        .writeFileString(shared, "concurrent save")
                        .pipe(
                          Effect.andThen(Deferred.succeed(entered, undefined)),
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(fileSystem.rename(from, to)),
                        ),
          });
          const run = account.materialize.pipe(
            Effect.provideService(FileSystem.FileSystem, racingFs),
          );
          if (race === "interrupted") {
            const adoption = yield* Effect.forkChild(run);
            yield* Deferred.await(entered);
            const interrupting = yield* Fiber.interrupt(adoption).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(interrupting);
          } else yield* run;
          if (race === "another server") {
            yield* otherServer;
            expect(otherServerAttempts).toEqual(["blocked", "acquired"]);
          }

          expect(yield* fileSystem.readFileString(shared)).toBe(
            {
              "late write": "account edit",
              "another server": "account edit",
              interrupted: "concurrent save",
              "taken over": "original",
            }[race],
          );
          expect(yield* markers).toEqual([]);
          if (race === "taken over") {
            // The holder's setup fails with both sides intact, and the next setup adopts.
            expect(yield* fileSystem.readFileString(account.config)).toBe("account edit");
            yield* account.materialize;
            expect(yield* fileSystem.readFileString(shared)).toBe("account edit");
          }
          const backups = yield* backupsOf(sharedHome, "config.toml");
          expect(backups).toHaveLength(race === "late write" ? 1 : 0);
          if (race === "late write") {
            expect(yield* fileSystem.readFileString(path.join(sharedHome, backups[0]!))).toBe(
              "late write",
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps Windows files readable when a path setup links becomes a symlink",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const { replaced, during } of [
            { replaced: "account", during: "link" },
            { replaced: "account", during: "rename" },
            { replaced: "shared", during: "link" },
            { replaced: "shared", during: "rename" },
          ] as const) {
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shared = path.join(sharedHome, "config.toml");
            yield* writeTextFile(shared, "original");
            const account = yield* makeWindowsHome(sharedHome);
            yield* account.materialize;
            yield* replaceFile(account.config, "account edit");
            // Each side becomes a symlink to the other, as a configuration may legitimately set.
            const [swappedPath, swappedTarget] =
              replaced === "account" ? [account.config, shared] : [shared, account.config];
            let swapped = false;
            const swap = (now: boolean) =>
              Effect.suspend(() => {
                if (!now || swapped) return Effect.void;
                swapped = true;
                return fileSystem
                  .remove(swappedPath)
                  .pipe(Effect.andThen(fileSystem.symlink(swappedTarget, swappedPath)));
              });
            const swappingFs = FileSystem.FileSystem.of({
              ...fileSystem,
              link: (from, to) =>
                swap(during === "link" && from === swappedPath).pipe(
                  Effect.andThen(windowsLink(fileSystem)(from, to)),
                ),
              rename: (from, to) =>
                swap(during === "rename" && from === shared).pipe(
                  Effect.andThen(fileSystem.rename(from, to)),
                ),
            });
            // The setup after the swap must leave both paths readable too.
            for (let setup = 0; setup < 2; setup++) {
              yield* account.materialize.pipe(
                Effect.provideService(FileSystem.FileSystem, swappingFs),
              );
              expect(swapped).toBe(true);
              expect(yield* fileSystem.readLink(swappedPath)).toBe(swappedTarget);
              expect(yield* fileSystem.readFileString(shared)).toBe(
                replaced === "account" && during === "link" ? "original" : "account edit",
              );
              expect(yield* fileSystem.readFileString(account.config)).toBe(
                replaced === "account" && during === "link" ? "original" : "account edit",
              );
              expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
              expect(yield* backupsOf(sharedHome, "config.toml")).toEqual([]);
            }
          }
        }),
    );

    it.effect("finishes linking a Windows account file when setup is interrupted mid-capture", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "original");
        const account = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        yield* replaceFile(shared, "shared edit");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pausingFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            from === account.config
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(fileSystem.rename(from, to)),
                )
              : fileSystem.rename(from, to),
        });
        const setup = yield* account.materialize.pipe(
          Effect.provideService(FileSystem.FileSystem, pausingFs),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const interrupting = yield* Fiber.interrupt(setup).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
        expect(yield* fileSystem.readFileString(account.config)).toBe("shared edit");
        expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
        expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
      }),
    );

    it.effect(
      "keeps a Windows account copy still linked elsewhere until its backup is published",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "original");
          const account = yield* makeWindowsHome(sharedHome);
          const other = yield* makeWindowsHome(sharedHome);
          yield* account.materialize;
          yield* other.materialize;
          yield* replaceFile(shared, "new shared");
          // Written in place, the change is the other account's file too.
          yield* writeTextFile(account.config, "own changed config");
          const refusingFs = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (from, to) =>
              from !== account.config && to.includes(".t3-backup-")
                ? replaceFile(account.config, "writer save").pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "rename",
                          cause: { code: "EPERM" },
                        }),
                      ),
                    ),
                  )
                : fileSystem.rename(from, to),
          });
          yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, refusingFs));
          expect(yield* fileSystem.readFileString(account.config)).toBe("writer save");
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);

          yield* account.materialize;
          yield* writeTextFile(other.config, "later write through another account");
          const backups = yield* backupsOf(account.home, "config.toml");
          const backedUp = yield* Effect.forEach(backups, (name) =>
            fileSystem.readFileString(path.join(account.home, name)),
          );
          expect(backedUp.toSorted()).toEqual(["own changed config", "writer save"]);
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
        }),
    );

    it.effect("backs up what a linked Windows copy holds when it changes as it is duplicated", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "original");
        const account = yield* makeWindowsHome(sharedHome);
        const other = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        yield* other.materialize;
        yield* replaceFile(shared, "new shared");
        yield* writeTextFile(account.config, "own changed config");
        const aside = asideOf(account.config);
        yield* fileSystem.rename(account.config, aside);
        yield* fileSystem.link(shared, account.config);
        // Windows may not update a file's write time until its writer closes it.
        const keepTimes = Effect.promise(() => NodeFSP.utimes(aside, 1000, 1000));
        yield* keepTimes;
        let edited = false;
        const editingFs = FileSystem.FileSystem.of({
          ...fileSystem,
          copyFile: (from, to) =>
            fileSystem.copyFile(from, to).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (from !== aside || edited) return Effect.void;
                  edited = true;
                  return fileSystem
                    .writeFileString(aside, "OWN CHANGED CONFIG")
                    .pipe(Effect.andThen(keepTimes));
                }),
              ),
            ),
        });
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, editingFs));
        expect(edited).toBe(true);
        expect(yield* fileSystem.readFileString(aside)).toBe("OWN CHANGED CONFIG");
        expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);

        yield* account.materialize;
        yield* writeTextFile(other.config, "later write through another account");
        const backups = yield* backupsOf(account.home, "config.toml");
        expect(backups).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
          "OWN CHANGED CONFIG",
        );
        expect(yield* fileSystem.exists(aside)).toBe(false);
      }),
    );

    it.effect.each([
      "before installing",
      "after installing",
      "while the shared file could not be inspected",
      "before the shared file went",
      "before the shared file's folder went",
      "with its backup refused while the shared file was aside",
    ] as const)("recovers a linked Windows account copy a setup stopped %s left aside", (stage) =>
      Effect.gen(function* () {
        if (stage === "before the shared file's folder went" && !symlinksSupported) return;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "original");
        const account = yield* makeWindowsHome(sharedHome);
        const other = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        yield* other.materialize;
        yield* replaceFile(shared, "new shared");
        yield* writeTextFile(account.config, "own changed config");
        const aside = asideOf(account.config);
        yield* fileSystem.rename(account.config, aside);
        yield* writeTextFile(`${aside}.t3-copy`, "partial copy");
        const backupRefused = stage === "with its backup refused while the shared file was aside";
        const sharedGone =
          stage === "before the shared file went" ||
          stage === "before the shared file's folder went";
        if (stage === "after installing" || backupRefused) {
          yield* fileSystem.link(shared, account.config);
        }
        if (sharedGone) yield* fileSystem.remove(shared);
        if (stage === "before the shared file's folder went") {
          const dotfiles = yield* makeTempDir("t3code-codex-dotfiles-");
          yield* fileSystem.symlink(path.join(dotfiles, "moved", "config.toml"), shared);
        }
        if (backupRefused) yield* fileSystem.rename(shared, asideOf(shared));
        const stoppedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) =>
            stage === "while the shared file could not be inspected" && filePath === shared
              ? refused("stat", "EACCES")
              : fileSystem.stat(filePath),
          rename: (from, to) =>
            backupRefused && to.startsWith(`${account.config}.t3-backup-`)
              ? refused("rename", "EPERM")
              : fileSystem.rename(from, to),
        });
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, stoppedFs));

        const asidesIn = (directory: string) =>
          fileSystem
            .readDirectory(directory)
            .pipe(Effect.map((names) => names.filter((name) => name.includes(".t3-aside"))));
        expect(yield* asidesIn(sharedHome)).toEqual([]);
        if (backupRefused) {
          // The shared file comes back, and the account's own copy stays aside until a setup can
          // back it up.
          expect(yield* fileSystem.readFileString(shared)).toBe("new shared");
          expect(yield* asidesIn(account.home)).toEqual([path.basename(aside)]);
          expect(yield* fileSystem.readFileString(aside)).toBe("own changed config");
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
          yield* account.materialize;
          expect(yield* asidesIn(account.home)).toEqual([]);
          const backups = yield* backupsOf(account.home, "config.toml");
          expect(backups).toHaveLength(1);
          expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
            "own changed config",
          );
          return;
        }
        expect(yield* asidesIn(account.home)).toEqual([]);
        if (sharedGone) {
          expect(yield* fileSystem.readFileString(account.config)).toBe("own changed config");
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
          return;
        }
        yield* writeTextFile(other.config, "later write through another account");
        const backups = yield* backupsOf(account.home, "config.toml");
        expect(backups).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
          "own changed config",
        );
        expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "puts back a Windows shared file or symlink a stopped setup left aside for an account linking to it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const windowsFs = FileSystem.FileSystem.of({
            ...fileSystem,
            link: windowsLink(fileSystem),
          });
          for (const aside of ["file", "symlink"] as const) {
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shared = path.join(sharedHome, "config.toml");
            const dotfile = path.join(yield* makeTempDir("t3code-codex-dotfiles-"), "config.toml");
            yield* writeTextFile(aside === "file" ? shared : dotfile, "original");
            if (aside === "symlink") yield* fileSystem.symlink(dotfile, shared);
            const account = yield* makeWindowsHome(sharedHome);
            yield* fileSystem.symlink(shared, account.config);
            yield* fileSystem.rename(shared, asideOf(shared));
            yield* account.materialize.pipe(
              Effect.provideService(FileSystem.FileSystem, windowsFs),
            );
            expect(yield* fileSystem.readFileString(shared)).toBe("original");
            if (aside === "symlink") expect(yield* fileSystem.readLink(shared)).toBe(dotfile);
            expect(yield* fileSystem.exists(asideOf(shared))).toBe(false);
            expect(yield* backupsOf(sharedHome, "config.toml")).toEqual([]);
            expect(yield* fileSystem.readLink(account.config)).toBe(shared);
          }
        }),
    );

    it.effect("backs up a folder or junction a stopped Windows setup left aside", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const kind of ["folder", "junction"] as const) {
          if (kind === "junction" && !symlinksSupported) continue;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "shared");
          const account = yield* makeWindowsHome(sharedHome);
          const aside = asideOf(account.config);
          const folder = kind === "folder" ? aside : yield* makeTempDir("t3code-codex-folder-");
          yield* writeTextFile(path.join(folder, "own.toml"), "own");
          if (kind === "junction") yield* fileSystem.symlink(folder, aside);
          // Windows cannot hard-link a junction, which is a folder.
          const junctionFs = FileSystem.FileSystem.of({
            ...fileSystem,
            link: (from, to) => fileSystem.link(from === aside ? folder : from, to),
          });
          yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, junctionFs));
          const backups = yield* backupsOf(account.home, "config.toml");
          expect(backups).toHaveLength(1);
          expect(
            yield* fileSystem.readFileString(path.join(account.home, backups[0]!, "own.toml")),
          ).toBe("own");
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
        }
      }),
    );

    it.effect("keeps Windows files that only look like setup leftovers", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "shared");
        const account = yield* makeWindowsHome(sharedHome);
        const lookalikes = [
          `${shared}.t3-aside-personal`,
          `${shared}.t3-aside-personal.t3-copy`,
          `${account.config}.t3-aside-personal`,
          `${account.config}.t3-aside-personal.t3-copy`,
          // Setup removes its own unfinished duplicate only together with the aside it copies.
          `${asideOf(account.config)}.t3-copy`,
          // Setup never generates the nil UUID or any other non-v4 one.
          `${account.config}.t3-aside-00000000-0000-0000-0000-000000000000`,
          `${account.config}.t3-aside-00000000-0000-0000-0000-000000000000.t3-copy`,
          `${account.config}.t3-link-00000000-0000-0000-0000-000000000000`,
          `${account.config}.t3-link`,
          // Setup prepares links only beside account files.
          pendingLinkOf(shared),
        ];
        yield* Effect.forEach(lookalikes, (file) => writeTextFile(file, file));
        yield* account.materialize;
        // The second setup finds the account already linked.
        yield* account.materialize;
        expect(
          yield* Effect.forEach(lookalikes, (file) => fileSystem.readFileString(file)),
        ).toEqual(lookalikes);
        expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "neither reads nor writes a Windows shared-file record through a link",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const linked of ["record", "record folder"] as const) {
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shared = path.join(sharedHome, "config.toml");
            yield* writeTextFile(shared, "original");
            const account = yield* makeWindowsHome(sharedHome);
            yield* account.materialize;
            const stateDirectory = path.join(account.home, ".t3-shared-files");
            const record = path.join(stateDirectory, "config.toml.json");
            const recordText = yield* fileSystem.readFileString(record);
            const personal = yield* makeTempDir("t3code-personal-");
            const personalFile = path.join(personal, "config.toml.json");
            yield* writeTextFile(personalFile, "personal notes");
            if (linked === "record") {
              yield* fileSystem.remove(record);
              yield* fileSystem.symlink(personalFile, record);
            } else {
              yield* fileSystem.remove(stateDirectory, { recursive: true });
              yield* fileSystem.symlink(personal, stateDirectory);
            }
            yield* account.materialize;
            expect(yield* fileSystem.readFileString(personalFile)).toBe("personal notes");

            // A valid record behind the link would let setup adopt the account's edit.
            yield* writeTextFile(personalFile, recordText);
            yield* replaceFile(account.config, "account edit");
            yield* account.materialize;
            expect(yield* fileSystem.readFileString(personalFile)).toBe(recordText);
            expect(yield* fileSystem.readFileString(shared)).toBe("original");
            expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
            const backups = yield* backupsOf(account.home, "config.toml");
            expect(backups).toHaveLength(1);
            expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
              "account edit",
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a dangling Windows account symlink with the shared file",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "shared");
          const account = yield* makeWindowsHome(sharedHome);
          yield* fileSystem.symlink(path.join(account.home, "missing.toml"), account.config);
          yield* account.materialize;
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(shared));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "adopts Windows config into its shared symlink target",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const dotfiles = yield* makeTempDir("t3code-dotfiles-");
          const target = path.join(dotfiles, "codex.toml");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(target, "original");
          yield* fileSystem.symlink(target, shared);
          const account = yield* makeWindowsHome(sharedHome);
          yield* account.materialize;
          yield* replaceFile(account.config, "account edit");
          yield* account.materialize;
          expect(yield* fileSystem.readLink(shared)).toBe(target);
          expect(yield* fileSystem.readFileString(target)).toBe("account edit");
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(target));
          const interrupted = asideOf(target);
          yield* fileSystem.rename(target, interrupted);
          yield* account.materialize;
          expect(yield* fileSystem.readLink(shared)).toBe(target);
          expect(yield* fileSystem.readFileString(target)).toBe("account edit");
          expect(yield* fileSystem.exists(interrupted)).toBe(false);
        }),
    );

    it.effect.each(["missing", "recreated", "untouched"] as const)(
      "recovers Windows reconciliation leftovers with the shared file %s",
      (sharedState) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shared = path.join(sharedHome, "config.toml");
          yield* writeTextFile(shared, "original");
          const account = yield* makeWindowsHome(sharedHome);
          yield* account.materialize;
          const interrupted = asideOf(shared);
          if (sharedState !== "untouched") yield* fileSystem.rename(shared, interrupted);
          yield* fileSystem.link(account.config, pendingLinkOf(account.config));
          if (sharedState === "recreated") {
            yield* writeTextFile(shared, "recreated");
            yield* writeTextFile(asideOf(shared, 1), "crashed copy");
          }
          yield* writeTextFile(`${shared}.t3-backup-old`, "preserved");
          yield* writeTextFile(`${shared}.t3-link`, "pending");
          const staleLock = path.join(sharedHome, ".t3-shared-files.lock");
          yield* fileSystem.makeDirectory(staleLock);
          yield* Effect.promise(() => NodeFSP.utimes(staleLock, 1, 1));
          // Backups made in the same instant stay apart without checking which names exist.
          const backupBlindFs = FileSystem.FileSystem.of({
            ...fileSystem,
            exists: (entry) =>
              entry.includes(".t3-backup-") ? Effect.succeed(false) : fileSystem.exists(entry),
          });
          yield* account.materialize.pipe(
            Effect.provideService(FileSystem.FileSystem, backupBlindFs),
          );
          expect(yield* fileSystem.readFileString(shared)).toBe(
            sharedState === "recreated" ? "recreated" : "original",
          );
          expect(yield* fileSystem.exists(interrupted)).toBe(false);
          expect(yield* fileSystem.exists(pendingLinkOf(account.config))).toBe(false);
          expect(yield* fileSystem.exists(staleLock)).toBe(false);
          const backups = yield* backupsOf(sharedHome, "config.toml");
          const backedUp = yield* Effect.forEach(backups, (name) =>
            fileSystem.readFileString(path.join(sharedHome, name)),
          );
          expect(backedUp.toSorted()).toEqual(
            sharedState === "recreated" ? ["crashed copy", "original", "preserved"] : ["preserved"],
          );
          expect(
            (yield* fileSystem.readDirectory(account.home)).filter((name) =>
              /\.t3-(backup-|aside-|link|shared-files\.lock)/.test(name),
            ),
          ).toEqual([]);
        }),
    );

    it.effect(
      "does not block direct layouts or unrelated Windows homes behind a stalled home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const account = yield* makeWindowsHome(sharedHome);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const blockedFs = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directory) =>
              directory === sharedHome
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fileSystem.readDirectory(directory)),
                  )
                : fileSystem.readDirectory(directory),
          });
          const blocked = yield* account.materialize.pipe(
            Effect.provideService(FileSystem.FileSystem, blockedFs),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          const direct = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome }),
          );
          const other = yield* makeWindowsHome(yield* makeTempDir("t3code-codex-other-"));
          yield* Effect.gen(function* () {
            const directRun = yield* materializeCodexShadowHome(direct).pipe(
              Effect.provideService(HostProcess.Platform, "win32"),
              Effect.forkChild({ startImmediately: true }),
            );
            expect(directRun.pollUnsafe()?._tag).toBe("Success");
            yield* other.materialize;
            yield* Fiber.interrupt(blocked);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }),
    );

    it.effect("refreshes Windows content fingerprints only when linked metadata changes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "config.toml");
        yield* writeTextFile(shared, "original");
        const account = yield* makeWindowsHome(sharedHome);
        yield* account.materialize;
        let reads = 0;
        const trackedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (file) =>
            Effect.sync(() => reads++).pipe(Effect.andThen(fileSystem.readFile(file))),
        });
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));
        expect(reads).toBe(0);
        yield* writeTextFile(shared, "in-place edit to shared file");
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));
        expect(reads).toBe(1);
        yield* replaceFile(account.config, "next account edit");
        yield* account.materialize;
        expect(yield* fileSystem.readFileString(shared)).toBe("next account edit");
        expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
      }),
    );

    it.effect("keeps large Windows file edits as backups without hashing or adopting them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shared = path.join(sharedHome, "history.jsonl");
        const original = "x".repeat(1024 * 1024 + 1);
        yield* writeTextFile(shared, original);
        const account = yield* makeWindowsHome(sharedHome);
        const history = path.join(account.home, "history.jsonl");
        let reads = 0;
        const trackedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (file) =>
            Effect.sync(() => reads++).pipe(Effect.andThen(fileSystem.readFile(file))),
        });
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));
        yield* replaceFile(history, `${original}account edit`);
        yield* account.materialize.pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));
        expect(reads).toBe(0);
        expect(yield* fileSystem.readFileString(shared)).toBe(original);
        const backups = yield* backupsOf(account.home, "history.jsonl");
        expect(backups).toHaveLength(1);
        expect(yield* fileSystem.readFileString(path.join(account.home, backups[0]!))).toBe(
          `${original}account edit`,
        );
      }),
    );

    it.effect("serializes concurrent Windows materializations across accounts sharing a home", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const sharedConfig = path.join(sharedHome, "config.toml");
        yield* writeTextFile(sharedConfig, "original");
        const first = yield* makeWindowsHome(sharedHome);
        const second = yield* makeWindowsHome(sharedHome);
        yield* first.materialize;
        yield* second.materialize;
        yield* replaceFile(first.config, "edited");
        let readers = 0;
        let maximumReaders = 0;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const trackedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (directory) =>
            Effect.gen(function* () {
              readers += 1;
              maximumReaders = Math.max(maximumReaders, readers);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* fileSystem.readDirectory(directory).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    readers -= 1;
                  }),
                ),
              );
            }),
        });
        const adopting = yield* first.materialize.pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFs),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Effect.all(
          [
            Deferred.succeed(release, undefined),
            Fiber.join(adopting),
            first.materialize,
            second.materialize,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));

        expect(maximumReaders).toBe(1);
        expect(yield* fileSystem.readFileString(sharedConfig)).toBe("edited");
        for (const account of [first, second]) {
          expect(yield* fileIdentity(account.config)).toBe(yield* fileIdentity(sharedConfig));
          expect(yield* backupsOf(account.home, "config.toml")).toEqual([]);
        }
      }),
    );

    it.effect("shares the main home on Windows without symlinks, except SQLite files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        const sharedConfig = path.join(sharedHome, "config.toml");
        yield* writeTextFile(path.join(sharedHome, "sessions", "rollout.jsonl"), "shared\n");
        yield* writeTextFile(sharedConfig, 'model = "shared"\n');
        yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "stale"\n');
        yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared");
        yield* writeTextFile(path.join(sharedHome, "state_5.sqlite-wal"), "shared");
        yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "account");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const materializeOnWindows = materializeCodexShadowHome(layout).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        );

        yield* materializeOnWindows;
        const [backup] = yield* backupsOf(shadowHome, "config.toml");
        expect(backup).toBeDefined();
        expect(yield* fileSystem.readFileString(path.join(shadowHome, backup!))).toBe(
          'model = "stale"\n',
        );
        const originalIdentity = yield* fileIdentity(sharedConfig);
        expect(yield* fileIdentity(path.join(shadowHome, "config.toml"))).toBe(originalIdentity);
        const before = yield* Effect.promise(() => NodeFSP.stat(sharedConfig, { bigint: true }));
        yield* materializeOnWindows;
        expect(yield* fileIdentity(path.join(shadowHome, "config.toml"))).toBe(originalIdentity);
        expect(
          yield* Effect.promise(() => NodeFSP.stat(sharedConfig, { bigint: true })),
        ).toMatchObject({
          ino: before.ino,
          dev: before.dev,
          ctimeNs: before.ctimeNs,
          nlink: before.nlink,
        });
        // Codex replaces config.toml atomically, which breaks a hard link.
        yield* writeTextFile(`${sharedConfig}.tmp`, 'model = "updated"\n');
        yield* fileSystem.rename(`${sharedConfig}.tmp`, sharedConfig);
        yield* materializeOnWindows;

        expect(yield* fileIdentity(path.join(shadowHome, "config.toml"))).toBe(
          yield* fileIdentity(sharedConfig),
        );
        expect(yield* backupsOf(shadowHome, "config.toml")).toEqual([backup]);

        expect(
          yield* fileSystem.readFileString(path.join(shadowHome, "sessions", "rollout.jsonl")),
        ).toBe("shared\n");
        expect(yield* fileSystem.readFileString(path.join(shadowHome, "config.toml"))).toBe(
          'model = "updated"\n',
        );
        expect(yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite"))).toBe(
          "account",
        );
        expect(yield* fileSystem.exists(path.join(shadowHome, "state_5.sqlite-wal"))).toBe(false);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives a Windows account its own SQLite files in place of links from older setups",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const shared = (name: string) => path.join(sharedHome, name);
          const shadow = (name: string) => path.join(shadowHome, name);
          for (const name of ["goals_1.sqlite", "goals_1.sqlite-wal", "state_5.sqlite-wal"]) {
            yield* writeTextFile(shared(name), "shared");
          }
          // Windows SQLite wrote this log beside the link, apart from the shared database's log.
          yield* fileSystem.symlink(shared("goals_1.sqlite"), shadow("goals_1.sqlite"));
          yield* writeTextFile(shadow("goals_1.sqlite-wal"), "split");
          yield* writeTextFile(shadow("goals_1.sqlite-shm"), "split");
          yield* writeTextFile(shadow("state_5.sqlite"), "account");
          yield* fileSystem.symlink(shared("state_5.sqlite-wal"), shadow("state_5.sqlite-wal"));
          // A folder resists removal as Windows does for a file Codex holds open.
          yield* writeTextFile(shared("memories_1.sqlite"), "shared");
          yield* fileSystem.symlink(shared("memories_1.sqlite"), shadow("memories_1.sqlite"));
          yield* writeTextFile(path.join(shadow("memories_1.sqlite-shm"), "open"), "split");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(HostProcess.Platform, "win32"),
          );

          const [backup] = yield* backupsOf(shadowHome, "goals_1.sqlite-wal");
          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          expect(shadowEntries.filter((name) => name.includes(".sqlite")).toSorted()).toEqual([
            backup,
            "memories_1.sqlite",
            "memories_1.sqlite-shm",
            "state_5.sqlite",
          ]);
          expect(yield* fileSystem.readFileString(shadow(backup!))).toBe("split");
          expect(yield* fileSystem.readFileString(shadow("state_5.sqlite"))).toBe("account");
          expect(yield* fileSystem.readFileString(shared("goals_1.sqlite-wal"))).toBe("shared");
        }),
    );
  });
});
