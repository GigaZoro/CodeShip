import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isKeptUsage,
  settleUsageSnapshot,
  usageEnvironmentProgress,
  usageGaps,
  usageNotices,
  usageProgress,
  type EnvironmentUsageStatus,
} from "./usageProgress.ts";

function summary(refreshing: readonly UsageProviderKind[] = []): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-05T12:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-05"),
    untilDay: UsageDay.make("2026-09-05"),
    buckets: [],
    sources: (["codex", ...refreshing] as const).map((provider) => ({
      fingerprint: { hostId: "host", provider, resolvedHomePath: "/home", volumeId: "1:1" },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
      ...(provider === "codex" ? {} : { refreshing: true as const }),
    })),
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

function environment(
  label: string,
  overrides: Partial<{
    isConnected: boolean;
    isPending: boolean;
    error: string | null;
    summary: UsageSummary | null;
  }> = {},
) {
  return {
    label,
    isConnected: true,
    isPending: false,
    error: null as string | null,
    summary: summary(),
    ...overrides,
  };
}

const options = { providerLabel: (provider: UsageProviderKind) => `${provider} label` };

describe("usageProgress", () => {
  it("names the environments that are still updating", () => {
    const waiting = [environment("a", { isPending: true }), environment("b", { isPending: true })];
    expect(usageProgress(waiting, options)).toEqual({
      announcement: null,
      label: "Updating 2 environments…",
    });
    expect(
      usageProgress([environment("a"), ...waiting.slice(1), environment("c")], options),
    ).toEqual({ announcement: null, label: "Updating b…" });
    expect(
      usageProgress(
        [environment("a"), environment("b", { summary: null, isPending: true })],
        options,
      ),
    ).toEqual({ announcement: null, label: "Updating b…" });
  });

  it("names a slow source once its environment answers from cache", () => {
    const partway = environment("a", { isPending: true, summary: summary(["cursor"]) });
    expect(usageEnvironmentProgress(partway)).toEqual({ phase: "partway", providers: ["cursor"] });
    expect(usageProgress([partway, environment("b")], options)).toEqual({
      announcement: null,
      label: "Updating cursor label…",
    });
    expect(
      usageProgress(
        [partway, environment("b", { isPending: true, summary: summary(["cursor", "grok"]) })],
        options,
      ),
    ).toEqual({ announcement: null, label: "Updating 2 providers…" });
    expect(usageProgress([{ ...partway, isPending: false }], options)).toEqual({
      announcement: null,
      label: null,
    });
  });

  it("ignores reconnecting and failed environments", () => {
    const ignored = [
      environment("reconnecting", { isPending: true, isConnected: false }),
      environment("failed", { error: "Offline", summary: null }),
    ];
    expect(usageProgress([environment("a"), ...ignored], options)).toEqual({
      announcement: null,
      label: null,
    });
    expect(
      usageProgress(
        [environment("a"), ...ignored, environment("slow", { summary: null, isPending: true })],
        options,
      ),
    ).toEqual({ announcement: null, label: "Updating slow…" });
    expect(usageEnvironmentProgress(ignored[0]!)).toEqual({ phase: "inactive" });
  });
});

describe("settleUsageSnapshot", () => {
  it.each([
    ["all-failed", [status("Failed", { summary: null, error: "Scan failed." })]],
    [
      "all-offline",
      [status("Offline", { summary: null, isConnected: false, canReadDiagnostics: false })],
    ],
    ["mixed", [status("Ready"), status("Failed", { summary: null, error: "Scan failed." })]],
    ["answered", [status("Ready")]],
  ] as const)("reuses the settled snapshot for %s selections", (_kind, selected) => {
    const window = summary();
    const first = settleUsageSnapshot(null, window, selected, selected);
    expect(first).not.toBeNull();
    const cloned = selected.map((entry) => ({ ...entry }));
    expect(settleUsageSnapshot(first, window, cloned, cloned)).toBe(first);
  });

  it("shows the newly selected period's cached answer while it refreshes", () => {
    const currentSummary = summary();
    const cachedSummary = { ...currentSummary, sinceDay: UsageDay.make("2026-08-07") };
    const current = {
      ...environment("a", { summary: currentSummary }),
      environmentId: EnvironmentId.make("a"),
      canReadDiagnostics: true,
      needsCursorKeychainAccess: false,
    };
    const previous = settleUsageSnapshot(null, currentSummary, [current], [current]);
    const cached = { ...current, summary: cachedSummary, isPending: true };

    const shown = settleUsageSnapshot(previous, cachedSummary, [cached], [cached]);

    expect(shown?.window.sinceDay).toBe(cachedSummary.sinceDay);
    expect(settleUsageSnapshot(shown, cachedSummary, [cached], [cached])).toBe(shown);
  });

  it("keeps the current week's figures across midnight until the new request settles", () => {
    const previousWindow = {
      ...summary(),
      sinceDay: UsageDay.make("2026-08-30"),
      resolution: "day",
    } as const;
    const nextWindow = {
      ...previousWindow,
      sinceDay: UsageDay.make("2026-08-31"),
      untilDay: UsageDay.make("2026-09-06"),
    };
    const previous = status("Desk", { summary: previousWindow });
    const shown = settleUsageSnapshot(null, previousWindow, [previous], [previous]);
    const partial = status("Desk", {
      summary: { ...nextWindow, sources: summary(["cursor"]).sources },
      isPending: true,
    });
    const waiting = settleUsageSnapshot(shown, nextWindow, [partial], [partial]);
    expect(waiting?.merged).toBe(shown?.merged);
    expect(isKeptUsage(waiting, nextWindow, [partial])).toBe(false);
    expect(waiting?.window.untilDay).toBe(previousWindow.untilDay);

    const settled = status("Desk", { summary: nextWindow });
    const updated = settleUsageSnapshot(waiting, nextWindow, [settled], [settled]);
    expect(updated?.window.untilDay).toBe(nextWindow.untilDay);
    expect(isKeptUsage(updated, nextWindow, [settled])).toBe(false);
  });
});

function status(
  label: string,
  overrides: Partial<EnvironmentUsageStatus> = {},
): EnvironmentUsageStatus {
  return {
    ...environment(label),
    environmentId: EnvironmentId.make(label.toLowerCase()),
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    ...overrides,
  };
}

it("settles connected usage when another selected environment is still connecting", () => {
  const ready = status("Ready");
  const connecting = status("Connecting", {
    canReadDiagnostics: false,
    isConnected: false,
    isPending: true,
    summary: null,
  });
  const selected = [ready, connecting];

  const shown = settleUsageSnapshot(null, summary(), selected, selected);

  expect(shown?.environments).toEqual(selected);
  expect(usageGaps(shown?.environments ?? [], [])?.title).toBe("Totals leave out Connecting");
});

it("marks the previous totals as kept while a model filter changes the request", () => {
  const window = summary();
  const original = status("Desk", {
    summary: {
      ...window,
      buckets: [
        {
          day: window.sinceDay,
          provider: "codex",
          model: "included",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd: 0,
          cacheSavingsUsd: 0,
          costSource: "unpriced",
          records: 1,
          unpricedRecords: 1,
          sessions: 1,
        },
      ],
    },
  });
  const previous = settleUsageSnapshot(null, window, [original], [original]);
  const pending = {
    ...original,
    modelFilter: { exclude: [{ model: "included" }] },
    summary: null,
    isPending: true,
  };
  const kept = settleUsageSnapshot(previous, window, [pending], [pending]);

  expect(kept?.merged.totalTokens).toBe(100);
  expect(isKeptUsage(kept, window, [pending])).toBe(true);

  const answered = { ...pending, summary: window, isPending: false };
  const shown = settleUsageSnapshot(kept, window, [answered], [answered]);

  expect(shown?.merged.totalTokens).toBe(0);
  expect(isKeptUsage(shown, window, [answered])).toBe(false);
});

it("names missing and saved environments in a mixed usage result", () => {
  const notice = usageGaps(
    [
      status("Ready"),
      status("Missing", { error: "Scan failed.", summary: null }),
      status("Saved", { error: "Scan failed." }),
    ],
    [],
  );

  expect(notice?.title).toBe("Totals leave out Missing");
  expect(notice?.gaps.map(({ message }) => message)).toEqual([
    "Missing: Scan failed.",
    "Saved: Scan failed. Showing its last values.",
  ]);
});

it("keeps two consecutive background refetches quiet and announces a manual refresh", () => {
  const ready = environment("Desk");
  const refetching = { ...ready, isPending: true };
  const progress = [ready, refetching, ready, refetching, ready].map((entry) =>
    usageProgress([entry], options),
  );

  expect(progress.map(({ label }) => label)).toEqual([null, "Updating…", null, "Updating…", null]);
  expect(progress.map(({ announcement }) => announcement)).toEqual([null, null, null, null, null]);
  expect(usageProgress([refetching], { ...options, refreshing: true }).announcement).toBe(
    "Updating…",
  );
});

it("never retains an incompatible answer as figures for another selection", () => {
  const window = summary();
  const older = status("Old", {
    summary: { ...window, contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1 },
  });
  const pending = status("Waiting", { summary: null, isPending: true });
  const prior = settleUsageSnapshot(null, window, [older, pending], [older]);

  expect(prior?.merged.contractMismatches).toHaveLength(1);
  expect(prior?.hasAnswer).toBe(false);
  expect(settleUsageSnapshot(prior, window, [older, pending], [pending])).toBeNull();
});

it("shows the first answer and preserves the slow provider row when it settles empty", () => {
  const first = summary(["cursor"]);
  const provisional = status("Desk", { summary: first, isPending: true });
  const fresh = status("Desk", { summary: summary() });
  const oldWindow = { ...first, sinceDay: UsageDay.make("2026-08-07") };
  const old = settleUsageSnapshot(null, oldWindow, [fresh], [fresh]);

  for (const previous of [null, old]) {
    const shown = settleUsageSnapshot(previous, first, [provisional], [provisional]);
    expect(shown?.window.sinceDay).toBe(first.sinceDay);
    expect(shown?.providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);

    const finished = settleUsageSnapshot(shown, first, [fresh], [fresh]);
    expect(finished?.providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);
    expect(finished?.providers.find(({ provider }) => provider === "cursor")?.sessions).toBe(0);

    expect(settleUsageSnapshot(finished, first, [provisional], [provisional])).toBe(finished);
  }
});

it("reports a live partial failure while keeping same-window figures", () => {
  const window = summary();
  const a = status("Desk");
  const b = status("Laptop");
  const previous = settleUsageSnapshot(null, window, [a, b], [a, b]);
  const live = [
    { ...a, isPending: true },
    { ...b, summary: null, error: "Read failed." },
  ];
  const shown = settleUsageSnapshot(previous, window, live, live);
  expect(shown).toBe(previous);
  const notices = usageNotices(live, shown!.environments).coverage;
  expect(notices?.title).toBe("Some totals may be out of date");
  expect(notices?.gaps.map(({ message }) => message)).toEqual([
    "Laptop: Read failed. Showing its last values.",
  ]);
});

it("publishes the first compatible environment on a cold load and names the one still scanning", () => {
  const window = summary();
  const desk = status("Desk");
  const laptop = status("Laptop", { summary: null, isPending: true });
  const selected = [desk, laptop];
  const shown = settleUsageSnapshot(null, window, selected, selected);
  expect(shown?.hasAnswer).toBe(true);
  expect(shown?.settled).toBe(false);
  expect(usageProgress(selected, options).label).toBe("Updating Laptop…");
});

it("reserves a slow provider's row through a settled snapshot's background refresh", () => {
  const window = summary();
  const ready = status("Desk", { summary: summary(["cursor"]) });
  const previous = settleUsageSnapshot(null, window, [ready], [ready]);
  const fetching = { ...ready, isPending: true };
  const kept = settleUsageSnapshot(previous, window, [fetching], [fetching]);
  expect(kept?.merged).toBe(previous?.merged);
  expect(kept?.providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);
  const finished = status("Desk");
  const shown = settleUsageSnapshot(kept, window, [finished], [finished]);
  expect(shown?.providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);
});

it("uses live compatibility and source notices while keeping saved figures", () => {
  const window = summary();
  const desk = status("Desk");
  const laptop = status("Laptop");
  const prior = settleUsageSnapshot(null, window, [desk, laptop], [desk, laptop]);
  const pending = { ...desk, isPending: true };
  const incompatible = { ...laptop, summary: { ...window, contractVersion: 0 } };
  const selected = [pending, incompatible];
  const shown = settleUsageSnapshot(prior, window, selected, selected);
  expect(shown).toBe(prior);
  const notices = usageNotices(selected, shown!.environments);
  expect(notices.contractMismatches.map(({ environmentId }) => environmentId)).toEqual([
    laptop.environmentId,
  ]);
  expect(notices.coverage?.gaps[0]).toMatchObject({
    excluded: false,
    message: "Laptop runs an older server version. Showing its last compatible values.",
  });

  const source = {
    ...summary(["cursor"]).sources[1]!,
    status: "partial" as const,
    message: "Cursor fetch failed",
  };
  const duringTrouble = [pending, { ...laptop, summary: { ...window, sources: [source] } }];
  expect(usageNotices(duringTrouble, shown!.environments).sourceMessages).toEqual([
    "Cursor fetch failed",
  ]);
  expect(
    usageNotices(duringTrouble, shown!.environments, new Set(["cursor"])).sourceMessages,
  ).toEqual([]);
});
