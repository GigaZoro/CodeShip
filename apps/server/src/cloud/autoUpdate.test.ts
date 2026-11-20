import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSelfUpdateError,
  ThreadId,
  type OrchestrationV2RestartHold,
  type ServerSelfUpdateOutcome,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as AutoUpdate from "./autoUpdate.ts";
import { UpdateDrain } from "./updateDrain.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

const NEWER = "999.0.0";
const NEWEST_AFTER = "999.0.1";

describe("automatic update eligibility in America/New_York", () => {
  it.effect.each([
    ["before the local time", "03:00", "2026-11-18T07:59:59Z", "2026-11-18T07:00:00Z", false],
    ["at the local time", "03:00", "2026-11-18T08:00:00Z", "2026-11-18T08:00:00Z", true],
    ["after the local time", "03:00", "2026-11-18T08:30:00Z", "2026-11-18T07:30:00Z", true],
    ["offline at the local time", "03:00", "2026-11-18T22:00:00Z", "2026-11-18T07:30:00Z", true],
    [
      "only releases after the local time",
      "03:00",
      "2026-11-18T10:00:00Z",
      "2026-11-18T08:00:01Z",
      false,
    ],
    [
      "before the shifted spring time",
      "02:30",
      "2026-03-08T07:20:00Z",
      "2026-03-08T07:10:00Z",
      false,
    ],
    ["at the shifted spring time", "02:30", "2026-03-08T07:30:00Z", "2026-03-08T07:25:00Z", true],
    [
      "at the first autumn occurrence",
      "01:30",
      "2026-11-01T05:30:00Z",
      "2026-11-01T05:29:00Z",
      true,
    ],
    [
      "before the second autumn occurrence",
      "01:30",
      "2026-11-01T06:29:00Z",
      "2026-11-01T06:00:00Z",
      false,
    ],
    [
      "at the second autumn occurrence",
      "01:30",
      "2026-11-01T06:30:00Z",
      "2026-11-01T06:00:00Z",
      true,
    ],
    ["before midnight", "00:00", "2026-11-18T04:59:59Z", "2026-11-18T04:59:00Z", false],
    ["at midnight", "00:00", "2026-11-18T05:00:00Z", "2026-11-18T04:59:00Z", true],
    [
      "before today's slot with yesterday's update due",
      "03:00",
      "2026-11-18T05:01:00Z",
      "2026-11-17T08:00:00Z",
      true,
    ],
  ] as const)("%s", ([_name, time, checked, published, due]) =>
    Effect.gen(function* () {
      const now = DateTime.makeZonedUnsafe(checked, { timeZone: "America/New_York" });
      const releases = Stream.make(
        { version: "1.2.0", publishedAtMillis: Date.parse(checked) },
        { version: "1.1.0", publishedAtMillis: Date.parse(published) },
        { version: "1.0.0", publishedAtMillis: Date.parse("2025-12-01T00:00:00Z") },
      );
      const target = yield* AutoUpdate.automaticUpdateTarget(releases, "1.0.0", now, time);
      expect(Option.getOrUndefined(target)?.newest).toBe(due ? "1.2.0" : undefined);
    }),
  );
});

describe("automatic update target", () => {
  const now = DateTime.makeZonedUnsafe("2026-11-18T12:00:00Z", { timeZone: "America/New_York" });
  const beforeCutoff = Date.parse("2026-11-18T07:00:00Z");
  const afterCutoff = Date.parse("2026-11-18T09:00:00Z");

  it.effect("reads past an older release listed above newer ones, up to the running release", () =>
    Effect.gen(function* () {
      const releases = Stream.make(
        { version: "1.4.0", publishedAtMillis: afterCutoff },
        { version: "0.9.9", publishedAtMillis: beforeCutoff },
        { version: "1.2.0", publishedAtMillis: beforeCutoff },
        { version: "1.3.0", publishedAtMillis: beforeCutoff },
        { version: "1.0.0", publishedAtMillis: beforeCutoff },
      ).pipe(Stream.concat(Stream.fail("read past the running release")));
      const target = yield* AutoUpdate.automaticUpdateTarget(releases, "1.0.0", now, "03:00");
      expect(Option.getOrUndefined(target)).toEqual({ newest: "1.4.0", due: "1.3.0" });
    }),
  );

  it.effect("has nothing due while every newer release came after the install time", () =>
    Effect.gen(function* () {
      const releases = Stream.make(
        { version: "1.1.0", publishedAtMillis: afterCutoff },
        { version: "1.0.0", publishedAtMillis: beforeCutoff },
        { version: "0.9.0", publishedAtMillis: beforeCutoff },
      );
      const target = yield* AutoUpdate.automaticUpdateTarget(releases, "1.0.0", now, "03:00");
      expect(Option.isNone(target)).toBe(true);
    }),
  );
});

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
  readonly desktop?: boolean;
  readonly answering?: boolean;
  readonly notAppliedDesktopVersion?: string;
}

const makeHarness = Effect.fn("test.make_auto_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const events: Array<string> = [];
  const newest = yield* Ref.make(NEWER);
  // A release published after the install time, listed above the newest due one.
  const undue = yield* Ref.make<string | undefined>(undefined);
  const lookups = yield* Ref.make(0);
  // Runs inside each release lookup.
  const duringLookup = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const failUpdates = yield* Ref.make(false);
  const settings = yield* Ref.make({
    ...DEFAULT_SERVER_SETTINGS,
    installUpdatesAutomatically: options.enabled ?? true,
  });
  // Like the settings service, a subscriber sees only changes made after it subscribed.
  const settingChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const updateSettings = (
    change: (current: typeof DEFAULT_SERVER_SETTINGS) => typeof DEFAULT_SERVER_SETTINGS,
  ) =>
    Ref.updateAndGet(settings, change).pipe(
      Effect.flatMap((next) => PubSub.publish(settingChanges, next)),
      Effect.asVoid,
    );
  // Each test gets its own drain: a hold kept past the handoff must not leak into the next test.
  const drain = yield* Ref.make(0);
  const hold = yield* SubscriptionRef.make<OrchestrationV2RestartHold>({
    work: options.hold ?? [],
    runningTurns: options.answering === true ? answering : [],
  });
  const holdSeen = yield* Deferred.make<void>();
  // One entry each time the update starts watching what chats hold.
  const watchStarts = yield* Queue.unbounded<void>();
  // Runs while the release is prepared, between the wait for idle and the handoff.
  const whilePreparing = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const handedOff = yield* Deferred.make<void>();
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped();
  const path = yield* Path.Path;
  const recordPath = path.join(baseDir, "runtime", "automatic-update.json");
  const serverConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
  );

  const dependencies = Layer.mergeAll(
    ServerConfig.layer({
      ...serverConfig,
      mode: options.desktop === true ? "desktop" : "web",
      desktopTelemetryControlFd: options.desktop === true ? 5 : undefined,
    }),
    Layer.succeed(
      ServiceLauncherClient.ServiceLauncherClient,
      ServiceLauncherClient.ServiceLauncherClient.of({
        managed: options.desktop !== true,
        settledOutcome: options.settledOutcome,
        requestUpdate: () => Effect.die("the launcher is asked through the self-update service"),
        prepareTrial: Effect.undefined,
        reportPreparing: Effect.void,
      }),
    ),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Ref.get(settings),
      subscribeChanges: PubSub.subscribe(settingChanges).pipe(Effect.map(Stream.fromSubscription)),
    }),
    Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({
      notAppliedDesktopVersion: Effect.succeed(options.notAppliedDesktopVersion),
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
          yield* Deferred.succeed(handedOff, undefined);
          return { targetVersion: input.targetVersion, method: "boot-service", updateId: "u1" };
        }),
    }),
    Layer.mock(ProviderRuntimeRecoveryService)({
      restartHold: SubscriptionRef.get(hold),
      watchRestartHold: Stream.unwrap(
        Queue.offer(watchStarts, undefined).pipe(
          Effect.as(
            SubscriptionRef.changes(hold).pipe(
              Stream.tap(() => Deferred.succeed(holdSeen, undefined)),
            ),
          ),
        ),
      ),
    }),
    Layer.succeed(
      AutoUpdate.ServerReleaseLookup,
      AutoUpdate.ServerReleaseLookup.of({
        releases: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Ref.update(lookups, (count) => count + 1);
              yield* yield* Ref.get(duringLookup);
              const later = yield* Ref.get(undue);
              const now = yield* Clock.currentTimeMillis;
              return Stream.make(
                ...(later === undefined ? [] : [{ version: later, publishedAtMillis: now + 1 }]),
                { version: yield* Ref.get(newest), publishedAtMillis: -86_400_000 * 2 },
              );
            }),
          ),
      }),
    ),
    ManagedPolicy.layerTest(),
  );
  const made = yield* AutoUpdate.make().pipe(Effect.provide(dependencies));
  const auto = { check: () => made.check().pipe(Effect.provideService(UpdateDrain, drain)) };
  const startDesktop = AutoUpdate.start().pipe(
    Effect.provide(dependencies),
    Effect.provideService(UpdateDrain, drain),
  );
  const writeRecord = (record: unknown) =>
    fs
      .makeDirectory(path.dirname(recordPath), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            recordPath,
            typeof record === "string" ? record : JSON.stringify(record),
          ),
        ),
      );
  return {
    auto,
    events,
    newest,
    undue,
    lookups,
    duringLookup,
    failUpdates,
    updateSettings,
    draining: Ref.get(drain).pipe(Effect.map((holds) => holds > 0)),
    writeRecord,
    hold,
    holdSeen,
    watchStarts,
    whilePreparing,
    handedOff,
    startDesktop,
    recordPath,
  };
});

it.layer(NodeServices.layer)("automatic server update", (it) => {
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
      busy: { work: [work("started while preparing")] },
    },
    {
      name: "a chat starts answering",
      busy: { work: [], runningTurns: answering },
    },
  ])("waits again when $name while the release is prepared", ({ busy }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(
        harness.whilePreparing,
        SubscriptionRef.set(harness.hold, busy).pipe(
          Effect.andThen(Ref.set(harness.whilePreparing, Effect.void)),
        ),
      );
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Queue.take(harness.watchStarts);
      // Not a failed attempt: the same check watches the chats again.
      yield* Queue.take(harness.watchStarts);
      expect(harness.events).toEqual([`update ${NEWER}`]);

      yield* SubscriptionRef.set(harness.hold, { work: [] });
      yield* Fiber.join(check);
      expect(harness.events).toEqual([`update ${NEWER}`, `update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("keeps the patience and drain deadlines when chats put the handoff off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // Each time the release is prepared, a chat starts answering.
      yield* Ref.set(
        harness.whilePreparing,
        SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering }),
      );
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Queue.take(harness.watchStarts);
      yield* Queue.take(harness.watchStarts);
      expect(harness.events).toEqual([`update ${NEWER}`]);

      // The patience counts from the first wait, not from the put-off.
      yield* TestClock.adjust(
        Duration.subtract(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
      );
      expect(yield* harness.draining).toBe(false);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* harness.draining).toBe(true);

      // The drain empties the machine, and another chat starts while the release is prepared.
      yield* Queue.take(harness.watchStarts);
      yield* SubscriptionRef.set(harness.hold, { work: [] });
      yield* Queue.take(harness.watchStarts);
      expect(harness.events).toEqual([`update ${NEWER}`, `update ${NEWER}`]);

      // The drain also counts from its start: then the answering chat is cut.
      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_DRAIN_LIMIT);
      yield* Fiber.join(check);
      expect(harness.events).toEqual([
        `update ${NEWER}`,
        `update ${NEWER}`,
        `update ${NEWER}`,
        `handoff ${NEWER}`,
      ]);
      // Scheduled starts stay held until the installer stops this server.
      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_HANDOFF_STOP_LIMIT);
      expect(yield* harness.draining).toBe(false);
    }),
  );

  it.effect(
    "puts the update off when the setting is turned off while the release is prepared",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Ref.set(
          harness.whilePreparing,
          harness.updateSettings((current) => ({
            ...current,
            installUpdatesAutomatically: false,
          })),
        );
        yield* harness.auto.check();
        expect(harness.events).toEqual([`update ${NEWER}`]);

        // Not a failed attempt: the next check tries again at once.
        yield* Ref.set(harness.whilePreparing, Effect.void);
        yield* harness.updateSettings((current) => ({
          ...current,
          installUpdatesAutomatically: true,
        }));
        yield* harness.auto.check();
        expect(harness.events).toEqual([`update ${NEWER}`, `update ${NEWER}`, `handoff ${NEWER}`]);
      }),
  );

  it.effect(
    "drains a busy machine after the patience: holds scheduled starts, installs when turns end",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
        const check = yield* Effect.forkChild(harness.auto.check());
        yield* Deferred.await(harness.holdSeen);
        expect(yield* harness.draining).toBe(false);

        yield* TestClock.adjust(
          Duration.sum(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
        );
        expect(yield* harness.draining).toBe(true);
        expect(harness.events).toEqual([]);

        yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: [] });
        yield* Fiber.join(check);

        expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
        // Scheduled starts stay held until the installer stops this server.
        yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_HANDOFF_STOP_LIMIT);
        expect(yield* harness.draining).toBe(false);
      }),
  );

  it.effect("cuts only turns still running at the drain limit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
      );
      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_DRAIN_LIMIT, Duration.minutes(1)),
      );
      yield* Fiber.join(check);

      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
      // Scheduled starts stay held until the installer stops this server.
      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_HANDOFF_STOP_LIMIT);
      expect(yield* harness.draining).toBe(false);
    }),
  );

  it.effect(
    "starts a desktop install after patience and drain even with a turn still answering",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ desktop: true, answering: true, hold: [work("a")] });
        yield* harness.startDesktop;
        yield* Deferred.await(harness.holdSeen);
        expect(yield* harness.draining).toBe(false);

        yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE);
        expect(yield* harness.draining).toBe(true);
        expect(harness.events).toEqual([]);

        yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_DRAIN_LIMIT);
        expect(harness.events).toEqual([]);
        yield* SubscriptionRef.set(harness.hold, { runningTurns: answering, work: [] });
        yield* Deferred.await(harness.handedOff);
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
      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_DRAIN_LIMIT, Duration.minutes(1)),
      );
      expect(harness.events).toEqual([]);

      yield* SubscriptionRef.set(harness.hold, { work: [], runningTurns: answering });
      yield* Fiber.join(check);
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("stops waiting for background work that outlasts the cut by the grace", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("never ends")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);

      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE, Duration.minutes(1)),
      );
      yield* TestClock.adjust(
        Duration.sum(AutoUpdate.AUTO_UPDATE_DRAIN_LIMIT, Duration.minutes(1)),
      );
      yield* TestClock.adjust(
        Duration.subtract(AutoUpdate.AUTO_UPDATE_CUT_GRACE, Duration.minutes(1)),
      );
      expect(harness.events).toEqual([]);

      yield* TestClock.adjust(Duration.minutes(2));
      yield* Fiber.join(check);
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("ends the wait when the schedule changes while releases are looked up", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      yield* Ref.set(
        harness.duringLookup,
        harness.updateSettings((current) => ({ ...current, automaticUpdateTime: "05:00" })),
      );
      // Background work holds the update, so only the change can end this check.
      yield* harness.auto.check();
      expect(harness.events).toEqual([]);
    }),
  );

  it.effect("keeps scheduled starts held after the handoff until the installer stops it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
      expect(yield* harness.draining).toBe(true);

      yield* TestClock.adjust(
        Duration.subtract(AutoUpdate.AUTO_UPDATE_HANDOFF_STOP_LIMIT, Duration.seconds(1)),
      );
      expect(yield* harness.draining).toBe(true);
      // A server still running then lets them go again.
      yield* TestClock.adjust(Duration.seconds(1));
      expect(yield* harness.draining).toBe(false);
    }),
  );

  it.effect.each([
    { name: "a launcher installs the newest release", desktop: false, installs: NEWEST_AFTER },
    { name: "a desktop app gets the due release as its minimum", desktop: true, installs: NEWER },
  ])("$name", ({ desktop, installs }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ desktop });
      yield* Ref.set(harness.undue, NEWEST_AFTER);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${installs}`, `handoff ${installs}`]);
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

  it.effect("ends the drain when automatic updates are turned off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hold: [work("a")] });
      const check = yield* Effect.forkChild(harness.auto.check());
      yield* Deferred.await(harness.holdSeen);
      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_IDLE_PATIENCE);
      expect(yield* harness.draining).toBe(true);

      yield* harness.updateSettings((current) => ({
        ...current,
        installUpdatesAutomatically: false,
      }));
      yield* Fiber.join(check);

      expect(harness.events).toEqual([]);
      expect(yield* harness.draining).toBe(false);
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

  it.effect("leaves a desktop release that did not apply alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ desktop: true, notAppliedDesktopVersion: NEWER });
      yield* harness.auto.check();
      expect(harness.events).toEqual([]);

      yield* Ref.set(harness.newest, NEWEST_AFTER);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWEST_AFTER}`, `handoff ${NEWEST_AFTER}`]);
    }),
  );

  it.effect("waits out an attempt recorded before a restart of the same version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.writeRecord({
        fromVersion: packageJson.version,
        targetVersion: NEWER,
        attempts: 1,
        retryAtMillis:
          (yield* Clock.currentTimeMillis) + Duration.toMillis(AutoUpdate.AUTO_UPDATE_RETRY_BASE),
      });
      yield* harness.auto.check();
      expect(harness.events).toEqual([]);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("ignores an attempt recorded by an older version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.writeRecord({
        fromVersion: "0.0.1",
        targetVersion: NEWER,
        attempts: 3,
        retryAtMillis: (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.days(1)),
      });
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
    }),
  );

  it.effect("replaces an unreadable record", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const fs = yield* FileSystem.FileSystem;
      yield* harness.writeRecord(`{"localDay":"2026-11-18"`);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
      expect(JSON.parse(yield* fs.readFileString(harness.recordPath))).toMatchObject({
        fromVersion: packageJson.version,
        targetVersion: NEWER,
        attempts: 1,
      });
    }),
  );

  it.effect("waits before trying again when a handoff leaves the same version running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auto.check();
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toHaveLength(4);
    }),
  );

  it.effect("retries a release whose launcher update failed once the wait is over", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settledOutcome: {
          id: "u0",
          fromVersion: packageJson.version,
          targetVersion: NEWER,
          status: "failed",
        },
      });
      yield* harness.writeRecord({
        fromVersion: packageJson.version,
        targetVersion: NEWER,
        attempts: 1,
        retryAtMillis:
          (yield* Clock.currentTimeMillis) + Duration.toMillis(AutoUpdate.AUTO_UPDATE_RETRY_BASE),
      });
      yield* harness.auto.check();
      expect(harness.events).toEqual([]);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`, `handoff ${NEWER}`]);
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

  it.effect("waits out a failure even when a newer release appears", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.failUpdates, true);
      yield* harness.auto.check();

      yield* Ref.set(harness.newest, NEWEST_AFTER);
      yield* harness.auto.check();
      expect(harness.events).toEqual([`update ${NEWER}`]);

      yield* TestClock.adjust(AutoUpdate.AUTO_UPDATE_RETRY_BASE);
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
