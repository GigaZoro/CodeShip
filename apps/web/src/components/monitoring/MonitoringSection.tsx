import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { t, tn } from "~/i18n";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function MonitoringSection({
  title,
  description,
  aside,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function MonitoringKpi({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-medium tabular-nums text-foreground">{value}</dd>
      {hint ? <dd className="truncate text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

/** One truncated line whose full text opens in a tooltip. */
export function MonitoringTruncated({
  text,
  as = "span",
  className,
}: {
  readonly text: string;
  readonly as?: "span" | "code";
  readonly className?: string;
}) {
  const Element = as;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Element className={cn("block truncate", className)}>{text}</Element>}
      />
      <TooltipPopup>
        <span className="block max-w-96 break-words">{text}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

export function MonitoringOverviewNotices({
  stale,
  pending,
  failed,
  children,
}: {
  readonly stale: boolean;
  readonly pending: number;
  readonly failed: number;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-24 flex-col gap-2 overflow-y-auto text-sm text-muted-foreground">
      {stale ? <p>{t("Showing previous monitoring results.")}</p> : null}
      <div role="status" className="flex flex-col gap-2">
        {children}
      </div>
      {pending > 0 ? (
        <p>
          {tn(
            pending,
            "{count} settled chat is still being analyzed.",
            "{count} settled chats are still being analyzed.",
          )}
        </p>
      ) : null}
      {failed > 0 ? (
        <p>
          {tn(
            failed,
            "{count} chat could not be analyzed.",
            "{count} chats could not be analyzed.",
          )}
        </p>
      ) : null}
    </div>
  );
}

export function MonitoringRefreshButton({
  refreshing,
  timedOut = false,
  onRefresh,
}: {
  readonly refreshing: boolean;
  readonly timedOut?: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <>
      <Button
        onClick={refreshing ? undefined : onRefresh}
        aria-label={t("Refresh monitoring")}
        aria-busy={refreshing}
        aria-disabled={refreshing}
        size="icon-sm"
        variant="ghost"
      >
        <RefreshIcon size="sm" refreshing={refreshing} />
      </Button>
      <span role="status" className={timedOut ? "text-xs text-muted-foreground" : "sr-only"}>
        {timedOut ? t("The request timed out.") : refreshing ? t("Refreshing…") : ""}
      </span>
    </>
  );
}
