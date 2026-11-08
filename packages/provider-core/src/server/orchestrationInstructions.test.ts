import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  autoCoordinatorInstructions,
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
  models: [
    { slug: "opus", name: "Opus" },
    { slug: "haiku", name: "Haiku" },
  ],
};
describe("autoCoordinatorInstructions", () => {
  it("keeps the native-subagent brief when the other provider is unavailable", () => {
    expect(autoCoordinatorInstructions(input)).toContain(
      "Otherwise run the work as a native subagent",
    );
    expect(autoCoordinatorInstructions(input)).toContain("cheaper models on routine work");
    expect(autoCoordinatorInstructions(input)).not.toContain("delegate_task");
  });
  it.each([undefined, { id: "reasoningEffort", values: ["low", "high", "xhigh"] }])(
    "lists both providers for a Claude coordinator with effort %j",
    (effort) => {
      const brief = autoCoordinatorInstructions({
        ...input,
        models: [
          ...input.models,
          { slug: "claude-sonnet-5-5", name: "Sonnet" },
          { slug: "claude-fable", name: "Fable" },
        ],
        otherProvider: {
          providerInstanceId: "codex_work",
          displayName: "Work Codex",
          driver: ProviderDriverKind.make("codex"),
          models: [
            { slug: "gpt-6-astra", name: "Astra", ...(effort === undefined ? {} : { effort }) },
            { slug: "gpt-sol", name: "Sol" },
            { slug: "gpt-terra", name: "Terra" },
            { slug: "gpt-luna", name: "Luna" },
            { slug: "unknown", name: "Unknown" },
            { slug: "sixth", name: "Sixth" },
            { slug: "excluded", name: "Excluded" },
          ],
        },
      });
      expect(brief).toContain(
        "Otherwise split the work and give each piece (implementation, research, tests, mechanical edits) to the cheapest model below that can do it well, from either provider.",
      );
      expect(brief).toContain(
        "Claude models, as a native subagent (Claude `Agent` with `model`): Opus (`opus`, you): hardest design, subtle bugs, reviews; Haiku (`haiku`): fast and cheap: searches, mechanical edits, test runs; Sonnet (`claude-sonnet-5-5`): features, fixes and tests; Fable (`claude-fable`): frontier: the hardest problems.",
      );
      expect(brief).toContain(
        "Codex models on Work Codex, with `delegate_task` and target `" +
          JSON.stringify({
            providerInstanceId: "codex_work",
            model: "<id>",
            ...(effort === undefined ? {} : { options: { reasoningEffort: "<effort>" } }),
          }) +
          "`",
      );
      expect(brief).toContain(
        "Astra (`gpt-6-astra`): frontier: the most demanding work; Sol (`gpt-sol`): coding and everyday work; Terra (`gpt-terra`): straightforward work; Luna (`gpt-luna`): fast and cheap: easier tasks; Unknown (`unknown`); Sixth (`sixth`).",
      );
      expect(brief).not.toContain("Excluded");
      if (effort) expect(brief).toContain("effort one of low, high, xhigh");
      else expect(brief).not.toContain("effort one of");
    },
  );
  it("lists Claude effort options and Codex native models for a Codex coordinator", () => {
    const brief = autoCoordinatorInstructions({
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-sol",
      models: [
        { slug: "gpt-sol", name: "Sol" },
        ...Array.from({ length: 8 }, (_, i) => ({ slug: `model-${i}`, name: `Model ${i}` })),
      ],
      otherProvider: {
        providerInstanceId: "claude_work",
        displayName: "Work Claude",
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [
          {
            slug: "claude-sonnet",
            name: "Sonnet",
            effort: { id: "effort", values: ["low", "high", "max"] },
          },
        ],
      },
    });
    expect(brief).toContain(
      "Codex models, as a native subagent (Codex `spawn_agent` with `model`, then wait): Sol (`gpt-sol`, you): coding and everyday work;",
    );
    expect(brief).toContain(
      'Claude models on Work Claude, with `delegate_task` and target `{"providerInstanceId":"claude_work","model":"<id>","options":{"effort":"<effort>"}}`, effort one of low, high, max: Sonnet (`claude-sonnet`): features, fixes and tests.',
    );
    expect(brief).toContain("Model 6 (`model-6`).");
    expect(brief).not.toContain("Model 7");
  });
});
