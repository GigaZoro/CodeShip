import { describe, expect, it } from "vite-plus/test";

import { formatNextScheduledTaskRun } from "./scheduledTaskPresentation";

describe("formatNextScheduledTaskRun", () => {
  it("names the rounded unit for a run later today", () => {
    const now = new Date(2026, 10, 3, 10, 0, 0).getTime();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    expect(formatNextScheduledTaskRun(at(59), now)).toMatch(/^Next run in 59 minutes, at \S/);
    expect(formatNextScheduledTaskRun(at(59.5), now)).toMatch(/^Next run in 1 hour, at \S/);
    expect(formatNextScheduledTaskRun(at(150), now)).toMatch(/^Next run in 3 hours, at \S/);
  });
});
