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
  primary: { model: "custom-opus", options: [{ id: "effort", value: "max" }] },
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
      '\n  - one (`one`); reasoningEffort: low, high; target `{"providerInstanceId":"codex_first","model":"one"}`',
    );
    expect(brief).toContain(
      '\n  - two (`two`); effort: max; target `{"providerInstanceId":"codex_second","model":"two"}`',
    );
    expect(brief).toContain(
      '\n  - none (`none`); target `{"providerInstanceId":"codex_second","model":"none"}`',
    );
    expect(brief).not.toContain('"providerInstanceId":"codex_second","model":"one"');
    expect(brief?.match(/one \(`one`\)/g)).toHaveLength(1);
    expect(brief).toContain("extra-4");
    expect(brief).not.toContain("extra-5");
    expect(brief).toContain("More accounts and models: call `orchestrator_capabilities`");
  });
  it.each([false, true])(
    "reviews on the configured primary models (other available: %s)",
    (otherAvailable) => {
      const otherPrimary = {
        providerInstanceId: "codex_review",
        model: "custom-review-model",
        options: [{ id: "reasoningEffort", value: "ultra" }],
      };
      const brief = autoCoordinatorInstructions({
        ...input,
        models: [...input.models, { slug: input.primary.model, name: "Custom Opus" }],
        ...(otherAvailable ? { otherPrimary } : {}),
      });
      expect(brief).toContain("Custom Opus (`custom-opus`), effort max");
      expect(brief).not.toContain(JSON.stringify(input.primary));
      expect(brief).toContain("fresh native subagent on that model");
      if (otherAvailable) {
        expect(brief).toContain(
          'role "review" and target `{"providerInstanceId":"codex_review","model":"custom-review-model","options":{"reasoningEffort":"ultra"}}`',
        );
        expect(brief).toContain("preferring the provider that did not write the code");
        expect(brief).toContain("both for big or risky changes");
      } else expect(brief).not.toContain("delegate_task");
    },
  );
});
