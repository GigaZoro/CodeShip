import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  globalIdleCompaction,
  MACHINE_SHARED_SETTING_KEYS,
  type ManagedPolicySummary,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettingsPatch,
  type SharedSettingsShare,
  type SharedSettingVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

/**
 * A machine's settings, its provider instances, and the sqlite file that holds the versions. With
 * `followingTurnedOff`, reads outside the write lock still say the machine follows shared settings,
 * as they did a moment before following was turned off.
 */
const machine = (
  overrides: Parameters<typeof Settings.layerTest>[0],
  instances: Ref.Ref<ReadonlyArray<string>>,
  followingTurnedOff: boolean,
  managedPolicy: ManagedPolicySummary | undefined,
) => {
  const settings = Settings.layerTest({ followSharedSettings: true, ...overrides }, managedPolicy);
  const settingsSeen = followingTurnedOff
    ? Layer.effect(
        Settings.ServerSettingsService,
        Effect.gen(function* () {
          const real = yield* Settings.ServerSettingsService;
          return {
            ...real,
            getSettings: real.getSettings.pipe(
              Effect.map((current) => ({ ...current, followSharedSettings: true })),
            ),
          };
        }),
      ).pipe(Layer.provide(settings))
    : settings;
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
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  );
};

const run = <A, E>(
  body: (
    shared: SharedSettings.SharedSettings["Service"],
    settings: Settings.ServerSettingsService["Service"],
    instances: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<A, E>,
  overrides: Parameters<typeof Settings.layerTest>[0] = {},
  followingTurnedOff = false,
  managedPolicy?: ManagedPolicySummary,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const instances = yield* Ref.make<ReadonlyArray<string>>(["codex", "claudeAgent"]);
    return yield* Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      const settings = yield* Settings.ServerSettingsService;
      return yield* body(shared, settings, instances);
    }).pipe(Effect.provide(machine(overrides, instances, followingTurnedOff, managedPolicy)));
  });

const served = (shared: SharedSettings.SharedSettings["Service"]) =>
  shared.servedVersions.pipe(
    Effect.map((versions) => Object.fromEntries(versions.map((entry) => [entry.key, entry]))),
  );

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
    true,
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

it.effect("refuses keys that are not shared and values that do not fit their key", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.applyPulled(PEER, [
        version("linkedEnvironmentsEnabled", true, LATER),
        version("guestSharingEnabled", true, LATER),
        version("followSharedSettings", false, LATER),
        version("providerInstances", {}, LATER),
        version("defaultProjectScripts", [], LATER),
        version("noSuchSetting", 1, LATER),
        version("finalReviewByDefault", "yes", LATER),
      ]);
      const current = yield* settings.getSettings;
      expect([
        current.linkedEnvironmentsEnabled,
        current.guestSharingEnabled,
        current.followSharedSettings,
        current.finalReviewByDefault,
      ]).toEqual([false, false, true, false]);
      expect(yield* shared.servedVersions).toEqual([]);
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
      false,
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
