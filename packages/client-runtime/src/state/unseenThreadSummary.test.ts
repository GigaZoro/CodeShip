import { describe, expect, it } from "vite-plus/test";

import { unseenThreadSummary, type UnseenThreadSummaryInput } from "./unseenThreadSummary.ts";

const since = Date.parse("2026-01-01T10:00:00Z");
const through = Date.parse("2026-01-01T12:00:00Z");
const inside = "2026-01-01T11:00:00Z";
const before = "2026-01-01T09:00:00Z";
const after = "2026-01-01T13:00:00Z";

function summary(fields: Partial<UnseenThreadSummaryInput> = {}) {
  return unseenThreadSummary({
    window: { since, through },
    activity: [],
    latestRun: null,
    pullRequests: [],
    ...fields,
  });
}

describe("unseenThreadSummary", () => {
  it("says nothing without a window or any news", () => {
    expect(summary({ window: null, activity: [{ time: Date.parse(inside), runId: "a" }] })).toBe(
      null,
    );
    expect(summary()).toBe(null);
  });

  it("counts the turns whose items landed inside the window", () => {
    expect(
      summary({
        activity: [
          { time: Date.parse(before), runId: "old" },
          { time: Date.parse(inside), runId: "a" },
          { time: Date.parse(inside), runId: "a" },
          { time: Date.parse(inside), runId: "b" },
          { time: Date.parse(inside), runId: null },
          { time: Date.parse(after), runId: "later" },
        ],
      }),
    ).toBe("2 turns");
  });

  it.each([
    ["completed", inside, "finished"],
    ["failed", inside, "failed"],
    ["interrupted", inside, "stopped"],
    ["cancelled", inside, "stopped"],
    ["rolled_back", inside, null],
    ["completed", after, null],
    ["completed", before, null],
    ["running", null, null],
  ] as const)("reports a latest run %s at %s as %s", (status, completedAt, expected) => {
    expect(summary({ latestRun: { status, completedAt } })).toBe(expected);
  });

  it.each([
    [[{ number: 88, source: "created", linkedAt: inside }], "PR #88 opened"],
    [[{ number: 88, source: "agent", linkedAt: inside }], "PR #88 opened"],
    [[{ number: 88, source: "manual", linkedAt: inside }], "PR #88 linked"],
    [[{ number: 88, source: "stack-dismissed", linkedAt: inside }], null],
    [[{ number: 88, source: "created", linkedAt: before }], null],
    [
      [
        { number: 88, source: "created", linkedAt: inside },
        { number: 89, source: "agent", linkedAt: inside },
      ],
      "2 PRs opened",
    ],
    [
      [
        { number: 88, source: "created", linkedAt: inside },
        { number: 89, source: "stack", linkedAt: inside },
      ],
      "2 PRs linked",
    ],
  ] as const)("reports pull requests %j as %s", (pullRequests, expected) => {
    expect(summary({ pullRequests })).toBe(expected);
  });

  it("joins turns, outcome and pull requests", () => {
    expect(
      summary({
        activity: [
          { time: Date.parse(inside), runId: "a" },
          { time: Date.parse(inside), runId: "b" },
        ],
        latestRun: { status: "completed", completedAt: inside },
        pullRequests: [{ number: 88, source: "created", linkedAt: inside }],
      }),
    ).toBe("2 turns · finished · PR #88 opened");
  });
});
