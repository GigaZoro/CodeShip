import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
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
