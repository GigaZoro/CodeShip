import { threadKey } from "@t3tools/client-runtime/state/entities";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { selectRecentThreads } from "./DraftRecentThreads.logic";

const STARTED_AT = "2026-11-20T10:00:00.000Z";

function runningThread(
  id: string,
  activity: {
    readonly updatedAt?: string;
    readonly latestUserMessageAt?: string;
    readonly latestUserAuthoredMessageAt?: string;
  } = {},
) {
  return {
    ...makeThreadFixture({
      id: ThreadId.make(id),
      latestUserMessageAt: activity.latestUserMessageAt ?? STARTED_AT,
    }),
    createdAt: STARTED_AT,
    updatedAt: activity.updatedAt ?? STARTED_AT,
    latestUserAuthoredMessageAt: activity.latestUserAuthoredMessageAt ?? STARTED_AT,
  };
}

describe("selectRecentThreads", () => {
  it("moves a thread only when the user sends to it", () => {
    const ids = (threads: Parameters<typeof selectRecentThreads>[0]) =>
      selectRecentThreads(threads, new Set()).map((thread) => thread.id);

    expect(
      ids([
        runningThread("thread-a", { updatedAt: "2026-11-20T10:00:05.000Z" }),
        runningThread("thread-b", {
          updatedAt: "2026-11-20T10:00:07.000Z",
          latestUserMessageAt: "2026-11-20T10:00:06.000Z",
        }),
      ]),
    ).toEqual(["thread-a", "thread-b"]);
    expect(
      ids([
        runningThread("thread-a"),
        runningThread("thread-b", { latestUserAuthoredMessageAt: "2026-11-20T10:01:00.000Z" }),
      ]),
    ).toEqual(["thread-b", "thread-a"]);
  });

  it("leaves out a task shown under its parent, as the sidebar does", () => {
    const parent = runningThread("thread-parent");
    const task = runningThread("thread-task", {
      latestUserAuthoredMessageAt: "2026-11-20T10:01:00.000Z",
    });
    const underParent = new Set([
      threadKey({ environmentId: task.environmentId, threadId: task.id }),
    ]);

    expect(selectRecentThreads([parent, task], underParent).map((thread) => thread.id)).toEqual([
      "thread-parent",
    ]);
  });
});
