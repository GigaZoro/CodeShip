import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as AccountRouting from "./AccountRouting.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { failoverLimitedLaunch, routeAutoAccount } from "./AccountRouting.ts";

const nowMs = Date.parse("2026-11-03T12:00:00.000Z");
const projectId = ProjectId.make("project:routing");
const primary = ProviderInstanceId.make("claude_primary");
const second = ProviderInstanceId.make("claude_second");
const third = ProviderInstanceId.make("claude_third");

const provider = (instanceId: ProviderInstanceId, overrides: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T11:59:00.000Z",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        aliases: ["primary"],
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) satisfies ServerProvider;

const claude = ProviderDriverKind.make("claudeAgent");
const settings = (order: ReadonlyArray<ProviderInstanceId>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    order.map((instanceId) => [instanceId, { driver: claude }]),
  ),
  providerInstanceFailoverOrder: order,
  failoverLimitedThreads: true,
  autoModeProvider: claude,
});

const auto: ModelSelection = { instanceId: third, model: "claude-opus-5-5", autoAccount: true };

const route = (input: {
  readonly selection?: ModelSelection;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly limited?: ReadonlyArray<ProviderInstanceId>;
  readonly switching?: boolean;
}) =>
  routeAutoAccount({
    selection: input.selection ?? auto,
    projectId,
    currentInstanceId: input.currentInstanceId,
    started: input.currentInstanceId !== null,
    // Listed out of settings order, so the saved order decides.
    providers: [provider(third), provider(second), provider(primary)],
    settings: {
      ...settings([primary, second, third]),
      failoverLimitedThreads: input.switching ?? true,
    },
    recordedLimits: new Map(
      (input.limited ?? []).map((id) => [
        id,
        [{ resetAt: null, refusedAt: "2026-11-03T11:00:00Z" }],
      ]),
    ),
    nowMs,
  });

describe("routeAutoAccount", () => {
  it.each([
    ["a new thread starts on the primary account", null, [], primary],
    ["a new thread skips a limited primary", null, [primary], second],
    ["a thread stays on its account while it has room", second, [], second],
    ["a thread on a limited account moves to the highest with room", third, [third], primary],
    ["a thread stays put when every account is limited", second, [primary, second, third], second],
  ] as const)("%s", (_, currentInstanceId, limited, expected) => {
    assert.deepEqual(route({ currentInstanceId, limited }), {
      ...auto,
      instanceId: expected,
    });
  });

  it.each([
    ["a new thread starts on the primary account", null, primary],
    ["a thread stays on its account", third, third],
  ] as const)(
    "while account switching is off, %s even when it is limited",
    (_, current, expected) => {
      assert.deepEqual(
        route({ currentInstanceId: current, limited: [primary, third], switching: false }),
        { ...auto, instanceId: expected },
      );
    },
  );

  it("skips an account whose usage window is used up until it resets", () => {
    const exhausted = (resetsAt: string, id = "5h") =>
      routeAutoAccount({
        selection: { ...auto, instanceId: second },
        projectId,
        currentInstanceId: null,
        providers: [
          provider(primary, {
            usageLimits: {
              checkedAt: "2026-11-03T11:59:00.000Z",
              windows: [{ id, kind: "session", label: id, usedPercent: 100, resetsAt }],
            },
          }),
          provider(second),
        ],
        settings: settings([primary, second]),
        recordedLimits: new Map(),
        nowMs,
        started: false,
      }).instanceId;
    assert.equal(exhausted("2026-11-03T13:00:00.000Z"), second);
    assert.equal(exhausted("2026-11-03T11:00:00.000Z"), primary);
    // Opus still has room when only the Fable weekly window is full.
    assert.equal(exhausted("2026-11-03T13:00:00.000Z", "seven_day_fable"), primary);
  });

  describe("Auto models", () => {
    const codex = ProviderInstanceId.make("codex_main");
    const codexDriver = ProviderDriverKind.make("codex");
    const effort = (value: string) => [{ id: "effort", value }];
    const models = [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        aliases: ["primary"],
        isCustom: false,
        capabilities: null,
      },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
    ];
    const routeWith = (input: {
      readonly selection: ModelSelection;
      readonly currentInstanceId: ProviderInstanceId | null;
    }) =>
      routeAutoAccount({
        selection: input.selection,
        projectId,
        currentInstanceId: input.currentInstanceId,
        started: input.currentInstanceId !== null,
        providers: [
          provider(primary, { models }),
          provider(second, { models }),
          provider(codex, {
            driver: codexDriver,
            models: [
              { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
            ],
          }),
        ],
        settings: {
          ...settings([primary, second]),
          autoModeModels: {
            [claude]: { model: "claude-sonnet-5-5", options: effort("max") },
            [codexDriver]: { model: "gpt-6-astra", options: effort("ultra") },
          },
        },
        recordedLimits: new Map(
          [primary].map((id) => [id, [{ resetAt: null, refusedAt: "2026-11-03T11:00:00Z" }]]),
        ),
        nowMs,
      });

    it.each([
      [
        "a new thread runs the primary's Auto model and effort on the first account with room",
        { instanceId: codex, model: "gpt-5.5", autoAccount: true },
        null,
        { instanceId: second, model: "claude-sonnet-5-5", options: effort("max") },
      ],
      [
        "a thread runs its provider's Auto model, not an effort of its own",
        { instanceId: second, model: "claude-opus-5-5", options: effort("low"), autoAccount: true },
        second,
        { instanceId: second, model: "claude-sonnet-5-5", options: effort("max") },
      ],
      [
        "a thread that already ran keeps its provider",
        { instanceId: codex, model: "gpt-5.5", autoAccount: true },
        codex,
        { instanceId: codex, model: "gpt-6-astra", options: effort("ultra") },
      ],
    ] as const)("%s", (_, selection, currentInstanceId, expected) => {
      assert.deepEqual(routeWith({ selection, currentInstanceId }), {
        ...expected,
        autoAccount: true,
      });
    });
  });

  it("leaves a pinned selection on the account it names", () => {
    const pinned: ModelSelection = { instanceId: third, model: "claude-opus-5-5" };
    assert.strictEqual(
      route({ selection: pinned, currentInstanceId: null, limited: [third] }),
      pinned,
    );
  });
});

describe("failoverLimitedLaunch", () => {
  const pinned: ModelSelection = { instanceId: third, model: "claude-opus-5-5" };
  const launch = (input: {
    readonly selection?: ModelSelection;
    readonly limited: ReadonlyArray<ProviderInstanceId>;
    readonly switching?: boolean;
    readonly ownWindowFull?: boolean;
    readonly windowId?: string;
  }) =>
    failoverLimitedLaunch({
      selection: input.selection ?? pinned,
      projectId,
      providers: [
        provider(
          third,
          input.ownWindowFull === true
            ? {
                usageLimits: {
                  checkedAt: "2026-11-03T11:59:00.000Z",
                  windows: [
                    {
                      id: input.windowId ?? "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 100,
                      resetsAt: "2026-11-05T00:00:00.000Z",
                    },
                  ],
                },
              }
            : {},
        ),
        provider(second),
        provider(primary),
      ],
      settings: {
        ...settings([primary, second, third]),
        failoverLimitedThreads: input.switching ?? true,
      },
      recordedLimits: new Map(
        input.limited.map((id) => [id, [{ resetAt: null, refusedAt: "2026-11-03T11:00:00Z" }]]),
      ),
      nowMs,
    }).instanceId;

  it.each([
    ["moves off a limited account to the highest with room", [third], primary],
    ["skips other limited accounts", [third, primary], second],
    ["stays on its account while it has room", [primary], third],
    ["stays put when every account is limited", [primary, second, third], third],
  ] as const)("%s", (_, limited, expected) => {
    assert.equal(launch({ limited }), expected);
  });

  it("treats a used-up usage window as a limit", () => {
    assert.equal(launch({ limited: [], ownWindowFull: true }), primary);
    assert.equal(
      launch({
        limited: [],
        ownWindowFull: true,
        windowId: "seven_day_opus",
        selection: { ...pinned, model: "primary" },
      }),
      primary,
    );
  });

  it("leaves the account alone while account switching is off, and leaves Auto to its routing", () => {
    assert.equal(launch({ limited: [third], switching: false }), third);
    assert.equal(launch({ selection: auto, limited: [third] }), third);
  });
});

it.effect.each([
  { id: "5h", model: "claude-opus-5-5", resetsAt: undefined, limited: true, accountWide: true },
  {
    id: "5h",
    model: "claude-opus-5-5",
    resetsAt: "2099-01-01T00:00:00.000Z",
    limited: true,
    accountWide: true,
  },
  {
    id: "seven_day_opus",
    model: "claude-opus-5-5",
    resetsAt: undefined,
    limited: true,
    accountWide: false,
  },
  {
    id: "seven_day_opus",
    model: "primary",
    resetsAt: undefined,
    limited: true,
    accountWide: false,
  },
  {
    id: "seven_day_opus",
    model: "claude-sonnet-5-5",
    resetsAt: undefined,
    limited: false,
    accountWide: false,
  },
  {
    id: "5h",
    model: "claude-opus-5-5",
    resetsAt: undefined,
    limited: false,
    accountWide: false,
    // Five hours after the check that saw the window used up.
    at: "2026-11-08T05:00:00Z",
  },
])(
  "launchLimit and capabilities availability respect $id for $model (reset $resetsAt, limited $limited)",
  ({ id, model, resetsAt, limited, accountWide, ...row }) =>
    Effect.gen(function* () {
      // An hour after the check, so the hold must not move with the clock.
      yield* TestClock.setTime(Date.parse("at" in row ? row.at : "2026-11-08T01:00:00Z"));
      const routing = yield* AccountRouting.AccountRouting;
      const expected = {
        instanceId: primary,
        limitedUntil: resetsAt ?? "2026-11-08T05:00:00.000Z",
      };
      assert.deepEqual(
        yield* routing.launchLimit({
          projectId,

          selection: { instanceId: primary, model },
        }),
        limited ? expected : null,
      );
      assert.deepEqual(
        [...(yield* routing.limits).accounts],
        accountWide ? [[primary, resetsAt ?? "2026-11-08T05:00:00.000Z"]] : [],
      );
    }).pipe(
      Effect.provide(
        AccountRouting.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getUsageLimitedProviderInstances: () => Effect.succeed(new Map()),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([
                  provider(primary, {
                    usageLimits: {
                      checkedAt: "2026-11-08T00:00:00Z",
                      windows: [
                        {
                          id,
                          kind: "session",
                          label: id,
                          usedPercent: 100,
                          ...(resetsAt === undefined ? {} : { resetsAt }),
                        },
                      ],
                    },
                  }),
                ]),
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect.each([
  { name: "no reporting holds Auto and named launches", minutes: 1, limited: true },
  { name: "no reporting recovers at five hours", minutes: 300, limited: false },
  { name: "unavailable reporting recovers", minutes: 301, limited: false, unavailable: true },
  { name: "fresh room does not lift the hold", minutes: 1, limited: true, durations: [10_080, 60] },
  { name: "shortest window ends the hold", minutes: 60, limited: false, durations: [10_080, 60] },
  { name: "a weekly window holds five hours", minutes: 299, limited: true, durations: [10_080] },
  { name: "a weekly window ends at five hours", minutes: 300, limited: false, durations: [10_080] },
])("$name", (row) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs + row.minutes * 60_000);
    const current = provider(
      primary,
      "durations" in row || "unavailable" in row
        ? {
            usageLimits: {
              checkedAt: "2026-11-03T12:00:30Z",
              windows:
                "durations" in row
                  ? row.durations!.map((windowDurationMins) => ({
                      id: String(windowDurationMins),
                      kind: "session" as const,
                      label: "Session",
                      usedPercent: 10,
                      windowDurationMins,
                    }))
                  : [],
              ...("unavailable" in row ? { unavailable: { reason: "unsupported" as const } } : {}),
            },
          }
        : {},
    );
    const recordedLimits = new Map([
      [primary, [{ resetAt: null, refusedAt: "2026-11-03T12:00:00Z" }]],
    ]);
    const routing = yield* AccountRouting.AccountRouting.pipe(
      Effect.provide(
        AccountRouting.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getUsageLimitedProviderInstances: () => Effect.succeed(recordedLimits),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([current]),
              }),
            ),
          ),
        ),
      ),
    );
    for (const autoAccount of [true, false]) {
      assert.deepEqual(
        yield* routing.launchLimit({
          projectId,
          selection: { instanceId: primary, model: "primary", autoAccount },
        }),
        row.limited
          ? {
              instanceId: primary,
              limitedUntil: DateTime.formatIso(
                DateTime.makeUnsafe(nowMs + Math.min(300, ...(row.durations ?? [])) * 60_000),
              ),
            }
          : null,
      );
    }
    assert.equal(
      AccountRouting.modelWithRoom(current, {
        settings: settings([primary]),
        providers: [current],
        recordedLimits,
        nowMs: nowMs + row.minutes * 60_000,
        projectId,
        model: "primary",
      }),
      row.limited ? null : "claude-opus-5-5",
    );
  }),
);

describe("model-scoped refusals", () => {
  const refusedAt = "2026-11-03T11:59:00Z";
  const scopeWindow = (id: string, checkedAt: string, usedPercent: number) => ({
    usageLimits: {
      checkedAt,
      windows: [{ id, kind: "weekly" as const, label: id, usedPercent }],
    },
  });
  const scopedProvider = (overrides: Partial<ServerProvider> = {}) =>
    provider(primary, {
      models: [
        ...provider(primary).models,
        { slug: "claude-opus-4-8", name: "Opus 4.8", isCustom: false, capabilities: null },
        { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: null },
      ],
      ...overrides,
    });
  const roomFor = (
    refusal: Partial<ProjectionStore.RecordedUsageLimit>,
    overrides: Partial<ServerProvider> = {},
  ) => {
    const current = scopedProvider(overrides);
    const context = {
      settings: settings([primary]),
      providers: [current],
      projectId,
      nowMs,
      recordedLimits: new Map([
        [primary, [{ resetAt: null, refusedAt, modelScope: "opus", ...refusal }]],
      ]),
    };
    return ["primary", "claude-opus-4-8", "claude-sonnet-5-5"].map((model) =>
      AccountRouting.modelWithRoom(current, { ...context, model }),
    );
  };
  const held = [null, null, "claude-sonnet-5-5"];

  it.each([
    ["a later run of another model keeps it", "claude-sonnet-5-5", false],
    ["a later run in its scope lifts it", "claude-opus-4-8", true],
    ["a later run by alias lifts it", "primary", true],
  ] as const)("%s", (_, model, lifts) => {
    assert.equal(
      AccountRouting.completedRunLiftsScope([scopedProvider()])(primary, "opus", model),
      lifts,
    );
  });

  it.each([
    ["holds every model of its scope and no other", {}, {}, held],
    [
      // A partial update can refresh `checkedAt` while this bar is stale, so it proves nothing.
      "a newer check with room in its window keeps it",
      {},
      scopeWindow("seven_day_opus", "2026-11-03T12:00:00Z", 40),
      held,
    ],
    [
      "an older check with room keeps it",
      {},
      scopeWindow("seven_day_opus", "2026-11-03T11:58:00Z", 40),
      held,
    ],
    [
      "a newer check with room in another window keeps it",
      {},
      scopeWindow("seven_day_sonnet", "2026-11-03T12:00:00Z", 40),
      held,
    ],
  ] as const)("%s", (_, refusal, overrides, expected) => {
    assert.deepEqual(roomFor(refusal, overrides), expected);
  });
});
