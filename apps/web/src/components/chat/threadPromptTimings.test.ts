import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2UserMessageInputIntent,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadPromptTimings } from "./threadPromptTimings";

type Projection = Pick<ThreadStructure, "runs" | "turnItems">;

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 0, minute));
const iso = (minute: number) => DateTime.formatIso(at(minute));

function run(
  id: string,
  status: OrchestrationV2Run["status"],
  startedMinute: number | null,
  completedMinute: number | null,
): Projection["runs"][number] {
  return {
    id: RunId.make(id),
    userMessageId: MessageId.make(`prompt-${id}`),
    status,
    requestedAt: at(startedMinute ?? 0),
    startedAt: startedMinute === null ? null : at(startedMinute),
    completedAt: completedMinute === null ? null : at(completedMinute),
  } as Projection["runs"][number];
}

function prompt(
  messageId: string,
  runId: string | null,
  minute: number,
  inputIntent: OrchestrationV2UserMessageInputIntent = "turn_start",
): Projection["turnItems"][number] {
  return {
    type: "user_message",
    messageId: MessageId.make(messageId),
    runId: runId === null ? null : RunId.make(runId),
    inputIntent,
    startedAt: at(minute),
    updatedAt: at(minute),
  } as Projection["turnItems"][number];
}

describe("deriveThreadPromptTimings", () => {
  it("times each prompt by its own run, whatever happened in later runs", () => {
    const timings = deriveThreadPromptTimings({
      runs: [
        run("a", "failed", 1, 4),
        run("b", "completed", 10, 12),
        run("c", "running", 20, null),
      ],
      turnItems: [
        prompt("prompt-a", "a", 0),
        prompt("prompt-b", "b", 9),
        prompt("prompt-c", "c", 19),
      ],
    });

    expect(timings.get("prompt-a")).toEqual({
      startedAt: iso(1),
      completedAt: iso(4),
      outcome: "failed",
    });
    expect(timings.get("prompt-b")).toEqual({
      startedAt: iso(10),
      completedAt: iso(12),
      outcome: null,
    });
    expect(timings.get("prompt-c")).toEqual({
      startedAt: iso(20),
      completedAt: null,
      outcome: "running",
    });
  });

  it("starts a steer when it was sent and ends the prompt before it there", () => {
    const timings = deriveThreadPromptTimings({
      runs: [run("a", "interrupted", 1, 9)],
      turnItems: [prompt("prompt-a", "a", 0), prompt("steer", "a", 5, "steer")],
    });

    expect(timings.get("prompt-a")).toEqual({
      startedAt: iso(1),
      completedAt: iso(5),
      outcome: null,
    });
    expect(timings.get("steer")).toEqual({
      startedAt: iso(5),
      completedAt: iso(9),
      outcome: "stopped",
    });
  });

  it("starts a steer queued before its run no earlier than the run", () => {
    const timings = deriveThreadPromptTimings({
      runs: [run("a", "completed", 3, 8)],
      turnItems: [
        prompt("prompt-a", "a", 2),
        prompt("promoted", "a", 1, "promoted_queued_to_steer"),
      ],
    });

    expect(timings.get("prompt-a")).toEqual({
      startedAt: iso(3),
      completedAt: iso(3),
      outcome: null,
    });
    expect(timings.get("promoted")).toEqual({
      startedAt: iso(3),
      completedAt: iso(8),
      outcome: null,
    });
  });

  it("keeps an answer to the agent inside the prompt that asked for it", () => {
    const timings = deriveThreadPromptTimings({
      runs: [run("a", "completed", 1, 9)],
      turnItems: [prompt("prompt-a", "a", 0), prompt("async-answer:request-1", "a", 5, "steer")],
    });

    expect(timings.get("prompt-a")).toEqual({
      startedAt: iso(1),
      completedAt: iso(9),
      outcome: null,
    });
    expect(timings.has("async-answer:request-1")).toBe(false);
  });

  it("gives no timing without a run record, before the run starts, or once it is undone", () => {
    const timings = deriveThreadPromptTimings({
      runs: [run("queued", "queued", null, null), run("undone", "rolled_back", 1, 3)],
      turnItems: [
        prompt("imported", null, 0),
        prompt("missing-run", "gone", 0),
        prompt("prompt-queued", "queued", 0, "queued_turn"),
        prompt("prompt-undone", "undone", 0),
      ],
    });

    expect(timings.size).toBe(0);
  });

  it("gives no timing to a settled run whose end is unknown", () => {
    const timings = deriveThreadPromptTimings({
      runs: [run("a", "completed", 5, null), run("b", "completed", 5, 2)],
      turnItems: [prompt("prompt-a", "a", 4), prompt("prompt-b", "b", 4)],
    });

    expect(timings.size).toBe(0);
  });
});
