import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2GetArchivedShellSnapshotInput,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type ArchivedThreadsView,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsViewKey,
} from "./archivedThreads.ts";
import { v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getPageAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(
    registry.get(snapshotsAtom(makeArchivedThreadsViewKey({ environmentIds: [environmentId] }))),
  ).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
    hasMore: false,
  });

  registry.dispose();
});

describe("archived delegated tasks follow their parent on another machine", () => {
  const parentEnvironmentId = EnvironmentId.make("env-parent");
  const taskEnvironmentId = EnvironmentId.make("env-task");
  const parentId = ThreadId.make("thread-parent");
  const page = (
    threads: OrchestrationV2ArchivedShellSnapshot["threads"],
  ): OrchestrationV2ArchivedShellSnapshot => ({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [v2Project],
    threads,
  });
  const taskPage = page([
    {
      ...v2ThreadShell,
      id: ThreadId.make("thread-task"),
      delegatedFrom: { environmentId: parentEnvironmentId, threadId: parentId, title: "p" },
    },
  ]);
  const archivedTaggedParent = page([{ ...v2ThreadShell, id: parentId, tags: ["private"] }]);

  it.each([
    { name: "archived tagged parent", parentPage: archivedTaggedParent, live: false, tasks: 0 },
    { name: "live visible parent", parentPage: page([]), live: true, tasks: 1 },
    { name: "parent page not loaded yet", parentPage: null, live: false, tasks: 0 },
    { name: "archive scoped to the task's machine", parentPage: undefined, live: false, tasks: 0 },
    {
      name: "only a third machine hides tags",
      parentPage: page([]),
      live: false,
      tasks: 0,
      parentTags: null,
    },
  ])("$name", ({ parentPage, live, tasks, parentTags = ["private"] }) => {
    const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
      getPageAtom: (environmentId) =>
        Atom.make(
          environmentId === taskEnvironmentId
            ? AsyncResult.success(taskPage)
            : parentPage === null || parentPage === undefined
              ? AsyncResult.initial<OrchestrationV2ArchivedShellSnapshot, Error>(true)
              : AsyncResult.success(parentPage),
        ),
      hiddenThreadTagsAtom: (environmentId) =>
        Atom.make(environmentId === parentEnvironmentId ? parentTags : null),
      hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
      liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> =>
        live ? [{ environmentId: parentEnvironmentId, threadId: parentId }] : [],
      ),
      // The parent's machine hides tags; a scoped archive learns that only from this flag.
      anyEnvironmentHidingAtom: Atom.make(true),
      labelPrefix: "test:archived-thread-snapshots",
    });
    const registry = AtomRegistry.make();
    const { snapshots } = registry.get(
      snapshotsAtom(
        makeArchivedThreadsViewKey({
          environmentIds:
            parentPage === undefined
              ? [taskEnvironmentId]
              : [parentEnvironmentId, taskEnvironmentId],
        }),
      ),
    );
    const taskSnapshot = snapshots.find((entry) => entry.environmentId === taskEnvironmentId);
    expect(taskSnapshot?.snapshot.threads.length).toBe(tasks);
    registry.dispose();
  });
});

describe("archived pages from several machines", () => {
  const laptop = EnvironmentId.make("env-laptop");
  const desktop = EnvironmentId.make("env-desktop");
  const archived = (id: string, minute: number, title = id) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title,
    archivedAt: DateTime.makeUnsafe(Date.UTC(2026, 5, 20, 0, minute)),
  });
  const cursorOf = (thread: ReturnType<typeof archived>) => ({
    archivedAt: DateTime.formatIso(thread.archivedAt),
    threadId: thread.id,
  });
  const page = (
    threads: ReadonlyArray<ReturnType<typeof archived>>,
    nextCursor?: OrchestrationV2ArchivedShellSnapshot["nextCursor"],
  ): OrchestrationV2ArchivedShellSnapshot => ({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [v2Project],
    threads,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
  const laptopFirst = [archived("laptop-1", 50), archived("laptop-2", 30)];
  const laptopSecond = [archived("laptop-3", 20)];
  const desktopOnly = [archived("desktop-1", 40), archived("desktop-2", 10)];
  const pages = (
    environmentId: EnvironmentId,
    input: OrchestrationV2GetArchivedShellSnapshotInput,
  ): OrchestrationV2ArchivedShellSnapshot =>
    environmentId === desktop
      ? page(desktopOnly, null)
      : input.after === undefined
        ? page(laptopFirst, cursorOf(laptopFirst[1]!))
        : page(laptopSecond, null);
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getPageAtom: (environmentId, input) =>
      Atom.make(AsyncResult.success(pages(environmentId, input))),
    hiddenThreadTagsAtom: () => Atom.make(null),
    hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
    liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
    anyEnvironmentHidingAtom: Atom.make(false),
    labelPrefix: "test:archived-thread-pages",
  });
  const shown = (view: ArchivedThreadsView) => {
    const registry = AtomRegistry.make();
    const state = registry.get(snapshotsAtom(makeArchivedThreadsViewKey(view)));
    registry.dispose();
    return {
      ids: state.snapshots
        .flatMap(({ snapshot }) => snapshot.threads)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.archivedAt!) - DateTime.toEpochMillis(left.archivedAt!),
        )
        .map((thread) => thread.id),
      hasMore: state.hasMore,
    };
  };

  it.each([
    {
      name: "holds back rows a machine with more pages could still precede",
      pages: 1,
      ids: ["laptop-1", "desktop-1", "laptop-2"],
      hasMore: true,
    },
    {
      name: "shows every row once each machine has no more pages",
      pages: 2,
      ids: ["laptop-1", "desktop-1", "laptop-2", "laptop-3", "desktop-2"],
      hasMore: false,
    },
  ])("$name", ({ pages: pageCount, ids, hasMore }) => {
    expect(shown({ environmentIds: [laptop, desktop], pages: pageCount })).toEqual({
      ids: ids.map((id) => ThreadId.make(id)),
      hasMore,
    });
  });

  it("filters an older server's full answer by the query itself", () => {
    const legacyAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
      getPageAtom: () =>
        Atom.make(
          AsyncResult.success(
            page([archived("kestrel", 5, "Kestrel nest"), archived("heron", 6, "Heron")]),
          ),
        ),
      hiddenThreadTagsAtom: () => Atom.make(null),
      hiddenThreadKeysAtom: Atom.make((): ReadonlySet<string> => new Set()),
      liveThreadRefsAtom: Atom.make((): ReadonlyArray<ScopedThreadRef> => []),
      anyEnvironmentHidingAtom: Atom.make(false),
      labelPrefix: "test:archived-thread-legacy",
    });
    const registry = AtomRegistry.make();
    const state = registry.get(
      legacyAtom(makeArchivedThreadsViewKey({ environmentIds: [laptop], query: "kestrel" })),
    );
    expect(state.snapshots[0]?.snapshot.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("kestrel"),
    ]);
    expect(state.hasMore).toBe(false);
    registry.dispose();
  });
});
