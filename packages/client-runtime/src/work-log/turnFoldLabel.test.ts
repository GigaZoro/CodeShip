import { describe, expect, it } from "vite-plus/test";

import type { WorkLogPresentationEntry } from "./presentation.ts";
import { tallyTurnFoldWork, turnFoldLabel } from "./turnFoldLabel.ts";

function entry(fields: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry {
  return {
    id: "entry",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Ran command",
    tone: "tool",
    ...fields,
  };
}

describe("tallyTurnFoldWork", () => {
  it.each([
    ["a completed tool", entry({ toolLifecycleStatus: "completed" }), { tools: 1, failed: 0 }],
    ["a failed tool", entry({ toolLifecycleStatus: "failed" }), { tools: 1, failed: 1 }],
    ["a declined approval", entry({ toolLifecycleStatus: "declined" }), { tools: 1, failed: 0 }],
    ["thinking", entry({ tone: "thinking" }), { tools: 0, failed: 0 }],
    ["reasoning", entry({ tone: "info", itemType: "reasoning" }), { tools: 0, failed: 0 }],
    ["an info note", entry({ tone: "info" }), { tools: 0, failed: 0 }],
    ["an approval prompt", entry({ itemType: "approval_request" }), { tools: 0, failed: 0 }],
    ["an input prompt", entry({ itemType: "user_input_request" }), { tools: 0, failed: 0 }],
  ])("counts %s", (_name, work, expected) => {
    expect(tallyTurnFoldWork([work])).toEqual({ ...expected, files: 0 });
  });

  it("counts each changed file once across the turn", () => {
    expect(
      tallyTurnFoldWork([
        entry({ id: "a", changedFiles: ["src/a.ts", "src/b.ts"] }),
        entry({ id: "b", changedFiles: ["src/b.ts", "src/c.ts"] }),
      ]),
    ).toEqual({ tools: 2, files: 3, failed: 0 });
  });
});

describe("turnFoldLabel", () => {
  it.each([
    ["worked", "8m", "Worked for 8m · 14 tools · 6 files"],
    ["worked", null, "Worked · 14 tools · 6 files"],
    ["continued", "2m", "Continued for 2m · 14 tools · 6 files"],
    ["stopped", "40s", "You stopped after 40s · 14 tools · 6 files"],
    ["stopped", null, "You stopped this response · 14 tools · 6 files"],
  ] as const)("leads a %s turn with its duration (%s)", (outcome, duration, text) => {
    expect(turnFoldLabel(outcome, duration, { tools: 14, files: 6, failed: 2 })).toEqual({
      text,
      failed: "2 failed",
    });
  });

  it("drops zero counts and uses the singular form", () => {
    expect(turnFoldLabel("worked", "5s", { tools: 1, files: 1, failed: 0 })).toEqual({
      text: "Worked for 5s · 1 tool · 1 file",
      failed: null,
    });
    expect(turnFoldLabel("worked", "5s", { tools: 0, files: 0, failed: 0 }).text).toBe(
      "Worked for 5s",
    );
  });
});
