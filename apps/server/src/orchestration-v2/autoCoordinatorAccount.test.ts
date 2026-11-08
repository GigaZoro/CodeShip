import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { autoCoordinatorAccounts, autoCoordinatorBriefInput } from "./autoCoordinatorAccount.ts";

const first = ProviderInstanceId.make("codex_first");
const second = ProviderInstanceId.make("codex_second");
const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-08T00:00:00.000Z",
  models: [{ slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("autoCoordinatorAccounts", () => {
  it.each([
    {
      name: "respects failover order",
      overrides: {},
      limited: [],
      capable: [first, second],
      expected: first,
    },
    {
      name: "skips a usage-limited account",
      overrides: {},
      limited: [first],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips an exhausted account without a recorded limit",
      overrides: {
        usageLimits: {
          checkedAt: "2026-11-08T00:00:00Z",
          windows: [{ id: "5h", kind: "session", label: "Session", usedPercent: 100 }],
        },
      },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips an API-key account",
      overrides: { auth: { status: "authenticated", type: "apiKey" } },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips an empty first catalog",
      overrides: { models: [] },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips a signed-out account",
      overrides: { auth: { status: "unauthenticated" } },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips a disabled account",
      overrides: { enabled: false },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "requires an orchestration adapter",
      overrides: {},
      limited: [],
      capable: [second],
      expected: second,
    },
    {
      name: "returns none when no account can run",
      overrides: {},
      limited: [first, second],
      capable: [first, second],
      expected: undefined,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    overrides: Partial<ServerProvider>;
    limited: ProviderInstanceId[];
    capable: ProviderInstanceId[];
    expected: ProviderInstanceId | undefined;
  }>)("$name", ({ overrides, limited, capable, expected }) => {
    expect(
      autoCoordinatorAccounts({
        driver: ProviderDriverKind.make("claudeAgent"),
        providers: [provider(second), provider(first, overrides)],
        projectId: ProjectId.make("project:auto"),
        nowMs: Date.parse("2026-11-08T00:00:00Z"),
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: Object.fromEntries(
            [first, second].map((id) => [
              id,
              { driver: ProviderDriverKind.make("codex"), enabled: true },
            ]),
          ),
          providerInstanceFailoverOrder: [first, second],
        },
        recordedLimits: new Map(
          limited.map((id) => [id, { resetAt: null, refusedAt: "2026-11-03T00:00:00Z" }]),
        ),
        orchestrationCapableInstanceIds: new Set(capable),
      })[0]?.instanceId,
    ).toBe(expected);
  });
  it("uses Claude for a Codex coordinator and returns none without another provider", () => {
    const input = {
      driver: ProviderDriverKind.make("codex"),
      providers: [provider(first, { driver: ProviderDriverKind.make("claudeAgent") })],
      projectId: ProjectId.make("project:auto"),
      nowMs: Date.parse("2026-11-08T00:00:00Z"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: Object.fromEntries(
          [first, second].map((id) => [
            id,
            { driver: ProviderDriverKind.make("codex"), enabled: true },
          ]),
        ),
        providerInstanceFailoverOrder: [],
      },
      recordedLimits: new Map(),
      orchestrationCapableInstanceIds: new Set([first]),
    };
    expect(autoCoordinatorAccounts(input)[0]?.instanceId).toBe(first);
    expect(autoCoordinatorAccounts({ ...input, providers: [] })).toEqual([]);
  });
});

it("skips project-disabled accounts and retains all eligible catalogs in failover order", () => {
  const projectId = ProjectId.make("project:auto");
  const third = ProviderInstanceId.make("codex_third");
  const unique = { slug: "gpt-luna", name: "Luna", isCustom: false, capabilities: null };
  const input = {
    driver: ProviderDriverKind.make("claudeAgent"),
    projectId,
    providers: [
      provider(third, { models: [...provider(first).models, unique] }),
      provider(second),
      provider(first),
    ],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstanceFailoverOrder: [first, second, third],
      providerInstances: Object.fromEntries(
        [first, second, third].map((id) => [
          id,
          { driver: ProviderDriverKind.make("codex"), enabled: true },
        ]),
      ),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [first]: { enabled: false } } },
      },
    },
    recordedLimits: new Map(),
    nowMs: Date.parse("2026-11-08T00:00:00Z"),
    orchestrationCapableInstanceIds: new Set([first, second, third]),
  };
  expect(
    autoCoordinatorAccounts(input).map((account) => [
      account.instanceId,
      account.models.map((model) => model.slug),
    ]),
  ).toEqual([
    [second, ["gpt-6-astra"]],
    [third, ["gpt-6-astra", "gpt-luna"]],
  ]);
});

it("drops only the model whose Claude window is exhausted", () => {
  const models = ["claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  }));
  const accounts = autoCoordinatorAccounts({
    driver: ProviderDriverKind.make("codex"),
    projectId: ProjectId.make("project:auto"),
    providers: [
      provider(first, {
        driver: ProviderDriverKind.make("claudeAgent"),
        models,
        usageLimits: {
          checkedAt: "2026-11-08T00:00:00Z",
          windows: [{ id: "seven_day_opus", kind: "weekly", label: "Opus", usedPercent: 100 }],
        },
      }),
      provider(second, { driver: ProviderDriverKind.make("claudeAgent"), models }),
    ],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        [first, second].map((id) => [
          id,
          { driver: ProviderDriverKind.make("codex"), enabled: true },
        ]),
      ),
      providerInstanceFailoverOrder: [first, second],
    },
    recordedLimits: new Map(),
    nowMs: Date.parse("2026-11-08T00:00:00Z"),
    orchestrationCapableInstanceIds: new Set([first, second]),
  });
  expect(
    accounts.map((account) => [account.instanceId, account.models.map((model) => model.slug)]),
  ).toEqual([
    [first, ["claude-sonnet-5-5"]],
    [second, ["claude-opus-5-5", "claude-sonnet-5-5"]],
  ]);
});

it.each([false, true])(
  "assembles primaries and only the turn account's usable native models (reviewer limited: %s)",
  (reviewerLimited) => {
    const ownId = ProviderInstanceId.make("claude_own");
    const ownOtherId = ProviderInstanceId.make("claude_other");
    const model = (slug: string, isLegacy = false) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      isLegacy,
    });
    const primary = { model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] };
    const otherPrimary = {
      model: "gpt-review",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    };
    const result = autoCoordinatorBriefInput({
      driver: ProviderDriverKind.make("claudeAgent"),
      selection: { instanceId: ownId, model: primary.model },
      projectId: ProjectId.make("project:auto"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        autoModeModels: {
          [ProviderDriverKind.make("claudeAgent")]: primary,
          [ProviderDriverKind.make("codex")]: otherPrimary,
        },
        providerInstances: Object.fromEntries(
          [ownId, ownOtherId, first, second].map((id) => [
            id,
            {
              driver: ProviderDriverKind.make(id.startsWith("claude") ? "claudeAgent" : "codex"),
              enabled: true,
            },
          ]),
        ),
        providerInstanceFailoverOrder: [first, second],
      },
      nowMs: Date.parse("2026-11-08T12:00:00Z"),
      recordedLimits: reviewerLimited
        ? new Map([[second, { resetAt: null, refusedAt: "2026-11-08T11:00:00Z" }]])
        : new Map(),
      orchestrationCapableInstanceIds: new Set([first, second]),
      providers: [
        provider(ownOtherId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [model("native-other-account")],
        }),
        provider(ownId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [model(primary.model), model("claude-sonnet-5-5"), model("legacy", true)],
          usageLimits: {
            checkedAt: "2026-11-08T11:00:00Z",
            windows: [
              { id: "seven_day_sonnet", kind: "weekly", label: "Sonnet", usedPercent: 100 },
            ],
          },
        }),
        provider(first),
        provider(second, { models: [model("gpt-6-astra"), model(otherPrimary.model)] }),
      ],
    });
    expect(result.primary).toEqual(primary);
    expect(result.model).toBe(primary.model);
    expect(result.models.map((model) => model.slug)).toEqual([primary.model]);
    expect(result.otherPrimary).toEqual(
      reviewerLimited ? undefined : { ...otherPrimary, providerInstanceId: second },
    );
    expect(
      result.otherProviders?.map((provider) => [
        provider.providerInstanceId,
        provider.models.map((model) => model.slug),
      ]),
    ).toEqual(
      reviewerLimited
        ? [[first, ["gpt-6-astra"]]]
        : [
            [first, ["gpt-6-astra"]],
            [second, ["gpt-6-astra", "gpt-review"]],
          ],
    );
  },
);
