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

function usesUpAccount(
  window: ServerProviderUsageWindow,
  before: ServerProviderUsageWindow | undefined,
): boolean {
  return (
    (window.scope === "account" || (window.scope === undefined && window.model === undefined)) &&
    window.usedPercent >= 100 &&
    (before?.usedPercent ?? 0) < 100
  );
}

function differs<T>(a: T | undefined, b: T | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

function sameScope(a: ServerProviderUsageWindow["scope"], b: ServerProviderUsageWindow["scope"]) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a.models.length !== b.models.length)
    return false;
  const members = new Set(a.models);
  return b.models.every((model) => members.has(model));
}

function sameMembership(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  const aScope = a.scope ?? (a.model === undefined ? undefined : "model");
  const bScope = b.scope ?? (b.model === undefined ? undefined : "model");
  return (
    a.kind === b.kind &&
    !differs(a.model, b.model) &&
    (aScope === undefined ||
      bScope === undefined ||
      sameScope(aScope, bScope) ||
      (a.model !== undefined &&
        a.model === b.model &&
        (a.scope === undefined || b.scope === undefined)))
  );
}

function samePeriod(
  a: ServerProviderUsageWindow,
  b: ServerProviderUsageWindow,
  at: string,
): boolean {
  return (
    (b.resetsAt !== undefined ||
      a.resetsAt === undefined ||
      Date.parse(a.resetsAt) > Date.parse(at)) &&
    !differs(a.resetsAt, b.resetsAt) &&
    !differs(a.windowDurationMins, b.windowDurationMins)
  );
}

function sameWindow(
  a: ServerProviderUsageWindow,
  b: ServerProviderUsageWindow,
  at: string,
): boolean {
  return sameMembership(a, b) && samePeriod(a, b, at);
}

function observedAt(limits: ServerProviderUsageLimits, window: ServerProviderUsageWindow): string {
  return window.observedAt ?? limits.accountReadAt ?? limits.checkedAt;
}

export function fullReadAt(limits: ServerProviderUsageLimits | undefined): string | undefined {
  if (!limits || limits.streamOnly || limits.unavailable) return undefined;
  return limits.accountReadAt ?? limits.checkedAt;
}

export function creditsReadAt(limits: ServerProviderUsageLimits | undefined): string | undefined {
  return limits?.creditsObservedAt ?? fullReadAt(limits);
}

function newer(at: string | undefined, than: string | undefined): boolean {
  return at !== undefined && (than === undefined || Date.parse(at) > Date.parse(than));
}

function withWindowMetadata(
  window: ServerProviderUsageWindow,
  before: ServerProviderUsageWindow | undefined,
  at: string,
): ServerProviderUsageWindow {
  if (!before || !sameMembership(window, before)) return window;
  const retainPeriod = samePeriod(before, window, at);
  return {
    ...(before.model !== undefined ? { model: before.model } : {}),
    ...(before.scope !== undefined ? { scope: before.scope } : {}),
    ...(retainPeriod && before.resetsAt !== undefined ? { resetsAt: before.resetsAt } : {}),
    ...(retainPeriod && before.windowDurationMins !== undefined
      ? { windowDurationMins: before.windowDurationMins }
      : {}),
    ...window,
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
  const before = previous.window;
  const since =
    window.usedPercent < 100
      ? undefined
      : before !== undefined && before.usedPercent >= 100 && sameWindow(before, window, checkedAt)
        ? (before.exhaustedSince ?? before.observedAt ?? previous.checkedAt)
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
  const currentUpdate = Date.parse(input.checkedAt) >= Date.parse(previousCheckedAt);
  const accountReadAt = fullReadAt(previous);
  const previousCreditAt = creditsReadAt(previous);
  const creditsUpdate = newer(previousCreditAt, input.checkedAt) ? undefined : update.credits;
  const creditsObservedAt = creditsUpdate === undefined ? previousCreditAt : input.checkedAt;
  // Codex repeats unchanged limits on token ticks; those repeats are not observations.
  let changed =
    (currentUpdate && update.available === true && previous?.unavailable !== undefined) ||
    (creditsUpdate !== undefined &&
      (!usageCreditsEqual(previous?.credits, creditsUpdate) ||
        newer(creditsObservedAt, previousCreditAt)));
  let newlyUsedUp = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const observation = window.observedAt ?? input.checkedAt;
    const existingObservation = previous && existing && observedAt(previous, existing);
    if (
      newer(existingObservation, observation) ||
      (existing === undefined && accountReadAt !== undefined && !newer(observation, accountReadAt))
    ) {
      continue;
    }
    const same = existing !== undefined && sameWindow(existing, window, observation);
    const next = trackExhaustion(
      {
        ...withWindowMetadata(window, existing, observation),
        usedPercent: clampPercent(window.usedPercent),
      },
      { window: existing, checkedAt: existingObservation ?? previousCheckedAt },
      observation,
    );
    if (
      existing === undefined ||
      !usageWindowEquals(existing, next) ||
      ((update.available === true || window.observedAt !== undefined) &&
        existingObservation !== observation)
    ) {
      merged.set(window.id, { ...next, observedAt: observation });
      changed = true;
      newlyUsedUp ||=
        newer(observation, accountReadAt) && usesUpAccount(next, same ? existing : undefined);
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const checkedAt = currentUpdate ? input.checkedAt : previousCheckedAt;
  const unavailable =
    currentUpdate && update.available
      ? undefined
      : previous === undefined
        ? { reason: "probeFailed" as const }
        : previous.unavailable;
  // Freeze the legacy fallback before advancing the aggregate check time.
  const windows = [...merged.values()].map((window) => {
    if (window.observedAt !== undefined || previous === undefined) return window;
    const at = observedAt(previous, window);
    return {
      ...trackExhaustion(window, { window, checkedAt: at }, at),
      observedAt: at,
    };
  });
  const credits = creditsUpdate === null ? undefined : (creditsUpdate ?? previous?.credits);
  // Only fresh, account-wide exhaustion can withdraw the provider's yes for every model.
  const usageAllowed =
    previous?.usageAllowed === true && newlyUsedUp ? false : previous?.usageAllowed;
  return {
    ...makeUsageLimits({ checkedAt, windows }),
    ...(accountReadAt !== undefined && accountReadAt !== checkedAt ? { accountReadAt } : {}),
    ...(accountReadAt === undefined && unavailable === undefined ? { streamOnly: true } : {}),
    ...(creditsObservedAt !== undefined && creditsObservedAt !== accountReadAt
      ? { creditsObservedAt }
      : {}),
    ...(previous?.credentialFingerprint !== undefined
      ? { credentialFingerprint: previous.credentialFingerprint }
      : {}),
    ...(previous?.accountKey !== undefined ? { accountKey: previous.accountKey } : {}),
    ...(previous?.plan !== undefined ? { plan: previous.plan } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(usageAllowed !== undefined ? { usageAllowed } : {}),
    ...resetFieldsOf(previous),
    ...(previous?.externalUsage !== undefined ? { externalUsage: previous.externalUsage } : {}),
    ...(previous?.limitsSignIn !== undefined ? { limitsSignIn: previous.limitsSignIn } : {}),
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
    a.model === b.model &&
    sameScope(a.scope, b.scope)
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed === undefined || probed.unavailable?.reason === "unsupported") return probed;
  if (
    published &&
    (differs(published.accountKey, probed.accountKey) ||
      differs(published.credentialFingerprint, probed.credentialFingerprint) ||
      differs(published.plan, probed.plan))
  ) {
    return resolveUsageLimitsAfterProbe({ published: undefined, probed });
  }
  if (
    probed.unavailable?.reason === "probeFailed" &&
    published &&
    (!published.unavailable ||
      (published.unavailable.reason === "probeFailed" &&
        (published.windows.length > 0 ||
          published.creditsObservedAt !== undefined ||
          published.credits !== undefined)))
  ) {
    // A probe that read the reset fields although its usage failed knows them better.
    const resetFields = resetFieldsOf(probed);
    return Object.keys(resetFields).length === 0
      ? published
      : { ...withoutResetFields(published), ...resetFields };
  }
  if (probed.unavailable !== undefined) return probed;
  const previousById = new Map(published?.windows.map((window) => [window.id, window] as const));
  const publishedRead = fullReadAt(published);
  const probeRead = fullReadAt(probed) ?? probed.checkedAt;
  const newerInventory = published !== undefined && newer(publishedRead, probeRead);
  const account = newerInventory ? published : probed;
  const accountReadAt = newerInventory ? publishedRead! : probeRead;
  const merged = new Map<string, ServerProviderUsageWindow>();
  for (const window of probed.windows) {
    const observation = observedAt(probed, window);
    const before = previousById.get(window.id);
    if (!before && newerInventory && !newer(observation, publishedRead)) continue;
    const previousObservation = before && published ? observedAt(published, before) : undefined;
    if (before && newer(previousObservation, observation)) {
      merged.set(window.id, {
        ...withWindowMetadata(before, window, previousObservation!),
        observedAt: previousObservation,
      });
    } else {
      const next = trackExhaustion(
        withWindowMetadata(window, before, observation),
        { window: before, checkedAt: previousObservation ?? observation },
        observation,
      );
      merged.set(window.id, { ...next, observedAt: observation });
    }
    previousById.delete(window.id);
  }
  for (const window of previousById.values()) {
    const observation = observedAt(published!, window);
    if (newerInventory || newer(observation, probeRead)) {
      merged.set(window.id, { ...window, observedAt: observation });
    }
  }

  const windows = sortWindows(merged.values());
  const allowed = account.usageAllowed;
  const atRead = new Map(account.windows.map((window) => [window.id, window]));
  const withdrewAllowance =
    allowed === true &&
    windows.some((window) => {
      const prior = atRead.get(window.id);
      return (
        newer(window.observedAt, accountReadAt) &&
        usesUpAccount(
          window,
          prior && sameWindow(prior, window, window.observedAt!) ? prior : undefined,
        )
      );
    });
  const creditSource =
    published && newer(creditsReadAt(published), creditsReadAt(probed)) ? published : probed;
  const creditsObservedAt = creditsReadAt(creditSource);
  const checkedAt =
    published && newer(published.checkedAt, probed.checkedAt)
      ? published.checkedAt
      : probed.checkedAt;
  const {
    credits: _balance,
    creditsObservedAt: _balanceTime,
    accountReadAt: _accountTime,
    ...fields
  } = account;
  return {
    ...fields,
    checkedAt,
    windows,
    ...(checkedAt !== accountReadAt ? { accountReadAt } : {}),
    ...(creditSource.credits !== undefined ? { credits: creditSource.credits } : {}),
    ...(creditsObservedAt !== undefined && creditsObservedAt !== accountReadAt
      ? { creditsObservedAt }
      : {}),
    ...(withdrewAllowance ? { usageAllowed: false } : {}),
  };
}
