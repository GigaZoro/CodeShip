import { assert, describe, it } from "vite-plus/test";

import { incrementUsageCount } from "./usageCounters";

describe("incrementUsageCount", () => {
  it("keeps counting known controls but drops new ones past the cap", () => {
    const full = {
      since: "2026-11-20T00:00:00.000Z",
      counts: { "nav:usage": 2, "nav:settings": 1 },
    };

    assert.deepStrictEqual(incrementUsageCount(full, "nav:usage", 2).counts, {
      "nav:usage": 3,
      "nav:settings": 1,
    });
    assert.strictEqual(incrementUsageCount(full, "nav:projects", 2), full);
  });
});
