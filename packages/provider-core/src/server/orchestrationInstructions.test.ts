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
  it.each([
    { driver: "claudeAgent", otherAvailable: false },
    { driver: "claudeAgent", otherAvailable: true },
    { driver: "codex", otherAvailable: false },
    { driver: "codex", otherAvailable: true },
  ])(
    "reviews on both configured primaries with $driver coordinating (other available: $otherAvailable)",
    ({ driver, otherAvailable }) => {
      const claude = driver === "claudeAgent";
      const primary = claude
        ? { model: "custom-opus", options: [{ id: "effort", value: "xhigh" }] }
        : { model: "custom-astra", options: [{ id: "reasoningEffort", value: "ultra" }] };
      const otherPrimary = {
        providerInstanceId: claude ? "codex_review" : "claude_review",
        model: "custom-review-model",
        options: claude
          ? [{ id: "reasoningEffort", value: "max" }]
          : [{ id: "effort", value: "xhigh" }],
      };
      const brief = autoCoordinatorInstructions({
        ...input,
        driver: ProviderDriverKind.make(driver),
        model: primary.model,
        primary,
        models: [{ slug: primary.model, name: "Custom Primary", aliases: claude ? ["opus"] : [] }],
        ...(otherAvailable ? { otherPrimary } : {}),
      });
      expect(brief).toContain("review the diff yourself on your Settings primary, Custom Primary");
      expect(brief).toContain(claude ? "effort xhigh" : "reasoningEffort ultra");
      expect(brief).not.toContain("fresh native subagent");
      expect(brief).toContain("choose the best model for each task from either Claude or Codex");
      if (otherAvailable) {
        const target = brief?.match(/role "review", target `([^`]+)`/)?.[1];
        expect(target).toBeDefined();
        expect(JSON.parse(target!)).toEqual({
          ...otherPrimary,
          options: Object.fromEntries(otherPrimary.options.map(({ id, value }) => [id, value])),
        });
        expect(brief).toContain(
          "Also obtain an independent review from the other provider's Settings primary",
        );
        expect(brief).not.toContain("both for big or risky changes");
      } else {
        expect(brief).not.toContain("delegate_task");
        expect(brief).toContain("Report the independent review as incomplete");
      }
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
