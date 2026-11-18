import { Link } from "@tanstack/react-router";
import type { MonitoringChat } from "@t3tools/client-runtime/monitoring";
import { MONITORING_CHAT_LIMIT_MAX, type MonitoringChatSort } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatDateTimeShort, formatUsd } from "@t3tools/shared/usageFormat";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { KIND_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { msg, t, tn } from "~/i18n";

export const CHAT_PAGE_SIZE = 50;

const COLUMNS = [
  { key: "settledAt", label: msg("Settled") },
  { key: "lifetimeMs", label: msg("Lifetime") },
  { key: "activeMs", label: msg("Active") },
  { key: "costUsd", label: msg("Cost") },
  { key: "findings", label: msg("Findings") },
] as const satisfies ReadonlyArray<{
  key: MonitoringChatSort["key"];
  label: ReturnType<typeof msg>;
}>;

/**
 * Paged rather than virtualized: a page of fifty rows keeps the table a real table for keyboards
 * and screen readers. The server sorts and cuts the list, so more rows are asked for, not revealed.
 */
export function MonitoringChatList({
  chats,
  listedChats,
  sort,
  onSortChange,
  chatLimit,
  onShowMore,
  projectTitleOf,
}: {
  readonly chats: ReadonlyArray<MonitoringChat>;
  /** Chats the filters list in all, which may exceed `chats`. */
  readonly listedChats: number;
  readonly sort: MonitoringChatSort;
  readonly onSortChange: (sort: MonitoringChatSort) => void;
  readonly chatLimit: number;
  readonly onShowMore: () => void;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  if (listedChats === 0) {
    return <p className="text-sm text-muted-foreground">{t("No chats match these filters.")}</p>;
  }
  const hasMore = chats.length < listedChats;
  const capReached = chatLimit >= MONITORING_CHAT_LIMIT_MAX;

  return (
    <div className="flex flex-col gap-3">
      <div className="tabular-nums">
        <Table aria-label={t("Settled chats")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Chat")}</TableHead>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <TableHead
                    key={column.key}
                    className="text-right"
                    aria-sort={
                      active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                    }
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        onSortChange(
                          active
                            ? {
                                key: column.key,
                                direction: sort.direction === "asc" ? "desc" : "asc",
                              }
                            : { key: column.key, direction: "desc" },
                        )
                      }
                    >
                      {t(column.label)}
                      {active ? (
                        sort.direction === "asc" ? (
                          <ArrowUpIcon aria-hidden />
                        ) : (
                          <ArrowDownIcon aria-hidden />
                        )
                      ) : null}
                    </Button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {chats.map((chat) => {
              const { row } = chat;
              return (
                <TableRow key={`${chat.environmentId}:${row.threadId}`}>
                  <TableCell className="max-w-80">
                    <Link
                      to="/monitoring"
                      search={{ environment: chat.environmentId, thread: row.threadId }}
                      className="block truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
                    >
                      {row.title || t("Untitled chat")}
                    </Link>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{projectTitleOf(chat)}</span>
                      {row.model ? <span className="truncate">· {row.model}</span> : null}
                      {row.kind !== "interactive" ? (
                        <Badge size="sm" variant="outline">
                          {t(KIND_LABEL[row.kind])}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{formatDateTimeShort(row.settledAt)}</TableCell>
                  <TableCell className="text-right">{formatDuration(row.lifetimeMs)}</TableCell>
                  <TableCell className="text-right">{formatDuration(row.activeMs)}</TableCell>
                  <TableCell className="text-right">{formatUsd(row.costUsd)}</TableCell>
                  <TableCell className="text-right">{formatCount(row.findings)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {tn(listedChats, "Showing {shown} of {count} chat", "Showing {shown} of {count} chats", {
            shown: chats.length,
          })}
        </span>
        {hasMore && !capReached ? (
          <Button variant="outline" size="sm" onClick={onShowMore}>
            {t("Show more")}
          </Button>
        ) : null}
      </div>
      {hasMore && capReached ? (
        <p className="text-xs text-muted-foreground">{t("Narrow the filters to see the rest.")}</p>
      ) : null}
    </div>
  );
}
