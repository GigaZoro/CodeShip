import { assert, describe, it } from "vite-plus/test";

import { claimEveningReminder, readReminderState, writeReminderState } from "./reminder";

describe("claimEveningReminder", () => {
  it("shows the reminder once when two checks overlap", async () => {
    const evening = new Date(2026, 10, 27, 19, 0);
    writeReminderState({ mode: "on", lastShownDay: null, startedAt: "2026-11-01T00:00:00.000Z" });
    let release = () => {};
    const latestCapture = new Promise<string | null>((resolve) => {
      release = () => resolve(null);
    });

    const claims = Promise.all([
      claimEveningReminder(evening, () => latestCapture),
      claimEveningReminder(evening, () => latestCapture),
    ]);
    release();

    assert.deepStrictEqual(await claims, [true, false]);
    assert.strictEqual(readReminderState(evening).lastShownDay, "2026-11-27");
  });
});
