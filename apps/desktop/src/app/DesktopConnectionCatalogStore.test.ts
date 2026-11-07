import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(
  available: boolean,
  failDecrypt: Ref.Ref<boolean> | null,
  calls: string[],
) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.sync(() => {
      calls.push("isEncryptionAvailable");
      return available;
    }),
    encryptString: (value) =>
      Effect.sync(() => {
        calls.push("encryptString");
        return textEncoder.encode(`encrypted:${value}`);
      }),
    decryptString: (value) => {
      return Effect.gen(function* () {
        calls.push("decryptString");
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(
  baseDir: string,
  {
    encryptionAvailable = true,
    failDecrypt = null,
    appPath = "/repo",
    safeStorageCalls = [],
  }: {
    readonly encryptionAvailable?: boolean;
    readonly failDecrypt?: Ref.Ref<boolean> | null;
    readonly appPath?: string;
    readonly safeStorageCalls?: string[];
  } = {},
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath,
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const layerSafeStorage = layerSafeStorageFor(encryptionAvailable, failDecrypt, safeStorageCalls);
  const layerDependencies = Layer.mergeAll(layerEnvironment, layerSafeStorage, NodeServices.layer);
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
}

const makeBaseDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-desktop-connection-catalog-test-",
  });
});

const storeFor = (baseDir: string, options?: Parameters<typeof layerFor>[1]) =>
  DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
    Effect.provide(layerFor(baseDir, options)),
  );

const writeAppPackage = (directory: string, appleTeamSigned: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory, "package.json"),
      JSON.stringify({ t3codeAppleTeamSigned: appleTeamSigned }),
    );
    return directory;
  });

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const baseDir = yield* makeBaseDir;
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, { encryptionAvailable })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists and reads an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("keeps the catalog out of the Keychain on macOS builds without a Team ID", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir;
      const appPath = yield* writeAppPackage(path.join(baseDir, "app"), false);
      const safeStorageCalls: string[] = [];
      const store = yield* storeFor(baseDir, {
        encryptionAvailable: false,
        appPath,
        safeStorageCalls,
      });
      const catalog = '{"schemaVersion":1,"targets":[]}';

      assert.isTrue(yield* store.set(catalog));
      assert.deepStrictEqual(yield* store.get, Option.some(catalog));
      assert.deepEqual(safeStorageCalls, []);
      const info = yield* fileSystem.stat(
        path.join(baseDir, "userdata", "connection-catalog.json"),
      );
      assert.equal(info.mode & 0o777, 0o600);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("moves a stored catalog to the way its build keeps it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir;
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
      const catalog = '{"schemaVersion":1,"targets":[]}';
      const teamSigned = yield* storeFor(baseDir, {
        appPath: yield* writeAppPackage(path.join(baseDir, "team"), true),
      });
      const selfSignedCalls: string[] = [];
      const selfSigned = yield* storeFor(baseDir, {
        appPath: yield* writeAppPackage(path.join(baseDir, "self-signed"), false),
        safeStorageCalls: selfSignedCalls,
      });

      assert.isTrue(yield* teamSigned.set(catalog));
      assert.deepStrictEqual(yield* selfSigned.get, Option.some(catalog));
      assert.deepStrictEqual(yield* selfSigned.get, Option.some(catalog));
      assert.deepEqual(selfSignedCalls, ["isEncryptionAvailable", "decryptString"]);

      assert.deepStrictEqual(yield* teamSigned.get, Option.some(catalog));
      assert.include(yield* fileSystem.readFileString(catalogPath), '"encryptedCatalog"');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir;
      const failDecrypt = yield* Ref.make(false);
      const store = yield* storeFor(baseDir, { failDecrypt });

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
