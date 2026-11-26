import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake terminal uses a reset synchronously, inside a key press.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AntigravitySettings,
  EnvironmentId,
  type ClaudeSettings,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ResolvedProviderInstanceEnvironment,
  ProviderInstanceId,
  SecretProviderId,
  SettingsSecretValue,
  type SecretReference,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import {
  answeringClaim,
  GRANTS_REACTIONS,
  makeFakeClaude,
  withFakeClaude,
} from "./claudeLimitResetTerminal.testkit.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ClaudeAccountFolders from "./ClaudeAccountFolders.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { ProviderDriverError } from "./Errors.ts";
import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  idleCompaction: "default",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  yield* fileSystem.writeFileString(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude.mjs");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(
      Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
        endpoint: Effect.succeed("unused-private-pipe"),
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
    ),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(Layer.mock(SecretResolver.SecretResolver)({})),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ProviderInstallationGate.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(PortScanner.layerTest),
    Layer.provideMerge(layerBase),
  );

  it.effect.each(["replacement", "removal", "creation failure"] as const)(
    "detaches retired provider scopes after repeated %s",
    (scenario) =>
      Effect.gen(function* () {
        const parent = yield* Scope.make();
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped();
        let creates = 0;
        let closes = 0;
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: Effect.fn("ProviderInstanceRegistry.test.create")(function* (
            input: Parameters<typeof CodexDriver.create>[0],
          ) {
            creates++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closes++;
              }),
            );
            if (input.config.binaryPath === "creation-failure") {
              return yield* new ProviderDriverError({
                driver: CodexDriver.driverKind,
                instanceId: input.instanceId,
                detail: "fixture creation failed",
              });
            }
            return yield* CodexDriver.create(input);
          }),
        };
        const siblingId = ProviderInstanceId.make("sibling");
        const retiredId = ProviderInstanceId.make("retired");
        const entry = {
          driver: CodexDriver.driverKind,
          enabled: false,
          config: makeCodexConfig({ homePath }),
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [siblingId]: entry },
          });
          const sibling = yield* registry.getInstance(siblingId);
          const finalizerCount = () => {
            const state = parent.state;
            return state._tag === "Open" ? (state.finalizers?.size ?? 1) : 0;
          };
          const baseline = finalizerCount();
          for (let index = 0; index < 20; index++) {
            yield* mutator.reconcile({
              [siblingId]: entry,
              [retiredId]: {
                ...entry,
                config: makeCodexConfig({
                  homePath,
                  binaryPath: scenario === "creation failure" ? "creation-failure" : "unused-codex",
                  customModels: [`revision-${index}`],
                }),
              },
            });
            if (scenario === "removal") yield* mutator.reconcile({ [siblingId]: entry });
          }
          yield* mutator.reconcile({ [siblingId]: entry });
          expect(yield* registry.getInstance(siblingId)).toBe(sibling);
          expect(closes).toBe(creates - 1);
          expect(parent.state._tag).toBe("Open");
          expect(finalizerCount()).toBe(baseline);
        }).pipe(
          Effect.provideService(Scope.Scope, parent),
          Effect.ensuring(Scope.close(parent, Exit.void)),
        );
        expect(closes).toBe(creates);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["replacement", "removal"] as const)(
    "hides retired instances during reconcile (%s)",
    (scenario) =>
      Effect.gen(function* () {
        let closed = 0;
        const replacementStarted = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: (input) =>
            Effect.gen(function* () {
              if (input.displayName === "Second") {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(releaseReplacement);
              }
              const instance = yield* CodexDriver.create(input);
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
              return instance;
            }),
        };
        const retiredId = ProviderInstanceId.make("retired");
        const siblingId = ProviderInstanceId.make("sibling");
        const nextId = scenario === "replacement" ? retiredId : ProviderInstanceId.make("new");
        const entry = {
          driver: CodexDriver.driverKind,
          enabled: false,
          config: makeCodexConfig({}),
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [retiredId]: entry, [siblingId]: entry },
        });
        const sibling = yield* registry.getInstance(siblingId);
        const reconcile = yield* mutator
          .reconcile({
            [siblingId]: entry,
            [nextId]: {
              ...entry,
              displayName: "Second",
              config: makeCodexConfig({ customModels: ["replacement-model"] }),
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(replacementStarted);
        expect(closed).toBe(1);
        expect(yield* registry.getInstance(retiredId)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([sibling]);
        yield* Deferred.succeed(releaseReplacement, undefined);
        yield* Fiber.join(reconcile);
        expect((yield* registry.getInstance(nextId))?.displayName).toBe("Second");
        expect(yield* registry.getInstance(siblingId)).toBe(sibling);
        expect(closed).toBe(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("lists a blocked driver's instances as unavailable without running them", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const reason = "Example Corp's policy does not allow the Codex provider.";
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap: { [instanceId]: { driver: ProviderDriverKind.make("codex") } },
        blockedReason: (driver) => (driver === "codex" ? reason : undefined),
      });

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const [unavailable] = yield* registry.listUnavailable;
      expect(unavailable?.instanceId).toBe(instanceId);
      expect(unavailable?.availability).toBe("unavailable");
      expect(unavailable?.unavailableReason).toBe(reason);
    }).pipe(Effect.provide(layerTest)),
  );

  // The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
  it.live.skipIf(isWindowsHost)(
    "runs Codex and Claude readiness probes from configured tilde paths",
    () =>
      Effect.gen(function* () {
        const fixtures = yield* makeTildeProviderFixtures();

        const codexId = ProviderInstanceId.make("codex_tilde");
        const claudeId = ProviderInstanceId.make("claude_tilde");
        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            environment: [
              {
                name: "T3_CODEX_COLLAB_SCRIPT",
                value: fixtures.codexScriptPath,
                sensitive: false,
              },
            ],
            config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
          },
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv | ClaudeDriverEnv>({
          drivers: [CodexDriver, ClaudeDriver],
          configMap,
        });
        const codex = yield* registry.getInstance(codexId);
        const claude = yield* registry.getInstance(claudeId);
        expect(codex).toBeDefined();
        expect(claude).toBeDefined();

        const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
          [codex!.snapshot.refresh, claude!.snapshot.refresh],
          { concurrency: "unbounded" },
        );
        expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
        expect(claudeSnapshot).toMatchObject({
          status: "ready",
          installed: true,
          version: "2.1.219",
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.live.skipIf(isWindowsHost)(
    "runs Claude instance probes in the server state dir, not the server cwd",
    () =>
      Effect.gen(function* () {
        const fixtures = yield* makeTildeProviderFixtures();
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const claudeId = ProviderInstanceId.make("claude_state_dir");
        const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
          drivers: [ClaudeDriver],
          configMap: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              // Packaged desktop starts in $HOME, where some claude wrappers refuse to run.
              environment: [{ name: "T3_CLAUDE_REQUIRED_CWD", value: stateDir, sensitive: false }],
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath: fixtures.claudeHomePath,
              }),
            },
          },
        });
        const claude = yield* registry.getInstance(claudeId);

        expect(yield* claude!.snapshot.refresh).toMatchObject({
          status: "ready",
          version: "2.1.219",
          auth: { status: "authenticated" },
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    { platform: "linux", namesIgnoreCase: false },
    { platform: "win32", namesIgnoreCase: true },
  ] as const)(
    "publishes the folder each enabled Claude account runs in on $platform",
    ({ platform, namesIgnoreCase }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-folders-home-" });
        const claude = ProviderDriverKind.make("claudeAgent");
        const binaryPath = path.join(home, "claude-not-installed");
        const enabledConfig = makeClaudeConfig({ enabled: true, binaryPath });
        const folderSecret: SecretReference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Claude/folder",
        };
        const missingSecret: SecretReference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Claude/missing",
        };
        const gate = Deferred.makeUnsafe<void>();
        const resolver = Layer.succeed(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          read: (references) =>
            Deferred.await(gate).pipe(
              Effect.as(
                references.map((reference) =>
                  reference.reference === folderSecret.reference
                    ? "/vault/claude-folder"
                    : undefined,
                ),
              ),
            ),
          invalidate: () => Effect.void,
          refreshUnattended: () => Effect.succeedNone,
        });
        const settingsLayer = ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: { driver: claude, config: enabledConfig },
            [ProviderInstanceId.make("home_path")]: {
              driver: claude,
              displayName: "Home path",
              config: makeClaudeConfig({ enabled: true, binaryPath, homePath: "~/.claude-own" }),
            },
            [ProviderInstanceId.make("own")]: { driver: claude, config: enabledConfig },
            [ProviderInstanceId.make("named")]: {
              driver: claude,
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: "~/.claude-named", sensitive: false },
              ],
              config: enabledConfig,
            },
            [ProviderInstanceId.make("lowercase")]: {
              driver: claude,
              environment: [
                { name: "claude_config_dir", value: "/srv/claude-lower", sensitive: false },
              ],
              config: enabledConfig,
            },
            [ProviderInstanceId.make("from_secret")]: {
              driver: claude,
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: folderSecret, sensitive: true }],
              config: enabledConfig,
            },
            [ProviderInstanceId.make("unreadable")]: {
              driver: claude,
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: missingSecret, sensitive: true }],
              config: enabledConfig,
            },
            [ProviderInstanceId.make("invalid")]: { driver: claude, config: { binaryPath: 42 } },
            [ProviderInstanceId.make("off")]: {
              driver: claude,
              enabled: false,
              config: enabledConfig,
            },
            [ProviderInstanceId.make("off_invalid")]: {
              driver: claude,
              enabled: false,
              config: { binaryPath: 42 },
            },
          },
        });

        const contents = yield* Effect.gen(function* () {
          const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
          const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
            drivers: [ClaudeDriver],
            configMap: deriveProviderInstanceConfigMap(settings),
          }).pipe(Effect.provide(resolver));
          // Secrets are read after startup; wait for the change that applies them.
          const changes = yield* registry.subscribeChanges;
          yield* Deferred.succeed(gate, undefined);
          yield* PubSub.take(changes);
          yield* Layer.build(
            ClaudeAccountFolders.layer.pipe(
              Layer.provide(
                Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, registry),
              ),
            ),
          );
          return yield* fileSystem.readFileString(
            ClaudeAccountFolders.claudeAccountFoldersPath(path, stateDir),
          );
        }).pipe(
          Effect.provide(settingsLayer),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );

        const ownHome = (instanceId: string) =>
          path.join(stateDir, "providers", "claudeAgent", instanceId, "home");
        expect(JSON.parse(contents)).toEqual({
          version: 1,
          accounts: [
            {
              instanceId: "claudeAgent",
              displayName: null,
              status: "available",
              configFolder: { kind: "default" },
            },
            {
              instanceId: "home_path",
              displayName: "Home path",
              status: "available",
              configFolder: { kind: "path", path: path.join(home, ".claude-own") },
            },
            {
              instanceId: "own",
              displayName: null,
              status: "available",
              configFolder: { kind: "path", path: ownHome("own") },
            },
            {
              instanceId: "named",
              displayName: null,
              status: "available",
              configFolder: { kind: "path", path: path.join(home, ".claude-named") },
            },
            {
              instanceId: "lowercase",
              displayName: null,
              status: "available",
              configFolder: {
                kind: "path",
                path: namesIgnoreCase ? path.resolve("/srv/claude-lower") : ownHome("lowercase"),
              },
            },
            {
              instanceId: "from_secret",
              displayName: null,
              status: "available",
              configFolder: { kind: "secret" },
            },
            {
              instanceId: "unreadable",
              displayName: null,
              status: "unavailable",
              reason: expect.stringContaining("Could not read CLAUDE_CONFIG_DIR"),
            },
            {
              instanceId: "invalid",
              displayName: null,
              status: "unavailable",
              reason: expect.stringContaining("Invalid config for instance 'invalid'"),
            },
          ],
        });
        expect(contents).not.toContain("/vault/claude-folder");
        if (!isWindowsHost) {
          const info = yield* fileSystem.stat(
            ClaudeAccountFolders.claudeAccountFoldersPath(path, stateDir),
          );
          expect(info.mode & 0o777).toBe(0o600);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live.skipIf(isWindowsHost)(
    "applies the lowest maxEffortLevel across Claude's settings sources",
    () =>
      Effect.gen(function* () {
        const fixtures = yield* makeTildeProviderFixtures();
        const claudeId = ProviderInstanceId.make("claude_source_effort_cap");
        const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
          drivers: [ClaudeDriver],
          configMap: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              environment: [
                {
                  name: "T3_CLAUDE_SETTINGS_SOURCES",
                  // The merged `effective` settings read as exempting Opus 5; the flag tier's
                  // top-level cap still applies to it.
                  value: JSON.stringify([
                    {
                      source: "userSettings",
                      settings: { modelSettings: { "claude-opus-5": { maxEffortLevel: "max" } } },
                    },
                    { source: "flagSettings", settings: { maxEffortLevel: "high" } },
                  ]),
                  sensitive: false,
                },
              ],
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath: fixtures.claudeHomePath,
              }),
            },
          },
        });
        const claude = yield* registry.getInstance(claudeId);

        const snapshot = yield* claude!.snapshot.refresh;
        const maxLabel = snapshot.models
          .find((model) => model.slug === "claude-opus-5")
          ?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
            descriptor.id === "effort" && descriptor.type === "select"
              ? descriptor.options.filter((option) => option.id === "max")
              : [],
          )[0]?.label;
        expect(maxLabel).toBe("Max (capped to High)");
      }).pipe(Effect.provide(layerTest)),
  );

  it.live.skipIf(isWindowsHost)(
    "keeps usage and uncapped efforts when the CLI rejects get_settings",
    () =>
      Effect.gen(function* () {
        const fixtures = yield* makeTildeProviderFixtures();
        const claudeId = ProviderInstanceId.make("claude_settings_unsupported");
        const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
          drivers: [ClaudeDriver],
          configMap: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              environment: [
                { name: "T3_CLAUDE_SETTINGS_UNSUPPORTED", value: "1", sensitive: false },
              ],
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath: fixtures.claudeHomePath,
              }),
            },
          },
        });
        const claude = yield* registry.getInstance(claudeId);

        const snapshot = yield* claude!.snapshot.refresh;
        const effortLabels = snapshot.models.flatMap((model) =>
          (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
            descriptor.id === "effort" && descriptor.type === "select"
              ? descriptor.options.map((option) => option.label)
              : [],
          ),
        );
        expect(effortLabels).toContain("Max");
        expect(effortLabels.some((label) => label.includes("capped"))).toBe(false);
        expect(snapshot.auth).toMatchObject({ status: "authenticated", email: "test@example.com" });
        expect(snapshot.usageLimits?.windows[0]?.usedPercent).toBe(100);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(isWindowsHost)(
    "scopes Claude's one-probe fallback to the logged-in organization",
    () =>
      Effect.gen(function* () {
        const fixtures = yield* makeTildeProviderFixtures();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const accountConfigPath = path.join(fixtures.claudeHomePath, ".claude.json");
        yield* fs.writeFileString(
          accountConfigPath,
          JSON.stringify({ oauthAccount: { organizationUuid: "org-a" } }),
        );
        const claudeId = ProviderInstanceId.make("claude_probe_recovery");
        let probeCount = 0;
        let successfulProbeCount = 0;
        let failProbe = false;
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
          () =>
            ({
              initializationResult: () => {
                probeCount++;
                if (failProbe) return Promise.reject(new Error("initialization failed"));
                successfulProbeCount++;
                return Promise.resolve({
                  commands: [
                    {
                      name: successfulProbeCount === 1 ? "last-good" : "recovered",
                      description: "",
                      argumentHint: "",
                    },
                  ],
                  account: {
                    email:
                      successfulProbeCount === 1
                        ? "account-a@example.com"
                        : "account-b@example.com",
                    subscriptionType: "pro",
                    tokenSource: "oauth",
                  },
                });
              },
              usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
                rate_limits_available: true,
                rate_limits: {
                  five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" },
                },
              }),
            }) as ReturnType<typeof ClaudeSdk.query>,
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

        const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
          drivers: [ClaudeDriver],
          configMap: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath: fixtures.claudeHomePath,
              }),
            },
          },
        });
        const claude = yield* registry.getInstance(claudeId);
        expect(claude).toBeDefined();

        const first = yield* claude!.snapshot.refresh;
        expect(first).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", email: "account-a@example.com", workspaceId: "org-a" },
          slashCommands: expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
        });
        expect(first.usageLimits?.unavailable).toBeUndefined();
        expect(probeCount).toBe(1);

        yield* TestClock.adjust("1 second");
        yield* fs.writeFileString(
          accountConfigPath,
          JSON.stringify({ oauthAccount: { organizationUuid: "org-b" } }),
        );
        yield* claude!.invalidateCaches ?? Effect.void;
        failProbe = true;
        const accountChangedFailure = yield* claude!.snapshot.refresh;

        expect(accountChangedFailure).toMatchObject({
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude Agent CLI failed while checking account status: initialization failed",
        });
        expect(accountChangedFailure.checkedAt).not.toBe(first.checkedAt);
        expect(accountChangedFailure.usageLimits).toBeUndefined();
        expect(accountChangedFailure.slashCommands).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
        );
        const failedProbeCount = probeCount;
        expect(failedProbeCount).toBeGreaterThan(1);

        failProbe = false;
        const recovered = yield* claude!.snapshot.refresh;
        expect(recovered).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
          slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
        });
        expect(recovered.usageLimits?.unavailable).toBeUndefined();
        const recoveredProbeCount = probeCount;
        expect(recoveredProbeCount).toBeGreaterThan(failedProbeCount);

        yield* TestClock.adjust("1 second");
        yield* claude!.invalidateCaches ?? Effect.void;
        failProbe = true;
        const sameAccountFailure = yield* claude!.snapshot.refresh;
        expect(sameAccountFailure).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
          slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
        });
        expect(sameAccountFailure.usageLimits?.checkedAt).toBe(recovered.usageLimits?.checkedAt);
        expect(sameAccountFailure.usageLimits?.windows).toEqual(recovered.usageLimits?.windows);
        const sameAccountFailureProbeCount = probeCount;
        expect(sameAccountFailureProbeCount).toBeGreaterThan(recoveredProbeCount);

        const repeatedFailure = yield* claude!.snapshot.refresh;
        expect(repeatedFailure).toMatchObject({
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude Agent CLI failed while checking account status: initialization failed",
        });
        expect(repeatedFailure.slashCommands).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
        );
        expect(probeCount).toBeGreaterThan(sameAccountFailureProbeCount);
      }).pipe(Effect.provide(layerTest)),
  );

  const redeemClaudeReset = (claim: { answer?: string; usageFailsAfterClaim: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = yield* makeTildeProviderFixtures();
      const marker = path.join(fixtures.claudeHomePath, "redeemed");
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".claude.json"),
        JSON.stringify({
          oauthAccount: { organizationUuid: "fake-org" },
          cachedGrowthBookFeatures: { tengu_cedar_ember: { enabled: true } },
        }),
      );
      // The fixture's usage reads 0% once the marker exists, as after a reset.
      const fake = makeFakeClaude({
        reactions:
          claim.answer === undefined
            ? GRANTS_REACTIONS
            : answeringClaim(GRANTS_REACTIONS, "/limit-reset full", claim.answer),
        onUse: () => NodeFS.writeFileSync(marker, "redeemed"),
      });
      const instanceId = ProviderInstanceId.make("claude_reset");
      const { registry } = yield* withFakeClaude(
        fake,
        makeProviderInstanceRegistry({
          drivers: [ClaudeDriver],
          configMap: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              environment: [
                { name: "T3_CLAUDE_RESET_MARKER", value: marker, sensitive: false },
                ...(claim.usageFailsAfterClaim
                  ? [{ name: "T3_CLAUDE_USAGE_FAILS_AFTER_CLAIM", value: "1", sensitive: false }]
                  : []),
              ],
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath: fixtures.claudeHomePath,
              }),
            },
          },
        }),
      );
      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      const grantsShown = yield* instance!.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.usageLimits?.resetCredits !== undefined),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const before = yield* instance!.snapshot.refresh;
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      yield* Fiber.join(grantsShown);
      const outcome = yield* instance!.consumeResetCredit!().pipe(Effect.result);
      // The grant that expires first, used through its confirm dialog.
      expect(fake.used).toEqual(["/limit-reset full"]);
      return { outcome, after: yield* instance!.snapshot.getSnapshot };
    }).pipe(Effect.provide(layerTest));

  it.live.skipIf(isWindowsHost)("refreshes Claude usage after redeeming a reset", () =>
    Effect.gen(function* () {
      const { outcome, after } = yield* redeemClaudeReset({ usageFailsAfterClaim: false });
      expect(outcome).toMatchObject({ _tag: "Success", success: { outcome: "reset" } });
      expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
    }),
  );

  it.live.skipIf(isWindowsHost)(
    "reports Claude's answer when a claim changed nothing and the re-probe fails",
    () =>
      Effect.gen(function* () {
        const { outcome } = yield* redeemClaudeReset({
          answer: "That reset was already used · nothing changed just now",
          usageFailsAfterClaim: true,
        });
        expect(outcome).toMatchObject({
          _tag: "Success",
          success: { outcome: "alreadyRedeemed" },
        });
      }),
  );

  it.live.skipIf(isWindowsHost)(
    "refreshes Claude usage after a claim that pressed Yes but got no answer it knows",
    () =>
      Effect.gen(function* () {
        const { outcome, after } = yield* redeemClaudeReset({
          answer: "Something went differently this time",
          usageFailsAfterClaim: false,
        });
        expect(outcome).toMatchObject({ _tag: "Failure" });
        expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
      }),
  );

  it.live.skipIf(isWindowsHost)(
    "a Claude reset whose re-probe fails still succeeds, saying it was not confirmed",
    () =>
      Effect.gen(function* () {
        const { outcome } = yield* redeemClaudeReset({ usageFailsAfterClaim: true });
        expect(outcome).toMatchObject({
          _tag: "Success",
          success: {
            outcome: "reset",
            warning:
              "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
          },
        });
      }),
  );

  const makeClaudeCacheFixture = Effect.fnUntraced(function* (
    state: "ready" | "signed-out" | "usage-failed",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = yield* makeTildeProviderFixtures();
    const recovered = path.join(fixtures.claudeHomePath, "recovered");
    const probeLog = path.join(fixtures.claudeHomePath, "probes.log");
    const instanceId = ProviderInstanceId.make("claude_cache");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_PROBE_LOG", value: probeLog, sensitive: false },
            ...(state === "ready"
              ? []
              : [
                  {
                    name:
                      state === "signed-out"
                        ? "T3_CLAUDE_LOGIN_MARKER"
                        : "T3_CLAUDE_USAGE_FAILS_UNTIL",
                    value: recovered,
                    sensitive: false,
                  },
                ]),
          ],
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    return {
      refresh: instance!.snapshot.refresh,
      recover: fs.writeFileString(recovered, ""),
      probeLog: fs.readFileString(probeLog),
    };
  });

  for (const state of ["signed-out", "usage-failed"] as const) {
    it.effect.skipIf(isWindowsHost)(
      state === "signed-out"
        ? "shows Claude usage on the first refresh after signing back in"
        : "retries Claude usage on the first refresh after a failed usage read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeClaudeCacheFixture(state);
          const before = yield* fixture.refresh;
          if (state === "signed-out") {
            expect(before.auth.status).toBe("unauthenticated");
            expect(before.usageLimits).toBeUndefined();
          } else {
            expect(before.auth.status).toBe("authenticated");
            expect(before.usageLimits?.unavailable?.reason).toBe("probeFailed");
          }

          yield* fixture.recover;
          const after = yield* fixture.refresh;
          expect(after.auth.status).toBe("authenticated");
          expect(after.usageLimits?.unavailable).toBeUndefined();
          expect(after.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
        }).pipe(Effect.provide(layerTest)),
    );
  }

  it.effect(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(layerTest)),
  );
});

const DisabledByDefaultConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

describe("ProviderInstanceRegistry secret environment", () => {
  const driverKind = ProviderDriverKind.make("fake");
  const instanceId = ProviderInstanceId.make("fake_main");
  const secret: SecretReference = {
    provider: SecretProviderId.make("personal"),
    reference: "op://Private/OpenAI/credential",
  };

  function setup(
    initial: Record<string, string>,
    configSchema: AnyProviderDriver["configSchema"] = Schema.Unknown,
    config: unknown = {},
  ) {
    const vault = new Map(Object.entries(initial));
    const reads: Array<ReadonlyArray<string>> = [];
    const invalidated: Array<ReadonlyArray<string>> = [];
    const created: Array<ResolvedProviderInstanceEnvironment> = [];
    const configs: Array<unknown> = [];
    // A test can hold a build open, as a slow provider start does.
    let createHold: Effect.Effect<void> = Effect.void;
    const driver: AnyProviderDriver = {
      driverKind,
      metadata: { displayName: "Fake" },
      configSchema,
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.suspend(() => createHold).pipe(
          Effect.andThen(
            Effect.sync(() => {
              created.push(input.environment);
              configs.push(input.config);
              return { instanceId: input.instanceId, enabled: input.enabled } as ProviderInstance;
            }),
          ),
        ),
    };
    const holdCreates = (hold: Effect.Effect<void>) => {
      createHold = hold;
    };
    const gate = Deferred.makeUnsafe<void>();
    const resolver = Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) =>
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(references.map((reference) => reference.reference));
              return references.map((reference) => vault.get(reference.reference));
            }),
          ),
        ),
      invalidate: (references = []) =>
        Effect.sync(() => {
          invalidated.push(references.map((reference) => reference.reference));
        }),
      refreshUnattended: (references) =>
        Effect.sync(() => {
          const matches = references.map(({ reference }) => vault.get(reference));
          return matches.every((value) => value !== undefined)
            ? Option.some(matches)
            : Option.none();
        }),
    });
    const configMap: ProviderInstanceConfigMap = {
      [instanceId]: {
        driver: driverKind,
        config,
        environment: [
          { name: "OPENAI_API_KEY", value: secret, sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      },
    };
    const makeGated = makeProviderInstanceRegistry({ drivers: [driver], configMap }).pipe(
      Effect.provide(resolver),
    );
    // Secrets are read after startup, so wait for the change that applies them.
    const make = Effect.gen(function* () {
      const built = yield* makeGated;
      const changes = yield* built.registry.subscribeChanges;
      yield* Deferred.succeed(gate, undefined);
      yield* PubSub.take(changes);
      return built;
    });
    return {
      vault,
      reads,
      invalidated,
      created,
      configs,
      configMap,
      make,
      makeGated,
      gate,
      holdCreates,
    };
  }

  it.effect("starts an instance with the secret its environment points at", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.make;

      const shellEnvironment = (yield* registry.getInstance(instanceId))?.shellEnvironment;
      expect(fixture.created).toEqual([
        [
          { name: "OPENAI_API_KEY", value: "sk-live", sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      ]);
      // Its driver sets no shell environment, so its agent's shell commands get what it started with.
      expect(shellEnvironment).toBeDefined();
      expect(
        yield* shellEnvironment!("/work", { HOME: "/home/me" }, { instanceId, model: "gpt-5" }),
      ).toEqual({
        HOME: "/home/me",
        OPENAI_API_KEY: "sk-live",
        BASE_URL: "https://example.test",
      });
    }).pipe(Effect.scoped);
  });

  // An empty secret must not let a driver fall back to a credential the server inherited.
  it.effect.each([
    ["missing", {}],
    ["empty", { [secret.reference]: " " }],
  ] as const)("marks an instance unavailable when its secret is %s", ([, initial]) => {
    const fixture = setup(initial);
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;
      const readsAtStartup = fixture.reads.length;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(fixture.created).toEqual([]);
      const [unavailable] = yield* registry.listUnavailable;
      expect(unavailable?.instanceId).toBe(instanceId);
      expect(unavailable?.unavailableReason).toContain("OPENAI_API_KEY");

      // A settings save that leaves it alone does not read the vault again.
      yield* mutator.reconcile({ ...fixture.configMap });
      expect(fixture.reads).toHaveLength(readsAtStartup);
      expect(yield* registry.listUnavailable).toHaveLength(1);
    });
  });

  it.effect("does not read the secrets of an instance its config decodes as disabled", () => {
    const fixture = setup({ [secret.reference]: "sk-live" }, DisabledByDefaultConfig);
    return Effect.gen(function* () {
      const { mutator } = yield* fixture.makeGated;
      yield* mutator.reloadSecrets();

      expect(fixture.reads).toEqual([]);
      expect(fixture.invalidated).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    });
  });

  it.effect("re-reads secrets on reload and rebuilds only when they changed", () => {
    const fixture = setup({});
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.set(secret.reference, "sk-live");
      yield* mutator.reloadSecrets();
      expect(fixture.invalidated).toEqual([[secret.reference]]);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);

      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created).toHaveLength(1);

      fixture.vault.set(secret.reference, "sk-rotated");
      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created.map((environment) => environment[0]?.value)).toEqual([
        "sk-live",
        "sk-rotated",
      ]);
    });
  });

  it.effect("reads a config field typed SettingsSecretValue and rebuilds when it rotates", () => {
    const apiKey: SecretReference = { ...secret, reference: "op://Private/Gateway/key" };
    const fixture = setup(
      { [secret.reference]: "sk-live", [apiKey.reference]: "gw-live" },
      Schema.Struct({ apiKey: SettingsSecretValue, model: Schema.String }),
      { apiKey, model: "m" },
    );
    return Effect.gen(function* () {
      const { mutator } = yield* fixture.make;
      expect(fixture.reads.at(-1)).toEqual([secret.reference, apiKey.reference]);

      fixture.vault.set(apiKey.reference, "gw-rotated");
      yield* mutator.reloadSecrets();
      expect(fixture.configs).toEqual([
        { apiKey: "gw-live", model: "m" },
        { apiKey: "gw-rotated", model: "m" },
      ]);
    });
  });

  it.effect.each([
    { name: "Antigravity apiKey", schema: AntigravitySettings, field: "apiKey" },
    { name: "OpenCode serverPassword", schema: OpenCodeSettings, field: "serverPassword" },
  ])("hands the driver the secret its $name names", ({ schema, field }) => {
    const reference: SecretReference = { ...secret, reference: "op://Private/Provider/key" };
    const fixture = setup(
      { [secret.reference]: "sk-live", [reference.reference]: "provider-live" },
      schema,
      { enabled: true, [field]: reference },
    );
    return Effect.gen(function* () {
      yield* fixture.make;
      expect(fixture.configs).toEqual([expect.objectContaining({ [field]: "provider-live" })]);
    });
  });

  it.effect("applies a rotated unattended secret after it can reserve the instance", () => {
    const fixture = setup({ [secret.reference]: "sk-original" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;
      const original = yield* registry.getInstance(instanceId);
      fixture.vault.set(secret.reference, "sk-rotated");
      yield* mutator.refreshUnattendedSecrets(() => Effect.succeed(false));
      expect(yield* registry.getInstance(instanceId)).toBe(original);

      yield* mutator.refreshUnattendedSecrets(() => Effect.succeed(true));
      expect(fixture.created.map((environment) => environment[0]?.value)).toEqual([
        "sk-original",
        "sk-rotated",
      ]);
      const reloaded = yield* registry.getInstance(instanceId);
      expect(reloaded).not.toBe(original);

      fixture.vault.delete(secret.reference);
      yield* mutator.refreshUnattendedSecrets(() => Effect.succeed(true));
      expect(yield* registry.getInstance(instanceId)).toBe(reloaded);
      expect(fixture.created).toHaveLength(2);
    }).pipe(Effect.scoped);
  });

  it.effect("keeps a working instance live when a reload cannot read its secret", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.delete(secret.reference);
      yield* mutator.reloadSecrets();

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    });
  });

  it.effect("rebuilds the instance a secret reload retired when its caller goes away", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;
      const buildStarted = yield* Deferred.make<void>();
      const releaseBuild = yield* Deferred.make<void>();
      fixture.holdCreates(
        Deferred.succeed(buildStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseBuild)),
        ),
      );

      fixture.vault.set(secret.reference, "sk-rotated");
      const reload = yield* Effect.forkChild(mutator.reloadSecrets(instanceId));
      yield* Deferred.await(buildStarted);
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      yield* Fiber.interrupt(reload);
      yield* Deferred.succeed(releaseBuild, undefined);
      // Another change waits for the registry's lock and rebuilds nothing itself.
      yield* mutator.reloadSecrets(ProviderInstanceId.make("fake_other"));

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(fixture.created.map((environment) => environment[0]?.value)).toEqual([
        "sk-live",
        "sk-rotated",
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("a reconcile of unchanged settings waits for the startup secret read", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.makeGated;
      const reconcile = yield* Effect.forkChild(mutator.reconcile({ ...fixture.configMap }), {
        startImmediately: true,
      });
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();

      yield* Deferred.succeed(fixture.gate, undefined);
      yield* Fiber.join(reconcile);

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(fixture.created).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("starts without waiting for secrets to be read", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.makeGated;
      const changes = yield* registry.subscribeChanges;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const [pending] = yield* registry.listUnavailable;
      expect(pending?.unavailableReason).toBe("Reading secrets…");

      yield* Deferred.succeed(fixture.gate, undefined);
      yield* PubSub.take(changes);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
    });
  });
});
