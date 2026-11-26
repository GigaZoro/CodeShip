// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as SqlClient from "effect/sql/SqlClient";
import * as AccountRouting from "./AccountRouting.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type ProviderMcpServer,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type CodexCreditSpending,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";

import {
  type AccountRoutingContext,
  accountsWithRoom,
  automaticAccountEligibility,
  failoverLimitedLaunch,
  routeAutoAccount,
  usageBlock,
} from "./AccountRouting.ts";

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

const THREADPAGE = "threadpage";
const signIns = (needing: ReadonlyArray<ProviderInstanceId> = []) =>
  new Map(needing.map((instanceId) => [instanceId, [THREADPAGE]]));

const route = (input: {
  readonly selection?: ModelSelection;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly limited?: ReadonlyArray<ProviderInstanceId>;
  readonly needingSignIn?: ReadonlyArray<ProviderInstanceId>;
  readonly switching?: boolean;
  readonly signedOut?: ReadonlyArray<ProviderInstanceId>;
  /** Accounts limited until a reset the provider reported. */
  readonly limitedUntil?: ReadonlyArray<readonly [ProviderInstanceId, string]>;
  /** API-key accounts, which have no usage limits. */
  readonly metered?: ReadonlyArray<ProviderInstanceId>;
}) =>
  routeAutoAccount({
    selection: input.selection ?? auto,
    projectId,
    currentInstanceId: input.currentInstanceId,
    mcpSignInsNeeded: signIns(input.needingSignIn),
    started: input.currentInstanceId !== null,
    // Listed out of settings order, so the saved order decides.
    providers: [third, second, primary].map((id) =>
      provider(id, {
        auth: {
          status: input.signedOut?.includes(id) === true ? "unauthenticated" : "authenticated",
          ...(input.metered?.includes(id) === true ? { type: "apiKey" } : {}),
        },
      }),
    ),
    settings: {
      ...settings([primary, second, third]),
      failoverLimitedThreads: input.switching ?? true,
    },
    recordedLimits: new Map(
      [
        ...(input.limited ?? []).map((id) => [id, null] as const),
        ...(input.limitedUntil ?? []),
      ].map(([id, resetAt]) => [id, [{ resetAt, refusedAt: "2026-11-03T11:00:00Z" }]] as const),
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

  // Every account is limited here, in reverse of the saved order: third gets room first.
  const limitedUntil = [
    [primary, "2026-11-03T15:00:00.000Z"],
    [second, "2026-11-03T14:00:00.000Z"],
    [third, "2026-11-03T13:00:00.000Z"],
  ] as const;
  it.each([
    ["a new thread skips a signed-out primary", null, [primary], [], second],
    ["a thread leaves a signed-out account for the highest with room", third, [third], [], primary],
    [
      "a new thread with every account limited starts where a limit ends first",
      null,
      [],
      limitedUntil,
      third,
    ],
    [
      "a new thread with every account limited skips a signed-out one",
      null,
      [third],
      limitedUntil,
      second,
    ],
    [
      "a thread on a signed-out account moves to where a limit ends first",
      third,
      [third],
      limitedUntil,
      second,
    ],
    [
      "a thread on a limited account that can still run stays put",
      second,
      [],
      limitedUntil,
      second,
    ],
    [
      "a new thread stays named when no account can run",
      null,
      [primary, second, third],
      [],
      primary,
    ],
    [
      "a thread on an API-key account stays while every subscription is limited",
      primary,
      [],
      limitedUntil,
      primary,
      [primary],
    ],
    [
      "a new thread starts on a first API-key account while every subscription is limited",
      null,
      [],
      limitedUntil,
      primary,
      [primary],
    ],
  ] as const)(
    "%s",
    (
      _,
      currentInstanceId,
      signedOut,
      until,
      expected,
      metered: ReadonlyArray<ProviderInstanceId> = [],
    ) => {
      assert.deepEqual(route({ currentInstanceId, signedOut, limitedUntil: until, metered }), {
        ...auto,
        instanceId: expected,
      });
    },
  );

  it("never picks a limited account while one has room, or a signed-out one while one can run", () => {
    const accounts = [primary, second, third];
    const states = ["room", "limited", "signedOut"] as const;
    const mixes = states.flatMap((a) => states.flatMap((b) => states.map((c) => [a, b, c])));
    for (const mix of mixes) {
      const inState = (state: (typeof states)[number]) =>
        accounts.filter((_, index) => mix[index] === state);
      const best = Math.min(...mix.map((state) => states.indexOf(state)));
      for (const currentInstanceId of [null, ...accounts]) {
        const { instanceId } = route({
          currentInstanceId,
          signedOut: inState("signedOut"),
          limitedUntil: inState("limited").map((id) => [id, "2026-11-03T13:00:00.000Z"] as const),
        });
        const picked = mix[accounts.indexOf(instanceId)];
        assert.strictEqual(
          picked === undefined ? -1 : states.indexOf(picked),
          best,
          `${mix.join(",")} from ${currentInstanceId ?? "a new thread"}`,
        );
      }
    }
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

  it.each([
    [
      "a new thread starts on the first account whose sign-ins are in place",
      null,
      [primary],
      second,
    ],
    [
      "a thread leaves an account that must sign in again for one that need not",
      third,
      [third],
      primary,
    ],
    [
      "a thread stays when every account must sign in again",
      third,
      [primary, second, third],
      third,
    ],
    ["a thread on an account with its sign-ins in place stays", third, [primary], third],
  ] as const)("%s", (_, currentInstanceId, needingSignIn, expected) => {
    assert.deepEqual(route({ currentInstanceId, needingSignIn }), {
      ...auto,
      instanceId: expected,
    });
  });

  it("stays on an account that must sign in again while account switching is off", () => {
    assert.deepEqual(
      route({ currentInstanceId: third, needingSignIn: [third], switching: false }),
      { ...auto, instanceId: third },
    );
  });

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
        mcpSignInsNeeded: signIns(),
        recordedLimits: new Map(),
        nowMs,
        started: false,
      }).instanceId;
    assert.equal(exhausted("2026-11-03T13:00:00.000Z"), second);
    assert.equal(exhausted("2026-11-03T11:00:00.000Z"), primary);
    // Opus still has room when only the Fable weekly window is full.
    assert.equal(exhausted("2026-11-03T13:00:00.000Z", "seven_day_fable"), primary);
  });

  it.each([
    ["a scheduled run takes the account whose weekly usage resets first", true, third],
    ["any other run follows the saved order", false, primary],
  ] as const)("%s", (_, scheduled, expected) => {
    const weekly = (resetsAt: string, id = "seven_day") => ({
      usageLimits: {
        checkedAt: "2026-11-03T11:59:00.000Z",
        windows: [{ id, kind: "weekly" as const, label: id, usedPercent: 50, resetsAt }],
      },
    });
    const routed = routeAutoAccount({
      selection: auto,
      projectId,
      currentInstanceId: null,
      providers: [
        provider(primary, weekly("2026-11-08T00:00:00.000Z")),
        // Fable's own weekly meter does not hold Opus, so it does not move this account up.
        provider(second, weekly("2026-11-04T00:00:00.000Z", "seven_day_fable")),
        provider(third, weekly("2026-11-05T00:00:00.000Z")),
      ],
      settings: settings([primary, second, third]),
      mcpSignInsNeeded: signIns(),
      recordedLimits: new Map(),
      nowMs,
      started: false,
      scheduled,
    });
    assert.equal(routed.instanceId, expected);
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
    // The second account lists the same model under an id of its own.
    const secondModels = [
      models[0]!,
      { slug: "sonnet-5-5-latest", name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
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
        mcpSignInsNeeded: signIns(),
        providers: [
          provider(primary, { models }),
          provider(second, { models: secondModels }),
          provider(codex, {
            driver: codexDriver,
            models: [
              { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
            ],
          }),
        ],
        settings: {
          ...settings([primary, second]),
          providerInstances: {
            ...settings([primary, second]).providerInstances,
            [codex]: { driver: codexDriver },
          },
          autoModeModels: {
            [claude]: { model: "Claude Sonnet 5.5", options: effort("max") },
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
        { instanceId: second, model: "sonnet-5-5-latest", options: effort("max") },
      ],
      [
        "a thread runs its provider's Auto model, not an effort of its own",
        { instanceId: second, model: "claude-opus-5-5", options: effort("low"), autoAccount: true },
        second,
        { instanceId: second, model: "sonnet-5-5-latest", options: effort("max") },
      ],
      [
        "a thread on a limited account moves to the id the next account lists",
        { instanceId: primary, model: "claude-opus-5-5", autoAccount: true },
        primary,
        { instanceId: second, model: "sonnet-5-5-latest", options: effort("max") },
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
    readonly needingSignIn?: ReadonlyArray<ProviderInstanceId>;
    readonly switching?: boolean;
    readonly ownWindowFull?: boolean;
    readonly windowId?: string;
  }) =>
    failoverLimitedLaunch({
      selection: input.selection ?? pinned,
      projectId,
      mcpSignInsNeeded: signIns(input.needingSignIn),
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
    });
  const launchOn = (input: Parameters<typeof launch>[0]) => launch(input).selection.instanceId;

  it.each([
    ["moves off a limited account to the highest with room", [third], primary],
    ["skips other limited accounts", [third, primary], second],
    ["stays on its account while it has room", [primary], third],
    ["stays put when every account is limited", [primary, second, third], third],
  ] as const)("%s", (_, limited, expected) => {
    assert.equal(launchOn({ limited }), expected);
  });

  it.each([
    ["moves off an account that must sign in again to one that need not", [third], [], primary],
    [
      "leaves a limited account for the first with its sign-ins in place",
      [third],
      [primary],
      second,
    ],
    ["stays when every account must sign in again", [], [primary, second, third], third],
  ] as const)("%s", (_, limited, needingSignIn, expected) => {
    assert.equal(launchOn({ limited, needingSignIn }), expected);
  });

  it("says why it moved", () => {
    assert.deepEqual(launch({ limited: [third] }).failover, { reason: "usageLimit" });
    assert.deepEqual(launch({ limited: [], needingSignIn: [third] }).failover, {
      reason: "mcpSignIn",
      mcpServers: [THREADPAGE],
    });
    assert.isNull(launch({ limited: [] }).failover);
  });

  it("treats a used-up usage window as a limit", () => {
    assert.equal(launchOn({ limited: [], ownWindowFull: true }), primary);
    assert.equal(
      launchOn({
        limited: [],
        ownWindowFull: true,
        windowId: "seven_day_opus",
        selection: { ...pinned, model: "primary" },
      }),
      primary,
    );
  });

  it("leaves the account alone while account switching is off, and leaves Auto to its routing", () => {
    assert.equal(launchOn({ limited: [third], switching: false }), third);
    assert.equal(launchOn({ selection: auto, limited: [third] }), third);
    assert.equal(launchOn({ limited: [], needingSignIn: [third], switching: false }), third);
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
        [...(yield* routing.limits()).accounts],
        accountWide ? [[primary, resetsAt ?? "2026-11-08T05:00:00.000Z"]] : [],
      );
    }).pipe(
      Effect.provide(
        AccountRouting.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderMcp.ProviderMcp)({}),
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
    const limits = yield* routing.limits();
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
            Layer.mock(ProviderMcp.ProviderMcp)({}),
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
              Layer.mock(ProviderMcp.ProviderMcp)({}),
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
      mcpSignInsNeeded: signIns(),
      recordedLimits: new Map(),
      nowMs,
    }).selection;
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
        mcpSignInsNeeded: signIns(),
        recordedLimits: new Map([[third, [{ resetAt: null, refusedAt: "2026-11-03T11:00:00Z" }]]]),
        nowMs,
      }).selection.instanceId,
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
      name: "a later CODEX_HOME in another case, which Windows reads",
      platform: "win32" as const,
      before: { codex: codexAccount({}, "/a") },
      after: {
        codex: {
          ...codexAccount({}, "/a"),
          environment: [
            { name: "CODEX_HOME", value: "/a", sensitive: false },
            { name: "codex_home", value: "/b", sensitive: false },
          ],
        },
      },
      changed: ["codex"],
    },
    {
      name: "no other spelling of CODEX_HOME, which Linux does not read",
      before: { codex: codexAccount({}, "/a") },
      after: {
        codex: {
          ...codexAccount({}, "/a"),
          environment: [
            { name: "CODEX_HOME", value: "/a", sensitive: false },
            { name: "codex_home", value: "/b", sensitive: false },
          ],
        },
      },
      changed: [],
    },
    {
      name: "no CODEX_HOME that a later one overrides",
      platform: "win32" as const,
      before: {
        codex: {
          ...codexAccount({}),
          environment: [
            { name: "codex_home", value: "/a", sensitive: false },
            { name: "CODEX_HOME", value: "/c", sensitive: false },
          ],
        },
      },
      after: {
        codex: {
          ...codexAccount({}),
          environment: [
            { name: "codex_home", value: "/b", sensitive: false },
            { name: "CODEX_HOME", value: "/c", sensitive: false },
          ],
        },
      },
      changed: [],
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
  ])("lists $name", ({ before, after, changed, platform }) => {
    assert.deepEqual(
      AccountRouting.codexSignInChanges(before, after, platform ?? "linux"),
      changed,
    );
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
          Layer.mock(ProviderMcp.ProviderMcp)({}),
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

describe("cross-provider launch routing", () => {
  const codex = ProviderDriverKind.make("codex");
  const muse = ProviderDriverKind.make("muse");
  const codexMain = ProviderInstanceId.make("codex_main");
  const codexSpare = ProviderInstanceId.make("codex_spare");
  const museMain = ProviderInstanceId.make("muse_main");
  const named = { instanceId: primary, model: auto.model };
  const codexPick = { instanceId: codexMain, model: "gpt-explicit" };
  const musePick = { instanceId: museMain, model: "muse-explicit" };
  const claudeReset = "2026-11-05T00:00:00.000Z";
  const codexReset = "2026-11-04T00:00:00.000Z";
  const fallbackProvider = (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    models: ReadonlyArray<string>,
    resetsAt: string,
  ) =>
    provider(instanceId, {
      driver,
      models: models.map((slug) => ({ ...provider(primary).models[0]!, slug, aliases: [] })),
      usageLimits: {
        checkedAt: "2026-11-03T11:59:00.000Z",
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt }],
      },
    });

  const input = (limited: ReadonlyArray<ProviderInstanceId> = [primary, second]) => ({
    selection: named,
    projectId,
    nowMs,
    scheduled: true,
    mcpSignInsNeeded: signIns(),
    providers: [
      provider(primary),
      provider(second),
      fallbackProvider(codexMain, codex, ["gpt-auto", codexPick.model], claudeReset),
      fallbackProvider(codexSpare, codex, ["gpt-auto", codexPick.model], codexReset),
      fallbackProvider(museMain, muse, [musePick.model], claudeReset),
    ],
    settings: {
      ...settings([primary, second, codexMain, codexSpare, museMain]),
      autoModeModels: { codex: { model: "gpt-auto" }, muse: { model: musePick.model } },
      providerInstances: {
        ...settings([primary, second]).providerInstances,
        [codexMain]: { driver: codex, enabled: true },
        [codexSpare]: { driver: codex, enabled: true },
        [museMain]: { driver: muse, enabled: true },
      },
    },
    recordedLimits: new Map(
      limited.map((id) => [
        id,
        [
          {
            resetAt: id === codexSpare ? codexReset : claudeReset,
            refusedAt: "2026-11-03T11:00:00Z",
          },
        ],
      ]),
    ),
  });

  it.each([
    {
      name: "takes the first configured alternative",
      alternatives: [musePick, codexPick],
      expected: musePick,
    },
    {
      name: "moves on when the first alternative is limited",
      alternatives: [musePick, codexPick],
      limited: [primary, second, museMain],
      expected: codexPick,
    },
    {
      name: "passes over a disabled alternative",
      alternatives: [musePick, codexPick],
      disabled: museMain,
      expected: codexPick,
    },
    {
      name: "tries the named alternative's model on another account with room",
      alternatives: [codexPick, musePick],
      limited: [primary, second, codexMain],
      expected: { ...codexPick, instanceId: codexSpare },
    },
    {
      name: "uses the other provider's Auto model without a configured alternative",
      alternatives: [],
      expected: { instanceId: codexSpare, model: "gpt-auto" },
    },
  ])("$name and admits the scheduled run", ({ alternatives, limited, disabled, expected }) => {
    const base = input(limited);
    const context = {
      ...base,
      settings: {
        ...base.settings,
        projectSettingsOverrides:
          disabled === undefined
            ? {}
            : { [projectId]: { providerInstances: { [disabled]: { enabled: false } } } },
      },
      fallbackModelSelections: alternatives,
    };
    assert.include(failoverLimitedLaunch(context).selection, expected);
    assert.isNull(usageBlock({ ...context, delegates: [] }));
  });

  it("reports the earliest return of room across providers", () => {
    assert.include(
      usageBlock({
        ...input([primary, second, codexMain, codexSpare, museMain]),
        delegates: [],
      }),
      { driver: codex, until: codexReset },
    );
  });

  it("keeps all limited accounts in the Auto wait when they advertise different model IDs", () => {
    const base = input([primary, second, codexMain, codexSpare, museMain]);
    const block = usageBlock({
      ...base,
      selection: auto,
      providers: base.providers.map((account) =>
        account.instanceId === second
          ? {
              ...account,
              models: account.models.map((model) => ({ ...model, slug: "other-opus-id" })),
            }
          : account,
      ),
      settings: {
        ...base.settings,
        autoModeModels: { ...base.settings.autoModeModels, [claude]: { model: "primary" } },
      },
      delegates: [],
    });
    assert.includeMembers([...(block?.accounts ?? [])], [primary, second]);
  });
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
          Layer.mock(ProviderMcp.ProviderMcp)({}),
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

it.effect.each([
  {
    name: "frees it on the first read whose app-server says usage is allowed",
    answers: [false, true],
    usedPercent: 20,
    freed: true,
  },
  {
    name: "leaves it to the hourly path while the app-server gives no answer",
    answers: [null, undefined],
    usedPercent: 20,
    freed: false,
  },
  {
    name: "believes the app-server's yes over a window it still shows at 100%",
    answers: [false, true],
    usedPercent: 100,
    freed: true,
  },
  {
    // A failed read keeps the last one, whose yes predates the refusal.
    name: "does not believe a yes read before the refusal that a streamed update carried past it",
    answers: [false, true],
    usedPercent: 20,
    freed: false,
    readBeforeRefusal: true,
  },
] as const)(
  "reads a held Codex account every ten minutes: $name",
  ({ answers, usedPercent, freed, ...row }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
      const codexAccount = ProviderInstanceId.make("codex_main");
      const codexDriver = ProviderDriverKind.make("codex");
      const lifted = yield* Ref.make<string | null>(null);
      const reads = yield* Ref.make(0);
      // What the app-server answers to account/rateLimits/read on each read.
      const appServerRead = (allowed: boolean | null | undefined) => ({
        rateLimits: { primary: { usedPercent, windowDurationMins: 300 } },
        ...(allowed === undefined ? {} : { ordinaryUsageAllowed: allowed }),
      });
      const codexProvider = (usageLimits?: ServerProvider["usageLimits"]) =>
        provider(codexAccount, { driver: codexDriver, ...(usageLimits ? { usageLimits } : {}) });
      const latest = yield* Ref.make(codexProvider());
      const layer = AccountRouting.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderMcp.ProviderMcp)({}),
            ServerSettings.layerTest({
              providerInstances: { [codexAccount]: { driver: codexDriver } },
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getUsageLimitedProviderInstances: () =>
                Ref.get(lifted).pipe(
                  Effect.map(
                    (done) =>
                      new Map(
                        done !== null
                          ? []
                          : [
                              [
                                codexAccount,
                                [
                                  {
                                    refusedAt: "2026-11-03T11:55:00.000Z",
                                    resetAt: "2026-11-03T20:00:00.000Z",
                                  },
                                ],
                              ],
                            ],
                      ),
                  ),
                ),
              liftUsageLimitHolds: (_, at) => Ref.set(lifted, DateTime.formatIso(at)),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Ref.get(latest).pipe(Effect.map((entry) => [entry])),
              refreshInstance: () =>
                Effect.gen(function* () {
                  const count = yield* Ref.updateAndGet(reads, (value) => value + 1);
                  // A reading taken a minute ago, as a cached one is.
                  const readAt = DateTime.formatIso(
                    DateTime.subtract(yield* DateTime.now, { minutes: 1 }),
                  );
                  const read = appServerRead(answers[count - 1]);
                  const limits = codexRateLimitsToLimits({
                    read,
                    checkedAt: "readBeforeRefusal" in row ? "2026-11-03T11:50:00.000Z" : readAt,
                  });
                  const next = codexProvider(
                    "readBeforeRefusal" in row
                      ? { ...limits, checkedAt: readAt, accountReadAt: limits.checkedAt }
                      : limits,
                  );
                  yield* Ref.set(latest, next);
                  return [next];
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        // Ten minutes after the refusal is the first read.
        yield* TestClock.adjust("4 minutes");
        assert.isFalse(yield* routing.releaseAllowedHolds);
        assert.equal(yield* Ref.get(reads), 0);

        yield* TestClock.adjust("1 minute");
        assert.isFalse(yield* routing.releaseAllowedHolds);
        assert.equal(yield* Ref.get(reads), 1);
        assert.isNull(yield* Ref.get(lifted));

        yield* TestClock.adjust("9 minutes");
        assert.isFalse(yield* routing.releaseAllowedHolds);
        assert.equal(yield* Ref.get(reads), 1);

        yield* TestClock.adjust("1 minute");
        assert.equal(yield* routing.releaseAllowedHolds, freed);
        assert.equal(yield* Ref.get(reads), 2);
        // The lift ends at the reading, so a refusal after it still holds.
        assert.equal(yield* Ref.get(lifted), freed ? "2026-11-03T12:14:00.000Z" : null);
        // A freed account is one routing may send work to again.
        assert.equal((yield* routing.limits()).accounts.has(codexAccount), !freed);
      }).pipe(Effect.provide(layer));
    }),
);

describe("accountsWithRoom", () => {
  const room = (
    needingSignIn: ReadonlyArray<ProviderInstanceId>,
  ): ReadonlyArray<ProviderInstanceId> =>
    accountsWithRoom({
      driver: claude,
      projectId,
      model: "claude-opus-5-5",
      providers: [provider(third), provider(second), provider(primary)],
      settings: settings([primary, second, third]),
      recordedLimits: new Map(),
      mcpSignInsNeeded: signIns(needingSignIn),
      nowMs,
    }).map((account) => account.instanceId);

  it.each([
    ["keeps the saved order when every sign-in is in place", [], [primary, second, third]],
    [
      "puts accounts that must sign in again last, in their order",
      [primary, third],
      [second, primary, third],
    ],
  ] as const)("%s", (_, needingSignIn, expected) => {
    assert.deepEqual(room(needingSignIn), expected);
  });
});

describe("verified funding for automatic admission", () => {
  const antigravity = ProviderDriverKind.make("antigravity");
  const custom = ProviderDriverKind.make("custom-local-agent");
  const weeklyReset = "2026-11-06T00:00:00.000Z";

  it.effect("verifies the resolved model in the launch worktree before selecting the account", () =>
    Effect.gen(function* () {
      const routing = yield* AccountRouting.AccountRouting;
      const request = {
        projectId,
        driver: claude,
        model: auto.model,
        funding: "verified" as const,
      };
      assert.lengthOf(yield* routing.accountsWithRoom(request), 0);
      assert.lengthOf(yield* routing.accountsWithRoom({ ...request, cwd: "/root" }), 0);
      assert.deepEqual(
        (yield* routing.accountsWithRoom({ ...request, cwd: "/worktree" })).map(
          (entry) => entry.instanceId,
        ),
        [primary],
      );
    }).pipe(
      Effect.provide(
        AccountRouting.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(settings([primary])),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getUsageLimitedProviderInstances: () => Effect.succeed(new Map()),
              }),
              Layer.mock(ProviderMcp.ProviderMcp)({
                discover: () => Effect.succeedNone,
                listLoaded: () => Effect.succeedNone,
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([
                  provider(primary, {
                    auth: { status: "authenticated", fundingScope: "workspace" },
                  }),
                ]),
                fundingForWorkspace: ({ cwd, provider, model }) =>
                  Effect.succeed(
                    cwd === "/worktree" && provider.instanceId === primary && model === auto.model
                      ? "included"
                      : "metered",
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.each([
    {
      name: "Google OAuth without usage metrics",
      driver: antigravity,
      authType: "oauth-personal",
      funding: "included",
      admits: true,
    },
    {
      name: "Gemini key",
      driver: antigravity,
      authType: "gemini-api-key",
      funding: "metered",
      admits: false,
    },
    {
      name: "Agent Platform",
      driver: antigravity,
      authType: "agent-platform",
      funding: "metered",
      admits: false,
    },
    {
      name: "workspace funding without a destination check",
      driver: custom,
      funding: "included",
      workspaceScoped: true,
      admits: false,
    },
    {
      name: "verified funding in this worktree",
      driver: custom,
      funding: "unknown",
      workspaceScoped: true,
      verified: "included",
      admits: true,
    },
    {
      name: "a metered workspace on an otherwise included account",
      driver: custom,
      funding: "included",
      workspaceScoped: true,
      verified: "metered",
      admits: false,
    },
    {
      name: "a retained model with unknown funding in an included workspace",
      driver: custom,
      funding: "unknown",
      workspaceScoped: true,
      verified: "included",
      modelFunding: "unknown",
      admits: false,
    },
    {
      name: "a custom adapter with an included model",
      driver: custom,
      modelFunding: "included",
      admits: true,
    },
    {
      name: "a custom adapter with OAuth and no payer declaration",
      driver: custom,
      authType: "oauth-personal",
      admits: false,
    },
    {
      name: "a known driver with an unidentified payer",
      driver: claude,
      authType: "customEndpoint",
      admits: false,
    },
    {
      name: "a metered model on an included account",
      driver: custom,
      funding: "included",
      modelFunding: "metered",
      admits: false,
    },
    {
      name: "an included account disabled in the project",
      driver: custom,
      funding: "included",
      disabled: true,
      admits: false,
    },
    {
      name: "an included account held after a refusal with no metrics",
      driver: custom,
      funding: "included",
      held: true,
      admits: false,
    },
    {
      name: "an included account whose provider refused ordinary usage without a reset",
      driver: custom,
      funding: "included",
      ordinaryUsageRefused: true,
      admits: false,
    },
  ] as const)("admits $name only with verified funding and room", (row) => {
    const account = provider(primary, {
      driver: row.driver,
      auth: {
        status: "authenticated",
        ...("authType" in row ? { type: row.authType } : {}),
        ...("workspaceScoped" in row ? { fundingScope: "workspace" as const } : {}),
        ...("funding" in row ? { funding: row.funding } : {}),
      },
      models: provider(primary).models.map((model) => ({
        ...model,
        ...("modelFunding" in row ? { funding: row.modelFunding } : {}),
      })),
      ...("ordinaryUsageRefused" in row
        ? {
            usageLimits: {
              checkedAt: provider(primary).checkedAt,
              usageAllowed: false,
              windows: [],
            },
          }
        : {}),
    });
    const context = {
      providers: [account],
      ...("verified" in row ? { workspaceFunding: new Map([[primary, row.verified]]) } : {}),
      settings: {
        ...settings([primary]),
        providerInstances: { [primary]: { driver: row.driver, enabled: true } },
        projectSettingsOverrides:
          "disabled" in row
            ? { [projectId]: { providerInstances: { [primary]: { enabled: false } } } }
            : {},
      },
      nowMs,
      recordedLimits: new Map(
        "held" in row
          ? [[primary, [{ resetAt: weeklyReset, refusedAt: "2026-11-03T11:00:00Z" }]]]
          : [],
      ),
      projectId,
      driver: row.driver,
      model: auto.model,
      mcpSignInsNeeded: signIns(),
      funding: "verified" as const,
    };
    assert.deepEqual(
      accountsWithRoom(context).map(({ instanceId }) => instanceId),
      row.admits ? [primary] : [],
    );
    if ("ordinaryUsageRefused" in row) {
      assert.deepEqual(automaticAccountEligibility(account, context), {
        kind: "usage_limited",
        model: auto.model,
        onCredits: false,
        limitedUntilMs: null,
      });
    }
  });
});

describe("prepaid Codex credits", () => {
  const codexDriver = ProviderDriverKind.make("codex");
  const paid = ProviderInstanceId.make("codex_paid");
  const spare = ProviderInstanceId.make("codex_spare");
  const model = "gpt-5.5";
  const weeklyReset = "2026-11-06T00:00:00.000Z";
  const epochSeconds = (iso: string) => Date.parse(iso) / 1000;
  // What Codex's app-server answers for an account: by default the one that was refused child
  // tasks, its weekly window used up and ordinary usage refused, with credits left.
  const codexAccount = (
    instanceId: ProviderInstanceId,
    read: {
      readonly weeklyUsed?: number;
      /** Null: the account has no credits. */
      readonly balance?: string | null;
      readonly creditLimitLeft?: number;
      readonly checkedAt?: string;
    } = {},
  ) =>
    provider(instanceId, {
      driver: codexDriver,
      auth: { status: "authenticated", type: "chatgpt", funding: "included" },
      models: [{ ...provider(primary).models[0]!, slug: model, aliases: [] }],
      usageLimits: codexRateLimitsToLimits({
        checkedAt: read.checkedAt ?? "2026-11-03T11:59:00.000Z",
        read: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 10, windowDurationMins: 300 },
            secondary: {
              usedPercent: read.weeklyUsed ?? 100,
              windowDurationMins: 10_080,
              resetsAt: epochSeconds(weeklyReset),
            },
            ...(read.creditLimitLeft === undefined
              ? {}
              : {
                  individualLimit: {
                    remainingPercent: read.creditLimitLeft,
                    resetsAt: epochSeconds("2026-12-01T00:00:00.000Z"),
                  },
                }),
            credits:
              read.balance === null
                ? { hasCredits: false, unlimited: false }
                : { balance: read.balance ?? "25.00", hasCredits: true, unlimited: false },
          },
          ordinaryUsageAllowed: (read.weeklyUsed ?? 100) < 100,
        },
      }),
    });
  const allowed = ThreadId.make("thread:allowed");
  const delegate = ThreadId.make("thread:allowed-delegate");
  const fork = ThreadId.make("thread:allowed-fork");
  const other = ThreadId.make("thread:other");
  const cap: CodexCreditSpending = { capCredits: 3000 };
  const scopedCap: CodexCreditSpending = { capCredits: 3000, threadIds: [allowed] };
  const instancesFor = (
    optedIn: ReadonlyArray<ProviderInstanceId>,
    allowance: CodexCreditSpending = cap,
  ) =>
    Object.fromEntries(
      [paid, spare].map((id) => [
        id,
        {
          driver: codexDriver,
          ...(optedIn.includes(id) ? { config: { spendCredits: allowance } } : {}),
        },
      ]),
    );
  const settingsFor = (
    optedIn: ReadonlyArray<ProviderInstanceId>,
    allowance: CodexCreditSpending = cap,
  ) => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: instancesFor(optedIn, allowance),
    providerInstanceFailoverOrder: [paid, spare],
    failoverLimitedThreads: true,
    autoModeProvider: codexDriver,
    autoModeModels: { codex: { model } },
  });
  /** Both accounts counted from their current balance, with no thread asking. */
  const counted = {
    spent: new Map([
      [paid, 0],
      [spare, 0],
    ]),
    requesters: [],
  };
  const context = (
    providers: ReadonlyArray<ServerProvider>,
    optedIn: ReadonlyArray<ProviderInstanceId>,
    creditAccess: AccountRoutingContext["creditAccess"] = counted,
    allowance: CodexCreditSpending = cap,
  ) => ({
    projectId,
    providers,
    settings: settingsFor(optedIn, allowance),
    recordedLimits: new Map(),
    mcpSignInsNeeded: signIns(),
    nowMs,
    creditAccess,
  });

  it.each([
    { name: "refuses an account at its weekly limit without the opt-in", optedIn: [], read: {} },
    { name: "admits it once spending its credits is on", optedIn: [paid], read: {}, room: true },
    { name: "refuses it when its credits are used up", optedIn: [paid], read: { balance: "0.00" } },
    {
      name: "refuses it at its monthly credit limit",
      optedIn: [paid],
      read: { creditLimitLeft: 0 },
    },
    { name: "refuses it when it has no credits", optedIn: [paid], read: { balance: null } },
    {
      name: "refuses it once the cap is spent",
      optedIn: [paid],
      read: {},
      access: { spent: new Map([[paid, 3000]]), requesters: [] },
    },
    {
      name: "refuses it before any balance is counted against the cap",
      optedIn: [paid],
      read: {},
      access: { spent: new Map(), requesters: [] },
    },
    {
      name: "refuses it to a thread outside the allowed ones",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
      access: { ...counted, requesters: [other] },
    },
    {
      name: "refuses it to work no thread asked for when the allowance names threads",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
    },
    {
      name: "admits a delegate of an allowed thread",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
      access: { ...counted, requesters: [delegate, allowed] },
      room: true,
    },
  ] as const)("$name", ({ optedIn, read, room, ...credits }) => {
    const input = {
      ...context(
        [codexAccount(paid, read)],
        optedIn,
        "access" in credits ? credits.access : counted,
        "allowance" in credits ? credits.allowance : cap,
      ),
      driver: codexDriver,
      model,
    };
    assert.deepEqual(
      accountsWithRoom({ ...input, funding: "verified" }).map(({ instanceId, onCredits }) => ({
        instanceId,
        onCredits,
      })),
      room === true ? [{ instanceId: paid, onCredits: true }] : [],
    );
  });

  it.each([
    { name: "spending once plan usage is used up", optedIn: [paid], read: {}, use: "spending" },
    {
      name: "standby while the plan has room",
      optedIn: [paid],
      read: { weeklyUsed: 30 },
      use: "standby",
    },
    { name: "not_enabled without the opt-in", optedIn: [], read: {}, use: "not_enabled" },
    {
      name: "out_of_scope for a thread the allowance leaves out",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
      access: { ...counted, requesters: [other] },
      use: "out_of_scope",
    },
    {
      name: "cap_reached once the cap is spent",
      optedIn: [paid],
      read: {},
      access: { spent: new Map([[paid, 3000]]), requesters: [] },
      use: "cap_reached",
    },
    {
      name: "used_up with no balance left",
      optedIn: [paid],
      read: { balance: "0" },
      use: "used_up",
    },
    {
      name: "used_up at the monthly credit limit",
      optedIn: [],
      read: { creditLimitLeft: 0 },
      use: "used_up",
    },
    { name: "null without credits", optedIn: [paid], read: { balance: null }, use: null },
  ] as const)("credit use is $name", ({ optedIn, read, use, ...credits }) => {
    assert.equal(
      AccountRouting.creditUse(codexAccount(paid, read), {
        settings: settingsFor(optedIn, "allowance" in credits ? credits.allowance : cap),
        recordedLimits: new Map(),
        nowMs,
        creditAccess: "access" in credits ? credits.access : counted,
      }),
      use,
    );
  });

  it("leaves Claude's extra usage out", () => {
    const extraUsage = provider(primary, {
      usageLimits: {
        checkedAt: "2026-11-03T11:59:00.000Z",
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
        credits: { balance: "453.69", currency: "USD", unlimited: false },
      },
    });
    assert.isNull(
      AccountRouting.creditUse(extraUsage, {
        settings: settings([primary]),
        recordedLimits: new Map(),
        nowMs,
      }),
    );
  });

  it("sends new work to an account with plan usage left before one on credits", () => {
    const input = context([codexAccount(paid), codexAccount(spare, { weeklyUsed: 30 })], [paid]);
    const named = { instanceId: paid, model };
    assert.deepEqual(
      {
        room: accountsWithRoom({ ...input, driver: codexDriver, model }).map(
          (account) => account.instanceId,
        ),
        named: failoverLimitedLaunch({ ...input, selection: named }),
        thread: routeAutoAccount({
          ...input,
          selection: { ...named, autoAccount: true },
          currentInstanceId: paid,
          started: true,
        }).instanceId,
      },
      {
        room: [spare, paid],
        named: { selection: { ...named, instanceId: spare }, failover: { reason: "usageLimit" } },
        thread: spare,
      },
    );
  });

  it("keeps work with plan usage left off credits for an MCP sign-in", () => {
    const input = {
      ...context([codexAccount(spare, { weeklyUsed: 30 }), codexAccount(paid)], [paid]),
      mcpSignInsNeeded: signIns([spare]),
    };
    const named = { instanceId: spare, model };
    assert.deepEqual(failoverLimitedLaunch({ ...input, selection: named }), {
      selection: named,
      failover: null,
    });
  });

  const shell = (lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  }) => ({ lineage: { ...lineage, rootThreadId: allowed } }) as never;
  const shells = new Map([
    [allowed, shell({ parentThreadId: null, relationshipToParent: null })],
    [delegate, shell({ parentThreadId: allowed, relationshipToParent: "subagent" })],
    [fork, shell({ parentThreadId: allowed, relationshipToParent: "fork" })],
    [other, shell({ parentThreadId: null, relationshipToParent: null })],
  ]);
  /** The routing layer over one account whose balance reading the test moves. */
  const routingLayer = (input: {
    readonly optedIn: ReadonlyArray<ProviderInstanceId>;
    readonly reading: Ref.Ref<ServerProvider>;
    readonly allowance?: CodexCreditSpending;
    readonly held?: Ref.Ref<boolean>;
    readonly database?: Layer.Layer<SqlClient.SqlClient>;
    /** What a full read of the account finds, and how many were made. */
    readonly fresh?: { readonly reading: ServerProvider; readonly reads: Ref.Ref<number> };
    /** The runs underway, and how many times they were looked up. */
    readonly underway?: {
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
      readonly reads: Ref.Ref<number>;
    };
  }) =>
    AccountRouting.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderMcp.ProviderMcp)({}),
          ServerSettings.layerTest({
            providerInstances: instancesFor(input.optedIn, input.allowance),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitedProviderInstances: () =>
              (input.held === undefined ? Effect.succeed(false) : Ref.get(input.held)).pipe(
                Effect.map(
                  (refused) =>
                    new Map(
                      refused
                        ? [[paid, [{ refusedAt: "2026-11-03T11:00:00.000Z", resetAt: null }]]]
                        : [],
                    ),
                ),
              ),
            liftUsageLimitHolds: () =>
              input.held === undefined ? Effect.void : Ref.set(input.held, false),
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
            getRunsUnderwayOn: (instanceIds) =>
              input.underway === undefined
                ? Effect.succeed([])
                : Ref.update(input.underway.reads, (reads) => reads + 1).pipe(
                    Effect.as(
                      input.underway.runs.filter((run) =>
                        instanceIds.includes(run.providerInstanceId),
                      ),
                    ),
                  ),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Ref.get(input.reading).pipe(Effect.map((reading) => [reading])),
            refreshInstance: () =>
              input.fresh === undefined
                ? Effect.die("No full read was expected.")
                : Ref.update(input.fresh.reads, (reads) => reads + 1).pipe(
                    Effect.andThen(Ref.set(input.reading, input.fresh.reading)),
                    Effect.as([input.fresh.reading]),
                  ),
            streamChanges: Stream.empty,
          }),
          input.database ?? SqlitePersistence.layerMemory,
        ),
      ),
    );
  const launchOnPaid = (requesterThreadId?: ThreadId) =>
    AccountRouting.AccountRouting.use((routing) =>
      routing.launchLimit({
        projectId,
        selection: { instanceId: paid, model },
        ...(requesterThreadId === undefined ? {} : { requesterThreadId }),
      }),
    );

  it.effect.each([
    {
      name: "refused until its weekly reset without the opt-in",
      optedIn: [],
      read: {},
      expected: { limitedUntil: weeklyReset, credits: "not_enabled" },
    },
    {
      name: "admitted on its prepaid credits with the opt-in",
      optedIn: [paid],
      read: {},
      expected: { credits: "spending" },
    },
    {
      name: "refused to a thread the allowance leaves out",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
      requester: other,
      expected: { limitedUntil: weeklyReset, credits: "out_of_scope" },
    },
    {
      name: "admitted to a delegate of an allowed thread",
      optedIn: [paid],
      read: {},
      allowance: scopedCap,
      requester: delegate,
      expected: { credits: "spending" },
    },
    {
      name: "admitted with plan usage left",
      optedIn: [],
      read: { weeklyUsed: 30, balance: null },
      expected: {},
    },
  ] as const)(
    "a release reports what admission does next: $name",
    ({ optedIn, read, expected, ...credits }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const requesterThreadId = "requester" in credits ? credits.requester : undefined;
        const layer = routingLayer({
          optedIn,
          reading: yield* Ref.make(codexAccount(paid, read)),
          held: yield* Ref.make(true),
          ...("allowance" in credits ? { allowance: credits.allowance } : {}),
        });
        yield* Effect.gen(function* () {
          const routing = yield* AccountRouting.AccountRouting;
          const report = yield* routing.retryAccount(paid, { requesterThreadId });
          const refusal = yield* launchOnPaid(requesterThreadId);
          assert.deepEqual(report, expected);
          assert.equal(refusal?.limitedUntil, report.limitedUntil);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("stops admitting once the balance has fallen by the cap, counting no top-up", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const reading = yield* Ref.make(codexAccount(paid));
      yield* Effect.gen(function* () {
        // 25 to 22 spends 3; the top-up to 40 spends nothing; 40 to 38 spends the last 2.
        const launches = yield* Effect.forEach(["25.00", "22.00", "40.00", "38.00"], (balance) =>
          Ref.set(reading, codexAccount(paid, { balance })).pipe(
            Effect.andThen(launchOnPaid()),
            Effect.map((limit) => limit?.credits ?? "admitted"),
          ),
        );
        const grant = (yield* AccountRouting.AccountRouting.use((routing) =>
          routing.limits(),
        )).grants.get(paid);
        assert.deepEqual(
          { launches, grant },
          {
            launches: ["admitted", "admitted", "admitted", "cap_reached"],
            grant: { capCredits: 5, spentCredits: 5, remainingCredits: 0 },
          },
        );
      }).pipe(
        Effect.provide(routingLayer({ optedIn: [paid], reading, allowance: { capCredits: 5 } })),
      );
    }),
  );

  it.effect("keeps counting against the cap across a restart", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-credit-spend-"));
    const database = () =>
      SqlitePersistence.layerFromPath(NodePath.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const reading = yield* Ref.make(codexAccount(paid, { balance: "9880" }));
      const boot = () =>
        routingLayer({ optedIn: [paid], reading, database: Layer.orDie(database()) });
      yield* launchOnPaid().pipe(Effect.provide(boot()));
      yield* Ref.set(reading, codexAccount(paid, { balance: "9500" }));
      yield* launchOnPaid().pipe(Effect.provide(boot()));
      const grant = yield* AccountRouting.AccountRouting.use((routing) => routing.limits()).pipe(
        Effect.map((limits) => limits.grants.get(paid)),
        Effect.provide(boot()),
      );
      assert.deepEqual(grant, { capCredits: 3000, spentCredits: 380, remainingCredits: 2620 });
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect.each([
    { name: "spends for a delegate of an allowed thread", threadId: delegate, refused: undefined },
    { name: "refuses a fork of an allowed thread", threadId: fork, refused: "out_of_scope" },
  ] as const)("a turn on credits $name", ({ threadId, refused }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const refusal = yield* AccountRouting.AccountRouting.use((routing) =>
        routing.creditRefusal({ threadId, instanceId: paid, model }),
      ).pipe(
        Effect.provide(
          routingLayer({
            optedIn: [paid],
            reading: yield* Ref.make(codexAccount(paid)),
            allowance: scopedCap,
          }),
        ),
      );
      assert.equal(refusal?.credits, refused);
    }),
  );

  it.effect.each([
    {
      name: "reads an account again when its reading is older than two minutes",
      checkedAt: "2026-11-03T11:00:00.000Z",
      expected: { credits: "not_enabled", reads: 1 },
    },
    {
      name: "judges a recent reading as it stands",
      checkedAt: "2026-11-03T11:59:00.000Z",
      expected: { credits: undefined, reads: 0 },
    },
  ] as const)("a turn that could spend credits $name", ({ checkedAt, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const reads = yield* Ref.make(0);
      // The reading in hand shows plan room; Codex has used the plan up since.
      const layer = routingLayer({
        optedIn: [],
        reading: yield* Ref.make(codexAccount(paid, { weeklyUsed: 30, checkedAt })),
        fresh: { reading: codexAccount(paid), reads },
      });
      const refusal = yield* AccountRouting.AccountRouting.use((routing) =>
        routing.creditRefusal({ threadId: allowed, instanceId: paid, model }),
      ).pipe(Effect.provide(layer));
      assert.deepEqual({ credits: refusal?.credits, reads: yield* Ref.get(reads) }, expected);
    }),
  );

  const runUnderway = (threadId: ThreadId, instanceId: ProviderInstanceId): OrchestrationV2Run => ({
    id: RunId.make(`run:${threadId}`),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}`),
    rootNodeId: NodeId.make(`node:${threadId}`),
    activeAttemptId: null,
    status: "running",
    requestedAt: DateTime.makeUnsafe(nowMs),
    startedAt: DateTime.makeUnsafe(nowMs),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });

  it.effect.each([
    {
      name: "stops a turn once its spending reaches the cap",
      optedIn: [paid],
      allowance: { capCredits: 5 },
      readings: [{ balance: "25.00" }, { balance: "20.00" }],
      expected: { stopped: ["cap_reached"], reads: 1 },
    },
    {
      name: "keeps a turn whose spending is within the cap",
      optedIn: [paid],
      allowance: { capCredits: 5 },
      readings: [{ balance: "25.00" }, { balance: "22.00" }],
      expected: { stopped: [], reads: 1 },
    },
    {
      name: "stops a turn whose plan ran out while spending credits is off",
      optedIn: [],
      readings: [{ weeklyUsed: 30 }, {}],
      expected: { stopped: ["not_enabled"], reads: 1 },
    },
    {
      name: "stops a turn of a thread the allowance leaves out",
      optedIn: [paid],
      allowance: scopedCap,
      threadId: other,
      readings: [{}, { balance: "24.00" }],
      expected: { stopped: ["out_of_scope"], reads: 1 },
    },
    {
      name: "looks up no runs while the plan has room",
      optedIn: [],
      readings: [{ weeklyUsed: 30 }, { weeklyUsed: 40 }],
      expected: { stopped: [], reads: 0 },
    },
  ] as const)("a turn underway on credits: $name", ({ optedIn, readings, expected, ...input }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const reading = yield* Ref.make(codexAccount(paid, readings[0]));
      const reads = yield* Ref.make(0);
      const layer = routingLayer({
        optedIn,
        reading,
        ...("allowance" in input ? { allowance: input.allowance } : {}),
        underway: {
          runs: [
            runUnderway("threadId" in input ? input.threadId : allowed, paid),
            runUnderway(delegate, spare),
          ],
          reads,
        },
      });
      const overruns = yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        yield* Ref.set(reading, codexAccount(paid, readings[1]));
        return yield* routing.creditOverruns;
      }).pipe(Effect.provide(layer));
      const actual: { readonly stopped: ReadonlyArray<string>; readonly reads: number } = {
        stopped: overruns.map((overrun) => overrun.refusal.credits),
        reads: yield* Ref.get(reads),
      };
      assert.deepEqual(actual, expected);
    }),
  );
});

describe("MCP sign-ins in the layer", () => {
  const needsSignIn: ProviderMcpServer = {
    name: THREADPAGE,
    status: "needsAuth",
    origin: "config",
    canSignIn: true,
    canSignOut: false,
    removable: false,
  };
  const makeHarness = (
    options: {
      readonly order?: ReadonlyArray<ProviderInstanceId>;
      /** Nothing is loaded until a discovery lists it, as on a machine no client polls. */
      readonly cold?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      const listed = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
      const read = (kind: string, instanceId: ProviderInstanceId) =>
        Ref.update(reads, (done) => [...done, `${kind}:${instanceId}`]);
      const servers = (instanceId: ProviderInstanceId): ReadonlyArray<ProviderMcpServer> =>
        instanceId === third ? [needsSignIn] : [];
      const layer = AccountRouting.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderMcp.ProviderMcp)({
              discover: (instanceId) =>
                read("discover", instanceId).pipe(
                  Effect.andThen(Ref.update(listed, (done) => new Set([...done, instanceId]))),
                  Effect.as(Option.some(servers(instanceId))),
                ),
              listLoaded: (instanceId) =>
                read("loaded", instanceId).pipe(
                  Effect.andThen(Ref.get(listed)),
                  Effect.map((done) =>
                    options.cold === true && !done.has(instanceId)
                      ? Option.none()
                      : Option.some(servers(instanceId)),
                  ),
                ),
            }),
            ServerSettings.layerTest(settings(options.order ?? [primary, second, third])),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getUsageLimitedProviderInstances: () => Effect.succeed(new Map()),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([provider(primary), provider(second), provider(third)]),
            }),
          ),
        ),
      );
      return { reads, layer };
    });
  const harness = makeHarness();

  it.effect("routes a turn from the loaded lists and never starts a provider to read them", () =>
    Effect.gen(function* () {
      const { reads, layer } = yield* harness;
      const routed = yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        return yield* routing.route({
          selection: auto,
          projectId,
          currentInstanceId: third,
          started: true,
        });
      }).pipe(Effect.provide(layer));
      assert.equal(routed.instanceId, primary);
      assert.deepEqual(
        (yield* Ref.get(reads)).filter((read) => !read.startsWith("loaded:")),
        [],
      );
    }),
  );

  it.effect("lists the servers of a launch's accounts, and says it moved for a sign-in", () =>
    Effect.gen(function* () {
      const { reads, layer } = yield* harness;
      const launched = yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        return yield* routing.failoverLaunch({
          selection: { instanceId: third, model: "claude-opus-5-5" },
          projectId,
        });
      }).pipe(Effect.provide(layer));
      assert.deepEqual(launched, {
        selection: { instanceId: primary, model: "claude-opus-5-5" },
        failover: { reason: "mcpSignIn", mcpServers: [THREADPAGE] },
      });
      assert.deepEqual(
        (yield* Ref.get(reads)).filter((read) => !read.startsWith("discover:")),
        [],
      );
    }),
  );
  it.effect(
    "an Auto launch lists its provider's servers, so its first turn passes a sign-in by",
    () =>
      Effect.gen(function* () {
        // The account that must sign in again is first in the order, and nothing is loaded yet.
        const { reads, layer } = yield* makeHarness({
          order: [third, primary, second],
          cold: true,
        });
        const { launched, routed } = yield* Effect.gen(function* () {
          const routing = yield* AccountRouting.AccountRouting;
          const launched = yield* routing.failoverLaunch({ selection: auto, projectId });
          const routed = yield* routing.route({
            selection: auto,
            projectId,
            currentInstanceId: null,
            started: false,
          });
          return { launched, routed };
        }).pipe(Effect.provide(layer));
        assert.deepEqual(launched, { selection: auto, failover: null });
        assert.equal(routed.instanceId, primary);
        assert.includeMembers([...(yield* Ref.get(reads))], [`discover:${third}`]);
      }),
  );

  it.effect("says which servers each account with room must sign in to", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness;
      const accounts = yield* Effect.gen(function* () {
        const routing = yield* AccountRouting.AccountRouting;
        return yield* routing.accountsWithRoom({
          driver: claude,
          projectId,
          model: "claude-opus-5-5",
        });
      }).pipe(Effect.provide(layer));
      assert.deepEqual(
        accounts.map((account) => [account.instanceId, account.mcpSignInsNeeded]),
        [
          [primary, []],
          [second, []],
          [third, [THREADPAGE]],
        ],
      );
    }),
  );
});
