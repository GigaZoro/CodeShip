import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpSaveScheduledTaskInput,
  OrchestratorMcpScheduledTask,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
} from "./orchestratorMcp.ts";

const decodeScheduledTask = Schema.decodeUnknownSync(OrchestratorMcpScheduledTask);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeInterruptResult = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptResult);

describe("orchestrator MCP contracts", () => {
  it("preserves the resolved and requested run ids in restart interruption results", () => {
    const result = {
      threadId: "thread-restart",
      runId: "run-continuation",
      requestedRunId: "run-source",
      status: "interrupt_requested",
    };
    expect(decodeInterruptResult(result)).toEqual(result);
  });
  it("carries an interrupt's outcome, and still reads results from servers without it", () => {
    const ended = {
      threadId: "thread-restart",
      runId: "run-source",
      status: "completed",
      outcome: "already_terminal",
    };
    expect(decodeInterruptResult(ended)).toEqual(ended);
    expect(() => decodeInterruptResult({ ...ended, outcome: "stopped" })).toThrow();
    const older = { threadId: "thread-restart", runId: null, status: "no_active_run" };
    expect(decodeInterruptResult(older)).toEqual(older);
  });
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

it.each([
  {},
  { modelSelection: { instanceId: "codex", model: "astra" }, followsDefaultModel: false },
])("decodes scheduled tasks from old and current linked machines: %j", (modelFields) => {
  const task = {
    scheduledTaskId: "task-1",
    title: "Review",
    prompt: "Review changes",
    enabled: true,
    projectId: "project-1",
    boundThreadId: null,
    schedule: { type: "interval", everyMs: 1800000 },
    nextRunAt: null,
    lastRunStatus: "never",
    ...modelFields,
  };
  expect(decodeScheduledTask(task)).toEqual(task);
});

describe("scheduled task model selection input", () => {
  const decode = Schema.decodeUnknownSync(OrchestratorMcpSaveScheduledTaskInput);
  const base = { environmentId: "local", projectId: "project-1", prompt: "go" };

  it("accepts a canonical selection", () => {
    expect(
      decode({ ...base, modelSelection: { instanceId: "codex", model: "gpt-5" } }).modelSelection,
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
  });

  it.each([
    ["no provider identity", { model: "gpt-5" }],
    ["the legacy provider field alone", { provider: "codex", model: "gpt-5" }],
    ["a blank model", { instanceId: "codex", model: "  " }],
    ["a non-boolean autoAccount", { instanceId: "codex", model: "gpt-5", autoAccount: "yes" }],
  ])("rejects %s", (_name, modelSelection) => {
    expect(() => decode({ ...base, modelSelection })).toThrow();
  });
});
