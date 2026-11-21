import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { t } from "~/i18n";
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

export function MonitoringRefreshButton({
  refreshing,
  onRefresh,
}: {
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <Button
      onClick={onRefresh}
      aria-label={t("Refresh monitoring")}
      aria-busy={refreshing}
      disabled={refreshing}
      size="icon-sm"
      variant="ghost"
    >
      <RefreshIcon size="sm" refreshing={refreshing} />
    </Button>
  );
}
