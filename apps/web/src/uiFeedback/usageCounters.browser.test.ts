import { assert, describe, it } from "vite-plus/test";

import {
  flushUsageCounters,
  readUsageCounters,
  recordUsage,
  syncUsageCounters,
} from "./usageCounters";

const STORAGE_KEY = "t3code:ui-feedback:counters:v1";

describe("usage counters", () => {
  it("adds this tab's clicks to what another tab saved in the meantime", () => {
    localStorage.removeItem(STORAGE_KEY);
    readUsageCounters();
    recordUsage("nav:usage");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        since: "2026-11-20T00:00:00.000Z",
        counts: { "nav:usage": 5, "nav:settings": 2 },
      }),
    );

    flushUsageCounters();

    assert.deepStrictEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"), {
      since: "2026-11-20T00:00:00.000Z",
      counts: { "nav:usage": 6, "nav:settings": 2 },
    });
    assert.deepStrictEqual(readUsageCounters().counts, { "nav:usage": 6, "nav:settings": 2 });
    localStorage.removeItem(STORAGE_KEY);
  });

  it("does not bring back counts another tab cleared", () => {
    recordUsage("nav:usage");
    localStorage.removeItem(STORAGE_KEY);

    flushUsageCounters();

    assert.deepStrictEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").counts, {
      "nav:usage": 1,
    });
    localStorage.removeItem(STORAGE_KEY);
  });

  it("reads what another tab saved when this one has nothing unsaved", () => {
    readUsageCounters();
    const saved = { since: "2026-11-21T00:00:00.000Z", counts: { "composer:composer.mode": 3 } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    assert.deepStrictEqual(syncUsageCounters(), saved);
    localStorage.removeItem(STORAGE_KEY);
  });
});
