import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { currentSubagent } from "./ThreadRelationshipsControl.logic";

const delegatedSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-model-a",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const childSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-model-b",
  options: [{ id: "effort", value: "max" }],
};

const finishedAgent = (origin: "app_owned" | "provider_native") => ({
  origin,
  status: "completed" as const,
  model: delegatedSelection.model,
  providerInstanceId: delegatedSelection.instanceId,
  modelSelection: delegatedSelection,
  startedAt: "2026-01-01T10:00:00.000Z",
  completedAt: "2026-01-01T10:10:00.000Z",
  updatedAt: "2026-01-01T10:10:00.000Z",
  progress: "Finishing up",
  result: "Done",
  error: null,
});

const childRunning = {
  status: "running" as const,
  activityRunStatus: "running" as const,
  activityRunStartedAt: DateTime.makeUnsafe("2026-01-01T11:00:00.000Z"),
  latestRunRequestedAt: DateTime.makeUnsafe("2026-01-01T11:00:00.000Z"),
  latestRunStartedAt: DateTime.makeUnsafe("2026-01-01T11:00:00.000Z"),
  latestRunCompletedAt: null,
  latestRunModelSelection: childSelection,
  activityRunModelSelection: childSelection,
};

describe("currentSubagent", () => {
  it("describes a resumed app-owned child by its own run and model", () => {
    const agent = currentSubagent(finishedAgent("app_owned"), childRunning);

    expect(agent).toMatchObject({
      status: "running",
      startedAt: "2026-01-01T11:00:00.000Z",
      completedAt: null,
      model: childSelection.model,
      providerInstanceId: childSelection.instanceId,
      modelSelection: childSelection,
      progress: null,
      result: null,
    });
  });

  it("shows the model a finished run used, not the one chosen for the next run", () => {
    const nextSelection = { ...childSelection, model: "claude-model-c" };
    const childFinished = {
      ...childRunning,
      status: "completed" as const,
      activityRunStatus: null,
      activityRunModelSelection: null,
      latestRunCompletedAt: DateTime.makeUnsafe("2026-01-01T11:20:00.000Z"),
      modelSelection: nextSelection,
    };

    expect(currentSubagent(finishedAgent("app_owned"), childFinished)).toMatchObject({
      status: "completed",
      completedAt: "2026-01-01T11:20:00.000Z",
      model: childSelection.model,
      modelSelection: childSelection,
    });
  });

  it("keeps the delegation's model when the server does not say what the run used", () => {
    const {
      latestRunModelSelection: _latest,
      activityRunModelSelection: _activity,
      ...older
    } = childRunning;

    expect(currentSubagent(finishedAgent("app_owned"), older)).toMatchObject({
      status: "running",
      model: delegatedSelection.model,
      modelSelection: delegatedSelection,
    });
  });

  it("keeps a provider-native child's model, which its parent runs", () => {
    const agent = currentSubagent(finishedAgent("provider_native"), childRunning);

    expect(agent).toMatchObject({
      status: "running",
      model: delegatedSelection.model,
      providerInstanceId: delegatedSelection.instanceId,
      modelSelection: delegatedSelection,
    });
  });

  it("keeps the delegation when the child has run nothing since", () => {
    const agent = finishedAgent("app_owned");
    const idleChild = {
      ...childRunning,
      status: "idle" as const,
      activityRunStatus: null,
      latestRunRequestedAt: DateTime.makeUnsafe("2026-01-01T09:59:00.000Z"),
    };

    expect(currentSubagent(agent, idleChild)).toBe(agent);
  });
});
