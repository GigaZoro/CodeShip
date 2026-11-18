import type { MonitoringFindingRank } from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { FINDING_TEXT, SEVERITY_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { SEVERITY_BADGE_VARIANT } from "./monitoringText";
import { t, tn } from "~/i18n";

/** Findings across chats, worst first. Choosing one filters the chat list to its chats. */
export function MonitoringFindingRanking({
  ranks,
  activeCode,
  onSelect,
}: {
  readonly ranks: ReadonlyArray<MonitoringFindingRank>;
  readonly activeCode: MonitoringFindingRank["code"] | null;
  readonly onSelect: (code: MonitoringFindingRank["code"] | null) => void;
}) {
  if (ranks.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No weak points found.")}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {ranks.map((rank) => {
        const text = FINDING_TEXT[rank.code];
        const active = rank.code === activeCode;
        return (
          <li key={rank.code}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : rank.code)}
              className={cn(
                "flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-start sm:gap-4",
                active ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{t(text.title)}</span>
                  <Badge variant={SEVERITY_BADGE_VARIANT[rank.severity]} size="sm">
                    {t(SEVERITY_LABEL[rank.severity])}
                  </Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(text.overview ?? text.explanation)}
                </span>
                {text.advice ? (
                  <span className="text-xs text-foreground">{t(text.advice)}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 gap-4 text-xs tabular-nums text-muted-foreground sm:flex-col sm:items-end sm:gap-0.5">
                <span>{tn(rank.chats, "{count} chat", "{count} chats")}</span>
                <span>
                  {rank.wastedMs > 0
                    ? t("{duration} lost", { duration: formatDuration(rank.wastedMs) })
                    : t("No time counted")}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
