import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSelfUpdateError,
  ThreadId,
  type OrchestrationV2RestartHold,
  type ServerSelfUpdateOutcome,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as AutoUpdate from "./autoUpdate.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

const NEWER = "999.0.0";
const NEWEST_AFTER = "999.0.1";

const answering = [{ threadId: ThreadId.make("thread-2"), threadTitle: "Answering" }];

const work = (id: string): OrchestrationV2RestartHold["work"][number] => ({
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Coordinator",
  kind: "subagent",
  label: `Review ${id}`,
  id,
});

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly hold?: OrchestrationV2RestartHold["work"];
  readonly settledOutcome?: ServerSelfUpdateOutcome;
}

const makeHarness = Effect.fn("test.make_auto_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const events: Array<string> = [];
  const newest = yield* Ref.make(NEWER);
  const lookups = yield* Ref.make(0);
  const failUpdates = yield* Ref.make(false);
  const settings = yield* SubscriptionRef.make({
    ...DEFAULT_SERVER_SETTINGS,
    installUpdatesAutomatically: options.enabled ?? true,
  });
  const hold = yield* SubscriptionRef.make<OrchestrationV2RestartHold>({
    work: options.hold ?? [],
  });
  const holdSeen = yield* Deferred.make<void>();
  // Runs while the release is prepared, between the wait for idle and the handoff.
  const whilePreparing = yield* Ref.make<Effect.Effect<void>>(Effect.void);

  const auto = yield* AutoUpdate.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServiceLauncherClient.ServiceLauncherClient,
          ServiceLauncherClient.ServiceLauncherClient.of({
            managed: true,
            settledOutcome: options.settledOutcome,
            requestUpdate: () =>
              Effect.die("the launcher is asked through the self-update service"),
            prepareTrial: Effect.undefined,
          }),
        ),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: SubscriptionRef.get(settings),
          streamChanges: SubscriptionRef.changes(settings),
        }),
        Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({
          update: (input, _reportProgress, _onHandoffAccepted, beforeHandoff) =>
            Effect.gen(function* () {
              events.push(`update ${input.targetVersion}`);
              if (yield* Ref.get(failUpdates)) {
                return yield* new ServerSelfUpdateError({
                  reason: "Could not prepare the update.",
                });
              }
              yield* yield* Ref.get(whilePreparing);
              if (beforeHandoff !== undefined) yield* beforeHandoff();
              events.push(`handoff ${input.targetVersion}`);
              return { targetVersion: input.targetVersion, method: "boot-service", updateId: "u1" };
            }),
        }),
        Layer.mock(ProviderRuntimeRecoveryService)({
          restartHold: SubscriptionRef.get(hold),
          watchRestartHold: SubscriptionRef.changes(hold).pipe(
            Stream.tap(() => Deferred.succeed(holdSeen, undefined)),
          ),
        }),
        Layer.succeed(
          AutoUpdate.ServerReleaseLookup,
          AutoUpdate.ServerReleaseLookup.of({
            newest: () =>
              Ref.update(lookups, (count) => count + 1).pipe(Effect.andThen(Ref.get(newest))),
          }),
        ),
        ManagedPolicy.layerTest(),
      ),
    ),
  );
  return { auto, events, newest, lookups, failUpdates, settings, hold, holdSeen, whilePreparing };
});

describe("automatic server update", () => {
  it.effect("waits while a chat holds a restart, then installs once it is released", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);
      expect(harness.events).toEqual([]);

      yield* Effect.sync(() => harness.events.push("released"));
      yield* SubscriptionRef.set(harness.hold, { work: [] });
      yield* Fiber.join(check);

      expect(harness.events).toEqual(["released", `update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("waits while a chat is answering, with no background work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);
      expect(harness.events).toEqual([]);

      yield* Effect.sync(() => harness.events.push("answered"));
      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: [] });
      yield* Fiber.join(check);

      expect(harness.events).toEqual(["answered", `update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("also waits for work that started while it waited", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* SubscriptionRef.set(harness.hold, { work: [work("a"), work("later")] });
      yield* SubscriptionRef.set(harness.hold, { work: [work("later")] });
      expect(harness.events).toEqual([]);

      yield* Effect.sync(() => harness.events.push("later ended"));
      yield* SubscriptionRef.set(harness.hold, { work: [] });
      yield* Fiber.join(check);

      expect(harness.events).toEqual(["later ended", `update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect.each([
    {
      name: "a chat starts background work",
      change: (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
        SubscriptionRef.set(harness.hold, { work: [work("started while preparing")] }),
    },
    {
      name: "a chat starts answering",
      change: (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
        SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering }),
    },
    {
      name: "the setting is turned off",
      change: (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
        SubscriptionRef.update(harness.settings, (current) => ({
          ...current,
          installUpdatesAutomatically: false,
        })),
    },
  ])("puts the update off when $name while the release is prepared", ({ change }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.whilePreparing, change(harness));
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`]);

      // Not a failed attempt: the next check tries again at once, and goes when idle.
      yield* Ref.set(harness.whilePreparing, Effect.void);
      yield* SubscriptionRef.set(harness.hold, { work: [] });
      yield* SubscriptionRef.update(harness.settings, (current) => ({
        ...current,
        installUpdatesAutomatically: true,
      }));
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("installs a busy machine after the patience, once no background work is listed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
      );
      yield* Fiber.join(check);

      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("still waits for background work after the patience", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
      );
      expect(harness.events).toEqual([]);

      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
      yield* Fiber.join(check);
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("does nothing with the setting off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* harness.auto.check();

      expect(harness.events).toEqual([]);
      expect(yield* Ref.get(harness.lookups)).toBe(0);
    }),
  );

  it.effect("stops waiting when the setting is turned off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* SubscriptionRef.update(harness.settings, (current) => ({
        ...current,
        installUpdatesAutomatically: false,
      }));
      yield* Fiber.join(check);

      expect(harness.events).toEqual([]);
    }),
  );

  it.effect("leaves a release the launcher rolled back alone, and takes the next one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settledOutcome: {
          id: "u0",
          fromVersion: packageJson.version,
          targetVersion: NEWER,
          status: "rolled-back",
        },
      });
      yield* harness.auto.check();
      yield* harness.auto.check();
      expect(harness.events).toEqual([]);

      yield* Ref.set(harness.newest, NEWEST_AFTER);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWEST_AFTER}`, `handoff ${NEWEST_AFTER}`]);
    }),
  );

  it.effect("backs off after a failed attempt for the same version, doubling each time", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.failUpdates, true);

      yield* harness.auto.check();
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`]);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toHaveLength(2);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toHaveLength(2);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toHaveLength(3);
    }),
  );

  it.effect("tries a newer release at once after a failure on an older one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.failUpdates, true);
      yield* harness.auto.check();

      yield* Ref.set(harness.newest, NEWEST_AFTER);
      yield* harness.auto.check();

      expect(harness.events).toEqual([`update ${NEWER}`, `update ${NEWEST_AFTER}`]);
    }),
  );

  it.effect("does nothing when already on the newest release", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.newest, packageJson.version);
      yield* harness.auto.check();

      expect(harness.events).toEqual([]);
    }),
  );

  it("caps the retry delay", () => {
    expect(Duration.toMinutes(AutoUpdate.autoUpdateRetryDelay(1))).toBe(15);
    expect(Duration.toMinutes(AutoUpdate.autoUpdateRetryDelay(2))).toBe(30);
    expect(AutoUpdate.autoUpdateRetryDelay(50)).toEqual(AutoUpdate.AUTO_UPDATE_RETRY_MAX);
  });
});
