// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous hashing derives the account key inside pure usage mappers.
import * as NodeCrypto from "node:crypto";

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * Names a provider account the same way on every machine without revealing it: the first 16 hex
 * digits of the SHA-256 of the provider's account id. Usage reports compare accounts by it.
 */
export function usageAccountKey(accountId: string | null | undefined): string | undefined {
  const id = accountId?.trim();
  return id ? NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 16) : undefined;
}

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

/** Whether `window` is used up where the reading before it, `before`, still had room. */
function usesUp(
  window: ServerProviderUsageWindow,
  before: ServerProviderUsageWindow | undefined,
): boolean {
  return window.usedPercent >= 100 && (before?.usedPercent ?? 0) < 100;
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

/** The reset fields of `limits`, which are read apart from its usage windows. */
function resetFieldsOf(limits: ServerProviderUsageLimits | undefined) {
  return {
    ...(limits?.resetCredits !== undefined ? { resetCredits: limits.resetCredits } : {}),
    ...(limits?.resetCreditsError !== undefined
      ? { resetCreditsError: limits.resetCreditsError }
      : {}),
    ...(limits?.resetPrograms !== undefined ? { resetPrograms: limits.resetPrograms } : {}),
  };
}

/** `limits` without its reset fields, as after a reset was used and before they are read again. */
export function withoutResetFields(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  const {
    resetCredits: _credits,
    resetCreditsError: _error,
    resetPrograms: _programs,
    ...usage
  } = limits;
  return Object.keys(resetFieldsOf(limits)).length === 0 ? limits : usage;
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (
    (update.windows.length === 0 && update.credits === undefined) ||
    previous?.unavailable?.reason === "unsupported"
  ) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  const previousCheckedAt = previous?.checkedAt ?? input.checkedAt;
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed =
    (update.available === true && previous?.unavailable !== undefined) ||
    (update.credits !== undefined && !usageCreditsEqual(previous?.credits, update.credits));
  let newlyUsedUp = false;
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
      newlyUsedUp ||= usesUp(next, existing);
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
  const credits = update.credits === null ? undefined : (update.credits ?? previous?.credits);
  // An update cannot grant usage the last read refused, but a window it newly used up withdraws
  // it; one the read already saw at 100% was weighed by that read.
  const usageAllowed =
    previous?.usageAllowed === true && newlyUsedUp ? false : previous?.usageAllowed;
  // A failed read gave none of the account fields, so it is no read of the account.
  const accountReadAt =
    previous?.accountReadAt ??
    (previous?.unavailable === undefined ? previous?.checkedAt : undefined);
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
    ...(accountReadAt !== undefined && accountReadAt !== input.checkedAt ? { accountReadAt } : {}),
    ...(previous?.accountKey !== undefined ? { accountKey: previous.accountKey } : {}),
    ...(previous?.plan !== undefined ? { plan: previous.plan } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(usageAllowed !== undefined ? { usageAllowed } : {}),
    ...resetFieldsOf(previous),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageCreditsEqual(
  a: ServerProviderUsageCredits | undefined,
  b: ServerProviderUsageCredits | null,
): boolean {
  if (a === undefined || b === null) return a === undefined && b === null;
  return a.balance === b.balance && a.currency === b.currency && a.unlimited === b.unlimited;
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins &&
    a.exhaustedSince === b.exhaustedSince &&
    a.model === b.model
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
    // A probe that read the reset fields although its usage failed knows them better.
    const resetFields = resetFieldsOf(probed);
    return Object.keys(resetFields).length === 0
      ? published
      : { ...withoutResetFields(published), ...resetFields };
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    // A newer streamed update keeps what streams carry, and a window it used up withdraws the
    // read's yes, as `applyUsageLimitsUpdate` would have had it arrived after the read.
    const { credits: _readCredits, usageAllowed: readAllowed, ...read } = probed;
    const before = new Map(probed.windows.map((window) => [window.id, window] as const));
    const usageAllowed =
      readAllowed === true &&
      published.windows.some((window) => usesUp(window, before.get(window.id)))
        ? false
        : readAllowed;
    return {
      ...read,
      checkedAt: published.checkedAt,
      accountReadAt: probed.checkedAt,
      windows: published.windows,
      ...(published.credits !== undefined ? { credits: published.credits } : {}),
      ...(usageAllowed !== undefined ? { usageAllowed } : {}),
    };
  }
  return probed && carryExhaustion(published, probed);
}
