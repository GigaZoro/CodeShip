import { assert, describe, it } from "vite-plus/test";

import {
  msUntilNextReminderCheck,
  shouldShowReminder,
  type UiFeedbackReminderState,
} from "./reminder";

const evening = new Date(2026, 10, 27, 19, 0);
const started: UiFeedbackReminderState = {
  mode: "auto",
  lastShownDay: null,
  startedAt: new Date(2026, 10, 20, 9, 0).toISOString(),
};

describe("shouldShowReminder", () => {
  it.each([
    ["auto after two quiet days", { now: evening, state: started, latestCaptureAt: null }, true],
    [
      "auto the day after a capture",
      {
        now: evening,
        state: started,
        latestCaptureAt: new Date(2026, 10, 26, 12, 0).toISOString(),
      },
      false,
    ],
    [
      "auto in the first two days",
      {
        now: evening,
        state: { ...started, startedAt: new Date(2026, 10, 26, 9, 0).toISOString() },
        latestCaptureAt: null,
      },
      false,
    ],
    [
      "on despite a recent capture",
      {
        now: evening,
        state: { ...started, mode: "on" as const },
        latestCaptureAt: evening.toISOString(),
      },
      true,
    ],
    [
      "off",
      { now: evening, state: { ...started, mode: "off" as const }, latestCaptureAt: null },
      false,
    ],
    [
      "before the evening",
      { now: new Date(2026, 10, 27, 17, 59), state: started, latestCaptureAt: null },
      false,
    ],
    [
      "a second time the same day",
      { now: evening, state: { ...started, lastShownDay: "2026-11-27" }, latestCaptureAt: null },
      false,
    ],
  ])("%s", (_name, input, expected) => {
    assert.strictEqual(shouldShowReminder(input), expected);
  });
});

describe("msUntilNextReminderCheck", () => {
  it("waits for this evening, or tomorrow's once it has passed", () => {
    assert.strictEqual(msUntilNextReminderCheck(new Date(2026, 10, 27, 17, 0)), 3_600_000);
    assert.strictEqual(
      msUntilNextReminderCheck(new Date(2026, 10, 27, 18, 0)),
      new Date(2026, 10, 28, 18, 0).getTime() - new Date(2026, 10, 27, 18, 0).getTime(),
    );
  });
});
