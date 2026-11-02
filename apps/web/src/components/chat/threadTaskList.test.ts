import { MessageId, NodeId, PlanId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { resolveThreadTaskList } from "./threadTaskList";

describe("resolveThreadTaskList", () => {
  it("follows the to-do list of the run the agent is on, and only that run's", () => {
    const base = makeThreadProjectionFixture();
    const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");
    const run = (ordinal: number, status: "running" | "queued" = "running") => ({
      id: RunId.make(`run-${ordinal}`),
      threadId: base.thread.id,
      ordinal,
      providerInstanceId: base.thread.providerInstanceId,
      modelSelection: base.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: status === "queued" ? null : now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    const todoList = (id: string, ordinal: number, status: "active" | "superseded", done = 0) => ({
      id: PlanId.make(id),
      threadId: base.thread.id,
      runId: RunId.make(`run-${ordinal}`),
      nodeId: NodeId.make("root"),
      kind: "todo_list" as const,
      status,
      steps: ["Read", "Change", "Test"].map((text, index) => ({
        id: `${id}-${index}`,
        text,
        status: index < done ? ("completed" as const) : ("pending" as const),
      })),
    });
    const projection = {
      ...base,
      runs: [run(1), run(2)],
      plans: [
        todoList("earlier-run", 1, "active", 3),
        todoList("rewritten", 2, "superseded"),
        todoList("current", 2, "active", 1),
      ],
    };

    expect(resolveThreadTaskList(projection)).toMatchObject({
      completed: 1,
      steps: [{ id: "current-0" }, { id: "current-1" }, { id: "current-2" }],
    });
    // A follow-up queued behind the run keeps the list in view.
    expect(
      resolveThreadTaskList({ ...projection, runs: [run(1), run(2), run(3, "queued")] }),
    ).toMatchObject({
      completed: 1,
    });
    // A list from an earlier run would read as current work.
    expect(resolveThreadTaskList({ ...projection, plans: projection.plans.slice(0, 2) })).toBe(
      null,
    );
  });
});
