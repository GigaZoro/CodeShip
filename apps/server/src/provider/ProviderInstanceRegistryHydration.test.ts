import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEV_REPLAY_INSTANCE_ID,
  deriveProviderInstanceConfigMap,
  layerSettingsSync,
  patchChangesProviderInstances,
  seedDevReplayInstance,
} from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderInstanceRegistrySync from "./ProviderInstanceRegistrySync.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });
});

describe("seedDevReplayInstance", () => {
  const seed = (devUrl: URL | undefined) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedDevReplayInstance().pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl }),
      );
      const settings = yield* ServerSettingsService;
      return (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-replay-seed-" }),
          ServerSettingsService.layerTest({
            providerInstances: {
              [DEV_REPLAY_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "My replay",
                enabled: false,
                config: { source: "local", commandPath: "/old/node" },
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  effectIt.effect("leaves settings alone outside dev", () =>
    seed(undefined).pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect("points a dev server at the replay agent and keeps user edits", () =>
    seed(new URL("http://localhost:5733")).pipe(
      Effect.map((instance) => {
        expect(instance?.displayName).toBe("My replay");
        expect(instance?.enabled).toBe(false);
        expect(instance?.config).toMatchObject({
          source: "local",
          commandArgs: [expect.stringMatching(/scripts[/\\]dev-replay-agent\.ts$/)],
        });
      }),
    ),
  );
});

describe("patchChangesProviderInstances", () => {
  it("is true only for the settings provider instances come from", () => {
    expect(patchChangesProviderInstances({ providerInstances: {} })).toBe(true);
    expect(patchChangesProviderInstances({ projectSettingsOverrides: {} })).toBe(true);
    expect(patchChangesProviderInstances({ defaultRuntimeMode: "full-access" })).toBe(false);
  });
});

const codexDriver = ProviderDriverKind.make("codex");
const initialConfigMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

/** The sync over test settings, a registry `reconcile` and a watcher fed by `changes`. */
const layerSync = (
  changes: Queue.Queue<ServerSettings>,
  reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>,
) =>
  layerSettingsSync(Stream.fromQueue(changes), DEFAULT_SERVER_SETTINGS).pipe(
    Layer.provideMerge(
      Layer.mock(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator)({ reconcile }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );

describe("layerSettingsSync", () => {
  const provider = (label: string) => ({
    [SecretProviderId.make("personal")]: {
      kind: SecretProviderKind.make("one_password"),
      label,
      config: { account: "my" },
    },
  });

  const watch = (initial: ServerSettings | undefined) =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ServerSettings>();
      const reconciled = yield* Queue.unbounded<void>();
      let reloads = 0;
      const mutator = Layer.succeed(
        ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
        {
          reconcile: () => Queue.offer(reconciled, undefined),
          reloadSecrets: () => Effect.sync(() => void reloads++),
          applySecret: () => Effect.succeed([]),
          refreshUnattendedSecrets: () => Effect.void,
        },
      );
      yield* Layer.build(
        layerSettingsSync(Stream.fromQueue(changes), initial).pipe(Layer.provide(mutator)),
      );
      return {
        reloads: () => reloads,
        // Changes run one at a time, so the repeat's reconcile means the first one's reload decision is done.
        change: (settings: ServerSettings) =>
          Queue.offerAll(changes, [settings, settings]).pipe(
            Effect.andThen(Queue.take(reconciled)),
            Effect.andThen(Queue.take(reconciled)),
          ),
      };
    });

  effectIt.effect(
    "retries unreadable secrets when a secret provider changes, not when it is renamed",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const { reloads, change } = yield* watch(yield* settings.getSettings);

        yield* change(yield* settings.updateSettings({ secretProviders: provider("Personal") }));
        expect(reloads()).toBe(1);

        // A label is not read by any vault, so renaming a provider retries nothing.
        yield* change(yield* settings.updateSettings({ secretProviders: provider("Renamed") }));
        expect(reloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest())),
  );

  effectIt.effect(
    "compares a change queued during startup with the settings the registry started from",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const started = yield* settings.getSettings;
        const saved = yield* settings.updateSettings({ secretProviders: provider("Personal") });
        const { reloads, change } = yield* watch(started);

        yield* change(saved);

        expect(reloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest())),
  );

  // The registry can lack an instance its settings name, after a rebuild that failed or while its
  // startup secret read waits on a vault, so unchanged settings are no proof that it runs them.
  effectIt.effect("a catch-up reconciles settings that have not changed", () =>
    Effect.gen(function* () {
      const reconciled: Array<ProviderInstanceConfigMap> = [];
      const reconcile = (configMap: ProviderInstanceConfigMap) =>
        Effect.sync(() => {
          reconciled.push(configMap);
        });

      yield* Effect.gen(function* () {
        const sync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
        yield* sync.catchUp;

        expect(reconciled).toEqual([initialConfigMap]);
      }).pipe(Effect.provide(layerSync(yield* Queue.unbounded<ServerSettings>(), reconcile)));
    }),
  );

  effectIt.effect("a catch-up fails when the reconcile it runs fails", () =>
    Effect.gen(function* () {
      const reconcile = () => Effect.die("provider start failed");

      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const sync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
        yield* settings.updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: codexDriver },
        });

        expect(Exit.isFailure(yield* Effect.exit(sync.catchUp))).toBe(true);
      }).pipe(Effect.provide(layerSync(yield* Queue.unbounded<ServerSettings>(), reconcile)));
    }),
  );

  effectIt.effect(
    "a catch-up waits for a reconcile building other instances, then applies its own",
    () =>
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<ServerSettings>();
        const reconcileStarted = yield* Deferred.make<void>();
        const releaseReconcile = yield* Deferred.make<void>();
        const reconciled: Array<ProviderInstanceConfigMap> = [];
        let building = false;
        const reconcile = (configMap: ProviderInstanceConfigMap) =>
          Effect.gen(function* () {
            reconciled.push(configMap);
            if (reconciled.length > 1) return;
            building = true;
            yield* Deferred.succeed(reconcileStarted, undefined);
            yield* Deferred.await(releaseReconcile);
            building = false;
          });

        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          const sync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
          yield* settings.updateProviderInstance({
            operation: "create",
            instanceId,
            instance: { driver: codexDriver },
          });
          yield* Queue.offer(changes, yield* settings.getSettings);
          yield* Deferred.await(reconcileStarted);
          // Removed before that build ends: the saved instances are the ones applied before it.
          yield* settings.updateProviderInstance({ operation: "remove", instanceId });
          const writer = yield* Effect.forkChild(
            sync.catchUp.pipe(Effect.andThen(Effect.sync(() => building))),
            { startImmediately: true },
          );
          yield* Deferred.succeed(releaseReconcile, undefined);

          expect(yield* Fiber.join(writer)).toBe(false);
          expect(reconciled.at(-1)).toEqual(initialConfigMap);
        }).pipe(Effect.provide(layerSync(changes, reconcile)));
      }),
  );

  effectIt.effect("a catch-up after a failed reconcile rebuilds the saved instances", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ServerSettings>();
      const reconcileEnded = yield* Deferred.make<void>();
      const reconciled: Array<ProviderInstanceConfigMap> = [];
      // The first reconcile stops after retiring instances, so the registry matches no map.
      const reconcile = (configMap: ProviderInstanceConfigMap) =>
        Effect.suspend(() => {
          reconciled.push(configMap);
          return reconciled.length === 1
            ? Effect.die("provider start failed").pipe(
                Effect.ensuring(Deferred.succeed(reconcileEnded, undefined)),
              )
            : Effect.void;
        });

      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const sync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
        yield* settings.updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: codexDriver },
        });
        yield* Queue.offer(changes, yield* settings.getSettings);
        yield* Deferred.await(reconcileEnded);
        yield* settings.updateProviderInstance({ operation: "remove", instanceId });
        yield* sync.catchUp;

        expect(reconciled).toHaveLength(2);
        expect(reconciled.at(-1)).toEqual(initialConfigMap);
      }).pipe(Effect.provide(layerSync(changes, reconcile)));
    }),
  );

  effectIt.effect("finishes a catch-up reconcile when the writer waiting on it goes away", () =>
    Effect.gen(function* () {
      const reconcileStarted = yield* Deferred.make<void>();
      const releaseReconcile = yield* Deferred.make<void>();
      const reconcileOutcome = yield* Deferred.make<"finished" | "interrupted">();
      // A reconcile cut between creating an instance and recording it would leave that instance
      // running outside the registry.
      const reconcile = () =>
        Deferred.succeed(reconcileStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReconcile)),
          Effect.andThen(Deferred.succeed(reconcileOutcome, "finished")),
          Effect.onInterrupt(() => Deferred.succeed(reconcileOutcome, "interrupted")),
        );

      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const sync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
        yield* settings.updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: codexDriver },
        });
        const writer = yield* Effect.forkChild(sync.catchUp);
        yield* Deferred.await(reconcileStarted);
        yield* Fiber.interrupt(writer);
        yield* Deferred.succeed(releaseReconcile, undefined);

        expect(yield* Deferred.await(reconcileOutcome)).toBe("finished");
      }).pipe(Effect.provide(layerSync(yield* Queue.unbounded<ServerSettings>(), reconcile)));
    }),
  );
});
