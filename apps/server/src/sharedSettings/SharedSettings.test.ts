import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  globalIdleCompaction,
  MACHINE_SHARED_SETTING_KEYS,
  type ServerSettingsPatch,
  type SharedSettingStamp,
  type SharedSettingVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

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

const stamp = (updatedAt: string, origin: EnvironmentId = HERE): SharedSettingStamp => ({
  updatedAt,
  origin,
});

const version = (
  key: string,
  value: unknown,
  updatedAt: string,
  origin: EnvironmentId = PEER,
): SharedSettingVersion => ({ key, value, updatedAt, origin });

/** A machine's settings, its provider instances, and the sqlite file that holds the versions. */
const machine = (
  overrides: Parameters<typeof Settings.layerTest>[0] = {},
  instances: Ref.Ref<ReadonlyArray<string>>,
) =>
  SharedSettings.layer.pipe(
    Layer.provideMerge(Settings.layerTest({ followSharedSettings: true, ...overrides })),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Ref.get(instances).pipe(
          Effect.map((ids) => ids.map((instanceId) => ({ instanceId }) as never)),
        ),
      }),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  );

const run = <A, E>(
  body: (
    shared: SharedSettings.SharedSettings["Service"],
    settings: Settings.ServerSettingsService["Service"],
    instances: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<A, E>,
  overrides: Parameters<typeof Settings.layerTest>[0] = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const instances = yield* Ref.make<ReadonlyArray<string>>(["codex", "claudeAgent"]);
    return yield* Effect.gen(function* () {
      const shared = yield* SharedSettings.SharedSettings;
      const settings = yield* Settings.ServerSettingsService;
      return yield* body(shared, settings, instances);
    }).pipe(Effect.provide(machine(overrides, instances)));
  });

const served = (shared: SharedSettings.SharedSettings["Service"]) =>
  shared.servedVersions.pipe(
    Effect.map((versions) => Object.fromEntries(versions.map((entry) => [entry.key, entry]))),
  );

it.effect("a write saved for all machines becomes the shared version of the keys it sets", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, stamp(EARLIER));
      const versions = yield* served(shared);
      expect(versions.finalReviewByDefault).toEqual(
        version("finalReviewByDefault", true, EARLIER, HERE),
      );
    }),
  ),
);

it.effect("a write for one machine records nothing", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ defaultRuntimeMode: "full-access" }, undefined);
      expect((yield* settings.getSettings).defaultRuntimeMode).toBe("full-access");
      expect(yield* shared.servedVersions).toEqual([]);
    }),
  ),
);

it.effect("records the whole value a partial write leaves, not the partial patch", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.update({ sourceControlWritingStyle: { mode: "custom" } }, stamp(EARLIER));
      const style = (yield* served(shared)).sourceControlWritingStyle?.value;
      expect(style).toEqual({
        mode: "custom",
        customInstructions: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle.customInstructions,
        followChangeRequestTemplates:
          DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      });
    }),
  ),
);

it.effect("does not record keys that belong to one machine", () =>
  run((shared) =>
    Effect.gen(function* () {
      yield* shared.update(
        { linkedEnvironmentsEnabled: true, guestSharingEnabled: true, worktreesDirectory: "/tmp" },
        stamp(EARLIER),
      );
      expect(yield* shared.servedVersions).toEqual([]);
    }),
  ),
);

it.effect(
  "a machine that does not follow shared settings applies the write but serves nothing",
  () =>
    run(
      (shared, settings) =>
        Effect.gen(function* () {
          yield* shared.update({ finalReviewByDefault: true }, stamp(EARLIER));
          expect((yield* settings.getSettings).finalReviewByDefault).toBe(true);
          expect(yield* shared.servedVersions).toEqual([]);
        }),
      { followSharedSettings: false },
    ),
);

it.effect("a machine that does not follow shared settings takes nothing from a peer", () =>
  run(
    (shared, settings) =>
      Effect.gen(function* () {
        yield* shared.applyPulled(PEER, [version("finalReviewByDefault", true, LATER)]);
        expect((yield* settings.getSettings).finalReviewByDefault).toBe(false);
        expect(yield* shared.servedVersions).toEqual([]);
      }),
    { followSharedSettings: false },
  ),
);

it.effect("takes a peer's newer version and serves it on", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, stamp(EARLIER));
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, LATER)]);
      expect((yield* settings.getSettings).finalReviewByDefault).toBe(false);
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
      yield* shared.update({ finalReviewByDefault: true }, stamp(LATER));
      yield* shared.applyPulled(PEER, [version("finalReviewByDefault", false, EARLIER)]);
      expect((yield* settings.getSettings).finalReviewByDefault).toBe(true);
      expect((yield* served(shared)).finalReviewByDefault?.updatedAt).toBe(LATER);
    }),
  ),
);

it.effect("breaks a tie on the same time by the larger origin", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, stamp(EARLIER, PEER));
      // The smaller origin loses, the larger one wins, and the same version again changes nothing.
      yield* shared.applyPulled(HERE, [version("finalReviewByDefault", false, EARLIER, HERE)]);
      expect((yield* settings.getSettings).finalReviewByDefault).toBe(true);
      yield* shared.applyPulled(OTHER, [version("finalReviewByDefault", false, EARLIER, OTHER)]);
      expect((yield* settings.getSettings).finalReviewByDefault).toBe(false);
      expect((yield* served(shared)).finalReviewByDefault?.origin).toBe(OTHER);
    }),
  ),
);

it.effect("a change saved here is not undone by a version that arrives with the same stamp", () =>
  run((shared, settings) =>
    Effect.gen(function* () {
      yield* shared.update({ finalReviewByDefault: true }, stamp(EARLIER));
      yield* shared.applyPulled(HERE, [version("finalReviewByDefault", false, EARLIER, HERE)]);
      expect((yield* settings.getSettings).finalReviewByDefault).toBe(true);
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

it.effect(
  "dates a version stamped by a fast clock now, so later changes can still replace it",
  () =>
    run((shared, settings) =>
      Effect.gen(function* () {
        yield* shared.update({ finalReviewByDefault: true }, stamp("2099-01-01T00:00:00.000Z"));
        expect((yield* served(shared)).finalReviewByDefault?.updatedAt).toBe(NOW);
        yield* TestClock.adjust("1 hour");
        yield* shared.applyPulled(PEER, [
          version("finalReviewByDefault", false, "2026-11-11T14:30:00.000Z"),
        ]);
        expect((yield* settings.getSettings).finalReviewByDefault).toBe(false);
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

        yield* shared.retryPending;
        expect((yield* settings.getSettings).scheduledTaskModelSelection).toBeNull();

        yield* Ref.set(instances, ["codex", "cursor-work"]);
        yield* shared.retryPending;
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
      yield* shared.retryPending;
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
        yield* shared.update(everyDefault, stamp(EARLIER));
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
