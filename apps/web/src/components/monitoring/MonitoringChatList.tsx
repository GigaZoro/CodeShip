import { Link } from "@tanstack/react-router";
import {
  mainModel,
  sortChats,
  type ChatSortKey,
  type MonitoringChat,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatDateTimeShort, formatUsd } from "@t3tools/shared/usageFormat";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { KIND_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { msg, t, tn } from "~/i18n";

const PAGE_SIZE = 50;

const COLUMNS = [
  { key: "settledAt", label: msg("Settled") },
  { key: "lifetimeMs", label: msg("Lifetime") },
  { key: "activeMs", label: msg("Active") },
  { key: "costUsd", label: msg("Cost") },
  { key: "findings", label: msg("Findings") },
] as const satisfies ReadonlyArray<{ key: ChatSortKey; label: ReturnType<typeof msg> }>;

/**
 * Paged rather than virtualized: a page of fifty rows keeps the table a real table for keyboards
 * and screen readers, and the list holds at most 2000 chats.
 */
export function MonitoringChatList({
  chats,
  projectTitleOf,
}: {
  readonly chats: ReadonlyArray<MonitoringChat>;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  const [sort, setSort] = useState<{ key: ChatSortKey; direction: "asc" | "desc" }>({
    key: "settledAt",
    direction: "desc",
  });
  const [shown, setShown] = useState(PAGE_SIZE);
  const sorted = sortChats(chats, sort.key, sort.direction);
  const visible = sorted.slice(0, shown);

  if (chats.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No chats match these filters.")}</p>;
  }

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
                      onClick={() => {
                        setSort(
                          active
                            ? {
                                key: column.key,
                                direction: sort.direction === "asc" ? "desc" : "asc",
                              }
                            : { key: column.key, direction: "desc" },
                        );
                        setShown(PAGE_SIZE);
                      }}
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
            {visible.map((chat) => {
              const { summary } = chat;
              const model = mainModel(summary);
              return (
                <TableRow key={`${chat.environmentId}:${summary.threadId}`}>
                  <TableCell className="max-w-80">
                    <Link
                      to="/monitoring"
                      search={{ environment: chat.environmentId, thread: summary.threadId }}
                      className="block truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
                    >
                      {summary.title || t("Untitled chat")}
                    </Link>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{projectTitleOf(chat)}</span>
                      {model ? <span className="truncate">· {model}</span> : null}
                      {summary.kind !== "interactive" ? (
                        <Badge size="sm" variant="outline">
                          {t(KIND_LABEL[summary.kind])}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatDateTimeShort(summary.settledAt)}
                  </TableCell>
                  <TableCell className="text-right">{formatDuration(summary.lifetimeMs)}</TableCell>
                  <TableCell className="text-right">{formatDuration(summary.activeMs)}</TableCell>
                  <TableCell className="text-right">{formatUsd(summary.costUsd)}</TableCell>
                  <TableCell className="text-right">
                    {formatCount(summary.findings.length)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {tn(chats.length, "Showing {shown} of {count} chat", "Showing {shown} of {count} chats", {
            shown: visible.length,
          })}
        </span>
        {visible.length < sorted.length ? (
          <Button variant="outline" size="sm" onClick={() => setShown(shown + PAGE_SIZE)}>
            {t("Show more")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
