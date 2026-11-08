import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Stamps a window read at `checkedAt` with when it was first seen at 100%, carried from its
 * `previous` reading while it stays there, so a later update cannot move a no-reset window's hold.
 */
function trackExhaustion(
  window: ServerProviderUsageWindow,
  previous: { readonly window: ServerProviderUsageWindow | undefined; readonly checkedAt: string },
  checkedAt: string,
): ServerProviderUsageWindow {
  const since =
    window.usedPercent < 100
      ? undefined
      : previous.window !== undefined && previous.window.usedPercent >= 100
        ? (previous.window.exhaustedSince ?? previous.checkedAt)
        : checkedAt;
  if (window.exhaustedSince === since) return window;
  const { exhaustedSince: _replaced, ...rest } = window;
  return since === undefined ? rest : { ...rest, exhaustedSince: since };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  const previousCheckedAt = previous?.checkedAt ?? input.checkedAt;
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = update.available === true && previous?.unavailable !== undefined;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next = trackExhaustion(
      {
        ...window,
        usedPercent: clampPercent(window.usedPercent),
        ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
          ? { resetsAt: existing.resetsAt }
          : {}),
        ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
          ? { windowDurationMins: existing.windowDurationMins }
          : {}),
      },
      { window: existing, checkedAt: previousCheckedAt },
      input.checkedAt,
    );
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable = update.available
    ? undefined
    : previous === undefined
      ? { reason: "probeFailed" as const }
      : previous.unavailable;
  // The new `checkedAt` must not become the anchor of a used-up window this update omits.
  const windows = [...merged.values()].map((window) =>
    trackExhaustion(window, { window, checkedAt: previousCheckedAt }, input.checkedAt),
  );
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins &&
    a.exhaustedSince === b.exhaustedSince
  );
}

/** A probe's windows keep when the reading they replace first saw them used up. */
function carryExhaustion(
  published: ServerProviderUsageLimits | undefined,
  probed: ServerProviderUsageLimits,
): ServerProviderUsageLimits {
  const before = new Map(published?.windows.map((window) => [window.id, window] as const));
  const previousCheckedAt = published?.checkedAt ?? probed.checkedAt;
  let changed = false;
  const windows = probed.windows.map((window) => {
    const tracked = trackExhaustion(
      window,
      { window: before.get(window.id), checkedAt: previousCheckedAt },
      probed.checkedAt,
    );
    changed ||= tracked !== window;
    return tracked;
  });
  return changed ? { ...probed, windows } : probed;
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed && carryExhaustion(published, probed);
}
