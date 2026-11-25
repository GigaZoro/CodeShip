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
