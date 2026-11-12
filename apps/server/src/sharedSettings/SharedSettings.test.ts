import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  globalIdleCompaction,
  MACHINE_SHARED_SETTING_KEYS,
  type ManagedPolicyDocument,
  type ManagedPolicySummary,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerSettingsPatch,
  SHARED_SETTING_VALUE_MAX_BYTES,
  SHARED_SETTINGS_RESPONSE_MAX_BYTES,
  type SharedSettingsShare,
  type SharedSettingsWriteShare,
  type SharedSettingVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as SharedSettings from "./SharedSettings.ts";

const HERE = EnvironmentId.make("environment-here");
const PEER = EnvironmentId.make("environment-peer");
const OTHER = EnvironmentId.make("environment-zeta");

const NOW = "2026-11-11T14:00:00.000Z";
const EARLIER = "2026-11-11T11:00:00.000Z";
const LATER = "2026-11-11T13:00:00.000Z";
const SOON = "2026-11-11T14:01:00.000Z";
const AN_HOUR_AHEAD = "2026-11-11T15:00:00.000Z";

/** A change another machine saved for all machines, as the JSON it sends. */
const share = (
  values: Record<string, unknown>,
  updatedAt: string,
  origin: EnvironmentId = HERE,
): SharedSettingsShare => ({
  stamp: { updatedAt, origin },
  values: Object.entries(values).map(([key, value]) => ({ key, value })),
});

const version = (
  key: string,
  value: unknown,
  updatedAt: string,
  origin: EnvironmentId = PEER,
  instanceDriver?: string,
): SharedSettingVersion => ({
  key,
  value,
  ...(instanceDriver === undefined ? {} : { instanceDriver }),
  updatedAt,
  origin,
});

type SettingsService = Settings.ServerSettingsService["Service"];

/**
 * Settings whose reads outside the write lock still say the machine follows shared settings, as
 * they did a moment before following was turned off.
 */
const followingTurnedOff = (real: SettingsService): SettingsService => ({
  ...real,
  getSettings: real.getSettings.pipe(
    Effect.map((current) => ({ ...current, followSharedSettings: true })),
  ),
});

/** Settings that refuse every write to a provider instance, as an administrator's policy can. */
const refusingProviderInstances = (real: SettingsService): SettingsService => ({
  ...real,
  updateProviderInstance: () =>
    Effect.fail(
      new ServerSettingsError({
        settingsPath: "test settings",
        operation: "write-managed-setting",
        managedBy: "Example Corp",
      }),
    ),
});

/**
 * A machine's settings, its provider instances, and the sqlite file that holds the versions. `seen`
 * changes how the settings service behaves for the others.
 */
const machine = (
  overrides: Parameters<typeof Settings.layerTest>[0],
  instances: Ref.Ref<ReadonlyArray<string>>,
  seen: ((real: SettingsService) => SettingsService) | undefined,
  managedPolicy: ManagedPolicySummary | undefined,
  environmentId: EnvironmentId,
) => {
  const settings = Settings.layerTest({ followSharedSettings: true, ...overrides }, managedPolicy);
  const settingsSeen =
    seen === undefined
      ? settings
      : Layer.effect(
          Settings.ServerSettingsService,
          Settings.ServerSettingsService.pipe(Effect.map(seen)),
        ).pipe(Layer.provide(settings));
  return SharedSettings.layer.pipe(
    Layer.provideMerge(settingsSeen),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        // Built-in instances, each running the driver it is named after.
        getProviders: Ref.get(instances).pipe(
          Effect.map((ids) =>
            ids.map((instanceId) => ({ instanceId, driver: instanceId, enabled: true }) as never),
          ),
        ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  );
};

const run = <A, E>(
  body: (
    shared: SharedSettings.SharedSettings["Service"],
    settings: Settings.ServerSettingsService["Service"],
    instances: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
  overrides: Parameters<typeof Settings.layerTest>[0] = {},
  seen?: (real: SettingsService) => SettingsService,
  managedPolicy?: ManagedPolicySummary,
  environmentId: EnvironmentId = HERE,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const instances = yield* Ref.make<ReadonlyArray<string>>(["codex", "claudeAgent"]);
    return yield* Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      const settings = yield* Settings.ServerSettingsService;
      return yield* body(shared, settings, instances);
    }).pipe(Effect.provide(machine(overrides, instances, seen, managedPolicy, environmentId)));
  });

const served = (shared: SharedSettings.SharedSettings["Service"]) =>
  shared.servedVersions.pipe(
    Effect.map((versions) => Object.fromEntries(versions.map((entry) => [entry.key, entry]))),
  );

/** Runs `body` and returns, with its result, the text of each warning it logged. */
const withWarnings = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(Array.isArray(message) ? message[0] : message));
    });
    const result = yield* body.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return { result, warnings };
  });

const finalReview = (settings: Settings.ServerSettingsService["Service"]) =>
  settings.getSettings.pipe(Effect.map((current) => current.finalReviewByDefault));

it.effect("a write saved for all machines becomes the shared version of the keys it sets", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.update({}, share({ finalReviewByDefault: true }, EARLIER));
      const versions = yield* served(shared);
      expect(versions.finalReviewByDefault).toEqual(
        version("finalReviewByDefault", true, EARLIER, HERE),
      );
    }),
  ),
);

it.effect("a write for one machine shares nothing", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ defaultRuntimeMode: "full-access" }, undefined);
      expect((yield* settings.getSettings).defaultRuntimeMode).toBe("full-access");
      expect(yield* shared.servedVersions).toEqual([]);
    }),
  ),
);

it.effect("one stamp leaves every machine with one value, whatever each held before", () =>
  Effect.gen(function* () {
    const style = {
      mode: "custom" as const,
      customInstructions: "Use plain words.",
      followChangeRequestTemplates: false,
    };
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const after = (overrides: Parameters<typeof Settings.layerTest>[0]) =>
      run(
        (shared, settings) =>
          Effect.gen(function* () {
            yield* shared.update(
              {},
              share(
                { sourceControlWritingStyle: style, scheduledTaskModelSelection: selection },
                EARLIER,
              ),
            );
            const current = yield* settings.getSettings;
            const versions = yield* served(shared);
            return {
              style: current.sourceControlWritingStyle,
              selection: current.scheduledTaskModelSelection,
              served: [
                versions.sourceControlWritingStyle?.value,
                versions.scheduledTaskModelSelection?.value,
              ],
            };
          }),
        overrides,
      );
    const first = yield* after({
      sourceControlWritingStyle: { mode: "custom", customInstructions: "Machine one's own." },
      scheduledTaskModelSelection: {
        ...selection,
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    const second = yield* after({
      sourceControlWritingStyle: { mode: "repo_conventions", followChangeRequestTemplates: true },
    });
    // Merged into what each held, the first would keep its options and the second its templates.
    expect(first).toEqual(second);
    expect(first.style).toEqual(style);
    expect(first.selection).toEqual(selection);
  }),
);

it.effect("does not record keys that belong to one machine", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.update(
        { worktreesDirectory: "/tmp" },
        share({ linkedEnvironmentsEnabled: true, guestSharingEnabled: true }, EARLIER),
      );
      expect(yield* shared.servedVersions).toEqual([]);
    }),
  ),
);

it.effect("a machine that does not follow shared settings refuses a write saved for all", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          shared.update({}, share({ finalReviewByDefault: true }, EARLIER)),
        );
        expect(error.operation).toBe("take-shared-setting-unfollowed");
        expect(yield* finalReview(settings)).toBe(false);
        // Chosen by name, it is this machine's own change.
        yield* shared.update({ finalReviewByDefault: true }, undefined);
        expect(yield* finalReview(settings)).toBe(true);
      }),
    { followSharedSettings: false },
  ),
);

it.effect("a machine that does not follow shared settings takes nothing from a peer", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [version("finalReviewByDefault", true, LATER)]);
        expect(yield* finalReview(settings)).toBe(false);
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { followSharedSettings: false },
  ),
);

it.effect("takes nothing when following is turned off while a pull waits for the lock", () =>
  run(
    (shared, settings, instances) =>
      Effect.gen(function* () {
        const selection = { instanceId: "cursor-work", model: "gpt-x" };
        yield* shared.applyPulled(PEER, [
          version("finalReviewByDefault", true, LATER),
          version("scheduledTaskModelSelection", selection, LATER),
          version("defaultRuntimeMode", "full-access", AN_HOUR_AHEAD),
        ]);
        yield* Ref.set(instances, ["codex", "cursor-work"]);
        yield* TestClock.adjust("1 hour");
        yield* shared.retryWaiting;
        const current = yield* settings.getSettings;
        expect([
          current.finalReviewByDefault,
          current.scheduledTaskModelSelection,
          current.defaultRuntimeMode,
        ]).toEqual([
          DEFAULT_SERVER_SETTINGS.finalReviewByDefault,
          DEFAULT_SERVER_SETTINGS.scheduledTaskModelSelection,
          DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
        ]);
        // Nothing was kept to pass on either.
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { followSharedSettings: false },
    followingTurnedOff,
  ),
);

it.effect("takes a peer's newer version and serves it on", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({}, share({ finalReviewByDefault: true }, EARLIER));
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, LATER)]);
      expect(yield* finalReview(settings)).toBe(false);
      expect((yield* served(shared)).finalReviewByDefault).toEqual(
        version("finalReviewByDefault", false, LATER, PEER),
      );
    }),
  ),
);

it.effect("takes every shared setting from a machine that has never had any", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [
        version("finalReviewByDefault", true, EARLIER),
        version("defaultRuntimeMode", "full-access", EARLIER),
      ]);
      const current = yield* settings.getSettings;
      expect([current.finalReviewByDefault, current.defaultRuntimeMode]).toEqual([
        true,
        "full-access",
      ]);
    }),
  ),
);

it.effect("ignores a peer's older version", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({}, share({ finalReviewByDefault: true }, LATER));
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, EARLIER)]);
      expect(yield* finalReview(settings)).toBe(true);
      expect((yield* served(shared)).finalReviewByDefault?.updatedAt).toBe(LATER);
    }),
  ),
);

it.effect("a change saved here alone outranks an older shared version it has not seen", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, undefined);
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, LATER)]);
      expect(yield* finalReview(settings)).toBe(true);
      // A version made after the change still applies.
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, SOON)]);
      expect(yield* finalReview(settings)).toBe(false);
    }),
  ),
);

it.effect("a write saved for all machines keeps a newer version's value, and its version", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", true, LATER)]);
      // A delayed write stamped before the version this machine already took.
      yield* shared.update(
        {},
        share({ finalReviewByDefault: false, defaultRuntimeMode: "full-access" }, EARLIER, OTHER),
      );
      const current = yield* settings.getSettings;
      expect([current.finalReviewByDefault, current.defaultRuntimeMode]).toEqual([
        true,
        "full-access",
      ]);
      const versions = yield* served(shared);
      expect(versions.finalReviewByDefault).toEqual(
        version("finalReviewByDefault", true, LATER, PEER),
      );
      expect(versions.defaultRuntimeMode).toEqual(
        version("defaultRuntimeMode", "full-access", EARLIER, OTHER),
      );
    }),
  ),
);

it.effect("a write saved for all machines does not undo a newer change saved here alone", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, undefined);
      yield* shared.update({}, share({ finalReviewByDefault: false }, LATER, OTHER));
      expect(yield* finalReview(settings)).toBe(true);
      // Still passed on, so machines behind this one get it.
      expect((yield* served(shared)).finalReviewByDefault).toEqual(
        version("finalReviewByDefault", false, LATER, OTHER),
      );
    }),
  ),
);

it.effect("breaks a tie on the same time by the larger origin", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({}, share({ finalReviewByDefault: true }, EARLIER, PEER));
      // The smaller origin loses, the larger one wins, and the same version again changes nothing.
      yield* shared.applyPulled(HERE, [version("finalReviewByDefault", false, EARLIER, HERE)]);
      expect(yield* finalReview(settings)).toBe(true);
      yield* shared.applyPulled(OTHER, [version("finalReviewByDefault", false, EARLIER, OTHER)]);
      expect(yield* finalReview(settings)).toBe(false);
      expect((yield* served(shared)).finalReviewByDefault?.origin).toBe(OTHER);
    }),
  ),
);

it.effect("a change saved here is not undone by a version that arrives with the same stamp", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({}, share({ finalReviewByDefault: true }, EARLIER));
      yield* shared.applyPulled(HERE, [version("finalReviewByDefault", false, EARLIER, HERE)]);
      expect(yield* finalReview(settings)).toBe(true);
    }),
  ),
);

it.effect("refuses settings this build keeps to one machine, and never passes them on", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [
        version("linkedEnvironmentsEnabled", true, LATER),
        version("guestSharingEnabled", true, LATER),
        version("followSharedSettings", false, LATER),
        version("providerInstances", {}, LATER),
        version("defaultProjectScripts", [], LATER),
      ]);
      const current = yield* settings.getSettings;
      expect([
        current.linkedEnvironmentsEnabled,
        current.guestSharingEnabled,
        current.followSharedSettings,
      ]).toEqual([false, false, true]);
      expect(yield* shared.servedVersions).toEqual([]);
    }),
  ),
);

it.effect("passes on a version this build cannot read without applying it, saying so once", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      const unknownKey = version("fromANewerBuild", { on: true }, LATER);
      const newValue = version("defaultRuntimeMode", "a-newer-mode", LATER);
      const misfit = version("finalReviewByDefault", "yes", LATER);
      const { warnings } = yield* withWarnings(
        Effect.gen(function* () {
          yield* shared.applyPulled(PEER, [unknownKey, newValue, misfit]);
          yield* shared.applyPulled(OTHER, [unknownKey, newValue, misfit]);
          yield* shared.retryWaiting;
        }),
      );
      const before = yield* settings.getSettings;
      expect([before.defaultRuntimeMode, before.finalReviewByDefault]).toEqual([
        DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
        false,
      ]);
      const versions = yield* served(shared);
      expect([
        versions.fromANewerBuild,
        versions.defaultRuntimeMode,
        versions.finalReviewByDefault,
      ]).toEqual([unknownKey, newValue, misfit]);
      expect(warnings.filter((warning) => warning.includes("cannot read"))).toHaveLength(3);

      // A newer version this build reads replaces it, and a stamped write keeps the rest it can.
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", true, SOON)]);
      expect(yield* finalReview(settings)).toBe(true);
      yield* TestClock.adjust("2 minutes");
      yield* shared.update(
        {},
        share({ defaultRuntimeMode: "even-newer", snoozeLimitedThreads: false }, SOON, OTHER),
      );
      expect((yield* settings.getSettings).snoozeLimitedThreads).toBe(false);
      expect((yield* served(shared)).defaultRuntimeMode?.value).toBe("even-newer");
    }),
  ),
);

it.effect("keeps only so many settings this build does not know", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(
        PEER,
        Array.from({ length: 70 }, (_, index) =>
          version(`newer${String(index).padStart(2, "0")}`, index, LATER),
        ),
      );
      const unknown = (yield* shared.servedVersions).filter(({ key }) => key.startsWith("newer"));
      expect(unknown).toHaveLength(64);
      // One already kept still takes newer versions.
      yield* shared.applyPulled(PEER, [version("newer00", "again", SOON)]);
      expect((yield* served(shared)).newer00?.value).toBe("again");
      // An account this build cannot read, or whose driver it does not share, takes room too.
      const account = { driver: "codex", enabled: true, config: { customModels: ["g"] } };
      yield* shared.applyPulled(PEER, [
        version("providerInstance:codex_new", { driver: 7 }, LATER),
        version("providerInstance:newerAgent_a", { driver: "newerAgent", enabled: true }, LATER),
        version("providerInstance:codex_team", account, LATER),
      ]);
      const versions = yield* served(shared);
      expect([
        versions["providerInstance:codex_new"],
        versions["providerInstance:newerAgent_a"],
        versions["providerInstance:codex_team"]?.value,
      ]).toEqual([undefined, undefined, account]);
    }),
  ),
);

it.effect("leaves out values too large to share, when pulled and when served, saying so once", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      const tooLarge = "x".repeat(SHARED_SETTING_VALUE_MAX_BYTES);
      const { warnings } = yield* withWarnings(
        Effect.gen(function* () {
          const pulled = [
            version("threadTitleInstructions", tooLarge, LATER),
            version(WORK_KEY, { ...WORK_SHARED, displayName: tooLarge }, LATER),
          ];
          yield* shared.applyPulled(PEER, pulled);
          yield* shared.applyPulled(PEER, pulled);
          // One stored before the limit is not served either.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO shared_setting_versions
              (setting_key, kind, value_json, updated_at, origin, pending)
            VALUES ('reviewGuideInstructions', 'shared', ${JSON.stringify(tooLarge)}, ${LATER}, ${PEER}, 0)
          `;
          yield* shared.servedVersions;
          yield* shared.servedVersions;
        }),
      );
      const current = yield* settings.getSettings;
      expect(current.threadTitleInstructions).not.toBe(tooLarge);
      expect(Object.hasOwn(current.providerInstances, WORK)).toBe(false);
      expect(yield* shared.servedVersions).toEqual([]);
      expect(warnings.filter((warning) => warning.includes("too large"))).toHaveLength(3);

      // Each fits, but together they are more than one answer may carry.
      const large = "y".repeat(SHARED_SETTING_VALUE_MAX_BYTES - 100);
      yield* shared.applyPulled(
        PEER,
        Array.from({ length: 40 }, (_, index) => version(`large${index}`, large, LATER)),
      );
      const kept = yield* shared.servedVersions;
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(40);
      expect(JSON.stringify(kept).length).toBeLessThanOrEqual(SHARED_SETTINGS_RESPONSE_MAX_BYTES);
    }),
  ),
);

it.effect("refuses a write saved for all machines on a device whose clock runs ahead", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        shared.update({}, share({ finalReviewByDefault: true }, AN_HOUR_AHEAD, PEER)),
      );
      expect(error.operation).toBe("take-shared-setting-clock-ahead");
      expect(yield* finalReview(settings)).toBe(false);
      // Within five minutes, it is an ordinary difference between clocks.
      yield* shared.update({}, share({ finalReviewByDefault: true }, SOON, PEER));
      expect(yield* finalReview(settings)).toBe(true);
    }),
  ),
);

it.effect("a client's own stamp may run only 30 seconds ahead, a server's five minutes", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      // Clients from before `server.shareSettings` stamp by their own clock, values in the patch.
      const error = yield* Effect.flip(
        shared.update({ finalReviewByDefault: true }, { updatedAt: SOON, origin: PEER }),
      );
      expect(error.operation).toBe("take-shared-setting-clock-ahead");
      expect(yield* finalReview(settings)).toBe(false);

      const close = "2026-11-11T14:00:20.000Z";
      yield* shared.update({ finalReviewByDefault: true }, { updatedAt: close, origin: PEER });
      expect(yield* finalReview(settings)).toBe(true);
      expect((yield* served(shared)).finalReviewByDefault).toEqual(
        version("finalReviewByDefault", true, close, PEER),
      );
      // A server's stamp, a minute ahead, is an ordinary difference between machines' clocks.
      yield* shared.update({}, share({ finalReviewByDefault: false }, SOON, PEER));
      expect(yield* finalReview(settings)).toBe(false);
    }),
  ),
);

it.effect("a version from a fast clock waits for its time and does not keep undoing saves", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      const ahead = version("finalReviewByDefault", true, AN_HOUR_AHEAD);
      yield* shared.applyPulled(PEER, [ahead]);
      expect(yield* finalReview(settings)).toBe(false);
      // It is not passed on while it waits.
      expect((yield* served(shared)).finalReviewByDefault).toBeUndefined();

      yield* TestClock.adjust("1 minute");
      yield* shared.update({ finalReviewByDefault: false }, undefined);
      yield* TestClock.adjust("1 minute");
      yield* shared.applyPulled(PEER, [ahead]);
      yield* shared.retryWaiting;
      expect(yield* finalReview(settings)).toBe(false);

      // Within five minutes of its stamp it applies, once, and keeps the stamp it was made with.
      yield* TestClock.adjust("54 minutes");
      yield* shared.retryWaiting;
      expect(yield* finalReview(settings)).toBe(true);
      expect((yield* served(shared)).finalReviewByDefault).toEqual(ahead);

      yield* TestClock.adjust("5 minutes");
      yield* shared.update({ finalReviewByDefault: false }, undefined);
      yield* shared.applyPulled(PEER, [ahead]);
      yield* shared.retryWaiting;
      expect(yield* finalReview(settings)).toBe(false);
    }),
  ),
);

it.effect(
  "keeps a model selection for an instance this machine lacks until the instance exists",
  () =>
    run((shared, settings, instances) =>
      Effect.gen(function* () {
        const selection = { instanceId: "cursor-work", model: "gpt-x" };
        yield* shared.applyPulled(PEER, [version("scheduledTaskModelSelection", selection, LATER)]);
        expect((yield* settings.getSettings).scheduledTaskModelSelection).toBeNull();
        // The version is known and passed on, so machines that have the instance can still take it.
        expect((yield* served(shared)).scheduledTaskModelSelection?.value).toEqual(selection);

        yield* shared.retryWaiting;
        expect((yield* settings.getSettings).scheduledTaskModelSelection).toBeNull();

        yield* Ref.set(instances, ["codex", "cursor-work"]);
        yield* shared.retryWaiting;
        expect((yield* settings.getSettings).scheduledTaskModelSelection).toMatchObject(selection);
      }),
    ),
);

it.effect("a change made on this machine cancels a model selection that was waiting", () =>
  run((shared, settings, instances) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [
        version(
          "scheduledTaskModelSelection",
          { instanceId: "cursor-work", model: "gpt-x" },
          LATER,
        ),
      ]);
      yield* shared.update(
        { scheduledTaskModelSelection: { instanceId: "codex" as never, model: "gpt-5.4" } },
        undefined,
      );
      yield* Ref.set(instances, ["codex", "cursor-work"]);
      yield* shared.retryWaiting;
      expect((yield* settings.getSettings).scheduledTaskModelSelection?.instanceId).toBe("codex");
    }),
  ),
);

it.effect("applies a model selection that names an instance this machine has", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [
        version("scheduledTaskModelSelection", { instanceId: "codex", model: "gpt-5.4" }, LATER),
      ]);
      expect((yield* settings.getSettings).scheduledTaskModelSelection).toMatchObject({
        instanceId: "codex",
        model: "gpt-5.4",
      });
    }),
  ),
);

it.effect("every shared key saves and is taken back as a version", () =>
  Effect.gen(function* () {
    // Older stored settings carry the idle compaction mode only in a legacy field.
    const everyDefault = {
      ...Object.fromEntries(
        MACHINE_SHARED_SETTING_KEYS.map((key) => [key, DEFAULT_SERVER_SETTINGS[key]]),
      ),
      idleCompaction: globalIdleCompaction(DEFAULT_SERVER_SETTINGS),
    } as ServerSettingsPatch;
    const versions = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.updateForAllMachines(everyDefault);
        return yield* shared.servedVersions;
      }),
    );
    expect(versions.map((entry) => entry.key).toSorted()).toEqual(
      [...MACHINE_SHARED_SETTING_KEYS].toSorted(),
    );
    const taken = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, versions);
        return yield* shared.servedVersions;
      }),
    );
    expect(taken.map((entry) => entry.key).toSorted()).toEqual(
      [...MACHINE_SHARED_SETTING_KEYS].toSorted(),
    );
  }),
);

it.effect("passes on a version it does not apply because a change made here alone is newer", () =>
  run((shared, settings, instances) =>
    Effect.gen(function* () {
      // B changed the setting on its own after A saved a version for all machines.
      yield* shared.update({ finalReviewByDefault: true }, undefined);
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, LATER)]);
      expect(yield* finalReview(settings)).toBe(true);
      // C, which only B reaches, still gets A's version from B.
      expect((yield* served(shared)).finalReviewByDefault).toEqual(
        version("finalReviewByDefault", false, LATER, PEER),
      );
      // An older version is not passed on in its place.
      yield* shared.applyPulled(OTHER, [version("finalReviewByDefault", true, EARLIER, OTHER)]);
      expect((yield* served(shared)).finalReviewByDefault?.updatedAt).toBe(LATER);

      // A version kept only to pass on never applies here later, even once it could.
      const selection = { instanceId: "cursor-work", model: "gpt-x" };
      yield* shared.update(
        { scheduledTaskModelSelection: { instanceId: "codex" as never, model: "gpt-5.4" } },
        undefined,
      );
      yield* shared.applyPulled(PEER, [version("scheduledTaskModelSelection", selection, LATER)]);
      yield* Ref.set(instances, ["codex", "cursor-work"]);
      yield* shared.retryWaiting;
      const current = yield* settings.getSettings;
      expect([
        current.finalReviewByDefault,
        current.scheduledTaskModelSelection?.instanceId,
      ]).toEqual([true, "codex"]);
      expect((yield* served(shared)).scheduledTaskModelSelection?.value).toEqual(selection);
    }),
  ),
);

it.effect(
  "passes on a version for a setting an administrator locks here, without applying it",
  () =>
    run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(PEER, [version("finalReviewByDefault", true, LATER)]);
          expect(yield* finalReview(settings)).toBe(false);
          expect((yield* served(shared)).finalReviewByDefault?.value).toBe(true);
        }),
      {},
      undefined,
      { organization: "Example Corp", lockedSettings: ["finalReviewByDefault"] },
    ),
);

it.effect("passes on the JSON a version came as, with parts this build does not know", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      const pulled = {
        mode: "custom",
        customInstructions: "Use plain words.",
        followChangeRequestTemplates: false,
        fromANewerBuild: { kept: true },
      };
      yield* shared.applyPulled(PEER, [version("sourceControlWritingStyle", pulled, LATER)]);
      // Applied as this build reads it, and passed on as it came.
      expect((yield* settings.getSettings).sourceControlWritingStyle).toMatchObject({
        customInstructions: "Use plain words.",
      });
      expect((yield* served(shared)).sourceControlWritingStyle?.value).toEqual(pulled);

      const sent = { mode: "repo_conventions", fromANewerClient: 1 };
      yield* shared.update({}, share({ sourceControlWritingStyle: sent }, SOON, OTHER));
      expect((yield* served(shared)).sourceControlWritingStyle?.value).toEqual(sent);
    }),
  ),
);

it.effect(
  "the device settings profile is one whole value, passed on as sent and replaced whole",
  () =>
    run((shared, settings) =>
      Effect.gen(function* () {
        const pulled = { chatWidth: "wide", fontSizeCode: 14, fromANewerClient: { kept: true } };
        yield* shared.applyPulled(PEER, [version("deviceSettingsProfile", pulled, LATER)]);
        expect((yield* settings.getSettings).deviceSettingsProfile).toEqual(pulled);
        expect((yield* served(shared)).deviceSettingsProfile?.value).toEqual(pulled);

        // A newer change saved here carries the whole next profile: keys it leaves out are gone.
        const next = { chatWidth: "full" };
        const saved = yield* shared.updateForAllMachines({ deviceSettingsProfile: next });
        expect(saved.settings.deviceSettingsProfile).toEqual(next);
        expect(saved.share.values).toEqual([{ key: "deviceSettingsProfile", value: next }]);
        expect((yield* served(shared)).deviceSettingsProfile?.value).toEqual(next);

        // An older version from a peer changes nothing.
        yield* shared.applyPulled(PEER, [version("deviceSettingsProfile", pulled, EARLIER)]);
        expect((yield* settings.getSettings).deviceSettingsProfile).toEqual(next);
      }),
    ),
);

it.effect("keeps a model selection a direct write names until this machine has its instance", () =>
  run((shared, settings, instances) =>
    Effect.gen(function* () {
      const selection = { instanceId: "cursor-work", model: "gpt-x" };
      yield* shared.update(
        {},
        share({ scheduledTaskModelSelection: selection, finalReviewByDefault: true }, LATER, OTHER),
      );
      const current = yield* settings.getSettings;
      expect([current.scheduledTaskModelSelection, current.finalReviewByDefault]).toEqual([
        null,
        true,
      ]);
      expect((yield* served(shared)).scheduledTaskModelSelection?.value).toEqual(selection);

      yield* Ref.set(instances, ["codex", "cursor-work"]);
      yield* shared.retryWaiting;
      expect((yield* settings.getSettings).scheduledTaskModelSelection).toMatchObject(selection);
    }),
  ),
);

it.effect("keeps a model selection whose instance runs another driver here, or is off here", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [
          version(
            "scheduledTaskModelSelection",
            { instanceId: "work", model: "m" },
            LATER,
            PEER,
            "claudeAgent",
          ),
          version(
            "reviewGuideModelSelection",
            { instanceId: "personal", model: "m" },
            LATER,
            PEER,
            "codex",
          ),
          version(
            "sourceControlWriterModelSelection",
            { instanceId: "work", model: "gpt-5.4" },
            LATER,
            PEER,
            "codex",
          ),
        ]);
        const current = yield* settings.getSettings;
        expect([
          current.scheduledTaskModelSelection,
          current.reviewGuideModelSelection,
          current.sourceControlWriterModelSelection,
        ]).toEqual([
          DEFAULT_SERVER_SETTINGS.scheduledTaskModelSelection,
          DEFAULT_SERVER_SETTINGS.reviewGuideModelSelection,
          { instanceId: "work", model: "gpt-5.4" },
        ]);
        const versions = yield* served(shared);
        expect([
          versions.scheduledTaskModelSelection?.instanceDriver,
          versions.reviewGuideModelSelection?.instanceDriver,
        ]).toEqual(["claudeAgent", "codex"]);

        // Turned on here, the selection for it applies; the one for another driver still waits.
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId: ProviderInstanceId.make("personal"),
          instance: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        });
        yield* shared.retryWaiting;
        const after = yield* settings.getSettings;
        expect(after.reviewGuideModelSelection).toMatchObject({ instanceId: "personal" });
        expect(after.scheduledTaskModelSelection).toEqual(
          DEFAULT_SERVER_SETTINGS.scheduledTaskModelSelection,
        );
      }),
    {
      providerInstances: {
        [ProviderInstanceId.make("work")]: { driver: ProviderDriverKind.make("codex"), config: {} },
        [ProviderInstanceId.make("personal")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
    },
  ),
);

it.effect("stamps a change saved for all machines here by this server's clock", () =>
  Effect.gen(function* () {
    const saved = yield* run((shared) =>
      Effect.gen(function* () {
        // A version taken earlier that is newer than the change keeps its value and stays out.
        yield* shared.applyPulled(PEER, [version("defaultRuntimeMode", "full-access", SOON)]);
        const result = yield* shared.updateForAllMachines({
          finalReviewByDefault: true,
          defaultRuntimeMode: "approval-required",
          scheduledTaskModelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
        });
        expect(result.settings.defaultRuntimeMode).toBe("full-access");
        expect((yield* served(shared)).finalReviewByDefault).toEqual(
          version("finalReviewByDefault", true, NOW, HERE),
        );
        return result.share;
      }),
    );
    expect(saved.stamp).toEqual({ updatedAt: NOW, origin: HERE });
    expect(saved.values).toEqual([
      {
        key: "scheduledTaskModelSelection",
        value: { instanceId: "codex", model: "gpt-5.4" },
        instanceDriver: "codex",
      },
      { key: "finalReviewByDefault", value: true },
    ]);

    // Another follower takes it with that stamp.
    const elsewhere = yield* run((shared, settings) =>
      Effect.gen(function* () {
        yield* shared.update({}, saved);
        return {
          finalReview: (yield* settings.getSettings).finalReviewByDefault,
          served: (yield* served(shared)).finalReviewByDefault,
        };
      }),
    );
    expect(elsewhere).toEqual({
      finalReview: true,
      served: version("finalReviewByDefault", true, NOW, HERE),
    });
  }),
);

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const WORK = ProviderInstanceId.make("claudeAgent_work");
const WORK_KEY = "providerInstance:claudeAgent_work";

/** An account as one machine holds it, with its own home, binary, token and environment. */
const workAccount = (machineName: string) => ({
  driver: CLAUDE,
  displayName: "Claude - Work",
  accentColor: "violet",
  environment: [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", value: `token-${machineName}`, sensitive: true },
  ],
  config: {
    homePath: `/Users/${machineName}/.claude-work`,
    binaryPath: `/Users/${machineName}/bin/claude`,
    launchArgs: "--chrome",
    oauthToken: {
      issuedAt: EARLIER,
      expiresAt: "2027-11-11T11:00:00.000Z",
      fingerprint: machineName,
    },
    customModels: ["claude-opus-5-5"],
    autoCompactWindow: "300000",
  },
});

/** What every machine that follows holds of the work account. */
const WORK_REMOVED = { removed: true, driver: "claudeAgent" };

const WORK_SHARED = {
  driver: "claudeAgent",
  displayName: "Claude - Work",
  accentColor: "violet",
  enabled: true,
  config: { customModels: ["claude-opus-5-5"], autoCompactWindow: "300000" },
};

/** The work account as it arrives on a machine that never had it. */
const workArrived = (origin: EnvironmentId) => ({
  driver: CLAUDE,
  displayName: "Claude - Work",
  accentColor: "violet",
  enabled: true,
  config: { customModels: ["claude-opus-5-5"], autoCompactWindow: "300000" },
  sharedFrom: origin,
});

const instanceOf = (
  settings: Settings.ServerSettingsService["Service"],
  instanceId: ProviderInstanceId,
) => settings.getSettings.pipe(Effect.map((current) => current.providerInstances[instanceId]));

it.effect("an account added on one machine reaches another with its own home and no login", () =>
  Effect.gen(function* () {
    const versions = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.updateProviderInstance(
          { operation: "create", instanceId: WORK, instance: workAccount("a") },
          {},
          undefined,
        );
        return yield* shared.servedVersions;
      }),
    );
    // Its home, binary, launch arguments, token and environment stay where it was added.
    expect(versions).toEqual([version(WORK_KEY, WORK_SHARED, NOW, HERE)]);
    const arrived = yield* run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(HERE, versions);
          return {
            instance: yield* instanceOf(settings, WORK),
            served: (yield* served(shared))[WORK_KEY],
          };
        }),
      {},
      undefined,
      undefined,
      PEER,
    );
    expect(arrived).toEqual({
      instance: workArrived(HERE),
      served: version(WORK_KEY, WORK_SHARED, NOW, HERE),
    });
  }),
);

it.effect("an account's shared fields follow the group while its paths stay here", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const local = workAccount("b");
        const moved = { ...local, config: { ...local.config, homePath: "/Volumes/b/claude" } };
        // A new home path belongs to this machine alone.
        yield* shared.updateProviderInstance(
          { operation: "upsert", instanceId: WORK, instance: moved },
          {},
          undefined,
        );
        expect(yield* shared.servedVersions).toEqual([]);
        // A new name belongs to the group.
        yield* shared.updateProviderInstance(
          {
            operation: "upsert",
            instanceId: WORK,
            instance: { ...moved, displayName: "Claude - Office" },
          },
          {},
          undefined,
        );
        expect((yield* served(shared))[WORK_KEY]).toEqual(
          version(WORK_KEY, { ...WORK_SHARED, displayName: "Claude - Office" }, NOW, HERE),
        );
        // A newer version replaces everything shared, and nothing else.
        yield* shared.applyPulled(PEER, [
          version(
            WORK_KEY,
            {
              driver: "claudeAgent",
              displayName: "Claude - Team",
              enabled: false,
              config: { customModels: ["claude-fable-5-2"] },
            },
            SOON,
          ),
        ]);
        expect(yield* instanceOf(settings, WORK)).toEqual({
          driver: CLAUDE,
          displayName: "Claude - Team",
          environment: local.environment,
          enabled: false,
          config: {
            homePath: "/Volumes/b/claude",
            binaryPath: local.config.binaryPath,
            launchArgs: "--chrome",
            oauthToken: local.config.oauthToken,
            customModels: ["claude-fable-5-2"],
          },
        });
      }),
    { providerInstances: { [WORK]: workAccount("b") } },
  ),
);

it.effect("a built-in provider shares only its name and whether it is on", () =>
  Effect.gen(function* () {
    const codex = ProviderInstanceId.make("codex");
    const cursor = ProviderInstanceId.make("cursor");
    const versions = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.updateProviderInstance(
          {
            operation: "upsert",
            instanceId: codex,
            instance: {
              driver: CODEX,
              displayName: "Codex - Home",
              accentColor: "green",
              enabled: false,
              config: { binaryPath: "/opt/codex", customModels: ["gpt-x"] },
            },
          },
          {},
          undefined,
        );
        return yield* shared.servedVersions;
      }),
    );
    expect(versions).toEqual([
      version(
        "providerInstance:codex",
        { driver: "codex", displayName: "Codex - Home", enabled: false },
        NOW,
        HERE,
      ),
    ]);
    const elsewhere = yield* run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(HERE, [
            ...versions,
            // Cursor as it is with no settings of its own adds none here.
            version("providerInstance:cursor", { driver: "cursor", enabled: false }, NOW, HERE),
          ]);
          const current = yield* settings.getSettings;
          return [
            current.providerInstances[codex],
            Object.hasOwn(current.providerInstances, cursor),
          ];
        }),
      {
        providerInstances: {
          [codex]: {
            driver: CODEX,
            accentColor: "blue",
            config: { homePath: "~/.codex-b", customModels: ["gpt-y"] },
          },
        },
      },
      undefined,
      undefined,
      PEER,
    );
    expect(elsewhere).toEqual([
      {
        driver: CODEX,
        displayName: "Codex - Home",
        accentColor: "blue",
        enabled: false,
        config: { homePath: "~/.codex-b", customModels: ["gpt-y"] },
      },
      false,
    ]);
  }),
);

const CLAUDE_BUILT_IN = ProviderInstanceId.make("claudeAgent");

it.effect(
  "an agent sets the fields an account shares as its form would, and the group takes them",
  () =>
    Effect.gen(function* () {
      const local = workAccount("a");
      const { versions, accounts } = yield* run(
        (shared, settings) =>
          Effect.gen(function* () {
            yield* shared.updateAccountConfigs({
              [WORK]: { autoCompactWindow: " 400000 ", idleCompaction: "off" },
              [CLAUDE_BUILT_IN]: { autoCompactWindow: "250000" },
            });
            const current = yield* settings.getSettings;
            // Its paths, binary, launch arguments, token and environment stay as they were.
            expect(current.providerInstances[WORK]).toEqual({
              ...local,
              config: { ...local.config, autoCompactWindow: "400000", idleCompaction: "off" },
            });
            // A built-in account gets settings of its own here, which it never shares.
            expect(current.providerInstances[CLAUDE_BUILT_IN]).toEqual({
              driver: CLAUDE,
              config: { autoCompactWindow: "250000" },
            });
            return {
              versions: yield* shared.servedVersions,
              accounts: yield* shared.accountConfigs(current),
            };
          }),
        { providerInstances: { [WORK]: local } },
      );
      expect(versions.map(({ key }) => key)).toEqual([WORK_KEY]);
      expect(accounts).toEqual({
        [WORK]: {
          driver: CLAUDE,
          displayName: "Claude - Work",
          sharedWithMachines: true,
          config: {
            customModels: ["claude-opus-5-5"],
            autoCompactWindow: "400000",
            idleCompaction: "off",
          },
        },
        [CLAUDE_BUILT_IN]: {
          driver: CLAUDE,
          sharedWithMachines: false,
          config: { customModels: [], autoCompactWindow: "250000", idleCompaction: "default" },
        },
        codex: { driver: CODEX, sharedWithMachines: false, config: { customModels: [] } },
        cursor: { driver: "cursor", sharedWithMachines: false, config: { customModels: [] } },
        antigravity: {
          driver: "antigravity",
          sharedWithMachines: false,
          config: { customModels: [] },
        },
      });
      const elsewhere = yield* run(
        (shared, settings) =>
          Effect.gen(function* () {
            yield* shared.applyPulled(HERE, versions);
            const arrived = yield* instanceOf(settings, WORK);
            // Back to Claude's default, which the form leaves out rather than storing empty.
            yield* shared.updateAccountConfigs({ [WORK]: { autoCompactWindow: "" } });
            return { arrived, reset: yield* instanceOf(settings, WORK) };
          }),
        { providerInstances: { [WORK]: workAccount("b") } },
        undefined,
        undefined,
        PEER,
      );
      expect(elsewhere.arrived?.config).toEqual({
        ...workAccount("b").config,
        autoCompactWindow: "400000",
        idleCompaction: "off",
      });
      expect(elsewhere.reset?.config).not.toHaveProperty("autoCompactWindow");
    }),
);

it.effect.each([
  {
    name: "an account this machine does not have",
    changes: { claudeAgent_missing: { autoCompactWindow: "300000" } },
    says: "No account claudeAgent_missing",
  },
  { name: "a home path", changes: { [WORK]: { homePath: "/tmp/elsewhere" } }, says: "homePath" },
  {
    name: "launch arguments and a credential",
    changes: { [WORK]: { launchArgs: "--chrome", oauthToken: { fingerprint: "x" } } },
    says: "cannot set launchArgs, oauthToken",
  },
  {
    name: "a window below the least",
    changes: { [WORK]: { autoCompactWindow: "99999" } },
    says: 'autoCompactWindow "99999" is invalid',
  },
  {
    name: "a window given as a number",
    changes: { [WORK]: { autoCompactWindow: 400000 } },
    says: "autoCompactWindow 400000 is invalid",
  },
  {
    name: "an idle mode Claude does not have",
    changes: { [WORK]: { idleCompaction: "sometimes" } },
    says: 'idleCompaction "sometimes" is invalid',
  },
  {
    name: "a good account beside an unknown one",
    changes: { [WORK]: { autoCompactWindow: "500000" }, opencode: { customModels: [] } },
    says: "No account opencode",
  },
])("an agent cannot set $name, and nothing is saved", ({ changes, says }) =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const before = yield* settings.getSettings;
        const error = yield* shared
          .updateAccountConfigs(changes as Record<ProviderInstanceId, Record<string, unknown>>)
          .pipe(Effect.flip);
        expect(error._tag).toBe("AccountConfigError");
        expect(error.message).toContain(says);
        expect(yield* settings.getSettings).toEqual(before);
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { providerInstances: { [WORK]: workAccount("a") } },
  ),
);

it.effect("a change for all machines shares each account it names, even one already set here", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const asked = { [WORK]: { autoCompactWindow: "300000" } };
        // The value is already this one here, so a change for this machine has nothing to share.
        yield* shared.updateAccountConfigs(asked, { patch: { finalReviewByDefault: true } });
        expect(yield* shared.servedVersions).toEqual([]);
        expect(yield* finalReview(settings)).toBe(true);
        // Settings saved with the accounts in the same write are shared as a change for all is.
        yield* TestClock.adjust("1 minute");
        yield* shared.updateAccountConfigs(asked, {
          patch: { finalReviewByDefault: false },
          forAllMachines: true,
        });
        expect(yield* served(shared)).toEqual({
          finalReviewByDefault: version("finalReviewByDefault", false, SOON, HERE),
          [WORK_KEY]: version(WORK_KEY, WORK_SHARED, SOON, HERE),
        });
      }),
    { providerInstances: { [WORK]: workAccount("a") } },
  ),
);

it.effect.each([
  {
    name: "on a machine that does not follow shared settings",
    changes: { [WORK]: { autoCompactWindow: "500000" } },
    follows: false,
    error: { _tag: "ServerSettingsError", operation: "take-shared-setting-unfollowed" },
  },
  {
    name: "for a built-in account",
    changes: { claudeAgent: { autoCompactWindow: "500000" } },
    follows: true,
    error: {
      _tag: "AccountConfigError",
      message: expect.stringContaining("is a built-in account"),
    },
  },
])(
  "a change for all machines is refused $name, and nothing is saved",
  ({ changes, follows, error }) =>
    run(
      (shared, settings) =>
        Effect.gen(function* () {
          const before = yield* settings.getSettings;
          const refused = yield* shared
            .updateAccountConfigs(changes as Record<ProviderInstanceId, Record<string, unknown>>, {
              forAllMachines: true,
            })
            .pipe(Effect.flip);
          expect(refused).toMatchObject(error);
          expect(yield* settings.getSettings).toEqual(before);
          expect(yield* shared.servedVersions).toEqual([]);
        }),
      { followSharedSettings: follows, providerInstances: { [WORK]: workAccount("a") } },
    ),
);

/** Settings whose reads outside the write lock still list an account removed a moment before. */
const removedBeforeTheLock =
  (instanceId: ProviderInstanceId) =>
  (real: SettingsService): SettingsService => ({
    ...real,
    getSettings: real.getSettings.pipe(
      Effect.map((current) => ({
        ...current,
        providerInstances: { ...current.providerInstances, [instanceId]: workAccount("c") },
      })),
    ),
  });

it.effect("a batch saves nothing when an account it names is removed before the write", () => {
  const home = ProviderInstanceId.make("claudeAgent_home");
  return run(
    (shared, settings) =>
      Effect.gen(function* () {
        const refused = yield* shared
          .updateAccountConfigs({
            [WORK]: { autoCompactWindow: "500000" },
            [home]: { autoCompactWindow: "500000" },
          })
          .pipe(Effect.flip);
        expect(refused._tag).toBe("ServerSettingsError");
        expect(yield* instanceOf(settings, WORK)).toEqual(workAccount("a"));
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { providerInstances: { [WORK]: workAccount("a") } },
    removedBeforeTheLock(home),
  );
});

it.effect("a removed account leaves every machine that follows, and can be added back", () =>
  Effect.gen(function* () {
    const removal = yield* run(
      (shared) =>
        Effect.gen(function* () {
          yield* shared.updateProviderInstance(
            { operation: "remove", instanceId: WORK },
            {},
            undefined,
          );
          return yield* shared.servedVersions;
        }),
      { providerInstances: { [WORK]: workAccount("a") } },
    );
    expect(removal).toEqual([version(WORK_KEY, WORK_REMOVED, NOW, HERE)]);
    yield* run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(HERE, removal);
          expect(yield* instanceOf(settings, WORK)).toBeUndefined();
          expect((yield* served(shared))[WORK_KEY]).toEqual(removal[0]);
          // An older version of the account does not bring it back.
          yield* shared.applyPulled(OTHER, [version(WORK_KEY, WORK_SHARED, EARLIER, OTHER)]);
          expect(yield* instanceOf(settings, WORK)).toBeUndefined();
          // Added back, it again has no home of its own, so it uses the folder its login stayed in.
          yield* shared.applyPulled(OTHER, [version(WORK_KEY, WORK_SHARED, SOON, OTHER)]);
          expect(yield* instanceOf(settings, WORK)).toEqual(workArrived(OTHER));
        }),
      { providerInstances: { [WORK]: workArrived(HERE) } },
      undefined,
      undefined,
      PEER,
    );
  }),
);

it.effect("a removal takes only the account on its own driver under that id", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const mine = {
          driver: CODEX,
          displayName: "Codex - Work",
          config: { customModels: ["g"] },
        };
        const pulled = (value: unknown, updatedAt: string) =>
          shared.applyPulled(PEER, [version("providerInstance:work", value, updatedAt)]);
        // The other machine's `work` ran Claude; this one's runs Codex.
        yield* pulled(WORK_REMOVED, LATER);
        expect(yield* instanceOf(settings, ProviderInstanceId.make("work"))).toEqual(mine);
        expect((yield* served(shared))["providerInstance:work"]?.value).toEqual(WORK_REMOVED);
        // An older build's removal names no driver, so it is only passed on.
        yield* pulled({ removed: true }, SOON);
        expect(yield* instanceOf(settings, ProviderInstanceId.make("work"))).toEqual(mine);
        expect((yield* served(shared))["providerInstance:work"]?.value).toEqual({ removed: true });
        yield* pulled({ removed: true, driver: "codex" }, "2026-11-11T14:02:00.000Z");
        expect(yield* instanceOf(settings, ProviderInstanceId.make("work"))).toBeUndefined();
      }),
    {
      providerInstances: {
        [ProviderInstanceId.make("work")]: {
          driver: CODEX,
          displayName: "Codex - Work",
          config: { customModels: ["g"] },
        },
      },
    },
  ),
);

it.effect("a machine that does not follow shared settings neither takes nor shares accounts", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [
          version(WORK_KEY, WORK_SHARED, LATER),
          version("providerInstanceFailoverOrder", [WORK], LATER),
        ]);
        const current = yield* settings.getSettings;
        expect([
          Object.hasOwn(current.providerInstances, WORK),
          current.providerInstanceFailoverOrder,
        ]).toEqual([false, []]);
        // Its own accounts and their order are changes made here alone, even once it follows.
        yield* shared.updateProviderInstance(
          { operation: "create", instanceId: WORK, instance: workAccount("b") },
          {},
          undefined,
        );
        yield* shared.update({ providerInstanceFailoverOrder: [WORK] }, undefined);
        yield* shared.update({ followSharedSettings: true }, undefined);
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { followSharedSettings: false },
  ),
);

it.effect("a machine that follows shares the order of its accounts, unknown ones included", () =>
  Effect.gen(function* () {
    const home = ProviderInstanceId.make("claudeAgent_home");
    const order = [WORK, home];
    const versions = yield* run((shared) =>
      Effect.gen(function* () {
        // Saved on this machine alone, as the provider settings save it.
        yield* shared.update({ providerInstanceFailoverOrder: order }, undefined);
        return yield* shared.servedVersions;
      }),
    );
    expect(versions).toEqual([version("providerInstanceFailoverOrder", order, NOW, HERE)]);
    const elsewhere = yield* run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(HERE, versions);
          return {
            order: (yield* settings.getSettings).providerInstanceFailoverOrder,
            served: (yield* served(shared)).providerInstanceFailoverOrder?.value,
          };
        }),
      { providerInstances: { [home]: { driver: CLAUDE } } },
      undefined,
      undefined,
      PEER,
    );
    // Kept whole on a machine without the work account, which failover there skips.
    expect(elsewhere).toEqual({ order, served: order });
  }),
);

it.effect("takes only what an account shares from a version, whatever else it carries", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const before = yield* settings.getSettings;
        const sent = {
          ...WORK_SHARED,
          environment: [{ name: "ANTHROPIC_BASE_URL", value: "https://example.invalid" }],
          sharedFrom: OTHER,
          config: {
            ...WORK_SHARED.config,
            homePath: "/tmp/elsewhere",
            binaryPath: "/tmp/elsewhere/claude",
            launchArgs: "--dangerously-skip-permissions",
          },
        };
        yield* shared.applyPulled(PEER, [
          version(WORK_KEY, sent, LATER),
          // A built-in instance is never another driver's account, nor removed.
          version("providerInstance:codex", { driver: "claudeAgent", enabled: true }, LATER),
          version("providerInstance:claudeAgent", WORK_REMOVED, LATER),
          // An instance of a driver that is not shared is never removed by one that is.
          version("providerInstance:devReplay", WORK_REMOVED, LATER),
        ]);
        const current = yield* settings.getSettings;
        expect(current.providerInstances).toEqual({
          ...before.providerInstances,
          [WORK]: workArrived(PEER),
        });
        // Every machine takes only what it shares, so the version is passed on as it came.
        expect((yield* served(shared))[WORK_KEY]?.value).toEqual(sent);
      }),
    {
      providerInstances: {
        [ProviderInstanceId.make("codex")]: { driver: CODEX, config: { homePath: "~/.codex" } },
        [ProviderInstanceId.make("claudeAgent")]: { driver: CLAUDE, enabled: false },
        [ProviderInstanceId.make("devReplay")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { source: "local", commandPath: "/usr/bin/node" },
        },
      },
    },
  ),
);

it.effect(
  "passes on an account version from a newer build, and takes it once this build reads it",
  () =>
    run((shared, settings) =>
      Effect.gen(function* () {
        const before = yield* settings.getSettings;
        const unreadable = version("providerInstance:codex_new", { driver: 7 }, LATER);
        const newerDriver = version(
          "providerInstance:newerAgent_a",
          { driver: "newerAgent", enabled: true },
          LATER,
        );
        const { warnings } = yield* withWarnings(
          Effect.gen(function* () {
            yield* shared.applyPulled(PEER, [unreadable, newerDriver]);
            yield* shared.applyPulled(OTHER, [unreadable, newerDriver]);
            yield* shared.retryWaiting;
          }),
        );
        expect((yield* settings.getSettings).providerInstances).toEqual(before.providerInstances);
        const versions = yield* served(shared);
        expect([versions[unreadable.key], versions[newerDriver.key]]).toEqual([
          unreadable,
          newerDriver,
        ]);
        expect(warnings.filter((warning) => warning.includes("cannot read"))).toHaveLength(1);
        expect(warnings.filter((warning) => warning.includes("does not share"))).toHaveLength(1);
        // Both wait, so an update here that can take them applies them.
        const sql = yield* SqlClient.SqlClient;
        const waiting = yield* sql<{ readonly settingKey: string }>`
        SELECT setting_key AS "settingKey" FROM shared_setting_versions
        WHERE pending = 1 ORDER BY setting_key
      `;
        expect(waiting.map((row) => row.settingKey)).toEqual([unreadable.key, newerDriver.key]);

        // A build without account sharing kept the work account waiting; this one takes it.
        yield* sql`
        INSERT INTO shared_setting_versions
          (setting_key, kind, value_json, updated_at, origin, pending)
        VALUES (${WORK_KEY}, 'shared', ${JSON.stringify(WORK_SHARED)}, ${LATER}, ${PEER}, 1)
      `;
        yield* shared.retryWaiting;
        expect(yield* instanceOf(settings, WORK)).toEqual(workArrived(PEER));
        expect((yield* served(shared))[WORK_KEY]).toEqual(version(WORK_KEY, WORK_SHARED, LATER));
      }),
    ),
);

it.effect("passes on an account version that a change made here before following outranks", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        // Renamed here while this machine did not follow, after the group's version was made.
        const mine = { driver: CLAUDE, displayName: "Claude - Mine", enabled: true, config: {} };
        yield* shared.updateProviderInstance(
          { operation: "create", instanceId: WORK, instance: mine },
          {},
          undefined,
        );
        yield* shared.update({ followSharedSettings: true }, undefined);
        yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_SHARED, EARLIER)]);
        expect(yield* instanceOf(settings, WORK)).toEqual(mine);
        // A machine that only this one reaches still gets the group's version from it.
        expect((yield* served(shared))[WORK_KEY]).toEqual(
          version(WORK_KEY, WORK_SHARED, EARLIER, PEER),
        );
      }),
    { followSharedSettings: false },
  ),
);

it.effect("a change to an account here outranks a version from a clock a little ahead", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_SHARED, SOON)]);
      const arrived = yield* instanceOf(settings, WORK);
      yield* shared.updateProviderInstance(
        {
          operation: "upsert",
          instanceId: WORK,
          instance: { ...arrived!, displayName: "Claude - Office" },
        },
        {},
        undefined,
      );
      expect((yield* served(shared))[WORK_KEY]).toEqual(
        version(
          WORK_KEY,
          { ...WORK_SHARED, displayName: "Claude - Office" },
          "2026-11-11T14:01:00.001Z",
          HERE,
        ),
      );
      // Pulled again, the version it replaced does not undo it.
      yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_SHARED, SOON)]);
      expect((yield* instanceOf(settings, WORK))?.displayName).toBe("Claude - Office");
    }),
  ),
);

const GROK = ProviderDriverKind.make("grok");
const GROK_WORK = ProviderInstanceId.make("grok_work");
const CODEX_WORK = ProviderInstanceId.make("codex_work");
const KEYED = ProviderInstanceId.make("antigravity_keyed");

/** An account whose only part of its own here is a key kept in this machine's secret store. */
const keyedAccount = {
  driver: ProviderDriverKind.make("antigravity"),
  config: { apiKey: "\u2022\u2022\u2022\u2022\u2022\u2022" },
};

/**
 * A machine with the real settings file, secret store and managed policy, so a removal can drop a
 * stored secret and a policy vets each write.
 */
const machineWithSecretStore = (environmentId: EnvironmentId, policy?: ManagedPolicyDocument) =>
  SharedSettings.layer.pipe(
    Layer.provideMerge(Settings.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-shared-settings-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("a removal turns off an account that holds this machine's own keys or paths", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [
          version(WORK_KEY, WORK_REMOVED, LATER),
          version(`providerInstance:${KEYED}`, { removed: true, driver: "antigravity" }, LATER),
        ]);
        const current = yield* settings.getSettings;
        expect([current.providerInstances[WORK], current.providerInstances[KEYED]]).toEqual([
          { ...workAccount("b"), enabled: false },
          { ...keyedAccount, enabled: false },
        ]);
        expect((yield* served(shared))[WORK_KEY]?.value).toEqual(WORK_REMOVED);
      }),
    { providerInstances: { [WORK]: workAccount("b"), [KEYED]: keyedAccount } },
  ),
);

it.effect("a removal deletes an account that holds nothing of this machine's own", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_REMOVED, LATER)]);
        expect(yield* instanceOf(settings, WORK)).toBeUndefined();
      }),
    {
      providerInstances: {
        // Only shared fields, and local ones still at their defaults.
        [WORK]: { ...workArrived(HERE), config: { ...WORK_SHARED.config, homePath: "" } },
      },
    },
  ),
);

it.effect("a removal from the group keeps the secrets of an account it turns off", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const instance = yield* Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ followSharedSettings: true });
      yield* settings.updateProviderInstance({
        operation: "create",
        instanceId: WORK,
        instance: {
          driver: CLAUDE,
          environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-test-only", sensitive: true }],
        },
      });
      yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_REMOVED, LATER)]);
      return yield* instanceOf(settings, WORK);
    }).pipe(Effect.provide(machineWithSecretStore(PEER)));
    expect(instance).toMatchObject({
      enabled: false,
      environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-test-only", sensitive: true }],
    });
  }),
);

it.effect("an account of a driver without a private login per account is not shared", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      // Grok gets another login only through GROK_HOME, so a copy would run on the default one.
      yield* shared.updateProviderInstance(
        {
          operation: "create",
          instanceId: GROK_WORK,
          instance: { driver: GROK, displayName: "Grok - Work", config: { customModels: ["g"] } },
        },
        {},
        undefined,
      );
      yield* shared.updateProviderInstance(
        {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("grok"),
          instance: { driver: GROK, displayName: "Grok - Mine", enabled: false },
        },
        {},
        undefined,
      );
      expect(yield* shared.servedVersions).toEqual([]);
      // An older build's version of one is passed on, never applied.
      const sent = { driver: "grok", displayName: "Grok - Team", enabled: true };
      yield* shared.applyPulled(PEER, [version("providerInstance:grok_team", sent, LATER)]);
      expect(Object.hasOwn((yield* settings.getSettings).providerInstances, "grok_team")).toBe(
        false,
      );
      expect((yield* served(shared))["providerInstance:grok_team"]?.value).toEqual(sent);
    }),
  ),
);

it.effect("leaves how an account signs in, and where its requests go, on each machine", () =>
  Effect.gen(function* () {
    const versions = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.updateProviderInstance(
          {
            operation: "create",
            instanceId: CODEX_WORK,
            instance: { driver: CODEX, config: { setupMode: "managed", customModels: ["gpt-x"] } },
          },
          {},
          undefined,
        );
        yield* shared.updateProviderInstance(
          {
            operation: "create",
            instanceId: KEYED,
            instance: { ...keyedAccount, config: { ...keyedAccount.config, customModels: ["g"] } },
          },
          {},
          undefined,
        );
        return yield* served(shared);
      }),
    );
    expect([
      versions[`providerInstance:${CODEX_WORK}`]?.value,
      versions[`providerInstance:${KEYED}`]?.value,
    ]).toEqual([
      { driver: "codex", enabled: true, config: { customModels: ["gpt-x"] } },
      // Antigravity is off until turned on.
      { driver: "antigravity", enabled: false, config: { customModels: ["g"] } },
    ]);
    // An older build still sends them; a machine keeps its own.
    const taken = yield* run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.applyPulled(HERE, [
            version(
              `providerInstance:${KEYED}`,
              {
                driver: "antigravity",
                enabled: true,
                config: {
                  authMethod: "agent-platform",
                  gcpProject: "elsewhere",
                  gcpLocation: "attacker.example",
                  customModels: ["g"],
                },
              },
              LATER,
              HERE,
            ),
          ]);
          return yield* instanceOf(settings, KEYED);
        }),
      { providerInstances: { [KEYED]: keyedAccount } },
      undefined,
      undefined,
      PEER,
    );
    expect(taken?.config).toEqual({ ...keyedAccount.config, customModels: ["g"] });
  }),
);

it.effect("passes on an account version that would change a field a policy locks here", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const local = workArrived(OTHER);
        yield* shared.applyPulled(PEER, [
          version(
            WORK_KEY,
            { ...WORK_SHARED, config: { ...WORK_SHARED.config, customModels: ["other"] } },
            LATER,
          ),
        ]);
        expect(yield* instanceOf(settings, WORK)).toEqual(local);
        expect((yield* served(shared))[WORK_KEY]?.updatedAt).toBe(LATER);
        // One that leaves the locked field as it is here applies.
        yield* shared.applyPulled(PEER, [
          version(WORK_KEY, { ...WORK_SHARED, displayName: "Claude - Team" }, SOON),
        ]);
        expect((yield* instanceOf(settings, WORK))?.displayName).toBe("Claude - Team");
      }),
    { providerInstances: { [WORK]: workArrived(OTHER) } },
    undefined,
    {
      organization: "Example Corp",
      lockedSettings: [],
      limits: { providers: { lockedInstanceFields: { [CLAUDE]: ["config.customModels"] } } },
    },
  ),
);

it.effect("takes a shared account while a policy locks another account here", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const policy: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: {
        "providerInstances.codex": { value: { driver: "codex", enabled: true }, locked: true },
      },
    };
    const taken = yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      // Saved here before the policy, so it is not the locked value.
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          followSharedSettings: true,
          providerInstances: { codex: { driver: "codex", displayName: "Codex - Mine" } },
        }),
      );
      const shared = yield* SharedSettings.SharedSettings;
      const settings = yield* Settings.ServerSettingsService;
      const { warnings } = yield* withWarnings(
        Effect.gen(function* () {
          yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_SHARED, LATER)]);
          yield* shared.applyPulled(OTHER, [version(WORK_KEY, WORK_SHARED, LATER)]);
        }),
      );
      return {
        warnings,
        instance: yield* instanceOf(settings, WORK),
        served: (yield* served(shared))[WORK_KEY],
      };
    }).pipe(Effect.provide(machineWithSecretStore(HERE, policy)));
    expect(taken).toEqual({
      warnings: [],
      instance: workArrived(PEER),
      served: version(WORK_KEY, WORK_SHARED, LATER),
    });
  }),
);

it.effect("passes on an account version a policy here still refuses, saying so once", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        const { warnings } = yield* withWarnings(
          Effect.gen(function* () {
            yield* shared.applyPulled(PEER, [version(WORK_KEY, WORK_SHARED, LATER)]);
            yield* shared.applyPulled(OTHER, [version(WORK_KEY, WORK_SHARED, LATER)]);
          }),
        );
        expect(yield* instanceOf(settings, WORK)).toBeUndefined();
        expect((yield* served(shared))[WORK_KEY]).toEqual(version(WORK_KEY, WORK_SHARED, LATER));
        expect(warnings).toEqual([expect.stringContaining("policy")]);
      }),
    {},
    refusingProviderInstances,
  ),
);

it.effect("serves the settings it knows before accounts, and both before what it passes on", () =>
  run((shared) =>
    Effect.gen(function* () {
      // Each fits, but together the accounts are more than one answer may carry.
      const large = "z".repeat(SHARED_SETTING_VALUE_MAX_BYTES - 200);
      const accounts = Array.from({ length: 40 }, (_, index) =>
        version(
          `providerInstance:codex_${String(index).padStart(2, "0")}`,
          { driver: "codex", enabled: true, config: { customModels: [large] } },
          LATER,
        ),
      );
      yield* shared.applyPulled(PEER, accounts.slice(0, 20));
      yield* shared.applyPulled(PEER, accounts.slice(20));
      yield* shared.applyPulled(PEER, [
        version("fromANewerBuild", { on: true }, LATER),
        version("threadTitleInstructions", "Name threads plainly.", LATER),
      ]);
      const keys = (yield* shared.servedVersions).map(({ key }) => key);
      expect([keys[0], keys.at(-1)]).toEqual(["threadTitleInstructions", "fromANewerBuild"]);
      expect(keys.filter((key) => key.startsWith("providerInstance:")).length).toBeLessThan(40);
    }),
  ),
);

it.effect("a seed loses to a profile the group already has, and spreads where there is none", () =>
  Effect.gen(function* () {
    const mine = { chatWidth: "wide" };
    const group = { chatWidth: "full" };
    const lost = yield* run((shared) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [version("deviceSettingsProfile", group, EARLIER)]);
        return yield* shared.updateForAllMachines({ deviceSettingsProfile: mine }, { seed: true });
      }),
    );
    expect([lost.settings.deviceSettingsProfile, lost.share.values]).toEqual([group, []]);

    const seeded = yield* run((shared) =>
      Effect.gen(function* () {
        const saved = yield* shared.updateForAllMachines(
          { deviceSettingsProfile: mine },
          { seed: true },
        );
        return { saved, served: (yield* served(shared)).deviceSettingsProfile };
      }),
    );
    expect(seeded.saved.settings.deviceSettingsProfile).toEqual(mine);
    expect(seeded.served).toEqual(
      version("deviceSettingsProfile", mine, "1970-01-01T00:00:00.000Z", HERE),
    );
    // Another follower takes the seed only while it holds no profile of its own, whether a server
    // stamped it or a client did, for a machine without `server.shareSettings`.
    const clientSeed = {
      patch: { deviceSettingsProfile: mine },
      share: { updatedAt: "1970-01-01T00:00:00.000Z", origin: HERE },
    };
    const elsewhere = (
      pulled: ReadonlyArray<SharedSettingVersion>,
      write: { readonly patch: ServerSettingsPatch; readonly share: SharedSettingsWriteShare },
    ) =>
      run(
        (shared, settings) =>
          Effect.gen(function* () {
            yield* shared.applyPulled(OTHER, pulled);
            yield* shared.update(write.patch, write.share);
            return (yield* settings.getSettings).deviceSettingsProfile;
          }),
        {},
        undefined,
        undefined,
        PEER,
      );
    const held = [version("deviceSettingsProfile", group, EARLIER, OTHER)];
    for (const write of [{ patch: {}, share: seeded.saved.share }, clientSeed]) {
      expect(yield* elsewhere([], write)).toEqual(mine);
      expect(yield* elsewhere(held, write)).toEqual(group);
    }
  }),
);
