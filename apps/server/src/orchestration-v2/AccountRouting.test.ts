import * as Effect from "effect/Effect";
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
      (input.limited ?? []).map((id) => [id, { resetAt: null, refusedAt: "2026-11-03T00:00:00Z" }]),
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
          [primary].map((id) => [id, { resetAt: null, refusedAt: "2026-11-03T00:00:00Z" }]),
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
        input.limited.map((id) => [id, { resetAt: null, refusedAt: "2026-11-03T00:00:00Z" }]),
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
])(
  "launchLimit and capabilities availability respect $id for $model (reset $resetsAt)",
  ({ id, model, resetsAt, limited, accountWide }) =>
    Effect.gen(function* () {
      const routing = yield* AccountRouting.AccountRouting;
      const expected = { instanceId: primary, limitedUntil: resetsAt ?? null };
      assert.deepEqual(
        yield* routing.launchLimit({
          projectId,
          explicitAccount: true,
          selection: { instanceId: primary, model },
        }),
        limited ? expected : null,
      );
      assert.deepEqual(
        [...(yield* routing.limitedAccounts)],
        accountWide ? [[primary, resetsAt ?? null]] : [],
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
    name: "fresh room clears an unknown reset",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    limited: false,
  },
  {
    name: "older room after failed probes allows explicit recovery but not Auto",
    checkedAt: "2026-11-03T11:59:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    limited: true,
  },
  {
    name: "equally timed room allows explicit recovery but not Auto",
    checkedAt: "2026-11-03T12:00:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    limited: true,
  },
  {
    name: "fresh room clears a historical refusal",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2025-01-01T00:00:00Z",
    limited: false,
  },
  {
    name: "absent reporting allows an explicit recovery run",
    checkedAt: undefined,
    refusedAt: "2026-11-03T12:00:00Z",
    limited: true,
  },
  {
    name: "unavailable reporting allows an explicit recovery run",
    checkedAt: "2026-11-03T12:01:00Z",
    unavailable: true,
    refusedAt: "2026-11-03T12:00:00Z",
    limited: true,
  },
  {
    name: "fresh room cannot clear a known future reset",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    resetAt: "2099-01-01T00:00:00Z",
    limited: true,
  },
  {
    name: "an expired known reset no longer blocks a launch",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    resetAt: "1969-12-31T23:00:00Z",
    limited: false,
  },
  {
    name: "a fresh exhausted window still blocks recovery",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    exhausted: true,
    limited: true,
  },
  {
    name: "a fresh model-only limit leaves the other model usable",
    checkedAt: "2026-11-03T12:01:00Z",
    refusedAt: "2026-11-03T12:00:00Z",
    exhausted: true,
    windowId: "seven_day_fable",
    limited: false,
  },
])("$name", ({ checkedAt, refusedAt, limited, ...row }) =>
  Effect.gen(function* () {
    const unavailable = "unavailable" in row;
    const resetAt = "resetAt" in row ? row.resetAt! : null;
    const current = provider(
      primary,
      checkedAt === undefined
        ? {}
        : {
            usageLimits: {
              checkedAt,
              windows: [
                {
                  id: "windowId" in row ? row.windowId! : "5h",
                  kind: "session",
                  label: "Session",
                  usedPercent: "exhausted" in row ? 100 : 10,
                },
              ],
              ...(unavailable ? { unavailable: { reason: "unsupported" as const } } : {}),
            },
          },
    );
    const recordedLimits = new Map([[primary, { resetAt, refusedAt }]]);
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
    assert.equal(
      AccountRouting.modelWithRoom(current, {
        settings: settings([primary]),
        providers: [current],
        recordedLimits,
        nowMs: 0,
        projectId,
        model: "claude-opus-5-5",
      }),
      limited ? null : "claude-opus-5-5",
    );
    const selection = { instanceId: primary, model: "claude-opus-5-5" };
    assert.deepEqual(
      yield* routing.launchLimit({
        projectId,
        explicitAccount: false,
        selection: { ...selection, autoAccount: true },
      }),
      limited ? { instanceId: primary, limitedUntil: resetAt } : null,
    );
    assert.deepEqual(
      yield* routing.launchLimit({ projectId, explicitAccount: true, selection }),
      limited && (resetAt !== null || ("exhausted" in row && !("windowId" in row)))
        ? { instanceId: primary, limitedUntil: resetAt }
        : null,
    );
  }),
);
