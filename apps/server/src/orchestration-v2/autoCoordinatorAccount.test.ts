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

// Settings that turn each account on, its driver read from its id's prefix.
const enabledInstances = (ids: ReadonlyArray<ProviderInstanceId>) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      {
        driver: ProviderDriverKind.make(id.startsWith("claude") ? "claudeAgent" : "codex"),
        enabled: true,
      },
    ]),
  );

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
          limited.map((id) => [id, [{ resetAt: null, refusedAt: "2026-11-08T00:00:00Z" }]]),
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
      options: [
        { id: "reasoningEffort", value: "ultra" },
        { id: "serviceTier", value: "default" },
      ],
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
        providerInstances: enabledInstances([ownId, ownOtherId, first, second]),
        providerInstanceFailoverOrder: [first, second],
      },
      nowMs: Date.parse("2026-11-08T12:00:00Z"),
      recordedLimits: reviewerLimited
        ? new Map([[second, [{ resetAt: null, refusedAt: "2026-11-08T11:00:00Z" }]]])
        : new Map(),
      orchestrationCapableInstanceIds: new Set([first, second]),
      providers: [
        provider(ownOtherId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [model("native-other-account")],
        }),
        provider(ownId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          auth: { status: "authenticated", type: "apiKey" },
          models: [model(primary.model), model("claude-sonnet-5-5"), model("legacy", true)],
          usageLimits: {
            checkedAt: "2026-11-08T11:00:00Z",
            windows: [
              { id: "seven_day_sonnet", kind: "weekly", label: "Sonnet", usedPercent: 100 },
            ],
          },
        }),
        provider(first),
        provider(second, {
          models: [
            model("gpt-6-astra"),
            {
              ...model(otherPrimary.model),
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select" as const,
                    options: [{ id: "ultra", label: "Ultra" }],
                  },
                ],
              },
            },
          ],
        }),
      ],
    });
    expect(result.primary).toEqual(primary);
    expect(result.model).toBe(primary.model);
    expect(result.models.map((model) => model.slug)).toEqual([primary.model]);
    expect(result.otherReviewer).toEqual(
      reviewerLimited
        ? undefined
        : {
            ...otherPrimary,
            options: [{ id: "reasoningEffort", value: "ultra" }],
            providerInstanceId: second,
          },
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

it.each([
  {
    name: "a model-scoped refusal drops its models",
    modelScope: "opus",
    expected: ["claude-sonnet-5-5"],
  },
  {
    name: "an account-wide refusal keeps them",
    modelScope: undefined,
    expected: ["claude-opus-5-5", "claude-sonnet-5-5"],
  },
  {
    name: "a used-up account-wide window keeps them",
    windows: ["five_hour"],
    expected: ["claude-opus-5-5", "claude-sonnet-5-5"],
  },
  {
    name: "a used-up model window beside an account-wide one drops only its models",
    windows: ["five_hour", "seven_day_opus"],
    expected: ["claude-sonnet-5-5"],
  },
])("on the coordinator's own account, $name", ({ expected, ...row }) => {
  const ownId = ProviderInstanceId.make("claude_own");
  const result = autoCoordinatorBriefInput({
    driver: ProviderDriverKind.make("claudeAgent"),
    selection: { instanceId: ownId, model: "claude-sonnet-5-5" },
    projectId: ProjectId.make("project:auto"),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [ownId]: { driver: ProviderDriverKind.make("claudeAgent") } },
    },
    nowMs: Date.parse("2026-11-08T12:00:00Z"),
    recordedLimits: new Map(
      "windows" in row
        ? []
        : [
            [
              ownId,
              [
                {
                  resetAt: null,
                  refusedAt: "2026-11-08T11:00:00Z",
                  ...(row.modelScope === undefined ? {} : { modelScope: row.modelScope }),
                },
              ],
            ],
          ],
    ),
    orchestrationCapableInstanceIds: new Set(),
    providers: [
      provider(ownId, {
        driver: ProviderDriverKind.make("claudeAgent"),
        models: ["claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
        ...("windows" in row
          ? {
              usageLimits: {
                checkedAt: "2026-11-08T11:00:00Z",
                windows: row.windows.map((id) => ({
                  id,
                  kind: "weekly" as const,
                  label: id,
                  usedPercent: 100,
                  resetsAt: "2026-11-10T00:00:00.000Z",
                })),
              },
            }
          : {}),
      }),
    ],
  });
  expect(result.models.map((model) => model.slug)).toEqual(expected);
});

it.each([
  { name: "within its hold drops the model", checkedAt: "2026-11-08T10:00:00Z", listed: false },
  { name: "past its hold lists the model again", checkedAt: "2026-11-08T06:00:00Z", listed: true },
])(
  "an own-account window used up with no reset, checked $checkedAt, $name",
  ({ checkedAt, listed }) => {
    const ownId = ProviderInstanceId.make("claude_own");
    const result = autoCoordinatorBriefInput({
      driver: ProviderDriverKind.make("claudeAgent"),
      selection: { instanceId: ownId, model: "claude-sonnet-5-5" },
      projectId: ProjectId.make("project:auto"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [ownId]: { driver: ProviderDriverKind.make("claudeAgent") } },
      },
      nowMs: Date.parse("2026-11-08T12:00:00Z"),
      recordedLimits: new Map(),
      orchestrationCapableInstanceIds: new Set(),
      providers: [
        provider(ownId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: ["claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
            slug,
            name: slug,
            isCustom: false,
            capabilities: null,
          })),
          usageLimits: {
            checkedAt,
            windows: [{ id: "seven_day_opus", kind: "weekly", label: "Opus", usedPercent: 100 }],
          },
        }),
      ],
    });
    expect(result.models.some((model) => model.slug === "claude-opus-5-5")).toBe(listed);
  },
);

it("names the reviewer on the account whose login can run the model", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const slug = "gpt-6.2-astra";
  const codexModels = [{ slug, name: "Astra", isCustom: false, capabilities: null }];
  const result = autoCoordinatorBriefInput({
    driver: ProviderDriverKind.make("claudeAgent"),
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      autoModeModels: {
        [ProviderDriverKind.make("claudeAgent")]: { model: "claude-opus-5-5" },
        [ProviderDriverKind.make("codex")]: { model: slug },
      },
      providerInstances: enabledInstances([ownId, first, second]),
      providerInstanceFailoverOrder: [first, second],
    },
    nowMs: Date.parse("2026-11-08T12:00:00Z"),
    // The first account's login refused the model, so its own model list no longer decides.
    recordedLimits: new Map([
      [first, [{ resetAt: null, refusedAt: "2026-11-08T11:00:00Z", modelScope: "gpt_6_2_astra" }]],
    ]),
    orchestrationCapableInstanceIds: new Set([first, second]),
    providers: [
      provider(ownId, {
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(first, { models: codexModels }),
      provider(second, { models: codexModels }),
    ],
  });
  expect(result.otherReviewer?.providerInstanceId).toBe(second);
  expect(
    result.otherProviders?.map((account) => [account.providerInstanceId, account.models.length]),
  ).toEqual([[second, 1]]);
});

it.each([false, true])(
  "names a reviewer on the coordinator's provider for when the other cannot run (other limited: %s)",
  (otherLimited) => {
    const ownId = ProviderInstanceId.make("claude_own");
    const spareId = ProviderInstanceId.make("claude_spare");
    const claude = ProviderDriverKind.make("claudeAgent");
    const refused = [{ resetAt: null, refusedAt: "2026-11-08T11:00:00Z" }];
    const opus = {
      slug: "claude-opus-5-5",
      name: "Opus",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "xhigh", label: "xhigh" }],
          },
        ],
      },
    };
    const result = autoCoordinatorBriefInput({
      driver: claude,
      selection: { instanceId: ownId, model: opus.slug },
      projectId: ProjectId.make("project:auto"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        autoModeModels: {
          // Saved by its display name, which the target turns into the account's own id.
          [claude]: {
            model: opus.name,
            options: [
              { id: "effort", value: "xhigh" },
              { id: "fastMode", value: true },
            ],
          },
          [ProviderDriverKind.make("codex")]: { model: "gpt-6-astra" },
        },
        providerInstances: enabledInstances([ownId, spareId, first]),
        providerInstanceFailoverOrder: [ownId, spareId, first],
      },
      nowMs: Date.parse("2026-11-08T12:00:00Z"),
      // The coordinator's own account is out of room, so the next one in failover order reviews.
      recordedLimits: new Map([
        [ownId, refused],
        ...(otherLimited ? [[first, refused] as const] : []),
      ]),
      orchestrationCapableInstanceIds: new Set([ownId, spareId, first]),
      providers: [
        provider(ownId, { driver: claude, models: [opus] }),
        // The user chose this primary, so a catalog that now marks it legacy still runs it.
        provider(spareId, { driver: claude, models: [{ ...opus, isLegacy: true }] }),
        provider(first),
      ],
    });
    expect(result.ownReviewer).toEqual({
      model: opus.slug,
      options: [{ id: "effort", value: "xhigh" }],
      providerInstanceId: spareId,
    });
    expect(result.otherReviewer?.providerInstanceId).toBe(otherLimited ? undefined : first);
  },
);

it("includes enabled Antigravity accounts after the paired provider, honors per-model limits, and treats unmeasured usage as available", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const agDisabled = ProviderInstanceId.make("antigravity_disabled");
  const agLimited = ProviderInstanceId.make("antigravity_limited");
  const agRefused = ProviderInstanceId.make("antigravity_refused");
  const agMetered = ProviderInstanceId.make("antigravity_metered");
  const agUnmeasured = ProviderInstanceId.make("antigravity_unmeasured");
  const agPartial = ProviderInstanceId.make("antigravity_partial");
  const agNullUsage = ProviderInstanceId.make("antigravity_null_usage");
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const antigravity = ProviderDriverKind.make("antigravity");
  const agModels = [
    { slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null },
    { slug: "gemini-4-argon", name: "Gemini 4 Argon", isCustom: false, capabilities: null },
    { slug: "gemini-3.8-flash", name: "Gemini 3.8 Flash", isCustom: false, capabilities: null },
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
    {
      slug: "gpt-oss-120b-medium",
      name: "GPT-OSS 120B (Medium)",
      isCustom: false,
      capabilities: null,
    },
  ];
  const baseInput = {
    driver: claude,
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    nowMs: Date.parse("2026-11-27T12:00:00Z"),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      autoModeModels: {
        [claude]: { model: "claude-opus-5-5" },
        [codex]: { model: "gpt-6-astra" },
      },
      providerInstances: {
        [ownId]: { driver: claude, enabled: true },
        [agDisabled]: { driver: antigravity, enabled: false },
        [agLimited]: { driver: antigravity, enabled: true },
        [agRefused]: { driver: antigravity, enabled: true },
        [agMetered]: { driver: antigravity, enabled: true },
        [agUnmeasured]: { driver: antigravity, enabled: true },
        [agPartial]: { driver: antigravity, enabled: true },
        [agNullUsage]: { driver: antigravity, enabled: true },
        [first]: { driver: codex, enabled: true },
      },
      providerInstanceFailoverOrder: [
        agDisabled,
        agLimited,
        agRefused,
        agMetered,
        agUnmeasured,
        agPartial,
        agNullUsage,
        first,
      ],
    },
    orchestrationCapableInstanceIds: new Set([
      ownId,
      agDisabled,
      agLimited,
      agRefused,
      agMetered,
      agUnmeasured,
      agPartial,
      agNullUsage,
      first,
    ]),
    providers: [
      provider(ownId, {
        driver: claude,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(agDisabled, { driver: antigravity, enabled: false, models: agModels }),
      provider(agLimited, {
        driver: antigravity,
        models: agModels,
        usageLimits: {
          checkedAt: "2026-11-27T11:55:00Z",
          windows: [
            {
              id: "session",
              kind: "session",
              label: "Session",
              scope: "account",
              usedPercent: 100,
            },
          ],
        },
      }),
      provider(agRefused, { driver: antigravity, models: agModels }),
      provider(agMetered, {
        driver: antigravity,
        auth: { status: "authenticated", type: "apiKey" },
        models: agModels,
      }),
      provider(agUnmeasured, {
        driver: antigravity,
        models: agModels,
        usageLimits: {
          checkedAt: "2026-11-27T11:55:00Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
      provider(agPartial, {
        driver: antigravity,
        models: agModels,
        usageLimits: {
          checkedAt: "2026-11-27T11:55:00Z",
          windows: [
            {
              id: "gemini-default",
              kind: "session",
              label: "Gemini",
              scope: "gemini-default",
              usedPercent: 30,
            },
            {
              id: "gemini-argon",
              kind: "session",
              label: "Gemini Argon",
              scope: "gemini-argon",
              usedPercent: 10,
            },
            {
              id: "third-party",
              kind: "session",
              label: "Claude / GPT-OSS",
              scope: "third-party",
              usedPercent: 100,
            },
          ],
        },
      }),
      provider(agNullUsage, {
        driver: antigravity,
        models: agModels,
        usageLimits: undefined,
      }),
      provider(first),
    ],
  };

  // Paired provider (Codex) comes first even when Antigravity precedes it in failover order.
  const bothReady = autoCoordinatorBriefInput({
    ...baseInput,
    recordedLimits: new Map([[agRefused, [{ resetAt: null, refusedAt: "2026-11-27T11:30:00Z" }]]]),
  });
  expect(bothReady.otherProviders?.map((entry) => entry.providerInstanceId)).toEqual([
    first,
    agUnmeasured,
    agPartial,
    agNullUsage,
  ]);
  expect(
    bothReady.otherProviders
      ?.find((entry) => entry.providerInstanceId === agPartial)
      ?.models.map((model) => model.slug),
  ).toEqual(["gemini-4-neon", "gemini-4-argon", "gemini-3.8-flash"]);
  expect(
    bothReady.otherProviders
      ?.find((entry) => entry.providerInstanceId === agUnmeasured)
      ?.models.map((model) => model.slug),
  ).toContain("claude-opus-5-5");
  expect(
    bothReady.otherProviders
      ?.find((entry) => entry.providerInstanceId === agNullUsage)
      ?.models.map((model) => model.slug),
  ).toContain("gpt-oss-120b-medium");
  expect(bothReady.otherReviewer?.providerInstanceId).toBe(first);
});

it("falls back to Antigravity for cross-provider review using gemini-4-neon and highest thinking_level", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const agNoGemini = ProviderInstanceId.make("antigravity");
  const agWithGemini = ProviderInstanceId.make("antigravity_asd");
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const antigravity = ProviderDriverKind.make("antigravity");
  const thinking = (values: ReadonlyArray<string>) => ({
    optionDescriptors: [
      {
        id: "thinking_level",
        label: "Thinking",
        type: "select" as const,
        role: "reasoning" as const,
        options: values.map((id) => ({ id, label: id })),
      },
    ],
  });
  const baseInput = {
    driver: claude,
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    nowMs: Date.parse("2026-11-27T12:00:00Z"),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      autoModeModels: {
        [claude]: { model: "claude-opus-5-5" },
        [codex]: { model: "gpt-6-astra" },
      },
      providerInstances: {
        [ownId]: { driver: claude, enabled: true },
        [first]: { driver: codex, enabled: true },
        [agNoGemini]: { driver: antigravity, enabled: true },
        [agWithGemini]: { driver: antigravity, enabled: true },
      },
      providerInstanceFailoverOrder: [first, agNoGemini, agWithGemini],
    },
    recordedLimits: new Map([[first, [{ resetAt: null, refusedAt: "2026-11-27T11:00:00Z" }]]]),
    orchestrationCapableInstanceIds: new Set([ownId, first, agNoGemini, agWithGemini]),
    providers: [
      provider(ownId, {
        driver: claude,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(first),
      provider(agNoGemini, {
        driver: antigravity,
        usageLimits: {
          checkedAt: "2026-11-27T11:55:00Z",
          windows: [
            {
              id: "gemini-default",
              kind: "session",
              label: "Gemini",
              scope: "gemini-default",
              usedPercent: 100,
            },
            {
              id: "third-party",
              kind: "session",
              label: "Claude",
              scope: "third-party",
              usedPercent: 15,
            },
          ],
        },
        models: [
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            isCustom: false,
            capabilities: thinking(["low", "medium", "high", "xhigh"]),
          },
          {
            slug: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            isCustom: false,
            capabilities: thinking(["low", "high"]),
          },
        ],
      }),
      provider(agWithGemini, {
        driver: antigravity,
        models: [
          {
            slug: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            isCustom: false,
            isDefault: true,
            // What a live Antigravity session reports for its current model.
            aliases: ["antigravity-default"],
            capabilities: thinking(["low", "medium", "high"]),
          },
          {
            slug: "gemini-4-carbon",
            name: "Gemini 4 Carbon",
            isCustom: false,
            capabilities: thinking(["low", "high"]),
          },
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            isCustom: false,
            capabilities: thinking(["low", "medium", "high", "xhigh"]),
          },
        ],
      }),
    ],
  };

  // Without autoModeModels.antigravity configured, prefers gemini-4-neon on the account with room.
  const preferred = autoCoordinatorBriefInput(baseInput);
  expect(preferred.otherReviewer).toEqual({
    model: "gemini-4-neon",
    options: [{ id: "thinking_level", value: "xhigh" }],
    providerInstanceId: agWithGemini,
  });

  // Without the frontier model, Antigravity offers no reviewer: Auto's profile is the one choice.
  const withoutNeon = autoCoordinatorBriefInput({
    ...baseInput,
    providers: baseInput.providers.map((entry) =>
      entry.instanceId === agNoGemini || entry.instanceId === agWithGemini
        ? {
            ...entry,
            models: entry.models.filter((model) => model.slug !== "gemini-4-neon"),
          }
        : entry,
    ),
  });
  expect(withoutNeon.otherReviewer).toBeUndefined();

  // When Settings explicitly configures Antigravity's primary, honors that model and options.
  const configured = autoCoordinatorBriefInput({
    ...baseInput,
    settings: {
      ...baseInput.settings,
      autoModeModels: {
        ...baseInput.settings.autoModeModels,
        [antigravity]: {
          model: "gemini-4-carbon",
          options: [{ id: "thinking_level", value: "high" }],
        },
      },
    },
  });
  expect(configured.otherReviewer).toEqual({
    model: "gemini-4-carbon",
    options: [{ id: "thinking_level", value: "high" }],
    providerInstanceId: agWithGemini,
  });
});

it("reviews on a provider without an Auto profile with its default model and options", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const grokId = ProviderInstanceId.make("grok_main");
  const claude = ProviderDriverKind.make("claudeAgent");
  const grok = ProviderDriverKind.make("grok");
  const brief = autoCoordinatorBriefInput({
    driver: claude,
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    nowMs: Date.parse("2026-11-27T12:00:00Z"),
    recordedLimits: new Map(),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ownId]: { driver: claude, enabled: true },
        [grokId]: { driver: grok, enabled: true },
      },
      providerInstanceFailoverOrder: [grokId],
    },
    orchestrationCapableInstanceIds: new Set([ownId, grokId]),
    providers: [
      provider(ownId, {
        driver: claude,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(grokId, {
        driver: grok,
        models: [{ slug: "grok-build", name: "Grok Build", isCustom: false, capabilities: null }],
      }),
    ],
  });
  expect(brief.otherReviewer).toEqual({
    model: "grok-build",
    options: [],
    providerInstanceId: grokId,
  });
});

it("reviews on Claude's and Codex's default models when no Auto model is saved", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const claude = ProviderDriverKind.make("claudeAgent");
  const xhigh = {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        role: "reasoning" as const,
        options: ["high", "xhigh"].map((id) => ({ id, label: id })),
      },
    ],
  };
  const brief = autoCoordinatorBriefInput({
    driver: claude,
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    nowMs: Date.parse("2026-11-27T12:00:00Z"),
    recordedLimits: new Map(),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      autoModeModels: {},
      providerInstances: enabledInstances([ownId, first]),
      providerInstanceFailoverOrder: [first],
    },
    orchestrationCapableInstanceIds: new Set([ownId, first]),
    providers: [
      provider(ownId, {
        driver: claude,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(first, {
        models: [
          { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: xhigh },
          { slug: "gpt-6-astra-mini", name: "Astra Mini", isCustom: false, capabilities: xhigh },
        ],
      }),
    ],
  });
  // An unsaved default is still the Settings primary: no switch to the xhigh Auto profile.
  expect(brief.otherReviewer).toEqual({
    model: "gpt-6-astra",
    options: [],
    providerInstanceId: first,
  });
  expect(brief.ownReviewer).toEqual({
    model: "claude-opus-5-5",
    options: [],
    providerInstanceId: ownId,
  });
});

it("discovers all distinct enabled providers for delegation and independent review", () => {
  const ownId = ProviderInstanceId.make("claude_own");
  const museId = ProviderInstanceId.make("muse_main");
  const antigravityId = ProviderInstanceId.make("antigravity_main");
  const claude = ProviderDriverKind.make("claudeAgent");
  const muse = ProviderDriverKind.make("muse");
  const antigravity = ProviderDriverKind.make("antigravity");
  const result = autoCoordinatorBriefInput({
    driver: claude,
    selection: { instanceId: ownId, model: "claude-opus-5-5" },
    projectId: ProjectId.make("project:auto"),
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      autoModeModels: {
        [claude]: { model: "claude-opus-5-5" },
        [muse]: { model: "muse-wonder" },
      },
      providerInstances: {
        [ownId]: { driver: claude, enabled: true },
        [museId]: { driver: muse, enabled: true },
        [antigravityId]: { driver: antigravity, enabled: true },
      },
      providerInstanceFailoverOrder: [museId, antigravityId],
    },
    nowMs: Date.parse("2026-11-08T12:00:00Z"),
    recordedLimits: new Map(),
    orchestrationCapableInstanceIds: new Set([ownId, museId, antigravityId]),
    providers: [
      provider(ownId, {
        driver: claude,
        models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      }),
      provider(museId, {
        driver: muse,
        displayName: "Muse Code",
        models: [{ slug: "muse-wonder", name: "Muse Wonder", isCustom: false, capabilities: null }],
      }),
      provider(antigravityId, {
        driver: antigravity,
        displayName: "Antigravity",
        models: [
          { slug: "gemini-3-pro", name: "Gemini 3 Pro", isCustom: false, capabilities: null },
        ],
      }),
    ],
  });
  expect(result.otherProviders?.map((entry) => [entry.providerInstanceId, entry.driver])).toEqual([
    [museId, muse],
    [antigravityId, antigravity],
  ]);
  expect(result.otherReviewer).toEqual({
    model: "muse-wonder",
    options: [],
    providerInstanceId: museId,
  });
});
