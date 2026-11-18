import { describe, expect, it, vi } from "vite-plus/test";

describe("pre-commit hook", () => {
  // vp staged appends the staged files to each command. A whole-repo check here (knip took about
  // 7 GB per pass) would run in every worktree committing at once, outside check:changed's shared
  // memory budget, so the hook stays on these file-scoped commands. Whole-repo checks belong in
  // check:changed.
  it("formats and lints only the staged files", async () => {
    const config = await vi.importActual("../vite.config.ts");
    expect(config.default).toHaveProperty("staged", {
      "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
    });
  });
});
