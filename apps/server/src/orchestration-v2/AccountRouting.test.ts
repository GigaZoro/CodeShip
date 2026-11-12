import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
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
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";

import { failoverLimitedLaunch, routeAutoAccount, usageBlock } from "./AccountRouting.ts";

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
  {
    name: "ChatGPT's app cap is tried again an hour after the refusal",
    refusal: { resetAt: "2026-11-18T08:00:00.000Z", appCap: true as const },
    at: "2026-11-08T00:30:00Z",
    until: "2026-11-08T01:00:00.000Z",
    estimated: true,
    hold: {
      heldUntil: "2026-11-08T01:00:00.000Z",
      estimated: true as const,
      appCap: true as const,
    },
  },
  {
    name: "ChatGPT's app cap holds no longer than the hour once the hour has passed",
    refusal: { resetAt: "2026-11-18T08:00:00.000Z", appCap: true as const },
    at: "2026-11-08T01:30:00Z",
    until: undefined,
    estimated: false,
    hold: { appCap: true as const },
  },
  {
    name: "a plan limit with a read reset holds until it",
    refusal: { resetAt: "2026-11-08T03:00:00.000Z" },
    at: "2026-11-08T01:30:00Z",
    until: "2026-11-08T03:00:00.000Z",
    estimated: false,
    hold: { heldUntil: "2026-11-08T03:00:00.000Z" },
  },
  {
    name: "a plan limit with no reset holds on T3's guess",
    refusal: { resetAt: null },
    at: "2026-11-08T01:30:00Z",
    until: "2026-11-08T05:00:00.000Z",
    estimated: true,
    hold: { heldUntil: "2026-11-08T05:00:00.000Z", estimated: true as const },
  },
  {
    name: "a used-up usage window holds the account by itself, so it lists no hold",
    refusal: { resetAt: null },
    at: "2026-11-08T01:30:00Z",
    usedPercent: 100,
    until: "2026-11-18T08:00:00.000Z",
    estimated: false,
    hold: undefined,
  },
])("limits and holds mark the end of a held account as read or estimated: $name", (row) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(row.at));
    const routing = yield* AccountRouting.AccountRouting;
    const limits = yield* routing.limits;
    assert.deepEqual([...limits.accounts], row.until === undefined ? [] : [[primary, row.until]]);
    assert.deepEqual([...limits.estimated], row.estimated ? [primary] : []);
    assert.deepEqual(
      yield* routing.holds,
      row.hold === undefined ? [] : [{ instanceId: primary, ...row.hold }],
    );
  }).pipe(
    Effect.provide(
      AccountRouting.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getUsageLimitedProviderInstances: () =>
                Effect.succeed(
                  new Map([[primary, [{ refusedAt: "2026-11-08T00:00:00.000Z", ...row.refusal }]]]),
                ),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                provider(primary, {
                  usageLimits: {
                    checkedAt: "2026-11-08T00:00:00Z",
                    windows: [
                      {
                        id: "secondary",
                        kind: "weekly",
                        label: "Weekly",
                        usedPercent: "usedPercent" in row ? row.usedPercent : 27,
                        resetsAt: "2026-11-18T08:00:00.000Z",
                        windowDurationMins: 10080,
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
    assert.equal(AccountRouting.runLiftsScope([scopedProvider()])(primary, "opus", model), lifts);
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

describe("failoverLimitedLaunch with a signed-out account", () => {
  const codex = ProviderInstanceId.make("codex");
  const pinned: ModelSelection = { instanceId: third, model: "claude-opus-5-5" };
  const launch = (input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly fallback?: ModelSelection | null;
  }) =>
    failoverLimitedLaunch({
      selection: pinned,
      projectId,
      providers: input.providers,
      settings: {
        ...settings([primary, second, third]),
        fallbackModelSelection: input.fallback ?? null,
      },
      recordedLimits: new Map(),
      nowMs,
    });
  const signedOut = provider(third, { status: "error", auth: { status: "unauthenticated" } });

  it("starts on the first other account of its driver that can run", () => {
    assert.equal(
      launch({ providers: [signedOut, provider(second), provider(primary)] }).instanceId,
      primary,
    );
  });

  it("skips another signed-out account", () => {
    const providers = [
      signedOut,
      provider(second),
      provider(primary, { status: "error", auth: { status: "unauthenticated" } }),
    ];
    assert.equal(launch({ providers }).instanceId, second);
  });

  it("uses the fallback model when no account of its driver can run", () => {
    const codexModel = {
      slug: "gpt-5.5",
      name: "GPT 5.5",
      isCustom: false,
      capabilities: null,
    };
    const providers = [
      signedOut,
      provider(second, { auth: { status: "unauthenticated" }, status: "error" }),
      provider(codex, { driver: ProviderDriverKind.make("codex"), models: [codexModel] }),
    ];
    assert.deepEqual(launch({ providers, fallback: { instanceId: codex, model: "gpt-5.5" } }), {
      instanceId: codex,
      model: "gpt-5.5",
    });
    // Without a fallback the launch stays where it is, so the sign-in shows on the account.
    assert.equal(launch({ providers }).instanceId, third);
  });

  it("does not hand a usage-limited account to the fallback", () => {
    assert.equal(
      failoverLimitedLaunch({
        selection: pinned,
        projectId,
        providers: [provider(third), provider(codex, { driver: ProviderDriverKind.make("codex") })],
        settings: {
          ...settings([primary, second, third]),
          fallbackModelSelection: { instanceId: codex, model: "gpt-5.5" },
        },
        recordedLimits: new Map([[third, [{ resetAt: null, refusedAt: "2026-11-03T11:00:00Z" }]]]),
        nowMs,
      }).instanceId,
      third,
    );
  });
});

describe("codexSignInChanges", () => {
  const codexAccount = (config: Record<string, unknown>, codexHome?: string) => ({
    driver: ProviderDriverKind.make("codex"),
    config,
    ...(codexHome === undefined
      ? {}
      : { environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }] }),
  });

  it.each([
    {
      name: "a move from CodeShip's ChatGPT sign-in to Codex's own login",
      before: { codex_work: codexAccount({ setupMode: "managed" }) },
      after: { codex_work: codexAccount({ setupMode: "existing" }) },
      changed: ["codex_work"],
    },
    {
      name: "the built-in account taking a private login it had no settings for",
      before: {},
      after: { codex: codexAccount({ privateLogin: true }) },
      changed: ["codex"],
    },
    {
      name: "another login home",
      before: { codex: codexAccount({ homePath: "/a" }) },
      after: { codex: codexAccount({ homePath: " /b " }) },
      changed: ["codex"],
    },
    {
      name: "another CODEX_HOME in the account's environment",
      before: { codex: codexAccount({}, "/a") },
      after: { codex: codexAccount({}, "/b") },
      changed: ["codex"],
    },
    {
      name: "no setting that keeps the login, even on its first save",
      before: {},
      after: { codex: codexAccount({ launchArgs: "--verbose", setupMode: "existing" }) },
      changed: [],
    },
    {
      name: "no other provider's home",
      before: {
        claudeAgent: { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: "/a" } },
      },
      after: {
        claudeAgent: { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: "/b" } },
      },
      changed: [],
    },
  ])("lists $name", ({ before, after, changed }) => {
    assert.deepEqual(AccountRouting.codexSignInChanges(before, after), changed);
  });
});

describe("releasing a held account", () => {
  const codex = ProviderInstanceId.make("codex");
  const settingsWith = (config: Record<string, unknown>): ServerSettingsValue => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [codex]: { driver: ProviderDriverKind.make("codex"), config } },
  });
  const routingLayer = (
    changes: Queue.Queue<ServerSettingsValue>,
    lifted: Queue.Queue<ProviderInstanceId>,
  ) =>
    AccountRouting.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settingsWith({ setupMode: "managed" })),
            subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            liftUsageLimitHolds: (instanceId) =>
              Queue.offer(lifted, instanceId).pipe(Effect.asVoid),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider(codex, { driver: ProviderDriverKind.make("codex") }),
            ]),
          }),
        ),
      ),
    );

  it.effect("only when this machine has the account", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ServerSettingsValue>();
      const lifted = yield* Queue.unbounded<ProviderInstanceId>();
      yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        const missing = yield* routing
          .retryAccount(ProviderInstanceId.make("codex_gone"))
          .pipe(Effect.flip);
        assert.instanceOf(missing, AccountRouting.UnknownAccountError);
        yield* routing.retryAccount(codex);
        assert.equal(yield* Queue.take(lifted), codex);
      }).pipe(Effect.provide(routingLayer(changes, lifted)));
    }),
  );

  it.effect("each time its sign-in moves to another login, and back", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ServerSettingsValue>();
      const lifted = yield* Queue.unbounded<ProviderInstanceId>();
      yield* Effect.gen(function* () {
        yield* AccountRouting.AccountRouting;
        yield* Queue.offerAll(changes, [
          settingsWith({ setupMode: "existing" }),
          settingsWith({ setupMode: "managed" }),
        ]);
        assert.deepEqual([yield* Queue.take(lifted), yield* Queue.take(lifted)], [codex, codex]);
      }).pipe(Effect.provide(routingLayer(changes, lifted)));
    }),
  );
});

describe("usageBlock", () => {
  const codexDriver = ProviderDriverKind.make("codex");
  const codexMain = ProviderInstanceId.make("codex_main");
  const codexSpare = ProviderInstanceId.make("codex_spare");
  const resets = new Map([
    [primary, "2026-11-03T15:00:00.000Z"],
    [second, "2026-11-03T14:00:00.000Z"],
    [third, "2026-11-03T16:00:00.000Z"],
    [codexMain, "2026-11-03T18:00:00.000Z"],
    [codexSpare, "2026-11-03T17:00:00.000Z"],
  ]);
  const base = settings([primary, second, third]);
  const block = (input: {
    readonly limited: ReadonlyArray<ProviderInstanceId>;
    readonly launches?: boolean;
    readonly switching?: boolean;
    readonly delegates?: ReadonlyArray<ProviderDriverKind>;
  }) =>
    usageBlock({
      selection: input.launches === false ? null : { instanceId: third, model: "claude-opus-5-5" },
      projectId,
      delegates: input.delegates ?? [],
      providers: [
        provider(third),
        provider(second),
        provider(primary),
        provider(codexMain, { driver: codexDriver }),
        provider(codexSpare, { driver: codexDriver }),
      ],
      settings: {
        ...base,
        providerInstances: {
          ...base.providerInstances,
          [codexMain]: { driver: codexDriver },
          [codexSpare]: { driver: codexDriver },
        },
        failoverLimitedThreads: input.switching ?? true,
      },
      recordedLimits: new Map(
        input.limited.map((id) => [
          id,
          [{ resetAt: resets.get(id) ?? null, refusedAt: "2026-11-03T11:00:00Z" }],
        ]),
      ),
      nowMs,
    });

  it.each([
    {
      name: "holds a launch while every account of its provider is out, until the first has room",
      input: { limited: [primary, second, third] },
      expected: {
        driver: claude,
        until: "2026-11-03T14:00:00.000Z",
        accounts: [third, second, primary],
      },
    },
    { name: "starts while any account has room", input: { limited: [third, primary] } },
    {
      name: "with switching off, judges the task's own account alone",
      input: { limited: [third], switching: false },
      expected: { driver: claude, until: "2026-11-03T16:00:00.000Z", accounts: [third] },
    },
    {
      name: "holds a run while every account of a delegate provider is out",
      input: { limited: [codexMain, codexSpare], delegates: [codexDriver] },
      expected: {
        driver: codexDriver,
        until: "2026-11-03T17:00:00.000Z",
        accounts: [codexMain, codexSpare],
      },
    },
    {
      name: "judges a run sent to an existing thread by its delegates alone",
      input: {
        limited: [primary, second, third, codexMain],
        launches: false,
        delegates: [codexDriver],
      },
    },
    {
      name: "names the provider that has room last",
      input: { limited: [primary, second, third, codexMain, codexSpare], delegates: [codexDriver] },
      expected: {
        driver: codexDriver,
        until: "2026-11-03T17:00:00.000Z",
        accounts: [third, second, primary, codexMain, codexSpare],
      },
    },
  ])("$name", ({ input, expected }) => {
    assert.deepEqual(block(input), expected ?? null);
  });
});

it.effect("reads a held account's usage at most hourly, and frees it once the usage has room", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    const lifted = yield* Ref.make(false);
    const reads = yield* Ref.make(0);
    const usage = (checkedAt: string, usedPercent: number) => ({
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session" as const,
          label: "5h",
          usedPercent,
          resetsAt: "2026-11-03T20:00:00.000Z",
        },
      ],
    });
    const layer = AccountRouting.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ providerInstances: { [primary]: { driver: claude } } }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitedProviderInstances: () =>
              Ref.get(lifted).pipe(
                Effect.map(
                  (done) =>
                    new Map(
                      done
                        ? []
                        : [
                            [
                              primary,
                              [
                                {
                                  refusedAt: "2026-11-03T11:00:00.000Z",
                                  resetAt: "2026-11-03T20:00:00.000Z",
                                },
                              ],
                            ],
                          ],
                    ),
                ),
              ),
            liftUsageLimitHolds: () => Ref.set(lifted, true),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider(primary, { usageLimits: usage("2026-11-03T10:00:00.000Z", 40) }),
            ]),
            // The first read still finds the window used up; the one an hour later finds room.
            refreshInstance: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(reads, (value) => value + 1);
                const now = DateTime.formatIso(yield* DateTime.now);
                return [provider(primary, { usageLimits: usage(now, count === 1 ? 100 : 30) })];
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const routing = yield* AccountRouting.AccountRouting;
      const check = routing.scheduledRunBlock({
        selection: { instanceId: primary, model: "claude-opus-5-5" },
        projectId,
        delegates: [],
      });
      assert.deepEqual(yield* check, {
        driver: claude,
        until: "2026-11-03T20:00:00.000Z",
        accounts: [primary],
      });
      yield* TestClock.adjust("59 minutes");
      assert.equal((yield* check)?.until, "2026-11-03T20:00:00.000Z");
      assert.equal(yield* Ref.get(reads), 1);

      yield* TestClock.adjust("1 minute");
      assert.equal(yield* check, null);
      assert.equal(yield* Ref.get(reads), 2);
    }).pipe(Effect.provide(layer));
  }),
);
