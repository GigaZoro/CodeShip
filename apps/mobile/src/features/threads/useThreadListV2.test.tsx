import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import {
  createOlderSettledThreadAtoms,
  type OlderSettledShelfEnvironment,
} from "@t3tools/client-runtime/state/threads";
import { EMPTY_SHELL_STATE, presentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  type OrchestrationV2GetOlderSettledThreadsInput,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { olderSettledThreads } from "../../state/threads";
import { makeRawThreadShell } from "../../test-fixtures";
import { useThreadListV2 } from "./useThreadListV2";

vi.mock("../../state/threads", () => ({
  olderSettledThreads: {
    shelvesAtom: vi.fn(),
    rowsKey: () => "",
    pageRowsAtom: () => Atom.make([]),
    retryPages: vi.fn(),
  },
  threadFamilies: { mountRows: () => () => {} },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: undefined }));

it("reuses a large thread list across tab renders and updates when its inputs change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const shelfAtom = Atom.make<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>(new Map());
  // The Settled shelf reads `shelfAtom`; the list has no chat folders, whose shelves read none.
  const settledShelves = Atom.make((get) => [get(shelfAtom)]);
  const noShelves = Atom.make<
    ReadonlyArray<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>
  >([]);
  vi.mocked(olderSettledThreads.shelvesAtom).mockImplementation((shelves) =>
    shelves.length === 0 ? noShelves : settledShelves,
  );
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("environment-1");
  const otherEnvironmentId = EnvironmentId.make("environment-2");
  const threads = Array.from({ length: 1200 }, (_, index) =>
    presentThreadShell(
      index % 2 === 0 ? environmentId : otherEnvironmentId,
      makeRawThreadShell({
        id: ThreadId.make(`thread-${index}`),
        title: `Thread ${index}`,
        tags: index % 2 === 0 ? ["even"] : ["odd"],
        settledOverride: index < 150 ? "active" : "settled",
        settledAt: index < 150 ? null : DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      }),
    ),
  );
  const environmentIds = new Set([environmentId, otherEnvironmentId]);
  const input: Parameters<typeof useThreadListV2>[0] = {
    threads,
    pendingTasks: [],
    environmentId: null,
    projectRefs: null,
    searchQuery: "",
    searchMatches: new Map(),
    settlementEnvironmentIds: environmentIds,
    snoozeEnvironmentIds: environmentIds,
    pinReorderEnvironmentIds: environmentIds,
    activeReorderEnvironmentIds: environmentIds,
    queuedThreadKeys: new Set(),
    hiddenTaskThreadKeys: new Set(),
    settledLimit: 10,
    now: "2026-01-02T00:00:00.000Z",
    pendingOrder: null,
    shelfPreferencesLoaded: true,
    workingShelfEnabled: true,
    workingShelfExpanded: false,
    snoozedShelfExpanded: false,
    settledShelfExpanded: true,
    selectedThreadKey: null,
    grouping: null,
    chatFolders: null,
  };
  const seen: Array<ReturnType<typeof useThreadListV2>> = [];
  function Probe(props: { input: typeof input; tab: string }) {
    return (
      <RegistryContext value={registry}>
        <ListProbe {...props} />
      </RegistryContext>
    );
  }
  function ListProbe(props: { input: typeof input; tab: string }) {
    const result = useThreadListV2(props.input);
    useLayoutEffect(() => {
      seen.push(result);
    });
    return <div>{props.tab}</div>;
  }

  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () => root.render(<Probe input={{ ...input }} tab="chats" />));
  const initial = seen.at(-1)!;
  expect(initial.layout.items).toHaveLength(160);
  expect(initial.layout.settledCount).toBe(1050);

  for (const tab of ["pullRequests", "chats", "settings", "chats"]) {
    await act(async () => root.render(<Probe input={{ ...input }} tab={tab} />));
    expect(seen.at(-1)!.olderSettledShelf.isListed).toBe(initial.olderSettledShelf.isListed);
    expect(seen.at(-1)!.olderSettledShelf.unloadedCount).toBe(
      initial.olderSettledShelf.unloadedCount,
    );
    expect(seen.at(-1)!.layout).toBe(initial.layout);
    expect(seen.at(-1)!.items).toBe(initial.items);
  }

  const nextMinute = { ...input, now: "2026-01-02T00:01:00.000Z" };
  await act(async () => root.render(<Probe input={nextMinute} tab="chats" />));
  expect(seen.at(-1)!.layout).toBe(initial.layout);
  expect(seen.at(-1)!.items).not.toBe(initial.items);
  expect(seen.at(-1)!.items.find((item) => item.type === "v2-thread")).toMatchObject({
    snoozePresetMinute: nextMinute.now,
  });

  // Each chat folder has a shelf of its own older chats, which must keep the list stable too.
  const chatFolders: (typeof input)["chatFolders"] = {
    folders: [
      {
        kind: "chats",
        key: "chat-folder:autopilot",
        label: "Autopilot",
        saved: true,
        expandedByDefault: true,
        expanded: true,
      },
    ],
    folderKeyOf: (thread) => (thread.id === "thread-0" ? "chat-folder:autopilot" : null),
  };
  await act(async () => root.render(<Probe input={{ ...input, chatFolders }} tab="chats" />));
  const filed = seen.at(-1)!;
  expect(filed.items.find((item) => item.type === "v2-folder")).toMatchObject({
    key: "v2-folder:chat-folder:autopilot",
  });
  for (const tab of ["settings", "chats"]) {
    await act(async () => root.render(<Probe input={{ ...input, chatFolders }} tab={tab} />));
    expect(seen.at(-1)!.layout).toBe(filed.layout);
    expect(seen.at(-1)!.items).toBe(filed.items);
  }

  await act(async () => root.render(<Probe input={{ ...input, environmentId }} tab="chats" />));
  expect(seen.at(-1)!.layout.items).toHaveLength(85);
  expect(seen.at(-1)!.layout.settledCount).toBe(525);
  expect(
    seen.at(-1)!.layout.items.every((item) => item.thread.environmentId === environmentId),
  ).toBe(true);

  const queuedThreadKeys = new Set([`${environmentId}:thread-150`]);
  await act(async () => root.render(<Probe input={{ ...input, queuedThreadKeys }} tab="chats" />));
  const queued = seen.at(-1)!;
  expect(queued.layout.items).toHaveLength(161);
  expect(queued.layout.settledCount).toBe(1049);
  expect(
    queued.items.find((item) => item.type === "v2-thread" && item.item.thread.id === "thread-150"),
  ).toMatchObject({ hasQueuedMessages: true, item: { variant: "card" } });

  await act(async () => root.render(<Probe input={{ ...input, settledLimit: 35 }} tab="chats" />));
  expect(seen.at(-1)!.layout.items).toHaveLength(185);

  const updatedThreads = threads.map((thread) =>
    thread.id === "thread-0" ? { ...thread, title: "Updated title" } : thread,
  );
  await act(async () =>
    root.render(<Probe input={{ ...input, threads: updatedThreads }} tab="chats" />),
  );
  expect(
    seen.at(-1)!.layout.items.find((item) => item.thread.id === "thread-0")?.thread.title,
  ).toBe("Updated title");

  await act(async () =>
    root.render(
      <Probe
        input={{ ...input, threads: updatedThreads, searchQuery: "Updated title" }}
        tab="chats"
      />,
    ),
  );
  expect(seen.at(-1)!.layout.items.map((item) => item.thread.title)).toEqual(["Updated title"]);
  const search = seen.at(-1)!;
  await act(async () =>
    root.render(
      <Probe
        input={{ ...nextMinute, threads: updatedThreads, searchQuery: "Updated title" }}
        tab="chats"
      />,
    ),
  );
  expect(seen.at(-1)!.layout).not.toBe(search.layout);
  expect(seen.at(-1)!.layout.items.map((item) => item.thread.title)).toEqual(["Updated title"]);

  const clockThreads = threads.map((thread) =>
    thread.id === "thread-0" ? { ...thread, snoozedUntil: "2026-01-02T00:00:30.000Z" } : thread,
  );
  const clockInput = { ...input, threads: clockThreads, snoozedShelfExpanded: true };
  await act(async () => root.render(<Probe input={clockInput} tab="chats" />));
  const beforeClock = seen.at(-1)!;
  expect(beforeClock.layout.snoozedCount).toBe(1);
  expect(beforeClock.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    true,
  );
  await act(async () => root.render(<Probe input={clockInput} tab="settings" />));
  expect(seen.at(-1)!.items).toBe(beforeClock.items);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:00:10.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout).toBe(beforeClock.layout);
  expect(seen.at(-1)!.layout.snoozedCount).toBe(1);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:01:00.000Z" }} tab="chats" />),
  );
  const afterClock = seen.at(-1)!;
  expect(afterClock.items).not.toBe(beforeClock.items);
  expect(afterClock.layout.snoozedCount).toBe(0);
  expect(afterClock.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    false,
  );
  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:02:00.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout).toBe(afterClock.layout);
  expect(seen.at(-1)!.items).not.toBe(afterClock.items);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:00:20.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout.snoozedCount).toBe(1);
  expect(seen.at(-1)!.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    true,
  );
  await act(async () => root.render(<Probe input={input} tab="chats" />));
  const before = "2026-01-01T12:00:00.000Z";
  const older = {
    before,
    beforeMs: Date.parse(before),
    counts: new Map([[ProjectId.make("project-test"), 575]]),
    folders: new Map(),
  };
  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: { settledAt: before }, status: "pending" },
            unloaded: 50,
          },
        ],
      ]),
    );
  });
  const loading = seen.at(-1)!;
  expect(loading.layout.settledCount).toBe(1100);
  expect(loading.layout.listedSettledThreads).toHaveLength(0);
  expect(loading.layout.items).toHaveLength(150);
  expect(loading.olderSettledShelf.isListed(threads[150]!)).toBe(false);
  await act(async () => root.render(<Probe input={input} tab="settings" />));
  expect(seen.at(-1)!.items).toBe(loading.items);

  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: null, status: "ready" },
            unloaded: 50,
          },
        ],
      ]),
    );
  });
  const loaded = seen.at(-1)!;
  expect(loaded.layout.settledCount).toBe(1100);
  expect(loaded.layout.items).toHaveLength(160);
  expect(loaded.olderSettledShelf.isListed(threads[150]!)).toBe(true);
  expect(loaded.items).not.toBe(loading.items);

  await act(async () =>
    root.render(<Probe input={{ ...input, selectedTags: ["odd"] }} tab="chats" />),
  );
  const filtered = seen.at(-1)!;
  expect(filtered.layout.listedSections.active.length).toBeLessThan(
    loaded.layout.listedSections.active.length,
  );
  expect(loaded.getListedArrangement()).toBe(filtered.layout.listedSections);

  expect(filtered.layout.hiddenSettledCount).toBeNull();
  await act(async () => filtered.showMoreSettled());
  expect(seen.at(-1)!.olderSettledShelf.pages.size).toBe(0);
  expect(seen.at(-1)!.layout.items).toHaveLength(filtered.layout.items.length + 25);

  const filterInput = { ...input, selectedTags: ["odd"] };
  await act(async () =>
    root.render(<Probe input={{ ...filterInput, searchQuery: "Thread" }} tab="chats" />),
  );
  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: { settledAt: before }, status: "ready" },
            unloaded: 50,
          },
        ],
      ]),
    );
  });
  await act(async () => root.render(<Probe input={filterInput} tab="chats" />));
  expect(seen.at(-1)!.olderSettledShelf.visibleCount).toBe(10);
  expect(seen.at(-1)!.olderSettledShelf.pages.size).toBe(0);
  await act(async () => seen.at(-1)!.showMoreSettled());
  expect(seen.at(-1)!.olderSettledShelf.pages.get(environmentId)).toBe(1);

  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: { settledAt: before }, status: "failed" },
            unloaded: 50,
          },
        ],
        [
          otherEnvironmentId,
          {
            older,
            pages: { reads: [], frontier: { settledAt: before }, status: "ready" },
            unloaded: 50,
          },
        ],
      ]),
    );
  });
  await act(async () => seen.at(-1)!.showMoreSettled());
  expect(seen.at(-1)!.olderSettledShelf.pages).toEqual(
    new Map([
      [environmentId, 1],
      [otherEnvironmentId, 1],
    ]),
  );
  expect(olderSettledThreads.retryPages).not.toHaveBeenCalled();
  seen.at(-1)!.retrySettled();
  expect(vi.mocked(olderSettledThreads.retryPages).mock.calls).toEqual([
    [undefined, { environmentId, projectIds: null, folder: null }, 1],
  ]);
  expect(seen.at(-1)!.settledFooter?.failed).toBe(true);
  await act(async () =>
    root.render(<Probe input={{ ...filterInput, searchQuery: "Thread" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout.settledShelfHeaderIndex).toBeNull();
  expect.soft(seen.at(-1)!.settledFooter).toBeNull();

  await act(async () =>
    root.render(<Probe input={{ ...filterInput, selectedTags: ["even"] }} tab="chats" />),
  );
  expect(seen.at(-1)!.olderSettledShelf.pages.size).toBe(0);
  // LegendList can keep the even view's footer handler; it pages the view shown when pressed.
  const keptShowMoreSettled = seen.at(-1)!.showMoreSettled;
  await act(async () => root.render(<Probe input={filterInput} tab="chats" />));
  expect(seen.at(-1)!.olderSettledShelf.pages.size).toBe(0);
  await act(async () => keptShowMoreSettled());
  // The failed environment waits for a retry.
  expect(seen.at(-1)!.olderSettledShelf.pages).toEqual(new Map([[otherEnvironmentId, 1]]));
  // Retry also acts on the committed view: the other environment fails only in the even view.
  const keptRetrySettled = seen.at(-1)!.retrySettled;
  const shelfOf = (status: "ready" | "failed", otherStatus: "ready" | "failed") =>
    new Map(
      [
        [environmentId, status],
        [otherEnvironmentId, otherStatus],
      ].map(([id, state]) => [
        id as EnvironmentId,
        {
          older,
          pages: { reads: [], frontier: { settledAt: before }, status: state as "ready" },
          unloaded: 50,
        },
      ]),
    );
  await act(async () =>
    root.render(<Probe input={{ ...filterInput, selectedTags: ["even"] }} tab="chats" />),
  );
  await act(async () => registry.set(shelfAtom, shelfOf("ready", "ready")));
  await act(async () => seen.at(-1)!.showMoreSettled());
  await act(async () => registry.set(shelfAtom, shelfOf("ready", "failed")));
  vi.mocked(olderSettledThreads.retryPages).mockClear();
  keptRetrySettled();
  expect(vi.mocked(olderSettledThreads.retryPages).mock.calls).toEqual([
    [undefined, { environmentId: otherEnvironmentId, projectIds: null, folder: null }, 1],
  ]);

  const folderInput = {
    ...input,
    chatFolders,
    settledShelfExpanded: false,
    projectRefs: [{ environmentId, projectId: ProjectId.make("project-test") }],
  };
  const folderPages = () =>
    vi.mocked(olderSettledThreads.shelvesAtom).mock.calls.at(-1)?.[0][0]?.[0]?.pages;
  const atFrontier = (status: "ready" | "pending") => [
    new Map([
      [
        environmentId,
        {
          older,
          pages: { reads: [], frontier: { settledAt: before }, status },
          unloaded: 50,
        },
      ],
    ]),
  ];
  const readyFolder = Atom.make(atFrontier("ready"));
  const filteredProject = ProjectId.make("filtered-project");
  const folderScope = { environmentId, projectIds: [filteredProject], folder: "autopilot" };
  const fullPage = Array.from({ length: 25 }, (_, index) =>
    makeRawThreadShell({
      id: ThreadId.make(`older-${String(index).padStart(2, "0")}`),
      projectId: filteredProject,
      folder: "Autopilot",
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    }),
  );
  const counts = [{ projectId: filteredProject, count: 25 }];
  const folderCounts = [{ ...counts[0]!, folder: "Autopilot" }];
  const readPage = vi.fn((input: OrchestrationV2GetOlderSettledThreadsInput) =>
    Effect.succeed({
      snapshotSequence: 1,
      threads: input.before.threadId === undefined ? fullPage : [],
      counts,
      folderCounts,
    }),
  );
  const folderRuntime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Folder environment",
            httpBaseUrl: "https://folder.test",
            wsBaseUrl: "wss://folder.test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(
            Option.some({
              client: { [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: readPage },
              ready: Effect.void,
            } as unknown as RpcSession),
          ),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const connection = {
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } satisfies Pick<
          EnvironmentRegistry.EnvironmentRegistry["Service"],
          "run" | "followStream"
        >;
        return connection as EnvironmentRegistry.EnvironmentRegistry["Service"];
      }),
    ),
  );
  const folderShell = Atom.make(
    AsyncResult.success({
      ...EMPTY_SHELL_STATE,
      generation: 1,
      status: "live" as const,
      snapshot: Option.some({
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [],
        threads: [],
        archivedThreads: [],
        olderSettled: { asOfSequence: 1, before, counts, folderCounts },
      }),
    }),
  );
  const held = Atom.make([]);
  const nested = Atom.make([]);
  const folderAtoms = createOlderSettledThreadAtoms(
    folderRuntime,
    () => folderShell,
    () => held,
    () => nested,
  );
  const untilPage = (depth: number) => {
    const atom = folderAtoms.pagesAtom(folderScope, depth);
    if (registry.get(atom).reads.length === depth) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const release = registry.subscribe(atom, (pages) => {
        if (pages.reads.length !== depth) return;
        release();
        resolve();
      });
    });
  };
  const pendingFolder = Atom.make(atFrontier("pending"));
  vi.mocked(olderSettledThreads.shelvesAtom).mockImplementation((shelves) => {
    const scope = shelves[0]?.[0];
    if (!scope?.scope.folder) return shelves.length === 0 ? noShelves : settledShelves;
    if (scope.scope.projectIds?.includes(filteredProject)) return folderAtoms.shelvesAtom(shelves);
    return scope.pages === 0 ? readyFolder : pendingFolder;
  });
  await act(async () => root.render(<Probe input={folderInput} tab="chats" />));
  await act(async () => seen.at(-1)!.showMoreInFolder("chat-folder:autopilot"));
  expect(folderPages()).toBeGreaterThan(0);
  await act(async () =>
    root.render(
      <Probe
        input={{
          ...folderInput,
          projectRefs: [{ environmentId, projectId: ProjectId.make("another-project") }],
        }}
        tab="chats"
      />,
    ),
  );
  expect.soft(folderPages()).toBe(0);
  readPage.mockClear();
  const firstView = {
    ...folderInput,
    projectRefs: [{ environmentId, projectId: filteredProject }],
    selectedTags: ["even"],
  };
  await act(async () => root.render(<Probe input={firstView} tab="chats" />));
  expect(readPage.mock.calls).toEqual([]);
  const keptShowMoreInFolder = seen.at(-1)!.showMoreInFolder;
  await act(async () => seen.at(-1)!.showMoreInFolder("chat-folder:autopilot"));
  expect(folderPages()).toBe(1);
  await act(async () => {
    await untilPage(1);
  });
  await act(async () => seen.at(-1)!.showMoreInFolder("chat-folder:autopilot"));
  expect(folderPages()).toBe(2);
  await act(async () => {
    await untilPage(2);
  });
  const firstRequest = {
    before: { settledAt: before },
    folder: "autopilot",
    limit: 25,
    projectIds: [filteredProject],
  };
  expect(readPage.mock.calls).toEqual([
    [firstRequest],
    [
      {
        ...firstRequest,
        before: { settledAt: "2026-01-01T00:00:00.000Z", threadId: fullPage.at(-1)!.id },
      },
    ],
  ]);

  const collapsedFolders = {
    ...chatFolders,
    folders: chatFolders.folders.map((folder) => ({ ...folder, expanded: false })),
  };
  const disposed = new Promise<void>((resolve) => {
    registry.onNodeRemoved = (node) => {
      if (node.atom.label?.[0].startsWith("environment-data:orchestration:older-settled-page:")) {
        const readsRemain = [...registry.getNodes().values()].some(({ atom }) =>
          atom.label?.[0].startsWith("environment-data:orchestration:older-settled-page:"),
        );
        if (!readsRemain) resolve();
      }
    };
  });
  await act(async () =>
    root.render(<Probe input={{ ...firstView, chatFolders: collapsedFolders }} tab="chats" />),
  );
  expect(folderPages()).toBe(0);
  await disposed;
  registry.onNodeRemoved = undefined;
  readPage.mockClear();
  const nextView = { ...firstView, selectedTags: ["odd"] };
  await act(async () =>
    root.render(<Probe input={{ ...nextView, chatFolders: collapsedFolders }} tab="chats" />),
  );
  await act(async () => root.render(<Probe input={nextView} tab="chats" />));
  const reopenedDepth = folderPages() ?? 0;
  if (reopenedDepth > 0)
    await act(async () => {
      await untilPage(reopenedDepth);
    });
  expect.soft(readPage.mock.calls).toEqual([]);
  await act(async () => keptShowMoreInFolder("chat-folder:autopilot"));
  await act(async () => {
    await untilPage(1);
  });
  expect(readPage.mock.calls).toEqual([[firstRequest]]);
});
