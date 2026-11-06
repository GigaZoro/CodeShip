import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
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
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
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
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
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
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
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
          const fileSystem = yield* FileSystem.FileSystem;
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

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
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

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
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
        // Codex replaces config.toml atomically, which breaks a hard link.
        yield* writeTextFile(`${sharedConfig}.tmp`, 'model = "updated"\n');
        yield* fileSystem.rename(`${sharedConfig}.tmp`, sharedConfig);
        yield* materializeOnWindows;

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
