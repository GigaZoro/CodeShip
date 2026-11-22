import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  UsageDay,
  UsageReadError,
  USAGE_CONTRACT_VERSION,
  WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
  ServerSettings,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("usage-environment"),
  label: "Usage environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INPUT: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

const CONFIG = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as ServerConfig;

const PRICING = { status: "unavailable" as const, source: "test", fetchedAt: null, knownModels: 0 };

const cursorSource = (refreshing: boolean): UsageSource => ({
  fingerprint: {
    hostId: "cursor.com",
    provider: "cursor",
    resolvedHomePath: "cursor-account:abc",
    volumeId: "abc",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
  ...(refreshing ? { refreshing: true as const } : {}),
});

const sameServerSettings = Schema.toEquivalence(ServerSettings);

const makeHarness = Effect.fn("ServerUsageTest.makeHarness")(function* (
  beforeRead: (
    request: number,
    input: UsageSummaryInput,
  ) => Effect.Effect<void, UsageReadError> = () => Effect.void,
  sources: (input: UsageSummaryInput) => readonly UsageSource[] = () => [],
  progress?: (request: number) => {
    readonly output: number;
    readonly partialReason?: UsageSummary["partialReason"];
  },
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  let settings = DEFAULT_SERVER_SETTINGS;
  let requests = 0;
  const inputs: UsageSummaryInput[] = [];
  const client = {
    [WS_METHODS.serverRefreshUsageRates]: () => Effect.succeed(PRICING),
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.concat(
        Stream.make({ version: 1 as const, type: "snapshot" as const, config: CONFIG }),
        Stream.fromQueue(events),
      ),
    [WS_METHODS.serverGetUsageSummary]: (input: UsageSummaryInput) =>
      Effect.gen(function* () {
        const ordinal = ++requests;
        inputs.push(input);
        const price = settings.usagePriceOverrides["custom-model"]?.inputCostPerMillionTokens ?? 0;
        yield* beforeRead(ordinal, input);
        const step = progress?.(ordinal);
        return {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-09-04T12:00:00Z",
          ...input,
          buckets: [
            {
              day: input.sinceDay,
              provider: "codex",
              model: "custom-model",
              totals: {
                uncachedInputTokens: 1_000_000,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: step?.output ?? 0,
                reasoningTokens: 0,
              },
              costUsd: price,
              cacheSavingsUsd: 0,
              costSource: price === 0 ? "unpriced" : "modelPriced",
              records: 1,
              unpricedRecords: price === 0 ? 1 : 0,
              sessions: 1,
            },
          ],
          sources: sources(input),
          ...(step?.partialReason === undefined ? {} : { partialReason: step.partialReason }),
          pricing: PRICING,
          scanDurationMs: 0,
        } satisfies UsageSummary;
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: connection,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    ),
  );
  const initialConfigValueAtom = Atom.make(CONFIG);
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfigValueAtom,
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const updateSettings = Effect.fn("ServerUsageTest.updateSettings")(function* (
    next: ServerSettings,
  ) {
    settings = next;
    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });
    // An equal settings document keeps the previous object, so match on content.
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(TARGET.environmentId)).pipe(
      Stream.filter((current) => current !== null && sameServerSettings(current, next)),
      Stream.runHead,
    );
  });
  return {
    registry,
    atoms,
    requests: () => requests,
    inputs: () => inputs,
    updateSettings,
    setConnection: (next: SupervisorConnectionState) =>
      SubscriptionRef.set(connection, next).pipe(Effect.andThen(Effect.yieldNow)),
    summary: (input = INPUT) => atoms.usageSummary({ environmentId: TARGET.environmentId, input }),
  };
});

function settledUsage<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((result) => result._tag !== "Initial" && !result.waiting),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function settledSummary<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
) {
  return settledUsage(registry, atom).pipe(
    Effect.map((result) => {
      if (!AsyncResult.isSuccess(result)) throw new Error("Expected settled usage figures");
      return result.value;
    }),
  );
}

const makeRefreshingHarness = Effect.fn("ServerUsageTest.makeRefreshingHarness")(function* (
  followUp: Effect.Effect<void, UsageReadError>,
) {
  const followUpStarted = yield* Deferred.make<void>();
  const harness = yield* makeHarness(
    (_request, input) =>
      input.awaitRefresh === true
        ? Deferred.succeed(followUpStarted, undefined).pipe(Effect.andThen(followUp))
        : Effect.void,
    (input) => [cursorSource(input.awaitRefresh !== true)],
  );
  return { ...harness, followUpStarted };
});

function waitForCost<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
  cost: number,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) =>
        AsyncResult.isSuccess(result) &&
        !result.waiting &&
        result.value.buckets[0]?.costUsd === cost,
    ),
    Stream.runHead,
  );
}

it.effect("restarts a pending usage read after a price change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness((request) =>
        request === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : Effect.void,
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* waitForCost(harness.registry, summary, 5);
      yield* Deferred.await(interrupted);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("publishes the first usage answer while the slow follow-up is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const harness = yield* makeRefreshingHarness(Deferred.await(finish));
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(harness.followUpStarted);

      const initial = harness.registry.get(summary);
      expect(AsyncResult.isSuccess(initial) && initial.waiting).toBe(true);
      if (!AsyncResult.isSuccess(initial)) throw new Error("Expected the first usage answer");
      expect(initial.value.buckets[0]?.totals.uncachedInputTokens).toBe(1_000_000);
      expect(initial.value.sources).toEqual([cursorSource(true)]);

      yield* Deferred.succeed(finish, undefined);
      const result = yield* settledUsage(harness.registry, summary);
      expect(AsyncResult.isSuccess(result) && result.value.sources).toEqual([cursorSource(false)]);
      unmount();
    }),
  ),
);

it.effect("keeps a cold Usage query pending and follows it until the first figures arrive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness(
        (request, input) =>
          request === 1
            ? Effect.fail(new UsageReadError({ reason: "scanPending", detail: "Scanning" }))
            : Effect.sync(() => expect(input.awaitRefresh).toBe(true)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
        () => [],
        () => ({ output: 12 }),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      const result = harness.registry.get(summary);
      expect(result.waiting).toBe(true);
      expect(AsyncResult.isSuccess(result)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(
        (yield* settledSummary(harness.registry, summary)).buckets[0]?.totals.outputTokens,
      ).toBe(12);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("fails the Usage query when every follow-up stays pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(
            Effect.fail(new UsageReadError({ reason: "scanPending", detail: "Scanning" })),
          ),
        ),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      yield* TestClock.adjust("20 seconds");
      const terminal = yield* AtomRegistry.toStream(harness.registry, summary).pipe(
        Stream.filter((value) => AsyncResult.isFailure(value) && !value.waiting),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(AsyncResult.isFailure(terminal) && terminal.cause.toString()).toContain(
        "The usage scan timed out.",
      );
      expect(harness.requests()).toBe(21);
      unmount();
    }),
  ),
);

it.effect("keeps five partial tokens when the Usage follow-up budget runs out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness(
        () => Deferred.succeed(started, undefined),
        () => [
          { ...cursorSource(false), status: "partial", message: "Usage is still refreshing." },
        ],
        () => ({ output: 5, partialReason: "scanTimedOut" }),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      yield* TestClock.adjust("20 seconds");
      const settled = yield* AtomRegistry.toStream(harness.registry, summary).pipe(
        Stream.filter((result) => !result.waiting && !AsyncResult.isInitial(result)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(AsyncResult.isSuccess(settled) && settled.value.buckets[0]?.totals.outputTokens).toBe(
        5,
      );
      expect(AsyncResult.isSuccess(settled) && settled.value.partialReason).toBe("scanTimedOut");
      expect(harness.requests()).toBe(21);
      unmount();
    }),
  ),
);

it.effect.each(["top-level reason", "refreshing source"] as const)(
  "keeps the same window's partial figures from a %s through a scanPending-only refresh",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const retry = yield* Deferred.make<void>();
        const harness = yield* makeHarness(
          (request) =>
            request <= 21
              ? Deferred.succeed(first, undefined)
              : Deferred.succeed(retry, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(new UsageReadError({ reason: "scanPending", detail: "Scanning" })),
                  ),
                ),
          () => [cursorSource(kind === "refreshing source")],
          () =>
            kind === "top-level reason"
              ? { output: 5, partialReason: "scanTimedOut" }
              : { output: 5 },
        );
        const summary = harness.summary();
        const unmount = harness.registry.mount(summary);
        yield* Deferred.await(first);
        yield* TestClock.adjust("20 seconds");
        expect(
          (yield* settledSummary(harness.registry, summary)).buckets[0]?.totals.outputTokens,
        ).toBe(5);

        harness.registry.refresh(summary);
        yield* Deferred.await(retry);
        yield* TestClock.adjust("20 seconds");
        const settled = yield* AtomRegistry.toStream(harness.registry, summary).pipe(
          Stream.filter((result) => !result.waiting && !AsyncResult.isInitial(result)),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(
          AsyncResult.isSuccess(settled) && settled.value.buckets[0]?.totals.outputTokens,
        ).toBe(5);
        expect(AsyncResult.isSuccess(settled) && settled.value.partialReason).toBe("scanTimedOut");
        expect(harness.requests()).toBe(42);
        unmount();
      }),
    ),
);

it.effect("reports the reconnect failure once a settings change discards the figures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        () => Effect.void,
        () => [],
        () => ({ output: 5 }),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      expect((yield* settledSummary(harness.registry, summary)).buckets[0]?.costUsd).toBe(0);
      const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
      yield* harness.setConnection({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "backoff",
        attempt: 1,
        lastFailure,
        retryAt: 1,
      });
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      const settled = yield* AtomRegistry.toStream(harness.registry, summary).pipe(
        Stream.filter((result) => !result.waiting),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(AsyncResult.isFailure(settled)).toBe(true);
      expect(Option.isNone(AsyncResult.value(settled))).toBe(true);
      expect(harness.requests()).toBe(1);
      unmount();
    }),
  ),
);

it.effect("never settles a pending scan with partial figures from the previous price", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const changed = yield* Deferred.make<void>();
      const harness = yield* makeHarness(
        (request) =>
          request <= 21
            ? Deferred.succeed(first, undefined)
            : Deferred.succeed(changed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new UsageReadError({ reason: "scanPending", detail: "Scanning" })),
                ),
              ),
        () => [],
        () => ({ output: 5, partialReason: "scanTimedOut" }),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(first);
      yield* TestClock.adjust("20 seconds");
      expect((yield* settledSummary(harness.registry, summary)).buckets[0]?.costUsd).toBe(0);
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* Deferred.await(changed);
      expect(Option.isNone(AsyncResult.value(harness.registry.get(summary)))).toBe(true);
      yield* TestClock.adjust("20 seconds");
      const settled = harness.registry.get(summary);
      expect(settled.waiting).toBe(false);
      expect(AsyncResult.isFailure(settled)).toBe(true);
      expect(Option.isNone(AsyncResult.value(settled))).toBe(true);
      expect(harness.requests()).toBe(42);

      harness.registry.refresh(summary);
      yield* TestClock.adjust("20 seconds");
      const retried = harness.registry.get(summary);
      expect(retried.waiting).toBe(false);
      expect(AsyncResult.isFailure(retried)).toBe(true);
      expect(harness.requests()).toBe(63);
      unmount();
    }),
  ),
);

it.effect("keeps the cached usage summary when the awaited refresh fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const harness = yield* makeRefreshingHarness(
        Deferred.await(finish).pipe(
          Effect.andThen(
            Effect.fail(new UsageReadError({ reason: "scanFailed", detail: "Cursor is down" })),
          ),
        ),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(harness.followUpStarted);
      expect(AsyncResult.isSuccess(harness.registry.get(summary))).toBe(true);
      yield* Deferred.succeed(finish, undefined);
      const result = yield* settledUsage(harness.registry, summary);
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") throw new Error("Expected saved usage");
      expect(result.value.buckets).toHaveLength(1);
      expect(result.value.sources).toEqual([
        {
          ...cursorSource(false),
          status: "partial",
          message: "Could not refresh this usage source. Showing its last values.",
        },
      ]);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("updates the same Usage query from five to twelve tokens after a partial follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness(
        (request) =>
          request === 2
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        (input) => [cursorSource(!input.awaitRefresh)],
        (request) =>
          request === 2
            ? { output: 5, partialReason: "scanTimedOut" }
            : { output: request === 1 ? 5 : 12 },
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      const current = harness.registry.get(summary);
      expect(AsyncResult.isSuccess(current) && current.value.buckets[0]?.totals.outputTokens).toBe(
        5,
      );
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 second");
      expect(
        (yield* settledSummary(harness.registry, summary)).buckets[0]?.totals.outputTokens,
      ).toBe(12);
      expect(harness.requests()).toBe(3);
      unmount();
    }),
  ),
);
