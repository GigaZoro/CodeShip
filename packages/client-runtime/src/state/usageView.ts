import { groupBy } from "effect/Array";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  formatUsageContractMismatch,
  usageSourceMessages,
  usageWindowLabel,
} from "@t3tools/shared/usageFormat";
import {
  isCompatibleUsageContractVersion,
  type MergedUsage,
  type ProviderTotals,
} from "@t3tools/shared/usageMerge";
import { t } from "@t3tools/shared/i18n";

import {
  mergeAnsweredUsage,
  usagePeriodKey,
  usageWindowKey,
  type EnvironmentUsageStatus,
} from "./usageProgress.ts";

export interface UsageReading {
  readonly summary: UsageSummary;
  readonly usageSettingsKey: string;
  readonly requestKey: string;
  readonly window: UsageSummaryInput;
  readonly complete: boolean;
  readonly reservations: ReadonlySet<UsageProviderKind>;
  readonly seq: number;
  readonly windowKey: string;
  readonly slot: string;
  readonly hidden: readonly UsageProviderKind[];
}

export interface UsageFailure {
  readonly usageSettingsKey: string;
  readonly requestKey: string;
  readonly window: UsageSummaryInput;
  readonly windowKey: string;
  readonly message: string;
}

export interface UsageProviderRow {
  readonly provider: UsageProviderKind;
  readonly totals: ProviderTotals | null;
}

export interface UsageViewEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface UsageFigures {
  readonly kind: "figures";
  readonly window: UsageSummaryInput;
  readonly slot: string;
  readonly kept: boolean;
  readonly settled: boolean;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly environments: readonly UsageViewEnvironment[];
  readonly reserved: readonly UsageProviderKind[];
  readonly merged: MergedUsage;
  readonly providers: readonly UsageProviderRow[];
}

export type UsageView = { readonly kind: "none" } | { readonly kind: "loading" } | UsageFigures;

export interface UsageViewState {
  readonly readings: ReadonlyMap<EnvironmentId, readonly UsageReading[]>;
  readonly failures: ReadonlyMap<EnvironmentId, UsageFailure>;
  readonly revoked: ReadonlyMap<EnvironmentId, ReadonlySet<UsageSummary>>;
  readonly lastSummaries: ReadonlyMap<EnvironmentId, UsageSummary>;
  readonly seq: number;
  readonly view: UsageView;
}

export interface UsageViewInput {
  readonly window: UsageSummaryInput;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedIds: ReadonlySet<EnvironmentId> | null;
  readonly hidden: readonly UsageProviderKind[];
  readonly enabled: boolean;
}

const MAX_READING_KEYS = 2;
const NO_RESERVATIONS: ReadonlySet<UsageProviderKind> = new Set();
const NO_USAGE: UsageView = { kind: "none" };
const LOADING_USAGE: UsageView = { kind: "loading" };

export const initialUsageViewState: UsageViewState = {
  readings: new Map(),
  failures: new Map(),
  revoked: new Map(),
  lastSummaries: new Map(),
  seq: 0,
  view: NO_USAGE,
};

function compatible(summary: UsageSummary): boolean {
  return isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION);
}

// The model filter is a usage setting: readings under another one are dropped, not keyed apart.
function requestKeyOf(window: UsageSummaryInput, hidden: readonly UsageProviderKind[]): string {
  return JSON.stringify([usagePeriodKey(window), hidden]);
}

// Past 24h requests roll each minute while the page is visible (makeWindow floors them to the
// minute), so each minute is its own slot. Scans are incremental, which keeps a rescan per minute
// cheap; an hourly key would leave up to 59 minutes of usage off the page.
function slotOf(
  window: UsageSummaryInput,
  windowKey: string,
  hidden: readonly UsageProviderKind[],
): string {
  return JSON.stringify([usagePeriodKey(window), hidden, windowKey]);
}

function windowEnd(window: UsageSummaryInput): string {
  return window.untilTime ?? window.untilDay;
}

// The reading on screen stays until another view replaces it, so a later switch can still fall
// back to it while environments load.
function trimReadings(
  readings: readonly UsageReading[],
  onScreen: string | null,
): readonly UsageReading[] {
  if (readings.length <= MAX_READING_KEYS) return readings;
  const kept = new Set(
    [...readings]
      .sort(
        (left, right) =>
          Number(right.slot === onScreen) - Number(left.slot === onScreen) || right.seq - left.seq,
      )
      .slice(0, MAX_READING_KEYS),
  );
  return readings.filter((reading) => kept.has(reading));
}

function newest(readings: readonly UsageReading[]): UsageReading | undefined {
  return readings.reduce<UsageReading | undefined>(
    (latest, reading) => (latest === undefined || reading.seq > latest.seq ? reading : latest),
    undefined,
  );
}

function withReservations(
  reservations: ReadonlySet<UsageProviderKind>,
  summary: UsageSummary,
  hidden: readonly UsageProviderKind[],
): ReadonlySet<UsageProviderKind> {
  const adding = summary.sources.flatMap(({ refreshing, fingerprint: { provider } }) =>
    refreshing === true && !hidden.includes(provider) && !reservations.has(provider)
      ? [provider]
      : [],
  );
  return adding.length === 0 ? reservations : new Set([...reservations, ...adding]);
}

function withoutHidden(summary: UsageSummary, hidden: ReadonlySet<UsageProviderKind>) {
  if (hidden.size === 0) return summary;
  return {
    ...summary,
    buckets: summary.buckets.filter((bucket) => !hidden.has(bucket.provider)),
    sources: summary.sources.filter((source) => !hidden.has(source.fingerprint.provider)),
  };
}

function figures(
  view: Pick<UsageFigures, "window" | "slot" | "kept" | "settled" | "environments" | "reserved">,
  hidden: readonly UsageProviderKind[],
): UsageFigures {
  const hiddenProviders = new Set(hidden);
  const merged = mergeAnsweredUsage(
    view.environments.map((environment) => ({
      ...environment,
      summary: withoutHidden(environment.summary, hiddenProviders),
    })),
  );
  const active = merged.providers
    .filter(
      ({ costUsd, totalTokens, sessions, records }) =>
        costUsd > 0 || totalTokens > 0 || sessions > 0 || records > 0,
    )
    .map((totals) => ({ provider: totals.provider, totals }));
  const represented = new Set(active.map(({ provider }) => provider));
  return {
    kind: "figures",
    ...view,
    hiddenProviders,
    merged,
    providers: [
      ...active,
      ...view.reserved.flatMap((provider) =>
        represented.has(provider) ? [] : [{ provider, totals: null }],
      ),
    ],
  };
}

function reservedProviders(readings: readonly UsageReading[]): readonly UsageProviderKind[] {
  return [...new Set(readings.flatMap(({ reservations }) => [...reservations]))].sort();
}

export function settleUsageView(state: UsageViewState, input: UsageViewInput): UsageViewState {
  const hidden = [...new Set(input.hidden)].sort();
  const readings = new Map(state.readings);
  const failures = new Map(state.failures);
  const revoked = new Map(state.revoked);
  const lastSummaries = new Map(state.lastSummaries);
  let seq = state.seq;
  let changed = false;

  const present = new Set(input.environments.map(({ environmentId }) => environmentId));
  for (const map of [readings, failures, revoked, lastSummaries]) {
    for (const id of map.keys()) {
      if (present.has(id)) continue;
      map.delete(id);
      changed = true;
    }
  }

  for (const environment of input.environments) {
    const id = environment.environmentId;
    if (!environment.canReadDiagnostics) {
      const dropped = readings.get(id) ?? [];
      const last = lastSummaries.get(id);
      if (dropped.length === 0 && last === undefined && !failures.has(id)) continue;
      revoked.set(
        id,
        new Set([
          ...(revoked.get(id) ?? []),
          ...dropped.map(({ summary }) => summary),
          ...(last === undefined ? [] : [last]),
        ]),
      );
      readings.delete(id);
      failures.delete(id);
      lastSummaries.delete(id);
      changed = true;
      continue;
    }
    const { usageSettingsKey } = environment;
    const saved = readings.get(id) ?? [];
    if (saved.some((reading) => reading.usageSettingsKey !== usageSettingsKey)) {
      const current = saved.filter((reading) => reading.usageSettingsKey === usageSettingsKey);
      if (current.length === 0) readings.delete(id);
      else readings.set(id, current);
      changed = true;
    }
    if (failures.has(id) && failures.get(id)!.usageSettingsKey !== usageSettingsKey) {
      failures.delete(id);
      changed = true;
    }
    if (!input.enabled) continue;

    const { window } = input;
    const requestKey = requestKeyOf(window, hidden);
    const windowKey = usageWindowKey(window);
    let own = readings.get(id) ?? [];
    if (failures.get(id)?.requestKey !== undefined && failures.get(id)?.requestKey !== requestKey) {
      failures.delete(id);
      changed = true;
    }
    const summary =
      environment.summary !== null &&
      compatible(environment.summary) &&
      revoked.get(id)?.has(environment.summary) !== true
        ? environment.summary
        : null;
    const knownAtRequest = (candidate: UsageSummary) =>
      own.some(
        (reading) =>
          reading.summary === candidate &&
          reading.requestKey === requestKey &&
          reading.windowKey === windowKey,
      );
    const fresh =
      summary !== null &&
      lastSummaries.get(id) !== summary &&
      !own.some((reading) => reading.summary === summary);
    if (summary !== null && lastSummaries.get(id) !== summary) {
      lastSummaries.set(id, summary);
      changed = true;
    }
    const record = (answer: UsageSummary, complete: boolean) => {
      const at = own.find(
        (reading) => reading.requestKey === requestKey && reading.windowKey === windowKey,
      );
      const base = at ?? newest(own.filter((reading) => reading.requestKey === requestKey));
      const reservations = withReservations(base?.reservations ?? NO_RESERVATIONS, answer, hidden);
      if (at?.summary === answer && at.complete === complete && at.reservations === reservations)
        return;
      seq += 1;
      const next = [
        ...own.filter((reading) => reading !== at),
        {
          summary: answer,
          usageSettingsKey,
          requestKey,
          window,
          complete,
          reservations,
          seq,
          windowKey,
          slot: slotOf(window, windowKey, hidden),
          hidden,
        },
      ];
      own = trimReadings(next, state.view.kind === "figures" ? state.view.slot : null);
      readings.set(id, own);
      changed = true;
    };
    const clearAnsweredFailure = () => {
      const failure = failures.get(id);
      if (failure === undefined || windowEnd(window) < windowEnd(failure.window)) return;
      failures.delete(id);
      changed = true;
    };

    if (environment.error !== null && !environment.isPending) {
      const failure = failures.get(id);
      if (
        environment.isConnected &&
        (failure?.windowKey !== windowKey || failure.message !== environment.error)
      ) {
        failures.set(id, {
          usageSettingsKey,
          requestKey,
          window,
          windowKey,
          message: environment.error,
        });
        changed = true;
      }
      if (summary !== null && !knownAtRequest(summary)) record(summary, true);
      continue;
    }
    if (summary === null) continue;
    if (!environment.isPending) {
      record(summary, true);
      clearAnsweredFailure();
      continue;
    }
    if (knownAtRequest(summary)) continue;
    if (own.some((reading) => reading.complete && reading.requestKey === requestKey)) {
      const reserved = own.map((reading) => {
        if (!reading.complete || reading.requestKey !== requestKey) return reading;
        const reservations = withReservations(reading.reservations, summary, hidden);
        return reservations === reading.reservations ? reading : { ...reading, reservations };
      });
      if (reserved.some((reading, index) => reading !== own[index])) {
        own = reserved;
        readings.set(id, own);
        changed = true;
      }
    } else {
      record(summary, false);
    }
    if (fresh) clearAnsweredFailure();
  }

  const settled: Omit<UsageViewState, "view"> = changed
    ? { readings, failures, revoked, lastSummaries, seq }
    : state;
  const view = input.enabled
    ? chooseView(settled, input, hidden, state.view)
    : changed
      ? keepView(settled, state.view)
      : state.view;
  if (!changed && view === state.view) return state;
  return { ...settled, view };
}

function keepView(state: Omit<UsageViewState, "view">, previous: UsageView): UsageView {
  if (previous.kind !== "figures") return previous;
  const holders = previous.environments.flatMap((environment) => {
    const reading = state.readings
      .get(environment.environmentId)
      ?.find(({ slot, summary }) => slot === previous.slot && summary === environment.summary);
    return reading === undefined ? [] : [{ environment, reading }];
  });
  if (holders.length === previous.environments.length) return previous;
  if (holders.length === 0) return NO_USAGE;
  return figures(
    {
      ...previous,
      environments: holders.map(({ environment }) => environment),
      reserved: reservedProviders(holders.map(({ reading }) => reading)),
    },
    [...previous.hiddenProviders],
  );
}

function chooseView(
  state: Omit<UsageViewState, "view">,
  input: UsageViewInput,
  hidden: readonly UsageProviderKind[],
  previous: UsageView,
): UsageView {
  const { window, environments, selectedIds } = input;
  const windowKey = usageWindowKey(window);
  const selected =
    selectedIds === null
      ? environments
      : environments.filter(({ environmentId }) => selectedIds.has(environmentId));
  const settled = !selected.some(
    (environment) =>
      environment.isConnected &&
      environment.isPending &&
      (environment.canReadDiagnostics || environment.error === null),
  );
  const own = (environment: EnvironmentUsageStatus) =>
    state.readings.get(environment.environmentId) ?? [];
  const members = selected.filter(
    (environment) => environment.canReadDiagnostics && own(environment).length > 0,
  );
  if (members.length === 0) {
    return selected.some(
      (environment) =>
        environment.isConnected &&
        environment.isPending &&
        environment.error === null &&
        !state.failures.has(environment.environmentId),
    )
      ? LOADING_USAGE
      : NO_USAGE;
  }

  const requestKey = requestKeyOf(window, hidden);
  // A disconnected environment cannot answer until it reconnects, and its gap names it.
  const resolved = (environment: EnvironmentUsageStatus) => {
    const failure = state.failures.get(environment.environmentId);
    return (
      !environment.isConnected ||
      (failure !== undefined &&
        failure.requestKey === requestKey &&
        failure.windowKey === windowKey) ||
      (!environment.isPending && environment.summary !== null && !compatible(environment.summary))
    );
  };
  const unresolved = (environment: EnvironmentUsageStatus) =>
    !own(environment).some(
      (reading) =>
        reading.complete && reading.requestKey === requestKey && reading.windowKey === windowKey,
    ) && !resolved(environment);
  // Every saved reading was read under its environment's current usage settings, and `record`
  // keeps one reading per slot.
  const holdersAt = (slot: string) =>
    members.flatMap((environment) => {
      const reading = own(environment).find((candidate) => candidate.slot === slot);
      return reading === undefined ? [] : [{ environment, reading }];
    });

  const newestBySlot = new Map<string, UsageReading>();
  for (const environment of members) {
    for (const reading of own(environment)) {
      const known = newestBySlot.get(reading.slot);
      if (known === undefined || reading.seq > known.seq) newestBySlot.set(reading.slot, reading);
    }
  }
  const slots = [...newestBySlot.values()]
    .sort((left, right) => right.seq - left.seq)
    .map(({ slot }) => slot);
  const requestedSlot = slotOf(window, windowKey, hidden);
  const onScreen = previous.kind === "figures" ? newestBySlot.get(previous.slot) : undefined;
  const olderThanOnScreen = (slot: string) => {
    if (onScreen === undefined || slot === requestedSlot) return false;
    const reading = newestBySlot.get(slot)!;
    // Once the requested period is on screen, another period's reading is older usage.
    if (reading.requestKey !== onScreen.requestKey) return onScreen.requestKey === requestKey;
    return windowEnd(reading.window) < windowEnd(onScreen.window);
  };
  // Returning to a period or showing a hidden provider again finds its reading older than the
  // one on screen, so newest-first alone would keep showing the other request.
  const candidates = (
    newestBySlot.has(requestedSlot)
      ? [requestedSlot, ...slots.filter((slot) => slot !== requestedSlot)]
      : slots
  ).filter((slot) => !olderThanOnScreen(slot));
  // With no complete view, the one on screen stays rather than one environment's partial figures.
  const chosen =
    candidates.find((slot) => {
      const holders = holdersAt(slot);
      return (
        holders.length === members.length ||
        (slot === requestedSlot &&
          members.every(
            (environment) =>
              holders.some((holder) => holder.environment === environment) || resolved(environment),
          ))
      );
    }) ??
    onScreen?.slot ??
    slots[0]!;
  const holders = holdersAt(chosen);
  const shown = holders[0]!.reading;
  const kept =
    shown.requestKey !== requestKey || (shown.windowKey !== windowKey && !members.some(unresolved));
  const reserved = reservedProviders(holders.map(({ reading }) => reading));

  if (
    previous.kind === "figures" &&
    previous.slot === chosen &&
    previous.kept === kept &&
    previous.settled === settled &&
    previous.environments.length === holders.length &&
    holders.every(({ environment, reading }, index) => {
      const entry = previous.environments[index]!;
      return (
        entry.environmentId === environment.environmentId &&
        entry.label === environment.label &&
        entry.summary === reading.summary
      );
    }) &&
    previous.reserved.length === reserved.length &&
    previous.reserved.every((provider, index) => provider === reserved[index])
  ) {
    return previous;
  }
  return figures(
    {
      window: shown.window,
      slot: chosen,
      kept,
      settled,
      environments: holders.map(({ environment, reading }) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        summary: reading.summary,
      })),
      reserved,
    },
    shown.hidden,
  );
}

export function retainedUsageLabel(view: UsageFigures, hour12?: boolean): string {
  return t("Showing previous usage for {environments} · {period}", {
    environments: view.environments.map(({ label }) => label).join(", "),
    period: usageWindowLabel(view.window, hour12),
  });
}

export function usageEnvironmentError(environment: EnvironmentUsageStatus): string | null {
  return (
    environment.error ?? (environment.isConnected ? null : t("This environment is not connected."))
  );
}

function coverageError(
  usage: UsageViewState,
  environment: EnvironmentUsageStatus,
  shownWindowKey: string,
  represented: boolean,
  hour12: boolean | undefined,
): { readonly error: string; readonly window?: UsageSummaryInput } | null {
  const id = environment.environmentId;
  if (!environment.canReadDiagnostics || !environment.isConnected) {
    const error = usageEnvironmentError(environment);
    return error === null ? null : { error };
  }
  const failure = usage.failures.get(id);
  if (failure !== undefined) {
    return failure.windowKey === shownWindowKey
      ? { error: failure.message }
      : { error: failure.message, window: failure.window };
  }
  if (represented) return null;
  const latest = newest(usage.readings.get(id) ?? []);
  if (latest !== undefined) {
    return {
      error: t("Its latest figures are for {window}.", {
        window: usageWindowLabel(latest.window, hour12),
      }),
    };
  }
  return !environment.isPending &&
    environment.summary !== null &&
    usage.revoked.get(id)?.has(environment.summary) === true
    ? { error: t("Its access changed. Refresh to read its usage again.") }
    : null;
}

export function usageNotices(
  usage: UsageViewState,
  live: readonly EnvironmentUsageStatus[],
  requestedWindow: UsageSummaryInput,
  {
    hidden = new Set(),
    hour12,
  }: { readonly hidden?: ReadonlySet<UsageProviderKind>; readonly hour12?: boolean } = {},
) {
  const contractMismatches = live.flatMap(({ environmentId, summary }) => {
    if (summary === null || compatible(summary)) return [];
    return [
      {
        environmentId,
        direction:
          summary.contractVersion < USAGE_CONTRACT_VERSION
            ? ("serverBehind" as const)
            : ("clientBehind" as const),
        contractVersion: summary.contractVersion,
      },
    ];
  });
  const sourceMessages = live.flatMap(({ environmentId, label, summary }) => {
    if (summary === null || !compatible(summary) || usage.revoked.get(environmentId)?.has(summary))
      return [];
    const byProvider = groupBy(summary.sources, (source) => source.fingerprint.provider);
    return Object.values(byProvider).flatMap((sources) => {
      const provider = sources[0].fingerprint.provider;
      if (hidden.has(provider)) return [];
      return usageSourceMessages(sources).map((message) => ({
        environmentId,
        environmentLabel: label,
        provider,
        message,
      }));
    });
  });

  const view = usage.view.kind === "figures" ? usage.view : null;
  const shownIds = new Set(view?.environments.map(({ environmentId }) => environmentId));
  const shownWindowKey = usageWindowKey(view?.window ?? requestedWindow);
  const mismatchById = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const gaps = live.flatMap((environment) => {
    const mismatch = mismatchById.get(environment.environmentId);
    const represented = shownIds.has(environment.environmentId);
    if (mismatch !== undefined) {
      return [
        {
          environment,
          message: formatUsageContractMismatch(environment.label, mismatch, represented),
          excluded: !represented,
          retryable: false,
        },
      ];
    }
    const gap = coverageError(usage, environment, shownWindowKey, represented, hour12);
    if (gap === null) return [];
    const name =
      gap.window === undefined
        ? environment.label
        : t("{environment} ({window})", {
            environment: environment.label,
            window: usageWindowLabel(gap.window, hour12),
          });
    return [
      {
        environment,
        message: represented
          ? t("{environment}: {error} Showing its last values.", {
              environment: name,
              error: gap.error,
            })
          : t("{environment}: {error}", { environment: name, error: gap.error }),
        excluded: !represented,
        retryable: environment.canReadDiagnostics && environment.isConnected,
      },
    ];
  });
  const excluded = gaps.filter((gap) => gap.excluded);
  return {
    contractMismatches,
    sourceMessages,
    coverage:
      gaps.length === 0
        ? null
        : {
            title:
              excluded.length === 0
                ? t("Some totals may be out of date")
                : excluded.length === 1
                  ? t("Totals leave out {environment}", {
                      environment: excluded[0]!.environment.label,
                    })
                  : t("Totals leave out {count} environments", { count: excluded.length }),
            gaps,
          },
  };
}

export function formatUsageSourceNotices(
  notices: ReturnType<typeof usageNotices>["sourceMessages"],
  providerLabel: (provider: UsageProviderKind) => string,
) {
  return notices.map(({ environmentId, environmentLabel, provider, message }) => ({
    key: JSON.stringify([environmentId, provider, message]),
    text: t("{environment} · {provider}: {message}", {
      environment: environmentLabel,
      provider: providerLabel(provider),
      message,
    }),
  }));
}
