import {
  fixChatTarget,
  type MonitoringFindingRank,
  type MonitoringFixChatScope,
  type MonitoringGroupEntry,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { cn } from "../../lib/utils";
import { useMonitoringFixChat } from "../../state/monitoring";
import { Badge } from "../ui/badge";
import { FINDING_TEXT, SEVERITY_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { MonitoringFixChatButton, MonitoringFixChatStatus } from "./MonitoringFixChat";
import { SEVERITY_BADGE_VARIANT } from "./monitoringText";
import { t, tn } from "~/i18n";

/**
 * Findings across chats, worst first. Choosing one filters the chat list to its chats; each can
 * start a chat that fixes its root cause.
 */
export function MonitoringFindingRanking({
  ranks,
  groups,
  scope,
  activeCode,
  onSelect,
}: {
  readonly ranks: ReadonlyArray<MonitoringFindingRank>;
  readonly groups: ReadonlyArray<MonitoringGroupEntry>;
  readonly scope: MonitoringFixChatScope | null;
  readonly activeCode: MonitoringFindingRank["code"] | null;
  readonly onSelect: (code: MonitoringFindingRank["code"] | null) => void;
}) {
  if (ranks.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No weak points found.")}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {ranks.map((rank) => (
        <FindingRankRow
          key={rank.code}
          rank={rank}
          groups={groups}
          scope={scope}
          active={rank.code === activeCode}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function FindingRankRow({
  rank,
  groups,
  scope,
  active,
  onSelect,
}: {
  readonly rank: MonitoringFindingRank;
  readonly groups: ReadonlyArray<MonitoringGroupEntry>;
  readonly scope: MonitoringFixChatScope | null;
  readonly active: boolean;
  readonly onSelect: (code: MonitoringFindingRank["code"] | null) => void;
}) {
  const text = FINDING_TEXT[rank.code];
  const target = scope === null ? null : fixChatTarget(groups, rank.code, scope);
  const fixChat = useMonitoringFixChat(target, rank.code);
  return (
    <li className={cn("flex flex-col", active ? "bg-accent" : "hover:bg-accent/50")}>
      <div className="flex flex-col sm:flex-row sm:items-start">
        <button
          type="button"
          aria-pressed={active}
          onClick={() => onSelect(active ? null : rank.code)}
          className="flex w-full min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-start sm:gap-4"
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
            {text.advice ? <span className="text-xs text-foreground">{t(text.advice)}</span> : null}
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
        {fixChat.available ? (
          <div className="shrink-0 px-3 pb-2.5 sm:py-2.5 sm:pl-0">
            <MonitoringFixChatButton fixChat={fixChat} />
          </div>
        ) : null}
      </div>
      {fixChat.failure !== null || fixChat.started !== null ? (
        <div className="flex flex-col gap-1 px-3 pb-2.5">
          <MonitoringFixChatStatus fixChat={fixChat} />
        </div>
      ) : null}
    </li>
  );
}
