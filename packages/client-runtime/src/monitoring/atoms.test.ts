import {
  EnvironmentId,
  type MonitoringChatsInput,
  type MonitoringChatsResult,
  type MonitoringOverviewInput,
  type MonitoringThreadSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { MonitoringChatsRequest } from "./aggregate.ts";
import { createMonitoringAtoms } from "./atoms.ts";

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
