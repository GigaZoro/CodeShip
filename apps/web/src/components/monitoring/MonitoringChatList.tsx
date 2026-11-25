import { Link } from "@tanstack/react-router";
import {
  formatMonitoringTime,
  mainModel,
  missingEnvironments,
  type ChatSortKey,
  type MissingEnvironments,
  type MonitoringChat,
  type MonitoringChatOrder,
  type MonitoringChatsView,
  type MonitoringRetry,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, InfoIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveHour12 } from "../../timestampFormat";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { KIND_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { msg, t, tn } from "~/i18n";

export const MONITORING_PAGE_SIZE = 50;

const COLUMNS = [
  { key: "settledAt", label: msg("Settled") },
  { key: "lifetimeMs", label: msg("Lifetime") },
  { key: "activeMs", label: msg("Active") },
  { key: "costUsd", label: msg("Cost") },
  { key: "findings", label: msg("Findings") },
] as const satisfies ReadonlyArray<{ key: ChatSortKey; label: ReturnType<typeof msg> }>;

/** Stays focusable while busy, so a keyboard user who pressed it keeps their place. */
export function RetryButton({
  retry,
  onRetry,
}: {
  readonly retry: Exclude<MonitoringRetry, "unavailable">;
  readonly onRetry: () => void;
}) {
  const busy = retry === "busy";
  return (
    <Button
      size="xs"
      variant="outline"
      aria-busy={busy}
      aria-disabled={busy}
      onClick={busy ? undefined : onRetry}
    >
      {t("Retry")}
    </Button>
  );
}

/** Names the environments a view has not counted, with Retry for those that could not be read. */
export function MissingEnvironmentNotes({
  missing,
  retry,
  onRetry,
}: {
  readonly missing: MissingEnvironments;
  readonly retry: MonitoringRetry;
  readonly onRetry: () => void;
}) {
  return (
    <>
      {missing.unreadable ? (
        <Alert variant="warning" role={undefined}>
          <CircleAlertIcon />
          <AlertDescription>
            {t("Could not refresh these environments: {names}", {
              names: missing.unreadable,
            })}
          </AlertDescription>
          {retry === "unavailable" ? null : (
            <AlertAction>
              <RetryButton retry={retry} onRetry={onRetry} />
            </AlertAction>
          )}
        </Alert>
      ) : null}
      {missing.waiting ? (
        <Alert variant="info" role={undefined}>
          <InfoIcon />
          <AlertDescription>
            {t("Waiting for these environments: {names}", { names: missing.waiting })}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * Paged rather than virtualized: a page of fifty rows keeps the table a real table for keyboards
 * and screen readers. Each environment sorts and counts its own chats and sends them a page at a
 * time; this merges them.
 */
export function MonitoringChatList({
  view,
  updating,
  retry,
  sortedBy,
  order,
  onOrderChange,
  onRetry,
  projectTitleOf,
}: {
  readonly view: MonitoringChatsView;
  readonly updating: boolean;
  readonly retry: MonitoringRetry;
  /** The order of the rows on screen, which stays the previous one while `order` loads. */
  readonly sortedBy: MonitoringChatOrder;
  readonly order: MonitoringChatOrder;
  readonly onOrderChange: (order: MonitoringChatOrder) => void;
  readonly onRetry: () => void;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const notes = (
    <div role="status" className="flex h-20 flex-col gap-2 overflow-y-auto">
      {view.stale ? (
        <p className="text-sm text-muted-foreground">{t("Showing previous monitoring results.")}</p>
      ) : null}
      <MissingEnvironmentNotes
        missing={missingEnvironments(view)}
        retry={retry}
        onRetry={onRetry}
      />
    </div>
  );

  // Without every answer, a failure keeps the table and its headers, so a failed sort can change.
  if (view.isLoading && view.unreadable.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {notes}
        <Skeleton className="h-64 w-full" aria-busy />
      </div>
    );
  }

  if (view.chats.length === 0 && view.complete) {
    return (
      <div className="flex flex-col gap-3">
        {notes}
        <p className="text-sm text-muted-foreground">{t("No chats match these filters.")}</p>
      </div>
    );
  }

  const more = view.chats.length < view.total;
  const resorting = sortedBy.sort !== order.sort || sortedBy.direction !== order.direction;
  return (
    <div className="flex flex-col gap-3">
      {notes}
      <div
        className={cn("tabular-nums transition-opacity", resorting && "opacity-40 delay-150")}
        aria-busy={updating}
      >
        <Table aria-label={t("Settled chats")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Chat")}</TableHead>
              {COLUMNS.map((column) => {
                const active = order.sort === column.key;
                return (
                  <TableHead
                    key={column.key}
                    className="text-right"
                    aria-sort={
                      sortedBy.sort === column.key
                        ? sortedBy.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        onOrderChange({
                          sort: column.key,
                          direction: active && order.direction === "desc" ? "asc" : "desc",
                          limit: order.limit,
                        })
                      }
                    >
                      {t(column.label)}
                      {active ? (
                        order.direction === "asc" ? (
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
            {view.chats.map((chat) => {
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
                    {formatMonitoringTime(summary.settledAt, hour12)}
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
      {view.chats.length > 0 ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {tn(view.total, "Showing {shown} of {count} chat", "Showing {shown} of {count} chats", {
              shown: view.chats.length,
            })}
          </span>
          {more ? (
            <Button
              variant="outline"
              size="sm"
              disabled={updating}
              onClick={() => onOrderChange({ ...order, limit: order.limit + MONITORING_PAGE_SIZE })}
            >
              {t("Show more")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
