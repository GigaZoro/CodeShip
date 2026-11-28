import { ActivityIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { t, tn } from "~/i18n";
import { cn } from "~/lib/utils";

import { RelativeTime } from "./RelativeTime";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { noticeLog, type NoticeRecord } from "./ui/toastNoticeLog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function useActivityEntries(): ReadonlyArray<NoticeRecord> {
  const records = useSyncExternalStore(noticeLog.subscribe, noticeLog.getSnapshot);
  return records.filter((record) => record.delivery === "activity-log");
}

function EntryTime({ at }: { at: number }) {
  const timestamp = new Date(at).toISOString();
  return (
    <time className="shrink-0 text-xs text-muted-foreground" dateTime={timestamp}>
      <RelativeTime timestamp={timestamp} />
    </time>
  );
}

function ActivityEntry({ record }: { record: NoticeRecord }) {
  const action = record.outcome === "open" ? record.actionProps : undefined;
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 font-medium text-sm">{record.title}</span>
        <EntryTime at={record.lastAt} />
      </div>
      {record.description ? (
        <div className="text-muted-foreground text-xs">{record.description}</div>
      ) : null}
      {record.expandableContent ? (
        <div className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs">
          {record.expandableContent}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span>{record.outcome === "open" ? t("Ongoing") : t("Resolved")}</span>
        {record.count > 1 ? (
          <span className="tabular-nums">{tn(record.count, "{count} time", "{count} times")}</span>
        ) : null}
        {action ? (
          <Button
            {...action}
            className="ml-auto"
            onClick={(event) => {
              noticeLog.markClicked(record.id);
              action.onClick?.(event);
            }}
            size="xs"
            variant="outline"
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * Background notices that do not need the user now (slow requests, host recoveries, clone
 * progress) land here instead of the toast stack. No live region: the toast stack announces
 * what matters, and these would only interrupt.
 */
export function NoticeActivityLog({ onBackdrop }: { onBackdrop: boolean }) {
  const entries = useActivityEntries();
  const seenAt = useSyncExternalStore(noticeLog.subscribe, noticeLog.lastSeenAt);
  const unseen = entries.filter((record) => record.lastAt > seenAt).length;
  const label =
    unseen > 0 ? t("Background notices, {count} new", { count: unseen }) : t("Background notices");

  return (
    <Popover
      // On close as well: entries that arrived while it was open were seen too.
      onOpenChange={() => noticeLog.markSeen()}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={label}
                  className={cn(
                    "relative [-webkit-app-region:no-drag]",
                    onBackdrop && "top-auto translate-y-0",
                  )}
                  size="icon-sm"
                  variant={onBackdrop ? "media-navigation" : "ghost"}
                />
              }
            />
          }
        >
          <ActivityIcon className="size-3.5" />
          {/* A shape cue as well as a colour: the dot is absent when nothing is new. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background",
              unseen === 0 && "invisible",
            )}
            data-slot="activity-unseen-dot"
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" padding="compact" width="md">
        <PopoverTitle className="mb-1">{t("Background notices")}</PopoverTitle>
        {entries.length > 0 ? (
          <ul>
            {entries.map((record) => (
              <ActivityEntry key={record.id} record={record} />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-muted-foreground text-xs">
            {t("Background updates such as slow requests and clone progress show here.")}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}
