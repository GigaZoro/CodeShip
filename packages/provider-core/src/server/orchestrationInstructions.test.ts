import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  autoCoordinatorInstructions,
  autoModePromptBlock,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

it("sends a command the agent waits on to t3_command_run, which outlives a restart", () => {
  const section = T3_CODE_ORCHESTRATION_INSTRUCTIONS.split("### Background work you wait on")[1];
  expect(section).toContain("`t3_command_run`");
  expect(section).toContain("dev servers and watchers");
  expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).not.toContain("t3_background_wait");
});

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3.CodeShip devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3.CodeShip devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      t3AcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## T3.CodeShip devices",
    );
  });
});

const input = {
  driver: ProviderDriverKind.make("claudeAgent"),
  model: "opus",
  primary: { model: "custom-opus", options: [{ id: "effort", value: "max" }] },
  models: [
    { slug: "claude-opus-5-5", name: "Opus", aliases: ["opus"] },
    { slug: "claude-haiku-4-5", name: "Haiku", aliases: ["haiku"] },
  ],
};
describe("autoCoordinatorInstructions", () => {
  it("keeps the native-subagent brief when the other provider is unavailable", () => {
    expect(autoCoordinatorInstructions(input)).toContain(
      "native subagents (Claude `Agent` with `model`)",
    );
    expect(autoCoordinatorInstructions(input)).toContain("cheapest capable model");
    expect(autoCoordinatorInstructions(input)).toContain("Do tiny requests yourself");
    expect(autoCoordinatorInstructions(input)).toContain("match effort to complexity");
    expect(autoCoordinatorInstructions(input)).toContain(
      "Skip independent review only for trivial, low-risk edits",
    );
    expect(autoCoordinatorInstructions(input)).not.toContain("delegate_task");
  });
  it("uses each model's effort descriptors and points to omitted models", () => {
    const model = (slug: string, id?: string, values: string[] = []) => ({
      slug,
      name: slug,
      capabilities: {
        optionDescriptors:
          id === undefined
            ? []
            : [
                {
                  id,
                  label: "Effort",
                  type: "select" as const,
                  options: values.map((id) => ({ id, label: id })),
                },
              ],
      },
    });
    const brief = autoCoordinatorInstructions({
      ...input,
      otherProviders: [
        {
          providerInstanceId: "codex_first",
          displayName: "First",
          driver: ProviderDriverKind.make("codex"),
          models: [model("one", "reasoningEffort", ["low", "high"])],
        },
        {
          providerInstanceId: "codex_second",
          displayName: "Second",
          driver: ProviderDriverKind.make("codex"),
          models: [
            model("one", "effort", ["max"]),
            model("two", "effort", ["max"]),
            model("none"),
            ...Array.from({ length: 7 }, (_, i) => model(`extra-${i}`)),
          ],
        },
      ],
    });
    expect(brief).toContain(
      '`{"providerInstanceId":"codex_first","model":"<slug>","options":{"reasoningEffort":"<effort>"}}`, effort low, high:\n  - one (`one`)',
    );
    expect(brief).toContain(
      '`{"providerInstanceId":"codex_second","model":"<slug>"}`:\n  - two (`two`); `effort`: max',
    );
    expect(brief).toContain("\n  - none (`none`)\n");
    expect(brief).not.toContain('"providerInstanceId":"codex_second","model":"one"');
    expect(brief?.match(/one \(`one`\)/g)).toHaveLength(1);
    expect(brief).toContain("extra-4");
    expect(brief).not.toContain("extra-5");
    expect(brief).toContain("More accounts and models: call `orchestrator_capabilities`");
  });
  it.each(
    ["claudeAgent", "codex"].flatMap((driver) =>
      [true, false].flatMap((other) => [true, false].map((own) => ({ driver, other, own }))),
    ),
  )(
    "reviews on both providers only while both can run, $driver coordinating (other: $other, own: $own)",
    ({ driver, other, own }) => {
      const claude = driver === "claudeAgent";
      const primary = claude
        ? { model: "custom-opus", options: [{ id: "effort", value: "xhigh" }] }
        : { model: "custom-astra", options: [{ id: "reasoningEffort", value: "ultra" }] };
      const otherReviewer = {
        providerInstanceId: claude ? "codex_review" : "claude_review",
        model: "custom-review-model",
        options: claude
          ? [{ id: "reasoningEffort", value: "max" }]
          : [{ id: "effort", value: "xhigh" }],
      };
      const ownReviewer = {
        ...primary,
        providerInstanceId: claude ? "claude_spare" : "codex_spare",
      };
      const brief = autoCoordinatorInstructions({
        ...input,
        driver: ProviderDriverKind.make(driver),
        model: primary.model,
        primary,
        models: [{ slug: primary.model, name: "Custom Primary", aliases: claude ? ["opus"] : [] }],
        ...(other ? { otherReviewer } : {}),
        ...(own ? { ownReviewer } : {}),
      })!;
      const asTarget = (reviewer: typeof otherReviewer) => ({
        ...reviewer,
        options: Object.fromEntries(reviewer.options.map(({ id, value }) => [id, value])),
      });
      expect(brief).toContain("review the diff yourself on your Settings primary, Custom Primary");
      expect(brief).toContain(claude ? "effort xhigh" : "reasoningEffort ultra");
      expect(brief).not.toContain("fresh native subagent");
      expect(brief).toContain("choose the best model for each task from either Claude or Codex");
      expect(brief).not.toContain("incomplete");
      // The other provider's reviewer comes first, and this provider's takes over when it cannot run.
      expect(
        [...brief.matchAll(/target `(\{[^`]+\})`/g)].map((match) => JSON.parse(match[1]!)),
      ).toEqual([...(other ? [otherReviewer] : []), ...(own ? [ownReviewer] : [])].map(asTarget));
      expect(brief.includes('`delegate_task` role "review"')).toBe(other || own);
      expect(brief.includes("Also obtain an independent review from another provider")).toBe(other);
      expect(brief.includes("No other provider can review now")).toBe(!other && own);
      expect(brief).toContain(
        other && own
          ? "if neither can run, your own review is the only one: say so in your report."
          : other || own
            ? "If it cannot run, your own review is the only one: say so in your report."
            : "No account can run an independent reviewer now, so your own review is the only one",
      );
    },
  );
});

it.each([3, 8])("bounds the brief with four Claude and %s Codex models", (count) => {
  const models = (names: string[], claude: boolean) =>
    names.map((name) => ({
      slug: claude ? `claude-${name}-5-5` : `gpt-6-${name}`,
      name,
      aliases: claude ? [name] : [],
      capabilities: {
        optionDescriptors: [
          {
            id: claude ? "effort" : "reasoningEffort",
            label: "Effort",
            type: "select" as const,
            options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
          },
        ],
      },
    }));
  const brief = autoCoordinatorInstructions({
    ...input,
    models: [
      ...models(["opus", "sonnet", "haiku", "fable"], true),
      { slug: "claude-no-native-alias", name: "Unsupported" },
    ],
    otherProviders: [
      {
        providerInstanceId: "codex_main",
        displayName: "Codex",
        driver: ProviderDriverKind.make("codex"),
        models: models(
          ["astra", "sol", "luna", "terra", "extra-a", "extra-b", "extra-c", "extra-d"].slice(
            0,
            count,
          ),
          false,
        ),
      },
    ],
  })!;
  expect(brief.length).toBeLessThan(count === 3 ? 1800 : 2100);
  expect(brief).toContain("opus (`opus`)");
  expect(brief).not.toContain("claude-opus-5-5");
  expect(brief).not.toContain("Unsupported");
  expect(brief).toContain("gpt-6-astra");
  expect(brief.match(/effort low, medium, high, max/g)).toHaveLength(1);
  expect(brief).not.toMatch(/native subagents[^\n]*effort/);
});

it("notes a Codex native model whose effort differs from the others", () => {
  const model = (slug: string, values: string[]) => ({
    slug,
    name: slug,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select" as const,
          options: values.map((id) => ({ id, label: id })),
        },
      ],
    },
  });
  const brief = autoCoordinatorInstructions({
    ...input,
    driver: ProviderDriverKind.make("codex"),
    models: [
      model("gpt-6-astra", ["low", "high"]),
      model("gpt-6-luna", ["low", "high"]),
      model("gpt-6-nova", ["low", "xhigh"]),
    ],
  })!;
  expect(brief).toContain("- gpt-6-nova (`gpt-6-nova`); effort: low, xhigh");
  expect(brief).not.toMatch(/gpt-6-(astra|luna) \(`[^`]+`\)[^\n]*; effort/);
});

it("states Codex's spawn_agent effort values once and gives Claude's Agent none", () => {
  const efforts = ["low", "medium", "high"];
  const model = (slug: string, name: string, aliases: string[] = []) => ({
    slug,
    name,
    aliases,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select" as const,
          options: efforts.map((id) => ({ id, label: id })),
        },
      ],
    },
  });
  const codex = autoCoordinatorInstructions({
    ...input,
    driver: ProviderDriverKind.make("codex"),
    models: [model("gpt-6-astra", "Astra"), model("gpt-6-luna", "Luna")],
  })!;
  expect(codex).toContain(
    "native subagents (Codex `spawn_agent` with `model`, then wait), `reasoning_effort` low, medium, high:\n  - Astra (`gpt-6-astra`)",
  );
  expect(codex.match(/low, medium, high/g)).toHaveLength(1);
  const claude = autoCoordinatorInstructions({
    ...input,
    models: [model("claude-opus-5-5", "Opus", ["opus"])],
  })!;
  expect(claude).toContain("native subagents (Claude `Agent` with `model`):\n  - Opus (`opus`)");
  expect(claude).not.toContain("reasoning_effort");
  expect(claude).not.toContain("low, medium, high");
});

it("leaves the brief untagged and wraps it once for the prompt", () => {
  const brief = autoCoordinatorInstructions(input)!;
  expect(brief).not.toContain("<t3_auto_mode>");
  const block = autoModePromptBlock(brief);
  expect(block.match(/<t3_auto_mode>/g)).toHaveLength(1);
  expect(block.startsWith("<t3_auto_mode>\nAuto:")).toBe(true);
  expect(block.endsWith("\n</t3_auto_mode>")).toBe(true);
});

it("uses native Claude catalog aliases, omits unsupported models, and keeps Codex slugs", () => {
  const models = [
    { slug: "claude-sonnet-5-5", name: "Sonnet", aliases: ["primary", "sonnet"] },
    { slug: "custom", name: "Unsupported", aliases: ["custom"] },
  ];
  const claude = autoCoordinatorInstructions({ ...input, models })!;
  expect(claude).toContain("Sonnet (`sonnet`)");
  expect(claude).not.toContain("Unsupported");
  expect(claude).not.toContain("claude-sonnet-5-5");
  const codex = autoCoordinatorInstructions({
    ...input,
    driver: ProviderDriverKind.make("codex"),
    models: [{ slug: "gpt-6-astra", name: "Astra", aliases: ["primary"] }],
  })!;
  expect(codex).toContain("Astra (`gpt-6-astra`)");
});

it("lists paired and Antigravity targets via delegate_task, keeps Antigravity Claude models routable, and recognizes reasoning options by role", () => {
  const select = (id: string, values: string[], role?: "reasoning") => ({
    optionDescriptors: [
      {
        id,
        label: "Effort",
        type: "select" as const,
        ...(role === undefined ? {} : { role }),
        options: values.map((value) => ({ id: value, label: value })),
      },
    ],
  });
  const brief = autoCoordinatorInstructions({
    ...input,
    models: [
      { slug: "claude-opus-5-5", name: "Opus", aliases: ["opus"] },
      { slug: "claude-sonnet-5-5", name: "Sonnet", aliases: ["sonnet"] },
      { slug: "claude-haiku-4-5", name: "Haiku", aliases: ["haiku"] },
    ],
    otherProviders: [
      {
        providerInstanceId: "codex_main",
        displayName: "Codex",
        driver: ProviderDriverKind.make("codex"),
        models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna"].map((slug) => ({
          slug,
          name: slug,
          capabilities: select("reasoningEffort", ["low", "medium", "high", "xhigh"]),
        })),
      },
      {
        providerInstanceId: "antigravity",
        displayName: "Antigravity",
        driver: ProviderDriverKind.make("antigravity"),
        models: [
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            capabilities: select("thinking_level", ["low", "medium", "high", "xhigh"], "reasoning"),
          },
          {
            slug: "gemini-4-hydrogen",
            name: "Gemini 4 Hydrogen",
            capabilities: select("thinking_level", ["low", "medium", "high", "xhigh"], "reasoning"),
          },
          {
            slug: "gemini-4-carbon",
            name: "Gemini 4 Carbon",
            capabilities: select("thinking_level", ["low", "medium", "high", "xhigh"], "reasoning"),
          },
          {
            slug: "gemini-4-argon",
            name: "Gemini 4 Argon",
            capabilities: select("custom_reasoning", ["low", "high"], "reasoning"),
          },
          {
            slug: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            capabilities: select("thinking_level", ["low", "medium", "high", "xhigh"], "reasoning"),
          },
        ],
      },
      {
        providerInstanceId: "antigravity_asd",
        displayName: "Antigravity ASD",
        driver: ProviderDriverKind.make("antigravity"),
        models: [
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            capabilities: select("thinking_level", ["low", "medium", "high", "xhigh"], "reasoning"),
          },
          {
            slug: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            capabilities: select("thinking_level", ["low", "high"], "reasoning"),
          },
          {
            slug: "gpt-oss-120b-medium",
            name: "GPT-OSS 120B (Medium)",
            capabilities: select("thinking_level", ["low", "high"], "reasoning"),
          },
        ],
      },
    ],
  })!;
  expect(brief).toContain("from Claude, Codex, or Antigravity.");
  expect(brief.indexOf("- Codex via `delegate_task`")).toBeLessThan(
    brief.indexOf("- Antigravity via `delegate_task`"),
  );
  expect(brief).toContain(
    '- Antigravity via `delegate_task`, target `{"providerInstanceId":"antigravity","model":"<slug>","options":{"thinking_level":"<effort>"}}`, effort low, medium, high, xhigh:',
  );
  expect(brief).toContain(
    '- Antigravity via `delegate_task`, target `{"providerInstanceId":"antigravity_asd","model":"<slug>","options":{"thinking_level":"<effort>"}}`, effort low, high:\n  - Claude Opus 5.5 (`claude-opus-5-5`): hardest design, subtle bugs, reviews\n  - GPT-OSS 120B (Medium) (`gpt-oss-120b-medium`)',
  );
  expect(brief).toContain("Gemini 4 Neon (`gemini-4-neon`): frontier: the hardest problems");
  expect(brief).toContain(
    "Gemini 4 Hydrogen (`gemini-4-hydrogen`): demanding reasoning and coding",
  );
  expect(brief).toContain(
    "Gemini 4 Argon (`gemini-4-argon`): straightforward work; `custom_reasoning`: low, high",
  );
  // Second Antigravity account adds only models not already listed on the first Antigravity account.
  expect(brief.match(/Gemini 4 Neon \(`gemini-4-neon`\)/g)).toHaveLength(1);
  // Antigravity is never described as a native subagent target.
  expect(brief).not.toMatch(/native subagents[^\n]*Antigravity/i);
  expect(brief).not.toContain("More accounts and models: call `orchestrator_capabilities`");
  expect(Buffer.byteLength(brief, "utf8")).toBeLessThan(4000);
});

it("routes Claude models on Antigravity via delegate_task when Codex coordinates and caps oversized multi-provider rosters under 4000 bytes", () => {
  const select = (id: string, values: string[]) => ({
    optionDescriptors: [
      {
        id,
        label: "Effort",
        type: "select" as const,
        options: values.map((value) => ({ id: value, label: value })),
      },
    ],
  });
  const codexWithAntigravityClaude = autoCoordinatorInstructions({
    ...input,
    driver: ProviderDriverKind.make("codex"),
    model: "gpt-6-astra",
    models: [{ slug: "gpt-6-astra", name: "Astra" }],
    otherProviders: [
      {
        providerInstanceId: "antigravity_akucheri",
        displayName: "Antigravity",
        driver: ProviderDriverKind.make("antigravity"),
        models: [
          {
            slug: "model-opaque-frontier",
            name: "Frontier Opaque",
            nativeModelFamily: "gemini-4-neon",
            capabilities: select("thinking_level", ["low", "high", "xhigh"]),
          },
          {
            slug: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            capabilities: select("thinking_level", ["low", "high", "xhigh"]),
          },
        ],
      },
    ],
  })!;
  expect(codexWithAntigravityClaude).toContain(
    '- Antigravity via `delegate_task`, target `{"providerInstanceId":"antigravity_akucheri","model":"<slug>","options":{"thinking_level":"<effort>"}}`, effort low, high, xhigh:',
  );
  expect(codexWithAntigravityClaude).toContain(
    "Frontier Opaque (`model-opaque-frontier`): frontier: the hardest problems",
  );
  expect(codexWithAntigravityClaude).toContain("Claude Opus 5.5 (`claude-opus-5-5`)");
  expect(codexWithAntigravityClaude).not.toMatch(/spawn_agent[^\n]*antigravity/i);

  // Over the shared budget, providers split it evenly.
  const makeModels = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      slug: `${prefix}-model-${index + 1}`,
      name: `${prefix} ${index + 1}`,
      capabilities: select("reasoningEffort", ["low", "high"]),
    }));
  const capped = autoCoordinatorInstructions({
    ...input,
    otherProviders: [
      {
        providerInstanceId: "codex_main",
        displayName: "Codex",
        driver: ProviderDriverKind.make("codex"),
        models: makeModels("codex", 6),
      },
      {
        providerInstanceId: "antigravity_main",
        displayName: "Antigravity",
        driver: ProviderDriverKind.make("antigravity"),
        models: makeModels("ag", 6),
      },
      {
        providerInstanceId: "grok_main",
        displayName: "Grok",
        driver: ProviderDriverKind.make("grok"),
        models: makeModels("grok", 6),
      },
    ],
  })!;
  // On a tie the paired provider, Codex, takes the remainder.
  expect(capped).toContain("codex-model-6");
  expect(capped).toContain("ag-model-5");
  expect(capped).not.toContain("ag-model-6");
  expect(capped).toContain("grok-model-5");
  expect(capped).not.toContain("grok-model-6");
  expect(capped).toContain("More accounts and models: call `orchestrator_capabilities`");
  expect(Buffer.byteLength(capped, "utf8")).toBeLessThan(4000);
});

it("lists a model on the second account of a provider when the first has no room for it", () => {
  const thinking = {
    optionDescriptors: [
      {
        id: "thinking_level",
        label: "Thinking",
        type: "select" as const,
        role: "reasoning" as const,
        options: ["low", "high", "xhigh"].map((id) => ({ id, label: id })),
      },
    ],
  };
  const gemini = [
    "gemini-4-neon",
    "gemini-4-argon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.8-flash-lite",
    "gemini-3.5-pro",
    "gemini-3.5-flash",
  ].map((slug) => ({ slug, name: slug, capabilities: thinking }));
  const thirdParty = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b-medium"].map(
    (slug) => ({ slug, name: slug, capabilities: thinking }),
  );
  const antigravity = ProviderDriverKind.make("antigravity");
  const brief = autoCoordinatorInstructions({
    ...input,
    driver: ProviderDriverKind.make("codex"),
    model: "gpt-6-astra",
    models: [{ slug: "gpt-6-astra", name: "Astra" }],
    otherProviders: [
      // The first account is out of its Claude and GPT-OSS quota, so it lists only Gemini.
      { providerInstanceId: "ag_first", displayName: "AG 1", driver: antigravity, models: gemini },
      {
        providerInstanceId: "ag_second",
        displayName: "AG 2",
        driver: antigravity,
        models: [...thirdParty, ...gemini],
      },
    ],
  })!;
  const sections = brief.split("\n- ");
  const second = sections.find((section) => section.includes('"providerInstanceId":"ag_second"'));
  expect(second).toContain("(`claude-opus-5-5`)");
  // Each listed model appears once, on the first account that has room for it.
  expect(second).not.toContain("(`gemini-4-neon`)");
  expect(brief.match(/\(`gemini-4-neon`\)/g)).toHaveLength(1);
  expect(brief).toContain("More accounts and models: call `orchestrator_capabilities`");
});

it("hands a small provider's unused share to the rest and drops trailing accounts past the byte limit", () => {
  const select = {
    optionDescriptors: [
      {
        id: "thinking_level",
        label: "Thinking",
        type: "select" as const,
        options: ["low", "high", "xhigh"].map((id) => ({ id, label: id })),
      },
    ],
  };
  const models = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      slug: `${prefix}-model-${index + 1}`,
      name: `${prefix} ${index + 1}`,
      capabilities: select,
    }));
  const provider = (id: string, driver: string, list: ReturnType<typeof models>) => ({
    providerInstanceId: id,
    displayName: id,
    driver: ProviderDriverKind.make(driver),
    models: list,
  });
  // 2 + 11 + 4 = 17 models: Codex and Grok leave Antigravity room for its full 8.
  const filled = autoCoordinatorInstructions({
    ...input,
    otherProviders: [
      provider("codex_main", "codex", models("codex", 2)),
      provider("antigravity_main", "antigravity", models("ag", 11)),
      provider("grok_main", "grok", models("grok", 4)),
    ],
  })!;
  expect(filled).toContain("ag-model-8");
  expect(filled).not.toContain("ag-model-9");
  expect(filled).toContain("grok-model-4");
  expect(filled).toContain("More accounts and models: call `orchestrator_capabilities`");

  // Many accounts, each with its own quota, would pass the limit: trailing ones go, the review stays.
  const longId = (index: number) =>
    `antigravity_account_with_a_long_instance_identifier_for_a_work_profile_signed_in_on_this_machine_${index}`;
  const ag = models("gemini-long-model-name-for-the-byte-budget", 8);
  const crowded = autoCoordinatorInstructions({
    ...input,
    otherReviewer: { providerInstanceId: "codex_main", model: "gpt-6-astra" },
    otherProviders: [
      provider("codex_main", "codex", models("codex", 8)),
      ...ag.map((model, index) => provider(longId(index), "antigravity", [model])),
    ],
  })!;
  expect(new TextEncoder().encode(autoModePromptBlock(crowded)).length).toBeLessThanOrEqual(4000);
  expect(crowded).toContain('role "review", target `{"model":"gpt-6-astra"');
  expect(crowded).toContain("More accounts and models: call `orchestrator_capabilities`");
  expect(crowded).toContain(longId(0));
  expect(crowded).not.toContain(longId(7));
});

it("labels non-Claude/Codex providers accurately and keeps shared slugs across distinct drivers", () => {
  const brief = autoCoordinatorInstructions({
    ...input,
    otherProviders: [
      {
        providerInstanceId: "antigravity_main",
        displayName: "Antigravity",
        driver: ProviderDriverKind.make("antigravity"),
        models: [{ slug: "default", name: "Gemini Pro" }],
      },
      {
        providerInstanceId: "muse_main",
        displayName: "Muse Code",
        driver: ProviderDriverKind.make("muse"),
        models: [{ slug: "default", name: "Muse Default" }],
      },
    ],
  });
  expect(brief).toContain("- Antigravity via `delegate_task`");
  expect(brief).toContain("- Muse Code via `delegate_task`");
  expect(brief).toContain("Gemini Pro (`default`)");
  expect(brief).toContain("Muse Default (`default`)");
});
