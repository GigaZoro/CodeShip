import type {
  OrchestratorMcpProviderUsage,
  OrchestratorMcpUsageError,
  OrchestratorMcpUsageMeter,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
/** How old a usage reading may be before `orchestrator_capabilities` with `usage` reads it again. */
const USAGE_READING_MAX_AGE_MS = 10 * 60_000;

export function publishesUsage(provider: ServerProvider): boolean {
  return provider.enabled && (provider.driver === "claudeAgent" || provider.driver === "codex");
}

/**
 * Whether the account's last full usage read is missing or older than `USAGE_READING_MAX_AGE_MS`,
 * and no probe ran since then: one that left no newer reading would fail the same way again.
 */
export function usageReadingStale(provider: ServerProvider, now: number): boolean {
  const limits = provider.usageLimits;
  const old = (at: string | undefined) =>
    at === undefined || now - Date.parse(at) > USAGE_READING_MAX_AGE_MS;
  return old(limits?.accountReadAt ?? limits?.checkedAt) && old(provider.checkedAt);
}

function meterId(window: ServerProviderUsageWindow): string {
  if (window.kind === "weekly") {
    return window.model === undefined ? "weekly_all" : `weekly_scoped:${window.model}`;
  }
  return window.kind === "session" ? "session" : window.id;
}

function meter(window: ServerProviderUsageWindow): OrchestratorMcpUsageMeter {
  return {
    id: meterId(window),
    model: window.model ?? null,
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function bankedResets(
  provider: ServerProvider,
): Pick<OrchestratorMcpProviderUsage, "bankedResets" | "bankedResetsError"> {
  // Claude's grants are read from its CLI's `/limit-reset` screen, which this server does not drive yet.
  if (provider.driver !== "codex") return { bankedResets: null, bankedResetsError: "unsupported" };
  const summary = provider.usageLimits?.resetCredits;
  if (summary === undefined) return { bankedResets: null, bankedResetsError: "not_read" };
  return {
    bankedResets: {
      available: summary.availableCount,
      resets: (summary.credits ?? []).map((credit) => ({
        status: credit.status ?? null,
        grantedAt: credit.grantedAt ?? null,
        expiresAt: credit.expiresAt ?? null,
        program: credit.program,
        kind: credit.kind,
        ...(credit.resetsLeft === undefined ? {} : { resetsLeft: credit.resetsLeft }),
        ...(credit.usableNow === undefined ? {} : { usableNow: credit.usableNow }),
        ...(credit.requiresLimit === undefined ? {} : { requiresLimit: credit.requiresLimit }),
        ...(credit.paused === undefined ? {} : { paused: credit.paused }),
      })),
    },
  };
}

function usageError(provider: ServerProvider): OrchestratorMcpUsageError | undefined {
  if (provider.auth.status === "unauthenticated") return "signed_out";
  const limits = provider.usageLimits;
  if (limits === undefined) return "not_read";
  if (limits.unavailable?.reason === "unsupported") return "unsupported";
  if (limits.unavailable !== undefined && limits.windows.length === 0) return "read_failed";
  return undefined;
}

/**
 * The `usage` an enabled Claude or Codex account publishes in `orchestrator_capabilities`: its
 * meters, credits and banked resets, keyed by a hash of the account id. A provider's own error
 * text is never published, since it can name the account. `limited` is the account's usage hold.
 */
export function providerUsageFields(
  provider: ServerProvider,
  limited: boolean,
): {
  readonly usage: OrchestratorMcpProviderUsage | null;
  readonly usageError?: OrchestratorMcpUsageError;
} {
  const error = usageError(provider);
  const limits = provider.usageLimits;
  if (error !== undefined || limits === undefined) {
    return { usage: null, usageError: error ?? "not_read" };
  }
  return {
    usage: {
      accountKey: limits.accountKey ?? null,
      plan: limits.plan ?? null,
      measuredAt: limits.checkedAt,
      meters: limits.windows.map(meter),
      credits:
        limits.credits === undefined
          ? null
          : {
              balance: limits.credits.balance ?? null,
              unlimited: limits.credits.unlimited,
              ...(limits.credits.currency === undefined
                ? {}
                : { currency: limits.credits.currency }),
            },
      ...bankedResets(provider),
      usageAllowed: !limited && limits.usageAllowed !== false,
    },
  };
}
