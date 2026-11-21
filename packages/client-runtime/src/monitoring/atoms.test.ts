import {
  EnvironmentId,
  ThreadId,
  type MonitoringChange,
  type MonitoringChatsInput,
  type MonitoringChatsResult,
  type MonitoringOverviewInput,
  type MonitoringThreadSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { executeAtomQuery } from "../state/runtime.ts";
import type { MonitoringChatsRequest } from "./aggregate.ts";
import {
  createMonitoringAtoms,
  createMonitoringOperation,
  executeMonitoringQuery,
  followMonitoringChanges,
  monitoringRefreshTimedOut,
  monitoringOperationRetry,
} from "./atoms.ts";

type MonitoringAtomsInput = Parameters<typeof createMonitoringAtoms>[0];

describe("createMonitoringAtoms refresh", () => {
  it("asks again every chat page the list read, past its limit too, and every failure until it answers", () => {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("env-a");
    const ready = {
      entry: { target: { label: "Laptop" }, enabled: true },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: { environment: { capabilities: { monitoringPages: true } } },
      lastSeenAt: null,
    } as unknown as EnvironmentPresentation;
    const tooOld = {
      ...ready,
      serverConfig: { environment: { capabilities: { monitoringPages: false } } },
    } as unknown as EnvironmentPresentation;
    const presentationsAtom = Atom.make(new Map([[environmentId, ready]]));
    // Ten chats, two a page. Each query keeps its answer until it is asked again, as a cached
    // query does; the page at offset 2 can also load or repeat a chat, and a slow query answers
    // only when it lands, after the Refresh that asked it has returned.
    const failing = new Set(["page:4", "overview:last-week"]);
    const slow = new Set<string>();
    let pageTwo: "answers" | "loads" | "repeats" = "answers";
    const answer = (offset: number): MonitoringChatsResult => ({
      chats: [offset, offset + 1].map((index) => ({
        summary: { threadId: `chat-${index}` } as unknown as MonitoringThreadSummary,
        sortValue: 10 - index,
      })),
      total: 10,
    });
    const fetched = (name: string) => {
      if (failing.has(name)) return AsyncResult.failure(Cause.fail("boom"));
      if (name.startsWith("overview:")) return AsyncResult.success({ groups: [], unanalyzed: [] });
      const offset = Number(name.slice("page:".length));
      if (offset !== 2) return AsyncResult.success(answer(offset));
      return pageTwo === "loads"
        ? AsyncResult.initial(true)
        : AsyncResult.success(answer(pageTwo === "repeats" ? 1 : 2));
    };
    const asked: string[] = [];
    const cached = Atom.family((name: string) => Atom.make(fetched(name)).pipe(Atom.keepAlive));
    const land = (name: string) => registry.set(cached(name), fetched(name));
    const query = Atom.family((name: string) =>
      Atom.readable(
        (get) => get(cached(name)),
        () => {
          asked.push(name);
          if (slow.has(name)) registry.set(cached(name), AsyncResult.initial(true));
          else land(name);
        },
      ),
    );
    const lastWeek = "2026-10-25T00:00:00.000Z";
    const periodName = (since: string) => (since === lastWeek ? "last-week" : "current");
    const monitoring = createMonitoringAtoms({
      label: "test",
      registry,
      server: {
        monitoringOverview: ({ input }: { input: MonitoringOverviewInput }) =>
          query(`overview:${periodName(input.days[0].since)}`),
        monitoringChats: ({ input }: { input: MonitoringChatsInput }) =>
          query(`page:${input.offset}`),
      } as unknown as MonitoringAtomsInput["server"],
      presentations: { presentationsAtom },
      catalog: {} as MonitoringAtomsInput["catalog"],
      describeFailure: () => "boom",
    });
    const request: MonitoringChatsRequest = {
      window: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" },
      filters: {},
      order: { sort: "costUsd", direction: "desc", limit: 100 },
      pageSize: 2,
    };
    const overview: MonitoringOverviewInput = {
      days: [{ day: "2026-11-01", since: request.window.since }],
      until: request.window.until,
    };
    const lastWeekOverview = monitoring.overviewAtom(
      JSON.stringify({ ...overview, days: [{ day: "2026-10-25", since: lastWeek }] }),
    );
    const list = monitoring.chatsAtom(JSON.stringify(request));
    const shorterRequest = { ...request, order: { ...request.order, limit: 4 } };
    const shorterList = monitoring.chatsAtom(JSON.stringify(shorterRequest));
    const askedBy = (views: Parameters<typeof monitoring.refresh>[0]) => {
      asked.length = 0;
      monitoring.refresh(views);
      return [...asked].sort();
    };
    const refreshed = (chats = request) => askedBy({ overview, chats: [chats] });
    const everything = ["overview:current", "page:0", "page:2", "page:4"];
    const withLastWeek = ["overview:current", "overview:last-week", "page:0", "page:2", "page:4"];

    const failed = registry.get(list);
    // A view of the week before reads its failure and leaves.
    registry.get(lastWeekOverview);
    // A shorter list asks again the failure only the longer one read, so Show more cannot show it.
    registry.get(shorterList);
    const first = refreshed(shorterRequest);
    // Refresh in an open chat asks them too, and they stay asked until they answer.
    const inChat = askedBy({});
    // Its cache gone, a view of that week reads it loading and leaves before it fails again.
    registry.set(cached("overview:last-week"), AsyncResult.initial(true));
    registry.get(lastWeekOverview);
    land("overview:last-week");
    const reloaded = refreshed(shorterRequest);
    // It answers after Refresh returns, with no view reading it, and is asked no more.
    failing.delete("overview:last-week");
    slow.add("overview:last-week");
    const recovered = refreshed(shorterRequest);
    land("overview:last-week");
    const afterRecovery = refreshed(shorterRequest);
    const lastWeekShown = registry.get(lastWeekOverview);
    registry.set(
      presentationsAtom,
      new Map([
        [
          environmentId,
          {
            ...ready,
            connection: { phase: "reconnecting", error: null, traceId: null },
          } as EnvironmentPresentation,
        ],
      ]),
    );
    const reconnecting = registry.get(lastWeekOverview);
    expect(reconnecting.environments[0]?.result).toEqual({ groups: [], unanalyzed: [] });
    expect(reconnecting.waiting.map(({ label }) => label)).toEqual(["Laptop"]);
    expect(reconnecting.isLoading).toBe(false);
    expect(reconnecting.complete).toBe(false);
    registry.set(presentationsAtom, new Map([[environmentId, ready]]));
    pageTwo = "loads";
    registry.refresh(query("page:2"));
    const stopped = registry.get(list);
    const afterStop = refreshed();
    failing.delete("page:4");
    pageTwo = "answers";
    const pagesRecovered = refreshed();
    // It leaves the pages only the longer one read cached for Show more, once none failed since.
    registry.get(shorterList);
    const shorter = refreshed(shorterRequest);
    // A repeated chat leaves it three, so it reads a page past its limit.
    pageTwo = "repeats";
    registry.refresh(query("page:2"));
    const repeated = registry.get(shorterList);
    const pastLimit = refreshed(shorterRequest);
    registry.set(presentationsAtom, new Map([[environmentId, tooOld]]));

    expect([
      failed.unreadable.map((report) => report.error),
      first,
      inChat,
      reloaded,
      recovered,
      afterRecovery,
      lastWeekShown.unreadable.length,
      stopped.awaitingPage,
      afterStop,
      pagesRecovered,
      shorter,
      repeated.chats.map((chat) => chat.summary.threadId),
      pastLimit,
      refreshed(),
    ]).toEqual([
      ["boom"],
      withLastWeek,
      ["overview:last-week", "page:4"],
      withLastWeek,
      withLastWeek,
      everything,
      0,
      true,
      everything,
      everything,
      ["overview:current", "page:0", "page:2"],
      ["chat-0", "chat-1", "chat-2", "chat-4"],
      everything,
      [],
    ]);
  });
});

it("reloads a detail only for unseen changes to that chat and lets its in-flight answer catch up", async () => {
  const registry = AtomRegistry.make();
  const changes = Atom.make<AsyncResult.AsyncResult<MonitoringChange>>(AsyncResult.initial());
  const answer = Atom.make(AsyncResult.success({ revision: 4 }));
  let reads = 0;
  const query = Atom.readable(
    (get) => get(answer),
    () => {
      reads++;
      registry.set(answer, AsyncResult.success(registry.get(answer).value, { waiting: true }));
    },
  );
  const thread = ThreadId.make("selected");
  const detail = followMonitoringChanges(query, changes, thread);
  const unmount = registry.mount(detail);
  const publish = (sinceRevision: number, revision: number, threadId: string) => {
    registry.set(
      changes,
      AsyncResult.success({ sinceRevision, revision, threadIds: [ThreadId.make(threadId)] }),
    );
  };
  try {
    publish(0, 4, thread);
    publish(4, 5, "another-chat");
    expect(reads).toBe(0);

    publish(5, 6, thread);
    await Promise.resolve();
    expect(reads).toBe(1);
    publish(6, 7, thread);
    publish(7, 8, "another-chat");
    registry.set(answer, AsyncResult.success({ revision: 7 }));
    expect(reads).toBe(1);

    publish(8, 9, thread);
    await Promise.resolve();
    publish(9, 10, thread);
    registry.set(answer, AsyncResult.success({ revision: 9 }));
    await Promise.resolve();
    expect(reads).toBe(3);
  } finally {
    unmount();
  }
});

it("publishes every completed answer and settles manual Refresh under continuous notices", async () => {
  const registry = AtomRegistry.make();
  const changes = Atom.make<AsyncResult.AsyncResult<MonitoringChange>>(AsyncResult.initial());
  const answer = Atom.make<AsyncResult.AsyncResult<{ revision: number }, string>>(
    AsyncResult.success({ revision: 0 }),
  );
  let reads = 0;
  const query = Atom.readable(
    (get) => get(answer),
    () => {
      reads++;
      registry.set(answer, AsyncResult.waiting(registry.get(answer)));
    },
  );
  const watched = followMonitoringChanges(query, changes);
  const completions: Array<number | string> = [];
  const unsubscribe = registry.subscribe(watched, (value) => {
    if (value.waiting) return;
    if (value._tag === "Success") completions.push(value.value.revision);
    if (value._tag === "Failure") completions.push(String(Cause.squash(value.cause)));
  });
  const notice = (revision: number) =>
    registry.set(changes, AsyncResult.success({ revision, sinceRevision: revision - 1 }));

  try {
    const refresh = executeAtomQuery(registry, watched, { refresh: true, reportFailure: false });
    expect(reads).toBe(1);
    completions.length = 0;
    for (const revision of [1, 3, 5]) {
      notice(revision + 1);
      registry.set(answer, AsyncResult.success({ revision }));
      expect(completions.at(-1)).toBe(revision);
      expect(registry.get(watched).waiting).toBe(false);
      await Promise.resolve();
      expect(registry.get(watched).waiting).toBe(true);
    }
    expect(await refresh).toMatchObject({ _tag: "Success", value: { revision: 1 } });

    notice(8);
    registry.set(answer, AsyncResult.failure(Cause.fail("The request timed out.")));
    expect(registry.get(watched)).toMatchObject({ waiting: false, _tag: "Failure" });
    expect(completions).toEqual([1, 3, 5, "The request timed out."]);
  } finally {
    unsubscribe();
    registry.dispose();
  }
});

it("detects a skipped detail notice after a server restarts at revision zero", async () => {
  const registry = AtomRegistry.make();
  const changes = Atom.make<AsyncResult.AsyncResult<MonitoringChange>>(AsyncResult.initial());
  const answer = Atom.make(AsyncResult.success({ revision: 100, serverEpoch: "old" }));
  let reads = 0;
  const query = Atom.readable(
    (get) => get(answer),
    () => {
      reads++;
    },
  );
  const watched = followMonitoringChanges(query, changes, ThreadId.make("selected"));
  const unmount = registry.mount(watched);
  try {
    registry.set(
      changes,
      AsyncResult.success({ revision: 100, sinceRevision: 99, serverEpoch: "old" }),
    );
    registry.set(answer, AsyncResult.success({ revision: 0, serverEpoch: "new" }));
    registry.set(
      changes,
      AsyncResult.success({
        revision: 2,
        sinceRevision: 1,
        serverEpoch: "new",
        threadIds: [ThreadId.make("other")],
      }),
    );
    registry.get(watched);
    await Promise.resolve();
    expect(reads).toBe(1);
  } finally {
    unmount();
    registry.dispose();
  }
});

it("retries the selected detail after its first read on a new server fails", async () => {
  const registry = AtomRegistry.make();
  const changes = Atom.make<AsyncResult.AsyncResult<MonitoringChange>>(AsyncResult.initial());
  const old = AsyncResult.success({ revision: 100, serverEpoch: "old" });
  const answer = Atom.make<AsyncResult.AsyncResult<typeof old.value, string>>(old);
  let reads = 0;
  const query = Atom.readable(
    (get) => get(answer),
    () => {
      reads++;
    },
  );
  const thread = ThreadId.make("selected");
  const watched = followMonitoringChanges(query, changes, thread);
  const unmount = registry.mount(watched);
  try {
    registry.set(
      changes,
      AsyncResult.success({ revision: 100, serverEpoch: "old", threadIds: [thread] }),
    );
    registry.set(
      answer,
      AsyncResult.failure(Cause.fail("first read failed"), { previousSuccess: Option.some(old) }),
    );
    registry.set(
      changes,
      AsyncResult.success({
        revision: 1,
        sinceRevision: 0,
        serverEpoch: "new",
        threadIds: [thread],
      }),
    );
    await Promise.resolve();
    expect(reads).toBe(1);
  } finally {
    unmount();
    registry.dispose();
  }
});

it("discards an old-epoch notice when the replacement answer establishes a new baseline", async () => {
  const registry = AtomRegistry.make();
  const changes = Atom.make<AsyncResult.AsyncResult<MonitoringChange>>(AsyncResult.initial());
  const first = AsyncResult.success({ revision: 3, serverEpoch: "old" });
  const answer = Atom.make<AsyncResult.AsyncResult<typeof first.value, string>>(first);
  let reloads = 0;
  const query = Atom.readable(
    (get) => get(answer),
    () => {
      reloads++;
    },
  );
  const thread = ThreadId.make("selected");
  const watched = followMonitoringChanges(query, changes, thread);
  const unmount = registry.mount(watched);
  try {
    registry.set(answer, AsyncResult.waiting(first));
    registry.set(
      changes,
      AsyncResult.success({ revision: 4, serverEpoch: "old", threadIds: [thread] }),
    );
    const replacement = AsyncResult.success({ revision: 0, serverEpoch: "new" });
    registry.set(answer, replacement);
    registry.set(answer, AsyncResult.waiting(replacement));
    registry.set(
      answer,
      AsyncResult.failure(Cause.fail("manual read failed"), {
        previousSuccess: Option.some(replacement),
      }),
    );
    await Promise.resolve();
    expect(reloads).toBe(0);
  } finally {
    unmount();
    registry.dispose();
  }
});

it("ends a manual Refresh at its own deadline through repeated connection replacements and enables Retry", async () => {
  vi.useFakeTimers();
  const registry = AtomRegistry.make();
  const previous = { revision: 7 };
  const answer = Atom.make(AsyncResult.success(previous, { waiting: true }));
  const query = Atom.readable((get) => get(answer));
  const operation = createMonitoringOperation();
  const unmount = registry.mount(operation.state);
  try {
    const run = () =>
      operation.run(registry, async () =>
        monitoringRefreshTimedOut(
          await executeMonitoringQuery(registry, query, EnvironmentId.make("env-a")),
        ),
      );
    const outcome = run();
    expect(registry.get(operation.state)).toBe("pending");
    for (let generation = 1; generation <= 5; generation++) {
      await vi.advanceTimersByTimeAsync(3_000);
      registry.set(answer, AsyncResult.success(previous, { waiting: true, timestamp: generation }));
    }
    await outcome;
    expect(registry.get(operation.state)).toBe("timed-out");
    expect(monitoringOperationRetry("busy", registry.get(operation.state) === "pending")).toBe(
      "available",
    );
    expect(registry.getNodes().get(query)?.listeners.size ?? 0).toBe(0);
    expect(AsyncResult.getOrElse(registry.get(query), () => null)).toEqual(previous);
    const retry = run();
    registry.set(answer, AsyncResult.success({ revision: 8 }));
    await retry;
    expect(registry.get(operation.state)).toBe("settled");
  } finally {
    unmount();
    registry.dispose();
    vi.useRealTimers();
  }
});
