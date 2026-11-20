import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { selectRecentThreads } from "./DraftRecentThreads.logic";

describe("selectRecentThreads", () => {
  it("keeps threads started together in place while their replies stream", () => {
    const thread = (id: string, updatedAt: string) => ({
      ...makeThreadFixture({
        id: ThreadId.make(id),
        latestUserMessageAt: "2026-11-20T10:00:00.000Z",
      }),
      updatedAt,
    });
    const order = (aUpdatedAt: string, bUpdatedAt: string) =>
      selectRecentThreads([thread("thread-a", aUpdatedAt), thread("thread-b", bUpdatedAt)]).map(
        (recent) => recent.id,
      );

    expect(order("2026-11-20T10:00:05.000Z", "2026-11-20T10:00:07.000Z")).toEqual(
      order("2026-11-20T10:00:05.000Z", "2026-11-20T10:00:03.000Z"),
    );
  });
});
