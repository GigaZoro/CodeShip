import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { DRAFT_RECENT_THREAD_LIMIT, selectDraftRecentThreads } from "./DraftRecentThreads.logic";

const environmentId = EnvironmentId.make("environment-draft");

const thread = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
  makeThreadFixture({ id: ThreadId.make(id), environmentId, ...overrides });
type Thread = ReturnType<typeof thread>;
const select = (
  threads: Thread[],
  waiting: Thread[] = [],
  delegatedUnderParent: ReadonlySet<string> = new Set(),
) =>
  selectDraftRecentThreads(threads, {
    waiting,
    delegatedUnderParent,
    later: [],
    hiddenTaskThreadKeys: new Set(),
    scopedProjectKeys: null,
  });
const ids = (threads: readonly { readonly id: string }[]) => threads.map((entry) => entry.id);
const sentTo = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    thread(`t${index}`, { latestUserMessageAt: `2026-11-1${index}T00:00:00.000Z` }),
  );

describe("selectDraftRecentThreads", () => {
  it("lists the threads the user last sent to first and stops at the limit", () => {
    expect(ids(select(sentTo(DRAFT_RECENT_THREAD_LIMIT + 2)).recent)).toEqual([
      "t6",
      "t5",
      "t4",
      "t3",
      "t2",
    ]);
  });

  it("keeps a settled thread in place when only its updatedAt moves", () => {
    const [older, newer] = sentTo(2);

    expect(
      ids(select([{ ...older!, updatedAt: "2026-11-20T00:00:00.000Z" }, newer!]).recent),
    ).toEqual(["t1", "t0"]);
  });

  it("ranks running threads as active now, latest started first, ahead of threads that settled since", () => {
    const running = (id: string, startedAt: string, updatedAt: string) =>
      thread(id, {
        updatedAt,
        latestRun: {
          runId: RunId.make(`${id}-run`),
          status: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        runtime: {
          status: "running",
          providerName: "Codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          activeRunId: RunId.make(`${id}-run`),
          lastError: null,
          updatedAt,
        },
      });
    const earlier = running("earlier", "2026-11-01T00:00:00.000Z", "2026-11-09T00:00:00.000Z");
    const later = running("later", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z");

    expect(ids(select([...sentTo(DRAFT_RECENT_THREAD_LIMIT), earlier, later]).recent)).toEqual([
      "later",
      "earlier",
      "t4",
      "t3",
      "t2",
    ]);
  });

  it("puts waiting threads first in their own order, and lists each once", () => {
    const others = sentTo(DRAFT_RECENT_THREAD_LIMIT);
    const waiting = [others[0]!, others[3]!];

    const lists = select(others, waiting);

    expect([ids(lists.needsYou), ids(lists.recent), lists.needsYouCount]).toEqual([
      ["t0", "t3"],
      ["t4", "t2", "t1"],
      2,
    ]);
  });

  it("counts every thread that waits while listing only the limit", () => {
    const waiting = Array.from({ length: DRAFT_RECENT_THREAD_LIMIT + 3 }, (_, index) =>
      thread(`w${index}`),
    );

    const lists = select([...waiting, thread("idle")], waiting);

    expect([lists.needsYou.length, lists.recent.length, lists.needsYouCount]).toEqual([
      DRAFT_RECENT_THREAD_LIMIT,
      0,
      DRAFT_RECENT_THREAD_LIMIT + 3,
    ]);
  });

  it("leaves out what the sidebar does not list: archived threads, subagents, hidden tasks and other scopes", () => {
    const parent = thread("parent");
    const archived = thread("archived", { archivedAt: "2026-11-01T00:00:00.000Z" });
    const subagent = thread("subagent", {
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    const delegated = thread("delegated");

    const hidden = thread("hidden-task");
    const waiting = thread("waiting-task");
    const later = thread("later-task");
    const otherProject = thread("other-project", { projectId: ProjectId.make("project-other") });
    const lists = selectDraftRecentThreads(
      [parent, archived, subagent, delegated, hidden, waiting, later, otherProject],
      {
        waiting: [waiting],
        later: [later],
        delegatedUnderParent: new Set([threadKey({ environmentId, threadId: delegated.id })]),
        hiddenTaskThreadKeys: new Set(
          [hidden, waiting, later].map(({ id }) =>
            scopedThreadKey(scopeThreadRef(environmentId, id)),
          ),
        ),
        scopedProjectKeys: new Set([`${environmentId}:${parent.projectId}`]),
      },
    );

    expect(ids(lists.needsYou)).toEqual(["waiting-task"]);
    expect(ids(lists.recent)).toEqual(["parent", "later-task"]);
  });
});
