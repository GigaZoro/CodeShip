import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { Fragment } from "react";

import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import type { ProgressRingTone } from "../ui/progress-ring";

export function useLimitPools(now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  return collectLimitPools(collectLimitAccounts(presentations), now);
}

export function limitTone(remainingPercent: number): ProgressRingTone {
  if (remainingPercent <= 10) return "error";
  if (remainingPercent <= 25) return "warning";
  return "default";
}

const toneTextClassName: Record<ProgressRingTone, string> = {
  default: "text-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
};

export function limitPoolLabel(pool: LimitPool): string {
  return providerClients.get(pool.driver)?.label ?? String(pool.driver);
}

export function limitWindowLabel(pool: LimitPool, window: LimitPoolWindow): string {
  return (
    (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id)?.label : undefined) ??
    window.label
  );
}

/** Remaining quota per provider window, pooled across accounts, for a hover summary. */
export function UsageLimitsGlance({
  pools,
  now,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  return (
    <div className="flex w-64 max-w-full flex-col gap-2.5 py-1">
      {pools.map((pool) => {
        // Accounts whose limits could not be read are explained on the Usage page.
        if (pool.windows.length === 0) return null;
        const label = limitPoolLabel(pool);
        return (
          <section key={pool.driver} className="flex min-w-0 flex-col gap-1">
            <h3 className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                indicatorBackground="var(--popover)"
                className="size-4"
                iconClassName="size-3.5 text-foreground/80"
              />
              <span className="truncate">{label}</span>
              {pool.accounts.length > 1 ? (
                <span className="shrink-0 font-normal text-muted-foreground">
                  · {pool.accounts.length} accounts
                </span>
              ) : null}
            </h3>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-0.5 ps-5.5">
              {displayLimitWindows(pool).map((window) => {
                const nextReset = window.resets.find((reset) => reset.at > now);
                return (
                  <Fragment key={`${window.kind}:${window.id}`}>
                    <dt className="truncate text-muted-foreground">
                      {limitWindowLabel(pool, window)}
                    </dt>
                    <dd
                      className={cn(
                        "text-end font-medium tabular-nums",
                        toneTextClassName[limitTone(window.remainingPercent)],
                      )}
                    >
                      {window.remainingPercent}% left
                    </dd>
                    <dd className="text-end text-muted-foreground tabular-nums">
                      {nextReset ? (
                        <>
                          <span className="sr-only">resets in </span>
                          <span aria-hidden>↻ </span>
                          {formatDuration(nextReset.at - now)}
                        </>
                      ) : null}
                    </dd>
                  </Fragment>
                );
              })}
            </dl>
          </section>
        );
      })}
      <p className="border-t border-border/60 pt-1.5 text-muted-foreground">Click for details</p>
    </div>
  );
}
