import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  MonitoringFixChatError,
  ProjectId,
  ThreadId,
  type MonitoringChatsResult,
  type MonitoringFindingTotal,
  type MonitoringGroup,
  type MonitoringOverviewResult,
  type MonitoringThreadSummary,
} from "@t3tools/contracts";
import { activateLanguage } from "@t3tools/shared/i18n";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import {
  breakdownByModel,
  dailyTrend,
  environmentReport,
  failureRetry,
  filterGroups,
  formatMonitoringTime,
  keepsShownChats,
  fixChatRequest,
  fixChatTarget,
  median,
  mergeMonitoringChats,
  mergeMonitoringOverviews,
  missingEnvironments,
  monitoringChatKey,
  monitoringChatsInput,
  monitoringEnvironment,
  monitoringFacets,
  monitoringWindow,
  percentile,
  phaseTotals,
  projectKey,
  presentMonitoringChats,
  presentMonitoringOverview,
  queryRead,
  rankFindings,
  settleFixChat,
  sumTimeBuckets,
  threadFixChatTarget,
  totalsOf,
  TIME_BUCKET_KEYS,
  unanalyzedCounts,
  type MonitoringChat,
  type MonitoringChatOrder,
  type MonitoringChatsRequest,
  type MonitoringChatsSource,
  type MonitoringChatsView,
  type MonitoringEnvironment,
  type MonitoringEnvironmentReport,
  type MonitoringFixChatScope,
  type MonitoringGroupEntry,
} from "./aggregate.ts";

const zeroTime = {
  agentMs: 0,
  commandMs: 0,
  toolMs: 0,
  approvalMs: 0,
  queuedMs: 0,
  usageLimitMs: 0,
  delegateWaitMs: 0,
  userResponseMs: 0,
  idleMs: 0,
  settleTailMs: 0,
};

function group(
  overrides: Partial<MonitoringGroup> = {},
  environmentId = "env-a",
): MonitoringGroupEntry {
  const value = {
    day: "2026-11-10",
    projectId: "p1",
    kind: "interactive",
    model: "opus",
    lifetimesMs: [1000],
    activesMs: [400],
    time: { ...zeroTime, agentMs: 400, userResponseMs: 600 },
    tokens: {
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    },
    costUsd: 1,
    unpricedTurns: 0,
    runs: 2,
    failedRuns: 1,
    userPrompts: 1,
    helpers: 2,
    findings: [],
    phases: [],
    ...overrides,
  } as unknown as MonitoringGroup;
  return { environmentId, group: value };
}

/** Only the fields the chat list reads. */
function chat(id: string, overrides: Record<string, unknown> = {}): MonitoringChat {
  const summary = {
    threadId: id,
    projectId: "p1",
    settledAt: "2026-11-10T12:00:00.000Z",
    lifetimeMs: 1000,
    activeMs: 400,
    costUsd: 1,
    runs: { failed: 0 },
    commands: { failed: 0 },
    findings: [],
    ...overrides,
  } as unknown as MonitoringThreadSummary;
  return { environmentId: "env-a", summary };
}

/** One environment's answer, each chat with the key the server sorted it by. */
const answer = (
  chats: ReadonlyArray<readonly [MonitoringChat, number]>,
  total = chats.length,
): MonitoringChatsResult => ({
  chats: chats.map(([entry, sortValue]) => ({ summary: entry.summary, sortValue })),
  total,
});

const environment = (
  environmentId: string,
  unready: MonitoringEnvironment["unready"] = null,
): MonitoringEnvironment => ({
  environmentId: EnvironmentId.make(environmentId),
  label: environmentId,
  unready,
});

type SourcePage =
  | MonitoringChatsResult
  | { readonly again: MonitoringChatsResult | string }
  | string;

/**
 * An environment's chat list by page offset: a string is a page that failed, `again` a page read
 * again that still holds its old answer or failure, and a missing page still loads. `reads` records
 * each page the merge asked for.
 */
function source(
  environmentId: string,
  pages: Record<number, SourcePage>,
  reads: string[] = [],
  unready: MonitoringEnvironment["unready"] = null,
): MonitoringChatsSource {
  return {
    environment: environment(environmentId, unready),
    readPage: (offset) => {
      reads.push(`${environmentId}:${offset}`);
      const page = pages[offset];
      if (page === undefined) return { isPending: true, error: null, result: null };
      if (typeof page === "string") return { isPending: false, error: page, result: null };
      if (!("again" in page)) return { isPending: false, error: null, result: page };
      return typeof page.again === "string"
        ? { isPending: true, error: page.again, result: null }
        : { isPending: true, error: null, result: page.again };
    },
  };
}

const page = (environmentId: string, offset: number) => ({
  environmentId: EnvironmentId.make(environmentId),
  offset,
});

const chatsRequest = (
  order: Partial<MonitoringChatOrder> = {},
  pageSize = 2,
): MonitoringChatsRequest => ({
  window: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" },
  filters: {},
  order: { sort: "costUsd", direction: "desc", limit: 3, ...order },
  pageSize,
});

const report = <A>(
  environmentId: string,
  result: NoInfer<A> | null,
  overrides: Partial<MonitoringEnvironmentReport<A>> = {},
): MonitoringEnvironmentReport<A> => ({
  environmentId: EnvironmentId.make(environmentId),
  label: environmentId,
  retryable: true,
  isPending: false,
  error: null,
  result,
  ...overrides,
});

describe("percentile", () => {
  it("interpolates between neighbours and handles empty and single inputs", () => {
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(percentile([1, 2], 2)).toBe(2);
  });
});

describe("totalsOf and sumTimeBuckets", () => {
  const entries = [
    group({ lifetimesMs: [1000], activesMs: [400] }),
    group({
      lifetimesMs: [1000, 2000],
      activesMs: [400, 600],
      time: { ...zeroTime, commandMs: 1000, idleMs: 2000 },
      costUsd: 2,
      findings: [
        { code: "retries", severity: "low", chats: 2, occurrences: 5, wastedMs: 10 },
        { code: "usage_limit", severity: "high", chats: 1, occurrences: 1, wastedMs: 10 },
      ],
    }),
  ];

  it("sums buckets so they still add up to the summed lifetime", () => {
    const buckets = sumTimeBuckets(entries);
    expect(buckets.agentMs).toBe(400);
    expect(buckets.commandMs).toBe(1000);
    expect(TIME_BUCKET_KEYS.reduce((total, key) => total + buckets[key], 0)).toBe(4000);
  });

  it("counts chats and medians across groups and each chat's findings once per code", () => {
    const totals = totalsOf(entries);
    expect(totals).toMatchObject({
      chats: 3,
      lifetimeMs: 4000,
      medianLifetimeMs: 1000,
      medianActiveMs: 400,
      workingMs: 1400,
      costUsd: 3,
      cacheReuse: 0.25,
      failedRuns: 2,
      helpers: 4,
      findings: 3,
    });
    expect(totals.workingShare).toBeCloseTo(0.35);
  });

  it("has no cache reuse or share without data", () => {
    const totals = totalsOf([]);
    expect(totals.cacheReuse).toBeNull();
    expect(totals.workingShare).toBe(0);
  });
});

describe("rankFindings", () => {
  it("merges per code across groups and environments, ranks by time lost, keeps the worst severity", () => {
    const ranks = rankFindings([
      group({
        findings: [
          { code: "retries", severity: "low", chats: 1, occurrences: 1, wastedMs: 100 },
          { code: "usage_limit", severity: "medium", chats: 1, occurrences: 1, wastedMs: 5000 },
        ],
      }),
      group(
        {
          findings: [
            { code: "retries", severity: "high", chats: 1, occurrences: 2, wastedMs: 200 },
          ],
        },
        "env-b",
      ),
      group({
        findings: [
          { code: "many_prompts", severity: "low", chats: 1, occurrences: 7, wastedMs: 0 },
        ],
      }),
    ]);
    expect(ranks.map((rank) => rank.code)).toEqual(["usage_limit", "retries", "many_prompts"]);
    expect(ranks[1]).toEqual({
      code: "retries",
      chats: 2,
      occurrences: 3,
      wastedMs: 300,
      severity: "high",
    });
  });
});

describe("fixChatTarget", () => {
  const slow = (wastedMs: number, chats = 1): MonitoringFindingTotal => ({
    code: "slow_command",
    severity: "high",
    wastedMs,
    chats,
    occurrences: chats,
  });
  const window = { since: "2026-10-12T00:00:00.000Z", until: "2026-11-11T00:00:00.000Z" };
  const view = { window, filters: {} };

  it("picks the environment and project that lost the most time across all groups", () => {
    const target = fixChatTarget(
      [
        group({ findings: [slow(700)] }, "env-a"),
        group({ projectId: ProjectId.make("p2"), findings: [slow(300, 25)] }, "env-b"),
        group(
          { day: "2026-11-09", projectId: ProjectId.make("p2"), findings: [slow(150, 25)] },
          "env-b",
        ),
        group({ findings: [slow(400)] }, "env-b"),
        group({ projectId: ProjectId.make("p3") }, "env-b"),
      ],
      "slow_command",
      view,
    );
    expect(target).toMatchObject({
      environmentId: "env-b",
      projectId: ProjectId.make("p2"),
      source: { view: window },
    });
    expect(target?.source).toEqual({ view: window });
  });

  it("breaks ties by affected chat counts and then by stable environment and project ids", () => {
    const entries = [
      group({ findings: [slow(120, 4)] }, "env-a"),
      group({ findings: [slow(120, 5)] }, "env-c"),
      group({ projectId: ProjectId.make("p3"), findings: [slow(40, 2)] }, "env-b"),
      group({ findings: [slow(40, 1)] }, "env-b"),
      group({ projectId: ProjectId.make("p2"), findings: [slow(40, 2)] }, "env-b"),
    ];
    for (const order of [entries, entries.toReversed()]) {
      expect(fixChatTarget(order, "slow_command", view)).toMatchObject({
        environmentId: "env-b",
        projectId: ProjectId.make("p2"),
      });
    }
  });

  it("sends the active project, kind and model filters with the window", () => {
    const projectId = ProjectId.make("p2");
    const filters = { projectKey: "env-b:p2", kind: "scheduled", model: "" } as const;
    const entries = [
      group({ findings: [slow(800)] }),
      group(
        { projectId, kind: filters.kind, model: filters.model, findings: [slow(500)] },
        "env-b",
      ),
    ];
    expect(
      fixChatTarget(filterGroups(entries, filters), "slow_command", { window, filters }),
    ).toMatchObject({
      environmentId: "env-b",
      projectId,
      source: { view: { ...window, projectId, kind: "scheduled", model: "" } },
    });
  });

  it("keys retries to the exact window and filters across refreshed totals", () => {
    const place = (entries: ReadonlyArray<MonitoringGroupEntry>, shown: MonitoringFixChatScope) =>
      fixChatTarget(entries, "slow_command", shown)?.origin;
    const shown = [group({ findings: [slow(1)] })];
    expect(place([group({ findings: [slow(2)] })], view)).toBe(place(shown, view));
    for (const other of [
      { ...view, window: { ...window, since: "2026-10-13T00:00:00.000Z" } },
      { ...view, window: { ...window, until: "2026-11-12T00:00:00.000Z" } },
      { ...view, filters: { projectKey: "env-a:p1" } },
      { ...view, filters: { kind: "interactive" as const } },
      { ...view, filters: { model: "opus" } },
    ]) {
      expect(place(shown, other)).not.toBe(place(shown, view));
    }
  });

  it("is null when no chat has the weak point", () => {
    expect(fixChatTarget([group({ findings: [slow(1)] })], "retries", view)).toBeNull();
  });
});

describe("fixChatRequest", () => {
  const environmentId = EnvironmentId.make("env-retry");
  const target = (threadId: string) =>
    threadFixChatTarget(environmentId, {
      threadId: ThreadId.make(threadId),
      projectId: ProjectId.make("p1"),
    });
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;

  it("reuses a request while its view, environment, project and finding match", () => {
    const first = fixChatRequest(target("a"), "slow_command", "web", newId);
    expect(first.input).toMatchObject({ projectId: "p1", threadIds: ["a"] });
    expect(fixChatRequest(target("a"), "slow_command", "web", newId)).toBe(first);
    const moved = { ...target("a"), projectId: ProjectId.make("p2") };
    const destination = fixChatRequest(moved, "slow_command", "web", newId);
    expect(destination.input.projectId).toBe(moved.projectId);
    expect(destination.input.commandId).not.toBe(first.input.commandId);
    expect(fixChatRequest(target("a"), "retries", "web", newId)).not.toBe(first);
    expect(fixChatRequest(target("b"), "slow_command", "web", newId)).not.toBe(first);
    const elsewhere = { ...target("a"), environmentId: EnvironmentId.make("env-other") };
    expect(fixChatRequest(elsewhere, "slow_command", "web", newId)).not.toBe(first);
  });

  it.each([
    ["a started chat", null, true],
    ["a refusal", Cause.fail(new MonitoringFixChatError({ reason: "no-chats", detail: "" })), true],
    [
      "a refused grant",
      Cause.fail(
        new EnvironmentAuthorizationError({
          message: "",
          requiredScope: AuthOrchestrationOperateScope,
        }),
      ),
      false,
    ],
    [
      "a failed launch",
      Cause.fail(new MonitoringFixChatError({ reason: "launch-failed", detail: "" })),
      false,
    ],
    ["a lost answer", Cause.fail(new Error("socket closed")), false],
  ])(
    "after %s, sends a new request next only when nothing could have started",
    (name, failure, fresh) => {
      const place = target(`settle ${name}`);
      const first = fixChatRequest(place, "slow_command", "web", newId);
      settleFixChat(place, "slow_command", first, failure);
      expect(fixChatRequest(place, "slow_command", "web", newId) !== first).toBe(fresh);
    },
  );

  it("keeps a newer request when an earlier response arrives late", () => {
    const place = target("late response");
    const first = fixChatRequest(place, "slow_command", "web", newId);
    settleFixChat(place, "slow_command", first, null);
    const second = fixChatRequest(place, "slow_command", "web", newId);
    settleFixChat(place, "slow_command", first, null);
    expect(fixChatRequest(place, "slow_command", "web", newId)).toBe(second);
  });
});

describe("dailyTrend", () => {
  it("merges the groups of a day, sorts the days and fills listed empty ones", () => {
    const trend = dailyTrend(
      [
        group({ day: "2026-11-11", lifetimesMs: [300], costUsd: 2 }),
        group({ day: "2026-11-10", lifetimesMs: [100] }),
        group({ day: "2026-11-11", lifetimesMs: [100], kind: "scheduled" }, "env-b"),
      ],
      { days: [{ day: "2026-11-09" }, { day: "2026-11-10" }, { day: "2026-11-11" }] },
    );
    expect(trend.map((point) => [point.day, point.chats])).toEqual([
      ["2026-11-09", 0],
      ["2026-11-10", 1],
      ["2026-11-11", 2],
    ]);
    expect(trend[2]).toMatchObject({ medianLifetimeMs: 200, p90LifetimeMs: 280, costUsd: 3 });
  });
});

describe("filters, facets and breakdowns", () => {
  const entries = [
    group({ model: "opus" }),
    group({ model: "haiku", kind: "scheduled" }, "env-b"),
    group({ model: "" }),
  ];

  it("breaks down by main model with an empty key for chats without one", () => {
    expect(
      breakdownByModel(entries)
        .map((row) => row.key)
        .toSorted(),
    ).toEqual(["", "haiku", "opus"]);
  });

  it("filters by project, kind and model across environments", () => {
    const keys = (filtered: ReadonlyArray<MonitoringGroupEntry>) =>
      filtered.map(({ environmentId, group }) => `${environmentId}:${group.model}`);
    expect(keys(filterGroups(entries, { kind: "scheduled" }))).toEqual(["env-b:haiku"]);
    expect(keys(filterGroups(entries, { projectKey: "env-b:p1" }))).toEqual(["env-b:haiku"]);
    expect(keys(filterGroups(entries, { model: "" }))).toEqual(["env-a:"]);
    expect(filterGroups(entries, {})).toBe(entries);
    const unanalyzed = [
      {
        environmentId: "env-b",
        unanalyzed: { projectId: ProjectId.make("p1"), pending: 1, failed: 0 },
      },
      {
        environmentId: "env-b",
        unanalyzed: { projectId: ProjectId.make("p2"), pending: 0, failed: 1 },
      },
    ];
    expect(monitoringFacets({ groups: entries, unanalyzed }).projectKeys).toEqual([
      "env-a:p1",
      "env-b:p1",
      "env-b:p2",
    ]);
  });
});

describe("phaseTotals", () => {
  it("sums phases across groups, computes rates, and drops phases that never ran", () => {
    const totals = phaseTotals([
      group({
        phases: [
          { phase: "test", count: 2, failed: 1, durationMs: 4000 },
          { phase: "build", count: 0, failed: 0, durationMs: 0 },
        ],
      }),
      group({ phases: [{ phase: "test", count: 2, failed: 1, durationMs: 2000 }] }),
    ]);
    expect(totals).toEqual([
      { phase: "test", count: 4, failed: 2, failureRate: 0.5, durationMs: 6000, averageMs: 1500 },
    ]);
  });
});

describe("monitoringWindow", () => {
  const inZone = <A>(zone: string, read: () => A) => {
    vi.stubEnv("TZ", zone);
    try {
      return read();
    } finally {
      vi.unstubAllEnvs();
    }
  };
  const windowIn = (zone: string, days: number, at: string) =>
    inZone(zone, () => monitoringWindow(days, Date.parse(at)));

  it("runs from midnight on the device's clock, days - 1 days back, to the end of today, naming and starting every day", () => {
    // 15:30 in New York on 2026-11-18.
    const week = windowIn("America/New_York", 7, "2026-11-18T20:30:00.000Z");
    expect([week.since, week.until, week.days.length, week.days[0], week.days[6]]).toEqual([
      "2026-11-12T05:00:00.000Z",
      "2026-11-19T05:00:00.000Z",
      7,
      { day: "2026-11-12", since: "2026-11-12T05:00:00.000Z" },
      { day: "2026-11-18", since: "2026-11-18T05:00:00.000Z" },
    ]);
    expect([
      // Havana's clocks skipped from 00:00 to 01:00 on 2026-03-08.
      windowIn("America/Havana", 30, "2026-03-08T16:00:00.000Z").since,
      // Nuuk skipped 23:00 to 00:00 on 2026-03-28; 30 days on 2026-04-26 at 23:30 start that day.
      windowIn("America/Nuuk", 30, "2026-04-27T00:30:00.000Z").since,
      // New York's clocks went back an hour on 2026-11-01, so its later days start an hour later.
      windowIn("America/New_York", 3, "2026-11-02T15:00:00.000Z").days.map((day) => day.since),
      // Samoa skipped 2011-12-30 whole, so three days back from 2012-01-01 hold two.
      windowIn("Pacific/Apia", 3, "2012-01-01T00:00:00.000Z").days,
    ]).toEqual([
      "2026-02-07T05:00:00.000Z",
      "2026-03-28T02:00:00.000Z",
      ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
      [
        { day: "2011-12-31", since: "2011-12-30T10:00:00.000Z" },
        { day: "2012-01-01", since: "2011-12-31T10:00:00.000Z" },
      ],
    ]);
  });

  it("names a time on the device's clock, with the offset in an hour the clock shows twice", () => {
    const cases: ReadonlyArray<readonly [zone: string, instant: string, hour12: boolean]> = [
      // New York went back an hour, from 02:00 EDT to 01:00 EST, on 2026-11-01.
      ["America/New_York", "2026-11-01T04:30:00.000Z", true],
      ["America/New_York", "2026-11-01T05:30:00.000Z", true],
      ["America/New_York", "2026-11-01T06:30:00.000Z", false],
      // Troll went back two hours, Lord Howe half an hour, and Lord Howe skipped 02:00 to 02:30.
      ["Antarctica/Troll", "2026-10-25T00:30:00.000Z", true],
      ["Antarctica/Troll", "2026-10-25T02:30:00.000Z", true],
      ["Australia/Lord_Howe", "2026-04-04T14:15:00.000Z", true],
      ["Australia/Lord_Howe", "2026-04-04T14:45:00.000Z", true],
      ["Australia/Lord_Howe", "2026-04-04T15:15:00.000Z", true],
      ["Australia/Lord_Howe", "2026-10-03T15:45:00.000Z", false],
      // Monrovia was 44 minutes 30 seconds behind UTC, so this is still 1 June.
      ["Africa/Monrovia", "1971-06-02T00:44:15.000Z", true],
      // At noon on 1883-11-18 Denver went from 6:59:56 behind UTC to 7 hours, repeating 4 seconds.
      ["America/Denver", "1883-11-18T18:59:57.000Z", true],
      ["America/Denver", "1883-11-18T19:00:01.000Z", true],
    ];
    expect(
      cases.map(([zone, instant, hour12]) =>
        inZone(zone, () => formatMonitoringTime(instant, hour12)),
      ),
    ).toEqual([
      "Nov 1, 12:30 AM",
      "Nov 1, 1:30 AM GMT-4",
      "Nov 1, 01:30 GMT-5",
      "Oct 25, 2:30 AM GMT+2",
      "Oct 25, 2:30 AM GMT+0",
      "Apr 5, 1:15 AM",
      "Apr 5, 1:45 AM GMT+11",
      "Apr 5, 1:45 AM GMT+10:30",
      "Oct 4, 02:45",
      "Jun 1, 11:59 PM",
      "Nov 18, 12:00 PM GMT-6:59:56",
      "Nov 18, 12:00 PM GMT-7",
    ]);
  });

  it("keeps the chosen hour cycle in a locale with another one, and the locale's without a choice", () => {
    const instant = "2026-11-20T17:47:00.000Z";
    activateLanguage({ language: "en", catalog: {}, formattingLocale: "en-GB" });
    try {
      expect(
        inZone("UTC", () => [
          formatMonitoringTime(instant, true),
          formatMonitoringTime(instant, false),
          formatMonitoringTime(instant),
        ]),
      ).toEqual(["20 Nov, 5:47 pm", "20 Nov, 17:47", "20 Nov, 17:47"]);
    } finally {
      activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
    }
  });

  it("keeps to the clock's days when Intl names another zone", () => {
    // Node reads TZ=GMT+3 as UTC-3 in Date and UTC+3 in Intl, and Hermes on iOS misreads Intl's
    // offsets.
    const RealDateTimeFormat = Intl.DateTimeFormat;
    using _otherZone = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      locales,
      options,
    ) {
      return new RealDateTimeFormat(locales, {
        ...options,
        timeZone: options?.timeZone ?? "Asia/Tokyo",
      });
    } as typeof Intl.DateTimeFormat);
    // 23:30 in New York on 2026-11-20, already the 21st in Tokyo.
    const late = windowIn("America/New_York", 7, "2026-11-21T04:30:00.000Z");
    const row = inZone("America/New_York", () => formatMonitoringTime("2026-11-21T04:30:00.000Z"));
    expect([late.until, late.days.at(-1), row]).toEqual([
      "2026-11-21T05:00:00.000Z",
      { day: "2026-11-20", since: "2026-11-20T05:00:00.000Z" },
      "Nov 20, 11:30 PM",
    ]);
  });
});

describe("mergeMonitoringOverviews", () => {
  const overview = (environmentId: string) => ({
    groups: [group({}, environmentId).group],
    unanalyzed: [
      { projectId: ProjectId.make("p1"), pending: 1, failed: 2 },
      { projectId: ProjectId.make("p2"), pending: 3, failed: 0 },
    ],
  });

  it("sums the answers and names the environments not counted yet", () => {
    const merged = mergeMonitoringOverviews([
      report("env-a", overview("env-a")),
      report("env-b", null, { error: "offline" }),
      report("env-c", overview("env-c"), { isPending: true }),
      report("env-d", null, { isPending: true }),
    ]);
    expect(merged.groups.map((entry) => entry.environmentId)).toEqual(["env-a", "env-c"]);
    // Kind and model are unknown before analysis, so only the project narrows these.
    expect([
      unanalyzedCounts(merged.unanalyzed, null),
      unanalyzedCounts(merged.unanalyzed, projectKey("env-c", "p1")),
      unanalyzedCounts(merged.unanalyzed, projectKey("env-b", "p1")),
    ]).toEqual([
      { pending: 8, failed: 4 },
      { pending: 1, failed: 2 },
      { pending: 0, failed: 0 },
    ]);
    expect(merged.waiting.map((entry) => entry.environmentId)).toEqual(["env-d"]);
    expect(merged.unreadable.map((entry) => entry.environmentId)).toEqual(["env-b"]);
    expect([merged.isLoading, merged.failed]).toEqual([false, false]);
    expect(missingEnvironments(merged)).toEqual({ waiting: "env-d", unreadable: "env-b: offline" });
    const answered = mergeMonitoringOverviews([report("env-a", overview("env-a"))]);
    expect([answered.complete, missingEnvironments(answered)]).toEqual([
      true,
      { waiting: "", unreadable: "" },
    ]);
  });

  it("keeps an answered overview complete during a notice-driven reload", () => {
    const refreshing = environmentReport(environment("env-a"), () => ({
      result: overview("env-a"),
      isPending: true,
      error: null,
    }));
    expect(mergeMonitoringOverviews([refreshing])).toMatchObject({
      stale: false,
      waiting: [],
      complete: true,
    });
  });

  it("shows the selected period after one environment answers and the other fails", () => {
    const before = mergeMonitoringOverviews([
      report("env-a", overview("env-a")),
      report("env-b", overview("env-b")),
    ]);
    const days = [{ day: "2026-11-20", since: "2026-11-20T00:00:00.000Z" }];
    const shown = {
      key: "old",
      view: before,
      days: [{ day: "2026-11-10", since: "2026-11-10T00:00:00.000Z" }],
    };
    const answer = { ...overview("env-a"), groups: [group({ day: days[0]!.day }).group] };
    const failure = report<MonitoringOverviewResult>("env-b", null, { error: "offline" });
    const loading = mergeMonitoringOverviews([report("env-a", null), failure]);
    expect(presentMonitoringOverview(shown, { key: "new", view: loading, days })).toMatchObject({
      keep: true,
      days: shown.days,
      view: { groups: before.groups, stale: true },
    });

    const loaded = mergeMonitoringOverviews([report("env-a", answer), failure]);
    expect(presentMonitoringOverview(shown, { key: "new", view: loaded, days })).toMatchObject({
      keep: false,
      days,
      view: { groups: loaded.groups, unreadable: [failure], complete: false },
    });
    const reconnecting = mergeMonitoringOverviews([report("env-a", answer), report("env-b", null)]);
    expect(
      presentMonitoringOverview(shown, { key: "new", view: reconnecting, days }),
    ).toMatchObject({
      keep: false,
      days,
      view: { groups: reconnecting.groups, waiting: [{ environmentId: "env-b" }] },
    });
    const failed = mergeMonitoringOverviews([
      report("env-a", null, { error: "unreachable" }),
      failure,
    ]);
    expect(presentMonitoringOverview(shown, { key: "new", view: failed, days })).toMatchObject({
      keep: true,
      days: shown.days,
      view: { groups: before.groups, failed: false, stale: true },
    });
  });

  it("loads until the first answer, names whom it waits for once another failed, and fails when all did", () => {
    const status = (...reports: MonitoringEnvironmentReport[]) => {
      const merged = mergeMonitoringOverviews(reports);
      return [merged.isLoading, merged.failed, merged.complete, missingEnvironments(merged)];
    };
    expect(status(report("env-a", null, { isPending: true }))).toEqual([
      true,
      false,
      false,
      { waiting: "", unreadable: "" },
    ]);
    expect(
      status(
        report("env-a", null, { error: "offline" }),
        report("env-b", null, { isPending: true }),
      ),
    ).toEqual([true, false, false, { waiting: "env-b", unreadable: "env-a: offline" }]);
    expect(status(report("env-a", null, { error: "offline" }))).toEqual([
      false,
      true,
      false,
      { waiting: "", unreadable: "env-a: offline" },
    ]);
  });
});

describe("monitoringEnvironment", () => {
  const environmentId = EnvironmentId.make("env-a");
  const connection = (phase: EnvironmentConnectionPhase, error: string | null = null) =>
    ({ phase, error, traceId: null }) as const;
  /** Only the fields Monitoring reads; `capabilities: null` is a server config not arrived yet. */
  const presentation = (
    state: EnvironmentConnectionPresentation,
    options: { readonly enabled?: boolean; readonly capabilities?: object | null } = {},
  ) =>
    ({
      entry: { target: { label: "Laptop" }, enabled: options.enabled ?? true },
      connection: state,
      serverConfig:
        options.capabilities === null
          ? null
          : { environment: { capabilities: options.capabilities ?? { monitoringPages: true } } },
      lastSeenAt: null,
    }) as unknown as EnvironmentPresentation;
  const unready = (value: EnvironmentPresentation) =>
    monitoringEnvironment(environmentId, value)?.unready;

  it("asks a connected environment whose server pages Monitoring and waits for one on its way", () => {
    expect(unready(presentation(connection("connected")))).toBeNull();
    for (const waiting of [
      presentation(connection("connecting")),
      presentation(connection("reconnecting")),
    ]) {
      expect(unready(waiting)).toEqual({ error: null, reconnects: true });
    }
    expect(unready(presentation(connection("connected"), { capabilities: null }))).toEqual({
      error: null,
      reconnects: false,
    });
  });

  it("names one that is down or too old to page, and leaves out one not asked to connect", () => {
    for (const down of [
      connection("reconnecting", "timed out"),
      connection("offline"),
      connection("error"),
    ]) {
      expect(unready(presentation(down))).toEqual({
        error: connectionStatusText(down),
        reconnects: true,
      });
    }
    // Retry cannot reach a server that is too old, so it is not offered for one.
    expect(unready(presentation(connection("unsupported", "Too old")))).toEqual({
      error: "Too old",
      reconnects: false,
    });
    expect(unready(presentation(connection("connected"), { capabilities: {} }))).toEqual({
      error: "Update this environment's T3.CodeShip server to see it in Monitoring.",
      reconnects: false,
    });
    expect(unready(presentation(connection("available")))).toBeUndefined();
    expect(
      unready(presentation(connection("unsupported", "Too old"), { enabled: false })),
    ).toBeUndefined();
  });
});

describe("environmentReport", () => {
  const answer = { groups: [], unanalyzed: [] };
  const kept = AsyncResult.success(answer, { timestamp: 0 });
  const reportOf = (
    unready: MonitoringEnvironment["unready"],
    result: AsyncResult.AsyncResult<typeof answer, string>,
  ) =>
    environmentReport(environment("env-a", unready), () =>
      queryRead(result, (cause) => `failed: ${String(Cause.squash(cause))}`),
    );

  it("marks a previous answer stale during and after a failed refresh", () => {
    expect(
      reportOf(null, AsyncResult.success(answer, { waiting: true, timestamp: 0 })),
    ).toMatchObject({ isPending: true, error: null, result: answer });
    expect(
      reportOf(
        null,
        AsyncResult.failure(Cause.fail("boom"), { previousSuccess: Option.some(kept) }),
      ),
    ).toMatchObject({ isPending: false, error: "failed: boom", result: answer, stale: true });
  });

  it("does not count an environment that cannot answer yet, nor wait on a request it never sent", () => {
    expect(reportOf({ error: null, reconnects: true }, kept)).toMatchObject({
      retryable: true,
      isPending: false,
      error: null,
      result: null,
    });
    expect(reportOf({ error: "Too old", reconnects: false }, kept)).toMatchObject({
      retryable: false,
      isPending: false,
      error: "Too old",
      result: null,
    });
  });
});

describe("chat list across environments", () => {
  const costs = (
    environmentId: string,
    values: ReadonlyArray<number>,
    total: number,
    from = 0,
  ): MonitoringChatsResult =>
    answer(
      values.map(
        (costUsd, index) =>
          [chat(`${environmentId}-${from + index}`, { costUsd }), costUsd] as const,
      ),
      total,
    );
  const shownCosts = (view: MonitoringChatsView) =>
    view.chats.map((entry) => entry.summary.costUsd);

  it("merges by the keys the servers sorted by, so a longer list starts with the shorter one", () => {
    // The server counted three findings in x that this client cannot decode.
    const ranked = [
      [chat("x"), 3],
      [chat("y", { findings: [{}] }), 1],
    ] as const;
    const other = [
      [chat("z", { findings: [{}, {}] }), 2],
      [chat("w"), 0],
    ] as const;
    const merge = (limit: number) =>
      mergeMonitoringChats(
        [source("env-a", { 0: answer(ranked) }), source("env-b", { 0: answer(other) })],
        chatsRequest({ sort: "findings", limit }),
      ).chats.map(monitoringChatKey);
    expect([merge(1), merge(3)]).toEqual([["env-a:x"], ["env-a:x", "env-b:z", "env-a:y"]]);
    const tied = mergeMonitoringChats(
      [
        source("env-a", { 0: answer([[chat("a", { settledAt: "2026-11-02T08:00:00Z" }), 1]]) }),
        source("env-b", { 0: answer([[chat("b", { settledAt: "2026-11-02T09:00:00Z" }), 1]]) }),
      ],
      chatsRequest({ sort: "costUsd", limit: 2 }),
    );
    expect(tied.chats.map((entry) => entry.summary.threadId)).toEqual(["b", "a"]);
  });

  it("reads an environment's next page only once the chats shown need it", () => {
    const reads: string[] = [];
    const sources = (pagesOfA: Record<number, SourcePage>) => [
      source("env-a", pagesOfA, reads),
      source("env-b", { 0: costs("env-b", [6, 5], 2) }, reads),
    ];
    const pagesOfA = {
      0: costs("env-a", [9, 8], 5),
      2: costs("env-a", [7, 1], 5, 2),
      4: costs("env-a", [0], 5, 4),
    };
    const first = mergeMonitoringChats(sources(pagesOfA), chatsRequest({ limit: 2 }));
    expect([shownCosts(first), first.total, first.awaitingPage, reads]).toEqual([
      [9, 8],
      7,
      false,
      ["env-a:0", "env-b:0"],
    ]);
    const longer = mergeMonitoringChats(sources(pagesOfA), chatsRequest({ limit: 4 }));
    expect([shownCosts(longer), longer.pages]).toEqual([
      [9, 8, 7, 6],
      [page("env-a", 0), page("env-b", 0), page("env-a", 2)],
    ]);
    // Until the page arrives, env-a's next chat could come before env-b's.
    const loading = mergeMonitoringChats(sources({ 0: pagesOfA[0] }), chatsRequest({ limit: 4 }));
    expect([shownCosts(loading), loading.awaitingPage]).toEqual([[9, 8], true]);
    expect(loading.pages).toContainEqual(page("env-a", 2));
    // A page read again holds an answer or failure from before the pages already answered again.
    const readAgain = (pages: Record<number, SourcePage>) => {
      const view = mergeMonitoringChats(sources(pages), chatsRequest({ limit: 4 }));
      return [shownCosts(view), view.total, view.complete, view.awaitingPage];
    };
    expect([
      readAgain({ ...pagesOfA, 2: { again: pagesOfA[2] } }),
      readAgain({ ...pagesOfA, 0: { again: pagesOfA[0] } }),
      readAgain({ ...pagesOfA, 2: { again: "boom" } }),
      readAgain({ ...pagesOfA, 0: { again: "boom" } }),
    ]).toEqual([
      [[9, 8], 7, false, true],
      [[6, 5], 2, false, true],
      [[9, 8], 7, false, true],
      [[6, 5], 2, false, true],
    ]);
  });

  it("skips a chat a shifted page repeats and leaves out an environment whose later page fails", () => {
    const repeated = mergeMonitoringChats(
      [
        source("env-a", {
          0: costs("env-a", [9, 8], 4),
          2: answer([
            [chat("env-a-1", { costUsd: 8 }), 8],
            [chat("env-a-2", { costUsd: 7 }), 7],
          ]),
        }),
      ],
      chatsRequest({ limit: 4 }),
    );
    expect(repeated.chats.map(monitoringChatKey)).toEqual([
      "env-a:env-a-0",
      "env-a:env-a-1",
      "env-a:env-a-2",
    ]);
    const failed = mergeMonitoringChats(
      [
        source("env-a", { 0: costs("env-a", [9, 8], 5), 2: "boom" }),
        source("env-b", { 0: costs("env-b", [6, 5], 2) }),
      ],
      chatsRequest({ limit: 6 }),
    );
    expect([shownCosts(failed), failed.total]).toEqual([[6, 5], 2]);
    expect(failed.unreadable.map((report) => [report.environmentId, report.error])).toEqual([
      ["env-a", "boom"],
    ]);
  });

  it("offers Retry until each failure it can reach is asked again, though the list stops before one", () => {
    const request = chatsRequest({ limit: 6 });
    const pagesOfB = { 0: costs("env-b", [9, 8], 4), 2: costs("env-b", [5, 4], 4, 2) };
    const merge = (later: SourcePage, pagesOf: Record<number, SourcePage> = pagesOfB) =>
      mergeMonitoringChats(
        [source("env-a", { 0: costs("env-a", [7, 6], 5), 2: later }), source("env-b", pagesOf)],
        request,
      );
    const failed = merge("boom");
    // env-b's page read again stops the list before env-a's failed page, which nothing asks again.
    const otherReadAgain = merge("boom", { ...pagesOfB, 2: { again: pagesOfB[2] } });
    const overview = (...failures: ReadonlyArray<Partial<MonitoringEnvironmentReport>>) =>
      mergeMonitoringOverviews([
        report("env-a", null, { isPending: true }),
        ...failures.map((failure, index) => report(`failed-${index}`, null, failure)),
      ]);
    const asking = { error: "boom", isPending: true };
    const tooOld = { error: "Too old", retryable: false };
    expect([
      failureRetry(failed, otherReadAgain),
      failureRetry(failed, merge({ again: "boom" })),
      failureRetry(overview({ error: "boom" })),
      failureRetry(overview(asking)),
      failureRetry(overview(asking, { error: "boom" })),
      failureRetry(overview(asking, tooOld)),
      failureRetry(overview(tooOld)),
      failureRetry(overview()),
    ]).toEqual([
      "available",
      "busy",
      "available",
      "busy",
      "available",
      "busy",
      "unavailable",
      "unavailable",
    ]);
  });

  it("asks each environment only for its own project and leaves out unset filters", () => {
    const request = chatsRequest({ sort: "costUsd", limit: 3 });
    const input = (filters: Parameters<typeof filterGroups>[1]) =>
      monitoringChatsInput("env-a", { ...request, filters }, 4);
    const asked = { ...request.window, sort: "costUsd", direction: "desc", limit: 2, offset: 4 };
    expect(input({ projectKey: "env-b:p1" })).toBeNull();
    expect(input({ projectKey: "env-a:p:1", model: "" })).toEqual({
      ...asked,
      projectId: "p:1",
      model: "",
    });
    expect(input({ kind: null, findingCode: null })).toEqual(asked);
  });

  it("counts every match of the environments that answered", () => {
    const merged = mergeMonitoringChats(
      [
        source("env-a", { 0: costs("env-a", [9, 4], 10) }),
        source("env-b", { 0: costs("env-b", [7, 5], 2) }),
        source("env-c", {}),
      ],
      chatsRequest({ limit: 3 }),
    );
    expect([shownCosts(merged), merged.total, merged.isLoading]).toEqual([[9, 7, 5], 12, false]);
    expect(mergeMonitoringChats([source("env-c", {})], chatsRequest({ limit: 3 })).isLoading).toBe(
      true,
    );
  });
});

describe("keepsShownChats", () => {
  const four = answer(
    ["a", "b", "c", "d"].map((id, index) => [chat(id), 4 - index] as const),
    4,
  );
  const two = answer(
    ["a", "b"].map((id, index) => [chat(id), 2 - index] as const),
    2,
  );
  const byCost = chatsRequest({ limit: 4 }, 4);
  const ascending = chatsRequest({ limit: 4, direction: "asc" }, 4);
  const at = (request: MonitoringChatsRequest, ...sources: MonitoringChatsSource[]) => ({
    request,
    view: mergeMonitoringChats(sources, request),
  });
  const shown = at(byCost, source("env-a", { 0: four }));

  it("keeps the previous rows while a new period or sort is loading", () => {
    const earlier = {
      ...ascending,
      window: { ...ascending.window, since: "2026-10-01T00:00:00.000Z" },
    };
    const withB = at(byCost, source("env-a", { 0: four }), source("env-b", { 0: two }));
    // env-b alone fills the list while env-a is read again.
    const readAgain = at(
      byCost,
      source("env-a", { 0: { again: four } }),
      source("env-b", { 0: four }),
    );
    const readAgainTwo = at(
      byCost,
      source("env-a", { 0: { again: four } }),
      source("env-b", { 0: two }),
    );
    expect([
      keepsShownChats(shown, at(ascending, source("env-a", {}))),
      keepsShownChats(shown, at(ascending, source("env-a", { 0: four }))),
      keepsShownChats(shown, at(earlier, source("env-a", {}))),
      keepsShownChats(withB, at(ascending, source("env-a", {}))),
      keepsShownChats(
        at(byCost, source("env-a", { 0: four }), source("env-b", { 0: four })),
        readAgain,
      ),
      keepsShownChats(at(byCost, source("env-a", {}), source("env-b", { 0: four })), readAgain),
      // Shown while env-b connected or was offline, so its chats are news, not a list read again.
      keepsShownChats(
        at(
          byCost,
          source("env-a", { 0: four }),
          source("env-b", {}, [], { error: null, reconnects: true }),
        ),
        readAgain,
      ),
      keepsShownChats(
        at(
          byCost,
          source("env-a", { 0: four }),
          source("env-b", {}, [], { error: "offline", reconnects: true }),
        ),
        readAgain,
      ),
      keepsShownChats(
        at(
          byCost,
          source("env-a", { 0: four }),
          source("env-b", {}, [], { error: "offline", reconnects: true }),
        ),
        readAgainTwo,
      ),
      // env-b's first answer waits while env-a is read again, or env-a's chats would drop.
      keepsShownChats(at(byCost, source("env-a", { 0: four }), source("env-b", {})), readAgainTwo),
      // env-b failed and is asked again, so its note stays until it answers.
      keepsShownChats(
        at(byCost, source("env-a", { 0: four }), source("env-b", { 0: "boom" })),
        at(byCost, source("env-a", { 0: four }), source("env-b", { 0: { again: "boom" } })),
      ),
    ]).toEqual([true, false, true, false, true, false, false, false, false, true, true]);
  });

  it("keeps an answered chat page complete during a notice-driven reload", () => {
    const refreshing = at(byCost, source("env-a", { 0: { again: four } }));
    expect(presentMonitoringChats(shown, refreshing)).toMatchObject({
      updating: true,
      view: { stale: false, waiting: [], complete: true, chats: shown.view.chats },
    });
  });

  it("releases previous period and filter rows when the new request finishes with a failure", () => {
    const previous = at(byCost, source("env-a", { 0: four }), source("env-b", { 0: two }));
    const newChat = answer([[chat("new"), 1]]);
    const fail = source("env-b", { 0: "offline" });
    const earlier = { ...byCost, window: { ...byCost.window, since: "2026-10-01T00:00:00.000Z" } };
    const filtered = { ...byCost, filters: { kind: "interactive" as const } };
    for (const request of [earlier, filtered]) {
      expect(keepsShownChats(previous, at(request, source("env-a", {}), fail))).toBe(true);
      const loaded = at(request, source("env-a", { 0: newChat }), fail);
      expect(presentMonitoringChats(previous, loaded)).toMatchObject({
        keep: false,
        view: { chats: loaded.view.chats, unreadable: loaded.view.unreadable },
      });
    }
  });

  it("merges current rows with only the failed environment's previous pages", () => {
    const request = chatsRequest({ limit: 4 }, 4);
    const b = answer([
      [chat("b1"), 11],
      [chat("b2"), 2],
    ]);
    const initial = mergeMonitoringChats(
      [source("env-a", { 0: four }), source("env-b", { 0: b })],
      request,
    );
    const offline = source("env-b", {}, [], { error: "offline", reconnects: true });
    let view = initial;
    for (const [current, ids] of [
      [two, ["env-b:b1", "env-a:a", "env-b:b2", "env-a:b"]],
      [answer([]), ["env-b:b1", "env-b:b2"]],
      [answer([[chat("a-new"), 12]]), ["env-a:a-new", "env-b:b1", "env-b:b2"]],
    ] as const) {
      view = mergeMonitoringChats([source("env-a", { 0: current }), offline], request, view);
      expect(view.chats.map(monitoringChatKey)).toEqual(ids);
      expect(view).toMatchObject({
        stale: true,
        complete: false,
        unreadable: [{ environmentId: "env-b" }],
      });
    }
  });

  it("releases the previous filter when its requested pages settle while another environment reconnects", () => {
    const previous = at(byCost, source("env-a", { 0: four }), source("env-b", { 0: two }));
    const request = { ...byCost, filters: { kind: "interactive" as const } };
    const reconnecting = source("env-b", {}, [], { error: null, reconnects: true });
    const loaded = at(request, source("env-a", { 0: answer([[chat("new"), 1]]) }), reconnecting);
    expect(presentMonitoringChats(previous, loaded)).toMatchObject({
      keep: false,
      view: { chats: loaded.view.chats, waiting: [{ environmentId: "env-b" }], complete: false },
    });
  });

  it("retains rows when a project narrows the sources but releases them when an environment is removed", () => {
    const a = source("env-a", { 0: four });
    const b = source("env-b", { 0: two });
    const previous = at(byCost, a, b);
    const request = { ...byCost, filters: { projectKey: "env-a:p1" } };
    const pending = source("env-a", {});
    const narrowedTo = (target: MonitoringChatsSource) => ({
      request,
      view: mergeMonitoringChats([target], request, undefined, [
        a.environment.environmentId,
        b.environment.environmentId,
      ]),
    });
    for (const target of [pending, source("env-a", {}, [], { error: null, reconnects: true })]) {
      expect(presentMonitoringChats(previous, narrowedTo(target))).toMatchObject({
        keep: true,
        view: {
          chats: previous.view.chats,
          stale: true,
          isLoading: false,
          complete: false,
          waiting: [{ environmentId: "env-a" }],
        },
      });
    }
    expect(presentMonitoringChats(previous, narrowedTo(a)).keep).toBe(false);
    expect(keepsShownChats(previous, at(request, pending))).toBe(false);
  });

  it("marks cached rows until the replacement session answers and keeps ordinary refetches quiet", () => {
    const a = source("env-a", { 0: answer([[chat("a"), 2]]) });
    const oldB = answer([[chat("old-b"), 1]]);
    const b = source("env-b", { 0: oldB });
    const ready = mergeMonitoringChats([a, b], byCost);
    const pending = source("env-b", { 0: { again: oldB } });
    const quiet = mergeMonitoringChats([a, pending], byCost, ready);
    expect(quiet).toMatchObject({ chats: ready.chats, stale: false, complete: true, waiting: [] });

    const disconnected = mergeMonitoringChats(
      [a, source("env-b", {}, [], { error: null, reconnects: true })],
      byCost,
      ready,
    );
    const replacing = mergeMonitoringChats([a, pending], byCost, disconnected);
    expect(replacing).toMatchObject({
      chats: ready.chats,
      stale: true,
      complete: false,
      waiting: [{ environmentId: "env-b" }],
    });
    const replacement = source("env-b", { 0: answer([[chat("new-b"), 1]]) });
    const recovered = mergeMonitoringChats([a, replacement], byCost, replacing);
    expect(recovered.chats.map(monitoringChatKey)).toEqual(["env-a:a", "env-b:new-b"]);
    expect(recovered).toMatchObject({ stale: false, complete: true, waiting: [] });
  });

  it("keeps each pending environment's coherent pages when another refresh fails first", () => {
    const previous = at(byCost, source("env-a", { 0: two }), source("env-b", { 0: four }));
    const view = mergeMonitoringChats(
      [source("env-a", { 0: { again: two } }), source("env-b", { 0: "offline" })],
      byCost,
      previous.view,
    );
    expect(view.chats).toEqual(previous.view.chats);
    expect(view).toMatchObject({
      awaitingPage: true,
      unreadable: [{ environmentId: "env-b", error: "offline" }],
    });
  });

  it("shows a new order once it has as many chats, though an environment still loads", () => {
    const both = at(byCost, source("env-a", { 0: two }), source("env-b", { 0: two }));
    const next = at(ascending, source("env-a", { 0: four }), source("env-b", {}));
    expect([next.view.awaitingPage, keepsShownChats(both, next)]).toEqual([true, false]);
  });

  it("keeps the chats on screen while a later answer to the same request needs another page", () => {
    const request = chatsRequest({ limit: 4 }, 2);
    const a = {
      0: answer(
        [
          [chat("a"), 4],
          [chat("b"), 3],
        ],
        4,
      ),
      2: answer(
        [
          [chat("c"), 2],
          [chat("d"), 1],
        ],
        4,
      ),
    };
    const b = answer(
      [
        [chat("e"), 10],
        [chat("f"), 9],
      ],
      4,
    );
    const loading = at(request, source("env-a", a), source("env-b", { 0: b }));
    const loaded = at(
      request,
      source("env-a", a),
      source("env-b", {
        0: b,
        2: answer(
          [
            [chat("g"), 8],
            [chat("h"), 7],
          ],
          4,
        ),
      }),
    );
    const before = at(request, source("env-a", a), source("env-b", {}));
    // Its first page answering again does not undo the failure of a later one still asked again.
    const failing = at(request, source("env-a", { 0: a[0], 2: "boom" }));
    expect([
      before.view.chats.length,
      keepsShownChats(before, loading),
      keepsShownChats(before, loaded),
      keepsShownChats(failing, at(request, source("env-a", { 0: a[0], 2: { again: "boom" } }))),
    ]).toEqual([4, true, false, true]);
  });

  it("names a new, changed or cleared failure at once and keeps one asked again until more chats show", () => {
    const both = (a: MonitoringChatsResult | string) =>
      at(byCost, source("env-a", { 0: a }), source("env-b", { 0: two }));
    const next = at(ascending, source("env-a", { 0: "boom" }), source("env-b", {}));
    const unready = (error: string, reconnects: boolean) =>
      source("env-a", {}, [], { error, reconnects });
    const offline = at(byCost, unready("Offline", true), source("env-b", { 0: four }));
    const readAgain = (a: MonitoringChatsSource) =>
      at(byCost, a, source("env-b", { 0: { again: four } }));
    const failedWhileBLoads = at(byCost, source("env-a", { 0: "boom" }), source("env-b", {}));
    const askedAgain = (b: Record<number, SourcePage>) =>
      at(byCost, source("env-a", { 0: { again: "boom" } }), source("env-b", b));
    const offlineAndFailed = at(byCost, unready("Offline", true), source("env-b", { 0: "boom" }));
    const connecting = source("env-a", {}, [], { error: null, reconnects: false });
    expect([
      keepsShownChats(both(two), next),
      keepsShownChats(both("boom"), next),
      keepsShownChats(offline, readAgain(unready("Offline", true))),
      // A note held for an offline server would offer Retry, which cannot reach one too old to page.
      keepsShownChats(offline, readAgain(unready("Too old", false))),
      keepsShownChats(failedWhileBLoads, askedAgain({})),
      keepsShownChats(failedWhileBLoads, askedAgain({ 0: two })),
      // Another order is another list, so its rows are news even while the failure is asked again.
      keepsShownChats(
        both("boom"),
        at(ascending, source("env-a", { 0: { again: "boom" } }), source("env-b", { 0: two })),
      ),
      keepsShownChats(
        offlineAndFailed,
        at(byCost, connecting, source("env-b", { 0: { again: "boom" } })),
      ),
    ]).toEqual([false, true, true, false, true, false, false, false]);
  });

  it("keeps rows during reconnect only for the same set of environments", () => {
    const next = at(
      ascending,
      source("env-a", { 0: two }),
      source("env-b", {}, [], { error: null, reconnects: true }),
    );
    expect(keepsShownChats(shown, next)).toBe(false);
  });
});
