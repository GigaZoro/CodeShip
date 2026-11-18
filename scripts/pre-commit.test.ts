import { describe, expect, it, vi } from "vite-plus/test";

describe("pre-commit hook", () => {
  // vp staged passes the staged files to a command given as a string. A function entry can
  // return a whole-repo check, which every worktree committing at once would run side by side
  // outside check:changed's shared memory budget: knip there took about 7 GB per pass.
  it("runs every command on the staged files", async () => {
    const { default: config } = await vi.importActual<{
      default: { staged?: Record<string, unknown> };
    }>("../vite.config.ts");
    const commands = Object.values(config.staged ?? {}).flat();
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(typeof command).toBe("string");
  });
});
