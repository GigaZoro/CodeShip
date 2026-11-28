import { assert, describe, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { AutoModeModel } from "@t3tools/contracts/settings";
import {
  applyAutoComplexityToSelection,
  applyAutoRoutingConstraints,
  classifyAutoRequestComplexity,
  filterEligibleAutoProviders,
  preserveAutoSelectionOnAccount,
  resolveEffectiveCapabilityTier,
  vendorFamilyOfDriver,
  type AutoComplexityModelOption,
} from "./AutoComplexityRouting.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const antigravity = ProviderDriverKind.make("antigravity");
const claudeInstance = ProviderInstanceId.make("claude_main");
const codexInstance = ProviderInstanceId.make("codex_main");
const agInstance = ProviderInstanceId.make("antigravity_main");

const effortOption = (
  id: "effort" | "reasoningEffort",
  values: ReadonlyArray<string>,
  promptInjectedValues?: ReadonlyArray<string>,
) => ({
  optionDescriptors: [
    {
      id,
      label: "Effort",
      type: "select" as const,
      options: values.map((value) => ({ id: value, label: value })),
      ...(promptInjectedValues ? { promptInjectedValues } : {}),
    },
  ],
});

const claudeModels: ReadonlyArray<AutoComplexityModelOption> = [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    aliases: ["opus", "primary"],
    capabilities: effortOption("effort", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    capabilities: effortOption("effort", ["low", "medium", "high"]),
  },
  {
    slug: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    aliases: ["sonnet"],
    isDefault: true,
    capabilities: effortOption("effort", ["low", "medium", "high"]),
  },
  {
    slug: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    isLegacy: true,
    capabilities: effortOption("effort", ["low", "medium", "high"]),
  },
];

const codexModels: ReadonlyArray<AutoComplexityModelOption> = [
  {
    slug: "gpt-6.2-astra",
    name: "GPT 6.2 Astra",
    aliases: ["primary"],
    capabilities: effortOption(
      "reasoningEffort",
      ["minimal", "low", "medium", "high", "xhigh", "ultra"],
      ["ultra"],
    ),
  },
  {
    slug: "gpt-6.2-sol",
    name: "GPT 6.2 Sol",
    capabilities: effortOption("reasoningEffort", ["minimal", "low", "medium", "high"]),
  },
  {
    slug: "gpt-6.1-terra",
    name: "GPT 6.1 Terra",
    capabilities: effortOption("reasoningEffort", ["low", "medium", "high"]),
  },
];

describe("classifyAutoRequestComplexity", () => {
  it("classifies explicit high-depth cues, structural depth, and >= 4 attachments as deep", () => {
    for (const text of [
      "Let's redesign the orchestration architecture.",
      "Debug this concurrency race condition in the worker.",
      "Run a security audit on token handling.",
      "Plan a zero-downtime schema migration.",
      "Find the root cause of the crash.",
      "Check for a memory leak in the cache.",
      "Coordinate a multi-repo rollout.",
      "Propose a wire protocol change.",
      "Do a deep dive into this failure.",
      "Use ultra thinking on this bug.",
    ]) {
      assert.equal(classifyAutoRequestComplexity({ text, started: false }), "deep", text);
    }

    const structured =
      "Please investigate the following components:\n" +
      "- apps/server/src/a.ts\n" +
      "- apps/server/src/b.ts\n" +
      "x".repeat(1450);
    assert.equal(classifyAutoRequestComplexity({ text: structured, started: false }), "deep");

    assert.equal(
      classifyAutoRequestComplexity({ text: "Check these", attachmentCount: 4, started: false }),
      "deep",
    );
  });

  it("classifies only utility slash commands, pure started closings, read-only lookups, and narrow mechanical edits as lite", () => {
    for (const text of ["/compact", "/status", "/clear", "/help", "/cost"]) {
      assert.equal(classifyAutoRequestComplexity({ text, started: true }), "lite", text);
    }

    for (const text of ["thanks!", "thank you", "got it", "cool", "status", "any updates?"]) {
      assert.equal(classifyAutoRequestComplexity({ text, started: true }), "lite", text);
      assert.equal(classifyAutoRequestComplexity({ text, started: false }), "standard", text);
    }

    for (const text of [
      "What is the default port?",
      "Where is AccountRouting defined?",
      "git status",
      "Explain how usageLimits works",
      "Fix typo in README.md",
      "Remove unused import in utils.ts",
      "Update comment on line 42",
    ]) {
      assert.equal(classifyAutoRequestComplexity({ text, started: false }), "lite", text);
    }
  });

  it("keeps workflow slash commands, plan approvals, debugging, and broad edits at standard (never lite)", () => {
    for (const text of [
      "/polybot-ado-autopilot",
      "/codeship-daily-retro",
      "/ship",
      "/implement " + "x".repeat(400),
      "go ahead",
      "yes, do it",
      "approved, proceed",
      "ship it",
      "yes, push it",
      "ok",
      "lgtm",
      "looks good",
      "sounds good",
      "perfect",
      "git status, commit and push",
      "git log, then rebase onto main and push",
      "git log, then revert the last commit",
      "show me the last commit and revert it",
      "explain the schema then drop the users table",
      "summarize the PR and merge it",
      "check status and deploy to prod",
      "git diff, then push",
      "what is the bug here, and can you fix the crash",
      "explain the failure, then make the tests pass",
      "what is failing in CI? make it green",
      "why is the app crashing on startup?",
      "why does login fail with an auth error?",
      "why is the database corrupted?",
      "why did the deploy break production?",
      "where is the memory being leaked?",
      "revert the auth change and then find why login still breaks",
      "the date formatting is broken in invoices, fix the bug",
      "rename the users table column and keep every caller working",
      "why does prod crash on startup, fix it",
      "Add pagination to the thread list endpoint and unit tests.",
      "Check status and fix the broken button.",
      "Rename UserConfig across the codebase.",
      "Fix this:\n```ts\nconst x = 1;\n```",
    ]) {
      assert.equal(classifyAutoRequestComplexity({ text, started: true }), "standard", text);
      assert.equal(classifyAutoRequestComplexity({ text, started: false }), "standard", text);
    }
  });
});

describe("applyAutoComplexityToSelection", () => {
  const claudeAuto: ModelSelection = {
    instanceId: claudeInstance,
    model: "claude-opus-5-5",
    autoAccount: true,
    options: [{ id: "effort", value: "high" }],
  };

  it("downgrades fresh lite Auto turns to fast model + low effort on Claude and Codex", () => {
    const tunedClaude = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    });
    assert.deepEqual(tunedClaude, {
      instanceId: claudeInstance,
      model: "claude-sonnet-5-5",
      autoAccount: true,
      options: [{ id: "effort", value: "low" }],
    });

    const codexAuto: ModelSelection = {
      instanceId: codexInstance,
      model: "gpt-6.2-astra",
      autoAccount: true,
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const tunedCodex = applyAutoComplexityToSelection({
      selection: codexAuto,
      complexity: "lite",
      account: { instanceId: codexInstance, driver: codex, models: codexModels },
      started: false,
      configuredAuto: {
        model: "gpt-6.2-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    assert.deepEqual(tunedCodex, {
      instanceId: codexInstance,
      model: "gpt-6.2-sol",
      autoAccount: true,
      options: [{ id: "reasoningEffort", value: "low" }],
    });

    const fallbackCodex = applyAutoComplexityToSelection({
      selection: codexAuto,
      complexity: "lite",
      account: { instanceId: codexInstance, driver: codex, models: codexModels },
      started: false,
      configuredAuto: null,
      modelHasRoom: (slug) => slug !== "gpt-6.2-sol",
    });
    assert.equal(fallbackCodex.model, "gpt-6.1-terra");
  });

  it("keeps started lite threads on lite, never keeps stale non-lite models, and tunes effort live", () => {
    // Started lite thread on sonnet stays on sonnet + low effort even when command carries Opus
    const stayLite = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: true,
      previousModel: "claude-sonnet-5-5",
      configuredAuto: { model: "claude-opus-5-5" },
    });
    assert.equal(stayLite.model, "claude-sonnet-5-5");
    assert.deepEqual(stayLite.options, [{ id: "effort", value: "low" }]);

    // Stale retired frontier model (opus 4.6) is NOT kept when primary moved to opus 5.5
    const staleFrontier = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: true,
      previousModel: "claude-opus-4-6",
      configuredAuto: { model: "claude-opus-5-5" },
    });
    assert.equal(staleFrontier.model, "claude-opus-5-5");
    assert.deepEqual(staleFrontier.options, [{ id: "effort", value: "low" }]);

    // Started lite thread upgrades to opus + high when a deep turn arrives
    const upgradeDeep = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "deep",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: true,
      previousModel: "claude-sonnet-5-5",
      configuredAuto: { model: "claude-opus-5-5" },
    });
    assert.equal(upgradeDeep.model, "claude-opus-5-5");
    assert.deepEqual(upgradeDeep.options, [{ id: "effort", value: "high" }]);

    // Started thread already on opus stays on opus on lite closing and drops effort
    const stayFrontier = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: true,
      previousModel: "claude-opus-5-5",
      configuredAuto: { model: "claude-opus-5-5" },
    });
    assert.equal(stayFrontier.model, "claude-opus-5-5");
    assert.deepEqual(stayFrontier.options, [{ id: "effort", value: "low" }]);
  });

  it("preserves running lite/primary model and options on server continuations and wakes", () => {
    const preservedLite = preserveAutoSelectionOnAccount({
      selection: claudeAuto,
      previousSelection: {
        instanceId: claudeInstance,
        model: "claude-sonnet-5-5",
        autoAccount: true,
        options: [{ id: "effort", value: "low" }],
      },
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
    });
    assert.deepEqual(preservedLite, {
      instanceId: claudeInstance,
      model: "claude-sonnet-5-5",
      autoAccount: true,
      options: [{ id: "effort", value: "low" }],
    });

    const preservedOpusHigh = preserveAutoSelectionOnAccount({
      selection: { ...claudeAuto, options: [{ id: "effort", value: "medium" }] },
      previousSelection: {
        instanceId: claudeInstance,
        model: "claude-opus-5-5",
        autoAccount: true,
        options: [{ id: "effort", value: "high" }],
      },
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
    });
    assert.deepEqual(preservedOpusHigh, {
      instanceId: claudeInstance,
      model: "claude-opus-5-5",
      autoAccount: true,
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("honors lower configured effort on standard and never silently escalates to ultra on deep", () => {
    const lowConfigured: AutoModeModel = {
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "low" }],
    };
    const standardHonorsLow = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "standard",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: lowConfigured,
    });
    assert.deepEqual(standardHonorsLow.options, [{ id: "effort", value: "low" }]);

    const deepDefault = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "deep",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    });
    assert.deepEqual(deepDefault.options, [{ id: "effort", value: "high" }]);

    const deepUltra = applyAutoComplexityToSelection({
      selection: claudeAuto,
      complexity: "deep",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "ultra" }] },
    });
    assert.deepEqual(deepUltra.options, [{ id: "effort", value: "ultra" }]);

    const codexDeepUltra = applyAutoComplexityToSelection({
      selection: { instanceId: codexInstance, model: "gpt-6.2-astra", autoAccount: true },
      complexity: "deep",
      account: { instanceId: codexInstance, driver: codex, models: codexModels },
      started: false,
      configuredAuto: {
        model: "gpt-6.2-astra",
        options: [{ id: "reasoningEffort", value: "ultra" }],
      },
    });
    assert.deepEqual(codexDeepUltra.options, [{ id: "reasoningEffort", value: "xhigh" }]);
  });

  it("leaves non-auto, quotaAwareAuto, and non-claude/codex models untouched", () => {
    const explicit: ModelSelection = {
      instanceId: claudeInstance,
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    };
    assert.strictEqual(
      applyAutoComplexityToSelection({
        selection: explicit,
        complexity: "lite",
        account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
        started: false,
        configuredAuto: null,
      }),
      explicit,
    );

    const quotaAware: ModelSelection = { ...claudeAuto, quotaAwareAuto: true };
    assert.strictEqual(
      applyAutoComplexityToSelection({
        selection: quotaAware,
        complexity: "lite",
        account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
        started: false,
        configuredAuto: null,
      }),
      quotaAware,
    );

    const agSelection: ModelSelection = {
      instanceId: agInstance,
      model: "gemini-4-neon",
      autoAccount: true,
    };
    assert.strictEqual(
      applyAutoComplexityToSelection({
        selection: agSelection,
        complexity: "lite",
        account: {
          instanceId: agInstance,
          driver: antigravity,
          models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon" }],
        },
        started: false,
        configuredAuto: null,
      }),
      agSelection,
    );
  });
});

describe("Auto capability tiers and vendor-family dissimilarity constraints", () => {
  const claudeAuto: ModelSelection = {
    instanceId: claudeInstance,
    model: "claude-opus-5-5",
    autoAccount: true,
    options: [{ id: "effort", value: "high" }],
  };
  const codexAuto: ModelSelection = {
    instanceId: codexInstance,
    model: "gpt-6.2-astra",
    autoAccount: true,
    options: [{ id: "reasoningEffort", value: "high" }],
  };

  it("normalizes vendor families across driver kinds and multi-vendor model slugs", () => {
    assert.equal(vendorFamilyOfDriver("claudeAgent"), "anthropic");
    assert.equal(vendorFamilyOfDriver("codex"), "openai");
    assert.equal(vendorFamilyOfDriver("antigravity"), "google");
    assert.equal(vendorFamilyOfDriver("grok"), "xai");
    assert.equal(vendorFamilyOfDriver("antigravity", "claude-opus-4-6-thinking"), "anthropic");
    assert.equal(vendorFamilyOfDriver("antigravity", "gpt-oss-120b"), "openai");
    assert.equal(vendorFamilyOfDriver("opencode", "anthropic/claude-sonnet-4-5"), "anthropic");
    assert.equal(vendorFamilyOfDriver("opencode", "xai/grok-4"), "xai");
  });

  it("filters out excluded vendor families when a dissimilar provider with quota exists, and degrades gracefully otherwise", () => {
    const candidates = [
      { instanceId: claudeInstance, driver: claude, model: "claude-opus-5-5", hasQuota: true },
      { instanceId: codexInstance, driver: codex, model: "gpt-6.2-astra", hasQuota: true },
      { instanceId: agInstance, driver: antigravity, model: "gemini-4-neon", hasQuota: false },
    ];

    const dissimilar = filterEligibleAutoProviders(candidates, {
      excludeVendorFamily: "Anthropic",
    });
    assert.equal(dissimilar.degradedReason, undefined);
    assert.deepEqual(
      dissimilar.providers.map((provider) => provider.instanceId),
      [codexInstance],
    );

    const noQuotaLeft = filterEligibleAutoProviders(candidates, {
      excludeVendorFamily: ["claude", "openai"],
    });
    assert.equal(noQuotaLeft.degradedReason, "no-dissimilar-provider-available");
    assert.deepEqual(
      noQuotaLeft.providers.map((provider) => provider.instanceId),
      [claudeInstance, codexInstance],
    );

    const noMatchesAtAll = filterEligibleAutoProviders(candidates, {
      excludeVendorFamily: ["anthropic", "openai", "google"],
    });
    assert.equal(noMatchesAtAll.degradedReason, "no-dissimilar-provider-available");
    assert.deepEqual(
      noMatchesAtAll.providers.map((provider) => provider.instanceId),
      [claudeInstance, codexInstance],
    );

    const allExhausted = filterEligibleAutoProviders(
      candidates.map((candidate) => ({ ...candidate, hasQuota: false })),
      { excludeVendorFamily: ["anthropic", "openai", "google"] },
    );
    assert.equal(allExhausted.degradedReason, "no-dissimilar-provider-available");
    assert.equal(allExhausted.providers.length, 3);
  });

  it("maps fast, standard, deep, and frontier tiers and enforces minTier floor without downgrading", () => {
    assert.equal(
      resolveEffectiveCapabilityTier({
        complexity: "lite",
        constraints: { capabilityTier: "fast", minTier: "deep" },
      }),
      "deep",
    );
    assert.equal(
      resolveEffectiveCapabilityTier({
        complexity: "deep",
        constraints: { minTier: "standard" },
      }),
      "deep",
    );

    const fastClaude = applyAutoRoutingConstraints({
      selection: claudeAuto,
      constraints: { capabilityTier: "fast" },
      complexity: "deep",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    });
    assert.equal(fastClaude.model, "claude-sonnet-5-5");
    assert.deepEqual(fastClaude.options, [{ id: "effort", value: "low" }]);

    const flooredClaude = applyAutoRoutingConstraints({
      selection: claudeAuto,
      constraints: { capabilityTier: "fast", minTier: "deep" },
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    });
    assert.equal(flooredClaude.model, "claude-opus-5-5");
    assert.deepEqual(flooredClaude.options, [{ id: "effort", value: "high" }]);

    const frontierClaude = applyAutoRoutingConstraints({
      selection: claudeAuto,
      constraints: { capabilityTier: "frontier" },
      complexity: "lite",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-sonnet-5-5", options: [{ id: "effort", value: "low" }] },
    });
    assert.equal(frontierClaude.model, "claude-opus-5-5");
    assert.deepEqual(frontierClaude.options, [{ id: "effort", value: "ultra" }]);

    // Codex skips promptInjectedValues (ultra) on frontier and picks max supported non-injected value (xhigh).
    const frontierCodex = applyAutoRoutingConstraints({
      selection: codexAuto,
      constraints: { capabilityTier: "frontier" },
      complexity: "standard",
      account: { instanceId: codexInstance, driver: codex, models: codexModels },
      started: false,
      configuredAuto: { model: "gpt-6.2-sol", options: [{ id: "reasoningEffort", value: "low" }] },
    });
    assert.equal(frontierCodex.model, "gpt-6.2-astra");
    assert.deepEqual(frontierCodex.options, [{ id: "reasoningEffort", value: "xhigh" }]);

    // Omitting tier constraints preserves exact legacy Auto complexity behavior (standard honors low).
    const legacyOmitted = applyAutoRoutingConstraints({
      selection: claudeAuto,
      constraints: undefined,
      complexity: "standard",
      account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
      started: false,
      configuredAuto: { model: "claude-opus-5-5", options: [{ id: "effort", value: "low" }] },
    });
    assert.deepEqual(legacyOmitted.options, [{ id: "effort", value: "low" }]);

    // Non-Auto concrete selection stays untouched even when constraints are passed.
    const concretePin: ModelSelection = {
      instanceId: claudeInstance,
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "low" }],
    };
    assert.strictEqual(
      applyAutoRoutingConstraints({
        selection: concretePin,
        constraints: { capabilityTier: "frontier", minTier: "frontier" },
        complexity: "lite",
        account: { instanceId: claudeInstance, driver: claude, models: claudeModels },
        started: false,
        configuredAuto: null,
      }),
      concretePin,
    );
  });
});
