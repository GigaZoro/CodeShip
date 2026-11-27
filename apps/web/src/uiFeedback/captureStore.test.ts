import { assert, describe, it } from "vite-plus/test";

import { capturesToPrune } from "./captureStore";

describe("capturesToPrune", () => {
  it("drops the oldest captures so the new one fits under the cap", () => {
    const existing = [
      { id: "new", createdAt: "2026-11-27T10:00:00.000Z" },
      { id: "oldest", createdAt: "2026-11-20T10:00:00.000Z" },
      { id: "older", createdAt: "2026-11-21T10:00:00.000Z" },
    ];

    assert.deepStrictEqual(capturesToPrune(existing, 2), ["oldest", "older"]);
    assert.deepStrictEqual(capturesToPrune(existing, 4), []);
  });
});
