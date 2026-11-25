import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageDay,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { usageWindowLabel } from "@t3tools/shared/usageFormat";
import { usageScanSettingsKey } from "@t3tools/shared/usageScanSettings";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { usageProgress, type EnvironmentUsageStatus } from "./usageProgress.ts";
import {
  initialUsageViewState,
  retainedUsageLabel,
  settleUsageView,
  usageNotices,
  type UsageFigures,
  type UsageViewState,
} from "./usageView.ts";

const HOUR_MS = 3_600_000;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function hourly(untilTime: string): UsageSummaryInput {
  const until = Date.parse(untilTime);
  const since = iso(until - 24 * HOUR_MS);
  return {
    sinceDay: UsageDay.make(since.slice(0, 10)),
    untilDay: UsageDay.make(untilTime.slice(0, 10)),
    timeZone: "UTC",
    resolution: "hour",
    sinceTime: since,
    untilTime: iso(until),
  };
}

function daily(days: number, untilDay: string): UsageSummaryInput {
  const since = Date.parse(`${untilDay}T00:00:00Z`) - (days - 1) * 24 * HOUR_MS;
  return {
    sinceDay: UsageDay.make(iso(since).slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone: "UTC",
    resolution: "day",
  };
}

const tick = hourly("2026-09-05T12:00:00Z");
const next = hourly("2026-09-05T12:01:00Z");
const later = hourly("2026-09-05T12:02:00Z");

function summary({
  tokens = 0,
  provider = "codex",
  host = "host",
  refreshing = [],
  sources,
  contractVersion = USAGE_CONTRACT_VERSION,
}: {
  readonly tokens?: number;
  readonly provider?: UsageProviderKind;
  readonly host?: string;
  readonly refreshing?: readonly UsageProviderKind[];
  readonly sources?: UsageSummary["sources"];
  readonly contractVersion?: number;
} = {}): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-09-05T12:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-05"),
    untilDay: UsageDay.make("2026-09-05"),
    buckets:
      tokens === 0
        ? []
        : [
            {
              day: UsageDay.make("2026-09-05"),
              provider,
              model: "model",
              totals: {
                uncachedInputTokens: tokens,
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
    sources:
      sources ??
      [provider, ...refreshing].map((source) => ({
        fingerprint: {
          hostId: host,
          provider: source,
          resolvedHomePath: "/home",
          volumeId: "1:1",
        },
        status: "ok" as const,
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
        ...(refreshing.includes(source) ? { refreshing: true as const } : {}),
      })),
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

const id = (label: string) => EnvironmentId.make(label.toLowerCase());

function status(
  label: string,
  overrides: Partial<EnvironmentUsageStatus> = {},
): EnvironmentUsageStatus {
  return {
    label,
    environmentId: id(label),
    isConnected: true,
    isPending: false,
    error: null,
    summary: summary({ host: label }),
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    usageSettingsKey: "settings",
    ...overrides,
  };
}

const answered = (label: string, tokens: number, overrides: Partial<EnvironmentUsageStatus> = {}) =>
  status(label, { summary: summary({ tokens, host: label }), ...overrides });
const pending = (label: string, overrides: Partial<EnvironmentUsageStatus> = {}) =>
  status(label, { summary: null, isPending: true, ...overrides });
const failed = (label: string, error = `${label} scan failed.`) =>
  status(label, { summary: null, error });
const NO_ACCESS = "This connection does not have access to diagnostics and usage.";
const denied = (label: string) =>
  status(label, { summary: null, canReadDiagnostics: false, error: NO_ACCESS });

interface Step {
  readonly window: UsageSummaryInput;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selected?: readonly string[] | null;
  readonly hidden?: readonly UsageProviderKind[];
  readonly enabled?: boolean;
}

function settle(state: UsageViewState, step: Step): UsageViewState {
  const selected = step.selected ?? null;
  return settleUsageView(state, {
    window: step.window,
    environments: step.environments,
    selectedIds: selected === null ? null : new Set(selected.map(id)),
    hidden: step.hidden ?? [],
    enabled: step.enabled ?? true,
  });
}

const run = (steps: readonly Step[], from = initialUsageViewState) => steps.reduce(settle, from);

function figures(state: UsageViewState): UsageFigures {
  if (state.view.kind !== "figures") throw new Error(`expected figures, got ${state.view.kind}`);
  return state.view;
}

const shown = (state: UsageViewState) => {
  const view = figures(state);
  return {
    environments: view.environments.map(({ label }) => label),
    tokens: view.merged.totalTokens,
    window: view.window,
    kept: view.kept,
  };
};

function gaps(state: UsageViewState, step: Step) {
  const selected = step.selected ?? null;
  const live =
    selected === null
      ? step.environments
      : step.environments.filter(({ label }) => selected.includes(label));
  return usageNotices(state, live, step.window).coverage;
}

const messages = (state: UsageViewState, step: Step) =>
  gaps(state, step)?.gaps.map(({ message }) => message) ?? [];

function orderings<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("settleUsageView after both 12:01 scans fail", () => {
  type Event = "select" | "deselect" | "deskFails" | "laptopFails" | "revoke" | "regrant";
  const desk = answered("Desk", 100);
  const laptop = answered("Laptop", 200);
  const start = run([
    { window: tick, environments: [desk, laptop], selected: ["Desk"] },
    { window: next, environments: [pending("Desk"), pending("Laptop")], selected: ["Desk"] },
  ]);

  function replay(order: readonly Event[]) {
    const world = { selected: false, deskFailed: false, laptopFailed: false, granted: true };
    let state = start;
    let step: Step = { window: next, environments: [] };
    for (const event of order) {
      if (event === "select") world.selected = true;
      if (event === "deselect") world.selected = false;
      if (event === "deskFails") world.deskFailed = true;
      if (event === "laptopFails") world.laptopFailed = true;
      if (event === "revoke") world.granted = false;
      if (event === "regrant") world.granted = true;
      step = {
        window: next,
        environments: [
          world.deskFailed ? failed("Desk") : pending("Desk"),
          !world.granted
            ? denied("Laptop")
            : world.laptopFailed
              ? failed("Laptop")
              : pending("Laptop"),
        ],
        selected: world.selected ? ["Desk", "Laptop"] : ["Desk"],
      };
      state = settle(state, step);
    }
    return {
      final: JSON.stringify(world),
      result: { view: state.view, coverage: gaps(state, step) },
    };
  }

  function byFinalState(events: readonly Event[]) {
    const groups = new Map<string, ReturnType<typeof replay>["result"][]>();
    for (const order of orderings(events)) {
      const { final, result } = replay(order);
      groups.set(final, [...(groups.get(final) ?? []), result]);
    }
    return groups;
  }

  it("shows 300 at 12:00 with the kept label in every order of failures and selections", () => {
    const groups = byFinalState(["select", "deselect", "deskFails", "laptopFails"]);
    const both = [...groups].find(([final]) => JSON.parse(final).selected)![1];

    expect(both).toHaveLength(12);
    for (const result of both) expect(result).toEqual(both[0]);
    const view = both[0]!.view as UsageFigures;
    expect(view.merged.totalTokens).toBe(300);
    expect(view.window).toEqual(tick);
    expect(view.kept).toBe(true);
    expect(retainedUsageLabel(view)).toBe(
      `Showing previous usage for Desk, Laptop · ${usageWindowLabel(tick)}`,
    );
    for (const [final, results] of groups) {
      for (const result of results) expect(result).toEqual(results[0]);
      if (!JSON.parse(final).selected) {
        expect((results[0]!.view as UsageFigures).merged.totalTokens).toBe(100);
      }
    }
  });

  it("reaches one view for every ordering that ends in the same statuses and selection", () => {
    const groups = byFinalState([
      "select",
      "deselect",
      "deskFails",
      "laptopFails",
      "revoke",
      "regrant",
    ]);

    expect([...groups.values()].map((results) => results.length)).toEqual([180, 180, 180, 180]);
    for (const [final, results] of groups) {
      for (const result of results) expect(result).toEqual(results[0]);
      const { selected, granted } = JSON.parse(final);
      const view = results[0]!.view as UsageFigures;
      expect(view.environments.map(({ label }) => label)).toEqual(["Desk"]);
      expect(view.merged.totalTokens).toBe(100);
      expect(view.kept).toBe(true);
      const failedAt = usageWindowLabel(next);
      const deskGap = `Desk (${failedAt}): Desk scan failed. Showing its last values.`;
      expect(results[0]!.coverage?.gaps.map(({ message }) => message)).toEqual(
        !selected
          ? [deskGap]
          : [
              deskGap,
              granted ? `Laptop (${failedAt}): Laptop scan failed.` : `Laptop: ${NO_ACCESS}`,
            ],
      );
    }
  });
});

describe("settleUsageView choosing the shown key", () => {
  const desk = answered("Desk", 100);
  const laptop = answered("Laptop", 200);
  const atTick: Step = { window: tick, environments: [desk, laptop] };

  it("holds both at 12:00 while Laptop is pending, then follows Laptop's answer or failure", () => {
    const waiting: Step = {
      window: next,
      environments: [answered("Desk", 110), pending("Laptop")],
    };
    const held = run([atTick, waiting]);

    expect(shown(held)).toEqual({
      environments: ["Desk", "Laptop"],
      tokens: 300,
      window: tick,
      kept: false,
    });

    const both = settle(held, {
      window: next,
      environments: [waiting.environments[0]!, answered("Laptop", 210)],
    });
    expect(shown(both)).toEqual({
      environments: ["Desk", "Laptop"],
      tokens: 320,
      window: next,
      kept: false,
    });

    const lost: Step = { window: next, environments: [waiting.environments[0]!, failed("Laptop")] };
    const alone = settle(held, lost);
    expect(shown(alone)).toEqual({
      environments: ["Desk"],
      tokens: 110,
      window: next,
      kept: false,
    });
    expect(gaps(alone, lost)).toMatchObject({
      title: "Totals leave out Laptop",
      gaps: [{ message: "Laptop: Laptop scan failed.", excluded: true, retryable: true }],
    });
  });

  it("keeps the labelled 7-day view through a 30-day switch until Laptop's 30-day scan fails", () => {
    const week = daily(7, "2026-09-05");
    const month = daily(30, "2026-09-05");
    const switching = run([
      { window: week, environments: [desk, laptop] },
      { window: month, environments: [pending("Desk"), pending("Laptop")] },
    ]);
    expect(shown(switching)).toEqual({
      environments: ["Desk", "Laptop"],
      tokens: 300,
      window: week,
      kept: true,
    });

    const deskMonth = answered("Desk", 130);
    const halfway = settle(switching, {
      window: month,
      environments: [deskMonth, pending("Laptop")],
    });
    expect(shown(halfway)).toEqual({
      environments: ["Desk", "Laptop"],
      tokens: 300,
      window: week,
      kept: true,
    });

    const lost: Step = { window: month, environments: [deskMonth, failed("Laptop")] };
    const monthly = settle(halfway, lost);
    expect(shown(monthly)).toEqual({
      environments: ["Desk"],
      tokens: 130,
      window: month,
      kept: false,
    });
    expect(messages(monthly, lost)).toEqual(["Laptop: Laptop scan failed."]);
  });

  describe("returning to a request it already holds", () => {
    const week = daily(7, "2026-09-05");
    const month = daily(30, "2026-09-05");
    const atMonth: Step = {
      window: month,
      environments: [answered("Desk", 130), answered("Laptop", 230)],
    };
    const monthly = run([
      { window: week, environments: [desk, laptop] },
      { window: month, environments: [pending("Desk"), pending("Laptop")] },
      atMonth,
    ]);

    it("shows the 7-day figures again from the cached answers after a 30-day visit", () => {
      expect(shown(monthly)).toMatchObject({ tokens: 360, window: month, kept: false });
      const back = settle(monthly, { window: week, environments: [desk, laptop] });
      expect(shown(back)).toEqual({
        environments: ["Desk", "Laptop"],
        tokens: 300,
        window: week,
        kept: false,
      });
      expect(figures(back).settled).toBe(true);
    });

    it("shows the cached 7-day figures while they refresh", () => {
      const refreshing = settle(monthly, {
        window: week,
        environments: [
          status("Desk", { summary: desk.summary, isPending: true }),
          status("Laptop", { summary: laptop.summary, isPending: true }),
        ],
      });
      expect(shown(refreshing)).toEqual({
        environments: ["Desk", "Laptop"],
        tokens: 300,
        window: week,
        kept: false,
      });
      expect(figures(refreshing).settled).toBe(false);
    });

    it("shows a provider again after it is hidden and shown", () => {
      const hidden = settle(monthly, { ...atMonth, hidden: ["codex"] });
      expect(figures(hidden).hiddenProviders).toEqual(new Set(["codex"]));
      expect(figures(hidden).merged.totalTokens).toBe(0);
      const visible = settle(hidden, atMonth);
      expect(figures(visible).hiddenProviders).toEqual(new Set());
      expect(shown(visible)).toEqual({
        environments: ["Desk", "Laptop"],
        tokens: 360,
        window: month,
        kept: false,
      });
    });
  });

  it("keeps Desk's figures as its last values while it reconnects", () => {
    const reconnecting = (summary: UsageSummary | null) =>
      status("Desk", { isConnected: false, isPending: true, summary });
    const aloneStep: Step = { window: tick, environments: [reconnecting(desk.summary)] };
    const alone = run([{ window: tick, environments: [desk] }, aloneStep]);
    expect(shown(alone)).toEqual({
      environments: ["Desk"],
      tokens: 100,
      window: tick,
      kept: false,
    });
    expect(messages(alone, aloneStep)).toEqual([
      "Desk: This environment is not connected. Showing its last values.",
    ]);

    const common = run([
      atTick,
      { window: tick, environments: [reconnecting(desk.summary), laptop] },
      { window: next, environments: [reconnecting(null), answered("Laptop", 210)] },
    ]);
    expect(shown(common)).toEqual({
      environments: ["Desk", "Laptop"],
      tokens: 300,
      window: tick,
      kept: false,
    });

    const apartStep: Step = {
      window: later,
      environments: [reconnecting(null), answered("Laptop", 220)],
    };
    const apart = settle(common, apartStep);
    expect(
      apart.readings
        .get(id("Laptop"))
        ?.map(({ window }) => window.untilTime)
        .toSorted(),
    ).toEqual([next.untilTime, later.untilTime]);
    expect(shown(apart)).toEqual({
      environments: ["Laptop"],
      tokens: 220,
      window: later,
      kept: false,
    });
    expect(messages(apart, apartStep)).toEqual(["Desk: This environment is not connected."]);
  });

  it("shows Laptop's 200 alone after Desk loses access during a rolling refresh", () => {
    const desk = answered("Desk", 100, {
      summary: summary({ tokens: 100, provider: "cursor", host: "Desk" }),
    });
    const refresh = answered("Laptop", 250, { isPending: true });
    const kept = run([
      { window: tick, environments: [desk, laptop] },
      { window: next, environments: [pending("Desk"), refresh] },
      { window: next, environments: [denied("Desk"), refresh] },
    ]);
    expect(shown(kept)).toEqual({
      environments: ["Laptop"],
      tokens: 200,
      window: tick,
      kept: false,
    });
    expect(figures(kept).providers.map(({ provider }) => provider)).toEqual(["codex"]);

    const finished = settle(kept, {
      window: next,
      environments: [denied("Desk"), { ...refresh, isPending: false }],
    });
    expect(shown(finished)).toEqual({
      environments: ["Laptop"],
      tokens: 250,
      window: next,
      kept: false,
    });
    expect(
      settle(finished, { window: next, environments: [denied("Desk"), denied("Laptop")] }).view,
    ).toEqual({ kind: "none" });
  });

  it("never brings back Laptop's figures after a revoke, regrant and revoke", () => {
    const revoked: Step = { window: tick, environments: [desk, denied("Laptop")] };
    const regranted: Step = { window: tick, environments: [desk, laptop] };
    let state = run([atTick, revoked]);
    const afterRevoke = state.view;
    for (const step of [regranted, revoked, regranted]) {
      state = settle(state, step);
      expect(shown(state)).toEqual({
        environments: ["Desk"],
        tokens: 100,
        window: tick,
        kept: false,
      });
    }
    expect(state.view).toBe(afterRevoke);
    expect(retainedUsageLabel(figures(state))).toBe(
      `Showing previous usage for Desk · ${usageWindowLabel(tick)}`,
    );
    expect(gaps(state, regranted)?.gaps).toMatchObject([
      {
        message: "Laptop: Its access changed. Refresh to read its usage again.",
        excluded: true,
        retryable: true,
      },
    ]);
  });

  it("drops reservations on a second revocation while another read is pending", () => {
    const provisional = status("Laptop", {
      isPending: true,
      summary: summary({ host: "Laptop", refreshing: ["cursor"] }),
    });
    const state = run([
      atTick,
      ...[denied("Laptop"), provisional, denied("Laptop")].map((env) => ({
        window: tick,
        environments: [{ ...desk, isPending: true }, env],
      })),
    ]);
    expect(figures(state).merged.totalTokens).toBe(100);
    expect(figures(state).providers.map(({ provider }) => provider)).toEqual(["codex"]);
  });
});

describe("settleUsageView readings", () => {
  it("never lets a provisional answer replace a complete reading for the same request", () => {
    const desk = answered("Desk", 100);
    const complete = run([{ window: tick, environments: [desk] }]);
    const provisional = status("Desk", {
      isPending: true,
      summary: summary({ tokens: 40, host: "Desk", refreshing: ["cursor"] }),
    });

    const sameWindow = settle(complete, { window: tick, environments: [provisional] });
    expect(figures(sameWindow).environments[0]!.summary).toBe(desk.summary);
    expect(figures(sameWindow).providers).toEqual([
      ...figures(complete).providers,
      { provider: "cursor", totals: null },
    ]);

    const rolling = settle(sameWindow, { window: next, environments: [provisional] });
    expect(shown(rolling)).toEqual({
      environments: ["Desk"],
      tokens: 100,
      window: tick,
      kept: false,
    });

    const settled = settle(rolling, { window: next, environments: [answered("Desk", 120)] });
    expect(shown(settled)).toEqual({
      environments: ["Desk"],
      tokens: 120,
      window: next,
      kept: false,
    });
    expect(figures(settled).providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);
  });

  it("shows the first answer and keeps the slow provider's row when it settles empty", () => {
    const window = daily(7, "2026-09-05");
    const old = { window: daily(30, "2026-09-05"), environments: [answered("Desk", 10)] };
    const provisional = status("Desk", {
      isPending: true,
      summary: summary({ host: "Desk", refreshing: ["cursor"] }),
    });
    for (const from of [initialUsageViewState, run([old])]) {
      const first = settle(from, { window, environments: [provisional] });
      expect(figures(first).window).toEqual(window);
      expect(figures(first).providers.map(({ provider }) => provider)).toEqual(["codex", "cursor"]);

      const finished = settle(first, { window, environments: [status("Desk")] });
      expect(figures(finished).providers).toEqual([
        expect.objectContaining({ provider: "codex" }),
        { provider: "cursor", totals: null },
      ]);
      const again = settle(finished, { window, environments: [provisional] });
      expect(figures(again).environments[0]!.summary).toBe(
        figures(finished).environments[0]!.summary,
      );
    }
  });

  it("keeps a reserved provider owned by an authorized environment across the next refresh", () => {
    const laptop = status("Laptop", {
      isPending: true,
      summary: summary({ host: "Laptop", refreshing: ["cursor"] }),
    });
    const state = run([
      { window: tick, environments: [denied("Desk"), laptop] },
      { window: tick, environments: [denied("Desk"), status("Laptop")] },
      { window: next, environments: [denied("Desk"), pending("Laptop")] },
    ]);
    expect(figures(state).providers).toContainEqual({ provider: "cursor", totals: null });
  });

  it("keeps the current week's figures across midnight until the new request settles", () => {
    const thisWeek = daily(7, "2026-09-05");
    const nextWeek = daily(7, "2026-09-06");
    const before = run([{ window: thisWeek, environments: [answered("Desk", 100)] }]);
    const partial = status("Desk", {
      isPending: true,
      summary: summary({ tokens: 30, host: "Desk", refreshing: ["cursor"] }),
    });
    const waiting = settle(before, { window: nextWeek, environments: [partial] });
    expect(figures(waiting).environments[0]!.summary).toBe(
      figures(before).environments[0]!.summary,
    );
    expect(shown(waiting)).toMatchObject({ window: thisWeek, kept: false });

    const updated = settle(waiting, { window: nextWeek, environments: [answered("Desk", 90)] });
    expect(shown(updated)).toMatchObject({ tokens: 90, window: nextWeek, kept: false });
  });

  it("never keeps an incompatible answer as figures", () => {
    const old = status("Old", {
      summary: summary({ contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1 }),
    });
    const environments = [old, pending("Waiting")];
    const onlyOld = run([{ window: tick, environments, selected: ["Old"] }]);
    expect(onlyOld.view).toEqual({ kind: "none" });
    expect(usageNotices(onlyOld, [old], tick).contractMismatches).toHaveLength(1);
    expect(settle(onlyOld, { window: tick, environments, selected: ["Waiting"] }).view).toEqual({
      kind: "loading",
    });
  });

  it("publishes the first compatible environment on a cold load and names the one still scanning", () => {
    const selected = [answered("Desk", 100), pending("Laptop")];
    const state = run([{ window: tick, environments: selected }]);
    expect(shown(state).environments).toEqual(["Desk"]);
    expect(figures(state).settled).toBe(false);
    expect(usageProgress(selected, { providerLabel: (provider) => provider }).label).toBe(
      "Updating Laptop…",
    );
  });

  it("settles connected usage when another selected environment is still connecting", () => {
    const connecting = status("Connecting", {
      canReadDiagnostics: false,
      isConnected: false,
      isPending: true,
      summary: null,
    });
    const step: Step = { window: tick, environments: [answered("Ready", 100), connecting] };
    const state = run([step]);
    expect(figures(state).settled).toBe(true);
    expect(gaps(state, step)?.title).toBe("Totals leave out Connecting");
  });

  it("keeps reading while disabled only to drop an environment that loses access", () => {
    const both = run([
      { window: tick, environments: [answered("Desk", 100), answered("Laptop", 200)] },
    ]);
    const disabledEnvironments = [
      status("Desk", { summary: null }),
      status("Laptop", { summary: null }),
    ];
    const idle = settle(both, { window: tick, environments: disabledEnvironments, enabled: false });
    expect(idle).toBe(both);

    const revoked = settle(idle, {
      window: tick,
      environments: [disabledEnvironments[0]!, denied("Laptop")],
      enabled: false,
    });
    expect(shown(revoked).environments).toEqual(["Desk"]);
    const back = settle(revoked, {
      window: tick,
      environments: [
        answered("Desk", 100, { summary: both.readings.get(id("Desk"))![0]!.summary }),
        status("Laptop", { summary: both.readings.get(id("Laptop"))![0]!.summary }),
      ],
    });
    expect(shown(back)).toMatchObject({ environments: ["Desk"], tokens: 100 });
  });
});

describe("settleUsageView usage settings", () => {
  const before = DEFAULT_SERVER_SETTINGS;
  it.each([
    [
      "a price",
      {
        ...before,
        usagePriceOverrides: {
          model: { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      },
    ],
    ["a model alias", { ...before, usageModelAliases: { model: "gpt-5" } }],
    ["the model filter", { ...before, usageModelFilter: { exclude: [{ model: "model" }] } }],
    [
      "Cursor Keychain access",
      { ...before, cursorKeychainUsageEnabled: !before.cursorKeychainUsageEnabled },
    ],
    [
      "a provider's transcript home",
      {
        ...before,
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: "/accounts/work" },
          },
        },
      },
    ],
  ] as const)("drops every figure and failure read before changing %s", (_setting, after) => {
    const old = { usageSettingsKey: usageScanSettingsKey(before) };
    const changed = { usageSettingsKey: usageScanSettingsKey(after) };
    const saved = run([
      {
        window: tick,
        environments: [
          answered("Desk", 100, old),
          pending("Laptop", { ...old, summary: summary({ tokens: 30, refreshing: ["cursor"] }) }),
          { ...failed("Phone"), ...old },
        ],
      },
    ]);
    expect(shown(saved).environments).toEqual(["Desk", "Laptop"]);

    const reloading: Step = {
      window: tick,
      environments: ["Desk", "Laptop", "Phone"].map((label) => pending(label, changed)),
    };
    const state = settle(saved, reloading);
    expect(state.view).toEqual({ kind: "loading" });
    expect(gaps(state, reloading)).toBeNull();
    const idle = ["Desk", "Laptop", "Phone"].map((label) =>
      status(label, { ...changed, summary: null }),
    );
    expect(settle(saved, { window: tick, environments: idle, enabled: false }).view).toEqual({
      kind: "none",
    });
  });
});

describe("settleUsageView failures", () => {
  it("names the Sept 5 failure while the Sept 6 retry waits, and clears it on an answer or a period switch", () => {
    const sept5 = daily(7, "2026-09-05");
    const sept6 = daily(7, "2026-09-06");
    const failedStep: Step = { window: sept5, environments: [failed("Desk", "Read failed.")] };
    const retry: Step = { window: sept6, environments: [pending("Desk")] };
    const waiting = run([failedStep, retry]);

    expect(waiting.view).toEqual({ kind: "none" });
    expect(gaps(waiting, retry)?.gaps).toMatchObject([
      {
        message: `Desk (${usageWindowLabel(sept5)}): Read failed.`,
        excluded: true,
        retryable: true,
      },
    ]);
    expect(usageWindowLabel(sept5)).toContain("Sep 5");

    const answeredStep: Step = { window: sept6, environments: [answered("Desk", 100)] };
    expect(gaps(settle(waiting, answeredStep), answeredStep)).toBeNull();

    const month: Step = { window: daily(30, "2026-09-06"), environments: [pending("Desk")] };
    expect(gaps(settle(waiting, month), month)).toBeNull();
  });

  it("never shows a failure saved for one period after switching to another", () => {
    const week = daily(7, "2026-09-05");
    const month = daily(30, "2026-09-05");
    const laptop = answered("Laptop", 200);
    const weekly: Step = {
      window: week,
      environments: [failed("Desk", "Weekly scan failed"), laptop],
    };
    const monthly: Step = {
      window: month,
      environments: [pending("Desk"), pending("Laptop")],
    };
    const state = run([weekly, monthly]);
    expect(messages(state, monthly)).toEqual([]);
    expect(shown(state)).toMatchObject({ environments: ["Laptop"], window: week, kept: true });
  });

  it("keeps a current failure and its Retry while the retry is pending, and drops it when access is lost", () => {
    const failedStep: Step = {
      window: tick,
      environments: [failed("Desk", "Read failed"), answered("Laptop", 200)],
    };
    const retrying = { ...failedStep.environments[0]!, isPending: true };
    const alone: Step = {
      window: tick,
      environments: [retrying, failedStep.environments[1]!],
      selected: ["Desk"],
    };
    const state = run([failedStep, alone]);
    expect(gaps(state, alone)?.gaps).toMatchObject([
      { message: "Desk: Read failed", excluded: true, retryable: true },
    ]);

    const regranted: Step = {
      ...alone,
      environments: [pending("Desk"), failedStep.environments[1]!],
    };
    const back = run(
      [{ ...alone, environments: [denied("Desk"), failedStep.environments[1]!] }, regranted],
      state,
    );
    expect(gaps(back, regranted)).toBeNull();
  });

  it("removes the saved failure and Retry when a retry publishes new provisional figures", () => {
    const old = answered("Desk", 100);
    const failure = { ...old, error: "Read failed" };
    const waiting = { ...failure, isPending: true };
    const provisional = status("Desk", {
      isPending: true,
      summary: summary({ tokens: 100, host: "Desk", refreshing: ["cursor"] }),
    });
    const kept = run([
      { window: tick, environments: [failure] },
      { window: tick, environments: [waiting] },
    ]);
    expect(messages(kept, { window: tick, environments: [waiting] })).toEqual([
      "Desk: Read failed Showing its last values.",
    ]);
    const cleared = settle(kept, { window: tick, environments: [provisional] });
    expect(gaps(cleared, { window: tick, environments: [provisional] })).toBeNull();
  });

  it("names missing and saved environments in a mixed result", () => {
    const step: Step = {
      window: tick,
      environments: [
        answered("Ready", 100),
        failed("Missing", "Scan failed."),
        answered("Saved", 50, { error: "Scan failed." }),
      ],
    };
    const coverage = gaps(run([step]), step);
    expect(coverage?.title).toBe("Totals leave out Missing");
    expect(coverage?.gaps.map(({ message }) => message)).toEqual([
      "Missing: Scan failed.",
      "Saved: Scan failed. Showing its last values.",
    ]);
  });

  it("reports a live partial failure while keeping same-window figures", () => {
    const both = run([
      { window: tick, environments: [answered("Desk", 100), answered("Laptop", 200)] },
    ]);
    const step: Step = {
      window: tick,
      environments: [
        status("Desk", { isPending: true, summary: both.readings.get(id("Desk"))![0]!.summary }),
        failed("Laptop", "Read failed."),
      ],
    };
    const state = settle(both, step);
    expect(figures(state).merged.totalTokens).toBe(300);
    expect(gaps(state, step)).toMatchObject({
      title: "Some totals may be out of date",
      gaps: [{ message: "Laptop: Read failed. Showing its last values.", excluded: false }],
    });
  });
});

describe("usageNotices", () => {
  it("uses live compatibility and source notices while keeping saved figures", () => {
    const desk = answered("Desk", 100);
    const laptop = answered("Laptop", 200);
    const saved = run([{ window: tick, environments: [desk, laptop] }]);
    const incompatible = status("Laptop", {
      summary: summary({ contractVersion: 0, host: "Laptop" }),
    });
    const live = [{ ...desk, isPending: true }, incompatible];
    const state = settle(saved, { window: tick, environments: live });
    expect(figures(state).merged.totalTokens).toBe(300);
    const notices = usageNotices(state, live, tick);
    expect(notices.contractMismatches.map(({ environmentId }) => environmentId)).toEqual([
      laptop.environmentId,
    ]);
    expect(notices.coverage?.gaps[0]).toMatchObject({
      excluded: false,
      message: "Laptop runs an older server version. Showing its last compatible values.",
    });

    const source = {
      ...summary({ host: "Laptop", refreshing: ["cursor"] }).sources[1]!,
      status: "partial" as const,
      message: "Cursor fetch failed",
    };
    const trouble = [live[0]!, status("Laptop", { summary: summary({ sources: [source] }) })];
    const troubled = settle(state, { window: tick, environments: trouble });
    expect(usageNotices(troubled, trouble, tick).sourceMessages).toEqual([
      {
        environmentId: laptop.environmentId,
        environmentLabel: "Laptop",
        provider: "cursor",
        message: "Cursor fetch failed",
      },
    ]);
    expect(
      usageNotices(troubled, trouble, tick, { hidden: new Set(["cursor"]) }).sourceMessages,
    ).toEqual([]);
  });

  it("keeps identical warnings from distinct environments and providers", () => {
    const source = (provider: UsageProviderKind, host: string) => ({
      ...summary({ host }).sources[0]!,
      fingerprint: { ...summary({ host }).sources[0]!.fingerprint, provider },
      status: "failed" as const,
      message: "Read failed.",
    });
    const live = [
      status("Desk", {
        summary: summary({
          sources: [source("codex", "Desk"), source("codex", "Desk"), source("cursor", "Desk")],
        }),
      }),
      status("Laptop", { summary: summary({ sources: [source("cursor", "Laptop")] }) }),
    ];
    const state = run([{ window: tick, environments: live }]);
    expect(
      usageNotices(state, live, tick).sourceMessages.map(({ environmentLabel, provider }) => [
        environmentLabel,
        provider,
      ]),
    ).toEqual([
      ["Desk", "codex"],
      ["Desk", "cursor"],
      ["Laptop", "cursor"],
    ]);
  });
});

describe("settleUsageView identity", () => {
  it.each([
    ["all-failed", [failed("Failed")]],
    [
      "all-offline",
      [status("Offline", { summary: null, isConnected: false, canReadDiagnostics: false })],
    ],
    ["mixed", [answered("Ready", 100), failed("Failed")]],
    ["partially authorized", [answered("Ready", 100), denied("Denied")]],
    ["answered", [answered("Ready", 100)]],
    ["pending", [pending("Ready")]],
  ] as const)("returns the same state for unchanged %s statuses", (_kind, environments) => {
    const first = run([{ window: tick, environments }]);
    const cloned = environments.map((environment) => ({ ...environment }));
    expect(settle(first, { window: tick, environments: cloned })).toBe(first);
  });
});
