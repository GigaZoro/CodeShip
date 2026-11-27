import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { didContinuationSwitchAccount } from "./TimelineUserMessageRow.logic";

function makeRun(input: {
  id: string;
  ordinal: number;
  instanceId: string;
  model?: string;
  status?: HandoffTimelineRun["status"];
  userMessageId?: string;
}): HandoffTimelineRun {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  return {
    id: RunId.make(input.id),
    ordinal: input.ordinal,
    providerInstanceId: instanceId,
    modelSelection: {
      instanceId,
      model: input.model ?? "gpt-5.4",
    },
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.userMessageId !== undefined
      ? { userMessageId: MessageId.make(input.userMessageId) }
      : {}),
  };
}

describe("didContinuationSwitchAccount", () => {
  it("does not mislabel a held-run restart on the same account as an account switch", () => {
    const runs = [
      makeRun({
        id: "run-1",
        ordinal: 1,
        instanceId: "codex-b",
        status: "completed",
        userMessageId: "user-1",
      }),
      makeRun({
        id: "run-2",
        ordinal: 2,
        instanceId: "codex-a",
        status: "running",
        userMessageId: "user-2",
      }),
    ];

    // Held-run restart attached to run-2 via appendSteeringMessage (inputIntent: "steer", no modelSwitch).
    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-2"),
        messageId: "limit-resume:run-2",
        runs,
        inputIntent: "steer",
      }),
    ).toBe(false);

    // Even without inputIntent, userMessageId mismatch shows the message was attached to an existing run.
    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-2"),
        messageId: "limit-resume:run-2",
        runs,
      }),
    ).toBe(false);
  });

  it("recognizes explicit modelSwitch or limit-failover ids as account switches even on steered continuations", () => {
    const runs = [
      makeRun({
        id: "run-1",
        ordinal: 1,
        instanceId: "codex-a",
        status: "running",
        userMessageId: "user-1",
      }),
    ];

    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-1"),
        messageId: "limit-failover:run-1",
        runs,
        inputIntent: "steer",
      }),
    ).toBe(true);

    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-1"),
        messageId: "limit-resume:run-1",
        runs,
        inputIntent: "steer",
        modelSwitch: {
          from: {
            instanceId: ProviderInstanceId.make("codex-a"),
            model: "gpt-5.4",
          },
          to: {
            instanceId: ProviderInstanceId.make("codex-b"),
            model: "gpt-5.4",
          },
        },
      }),
    ).toBe(true);
  });

  it("skips queued and rolled_back runs when comparing the continuation run against the previous run", () => {
    const runs = [
      makeRun({
        id: "run-1",
        ordinal: 1,
        instanceId: "codex-a",
        status: "completed",
        userMessageId: "user-1",
      }),
      makeRun({
        id: "run-2-rolled-back",
        ordinal: 2,
        instanceId: "codex-b",
        status: "rolled_back",
        userMessageId: "user-2",
      }),
      makeRun({
        id: "run-3-queued",
        ordinal: 3,
        instanceId: "codex-b",
        status: "queued",
        userMessageId: "user-3",
      }),
      makeRun({
        id: "run-4-resumed",
        ordinal: 4,
        instanceId: "codex-a",
        status: "completed",
        userMessageId: "limit-reset-resume:run-1",
      }),
    ];

    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-4-resumed"),
        messageId: "limit-reset-resume:run-1",
        runs,
        inputIntent: "turn_start",
      }),
    ).toBe(false);

    const switchedRuns = [
      ...runs.slice(0, 3),
      makeRun({
        id: "run-4-switched",
        ordinal: 4,
        instanceId: "codex-b",
        status: "completed",
        userMessageId: "limit-resume:run-1",
      }),
    ];

    expect(
      didContinuationSwitchAccount({
        runId: RunId.make("run-4-switched"),
        messageId: "limit-resume:run-1",
        runs: switchedRuns,
        inputIntent: "turn_start",
      }),
    ).toBe(true);
  });
});
