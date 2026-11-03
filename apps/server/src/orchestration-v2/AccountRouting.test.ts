import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { routeAutoAccount } from "./AccountRouting.ts";

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
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) satisfies ServerProvider;

const settings = (order: ReadonlyArray<ProviderInstanceId>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    order.map((instanceId) => [instanceId, { driver: ProviderDriverKind.make("claudeAgent") }]),
  ),
  providerInstanceFailoverOrder: order,
});

const auto: ModelSelection = { instanceId: third, model: "claude-opus-5-5", autoAccount: true };

const route = (input: {
  readonly selection?: ModelSelection;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly limited?: ReadonlyArray<ProviderInstanceId>;
}) =>
  routeAutoAccount({
    selection: input.selection ?? auto,
    projectId,
    currentInstanceId: input.currentInstanceId,
    started: input.currentInstanceId !== null,
    // Listed out of settings order, so the saved order decides.
    providers: [provider(third), provider(second), provider(primary)],
    settings: settings([primary, second, third]),
    limitedInstanceIds: new Set(input.limited ?? []),
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

  it("skips an account whose usage window is used up until it resets", () => {
    const exhausted = (resetsAt: string) =>
      routeAutoAccount({
        selection: { ...auto, instanceId: second },
        projectId,
        currentInstanceId: null,
        providers: [
          provider(primary, {
            usageLimits: {
              checkedAt: "2026-11-03T11:59:00.000Z",
              windows: [{ id: "5h", kind: "session", label: "5h", usedPercent: 100, resetsAt }],
            },
          }),
          provider(second),
        ],
        settings: settings([primary, second]),
        limitedInstanceIds: new Set(),
        nowMs,
        started: false,
      }).instanceId;
    assert.equal(exhausted("2026-11-03T13:00:00.000Z"), second);
    assert.equal(exhausted("2026-11-03T11:00:00.000Z"), primary);
  });

  describe("with an Auto model", () => {
    const codex = ProviderInstanceId.make("codex_main");
    const effort = (value: string) => [{ id: "effort", value }];
    const sonnet: ModelSelection = {
      instanceId: primary,
      model: "claude-sonnet-5-5",
      options: effort("high"),
    };
    const models = [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
    ];
    const routeWith = (input: {
      readonly autoModel: ModelSelection;
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
            driver: ProviderDriverKind.make("codex"),
            models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
          }),
        ],
        settings: { ...settings([primary, second]), autoModelSelection: input.autoModel },
        limitedInstanceIds: new Set([primary]),
        nowMs,
      });

    it.each([
      [
        "a new thread runs the Auto model and its effort on the first account with room",
        sonnet,
        { instanceId: primary, model: "claude-opus-5-5", autoAccount: true },
        null,
        { ...sonnet, instanceId: second, autoAccount: true },
      ],
      [
        "a pick on the Auto model keeps its own effort",
        sonnet,
        { ...sonnet, instanceId: second, options: effort("low"), autoAccount: true },
        second,
        { ...sonnet, instanceId: second, options: effort("low"), autoAccount: true },
      ],
      [
        "a thread moves to a changed Auto model on its own account",
        sonnet,
        { instanceId: second, model: "claude-opus-5-5", options: effort("low"), autoAccount: true },
        second,
        { ...sonnet, instanceId: second, autoAccount: true },
      ],
      [
        "a new thread follows an Auto model on another provider",
        { instanceId: codex, model: "gpt-5.5" },
        { instanceId: primary, model: "claude-opus-5-5", autoAccount: true },
        null,
        { instanceId: codex, model: "gpt-5.5", autoAccount: true },
      ],
      [
        "a thread that already ran keeps its provider",
        { instanceId: codex, model: "gpt-5.5" },
        { instanceId: second, model: "claude-opus-5-5", autoAccount: true },
        second,
        { instanceId: second, model: "claude-opus-5-5", autoAccount: true },
      ],
    ] as const)("%s", (_, autoModel, selection, currentInstanceId, expected) => {
      assert.deepEqual(routeWith({ autoModel, selection, currentInstanceId }), expected);
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
