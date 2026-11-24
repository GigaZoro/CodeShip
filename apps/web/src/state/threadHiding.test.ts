import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadHiding, type ThreadHidingInput } from "./threadHiding";

const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };
const base: ThreadHidingInput = {
  ref,
  hiddenKeys: new Set(),
  hidingAnywhere: false,
  unlisted: null,
};

describe("resolveThreadHiding", () => {
  it("hides a listed thread the tag filter hides", () => {
    expect(resolveThreadHiding({ ...base, hiddenKeys: new Set([threadKey(ref)]) })).toMatchObject({
      hiddenByTagFilter: true,
      offShellBlocked: false,
    });
    expect(resolveThreadHiding(base).hiddenByTagFilter).toBe(false);
  });

  it("blocks a thread outside the shell while hiding unless it is a visible archived root or a child of a visible parent", () => {
    const unlisted = (overrides: Partial<NonNullable<ThreadHidingInput["unlisted"]>>) =>
      resolveThreadHiding({
        ...base,
        hidingAnywhere: true,
        unlisted: {
          thread: null,
          parentKey: null,
          parentLoaded: false,
          hiddenTags: null,
          ...overrides,
        },
      }).offShellBlocked;

    expect(unlisted({})).toBe(true);
    expect(unlisted({ thread: { archivedAt: "2026-01-01" } })).toBe(false);
    expect(
      unlisted({ thread: { archivedAt: "2026-01-01", tags: ["wip"] }, hiddenTags: ["wip"] }),
    ).toBe(true);
    expect(unlisted({ parentKey: "env-1:parent", parentLoaded: true })).toBe(false);
    expect(unlisted({ parentKey: "env-1:parent", parentLoaded: false })).toBe(true);
  });

  it("leaves an off-shell thread open while nothing is hidden", () => {
    expect(
      resolveThreadHiding({
        ...base,
        unlisted: { thread: null, parentKey: null, parentLoaded: false, hiddenTags: null },
      }).offShellBlocked,
    ).toBe(false);
  });
});
