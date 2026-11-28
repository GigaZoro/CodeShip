import { useSyncExternalStore } from "react";

import { getFormattingLocale, t } from "~/i18n";

import { RelativeTime } from "../RelativeTime";
import { ScrollArea } from "../ui/scroll-area";
import {
  NOTICE_LOG_CAPACITY,
  noticeLog,
  summarizeNoticeEmitters,
  type NoticeEmitterSummary,
} from "../ui/toastNoticeLog";
import { SettingsSection } from "./settingsLayout";

const cellClassName = "whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums";

function EmitterRow({
  emitter,
  format,
}: {
  emitter: NoticeEmitterSummary;
  format: Intl.NumberFormat;
}) {
  return (
    <tr>
      <td className="px-4 py-3 align-top first:sm:pl-5">
        <div className="font-medium font-mono text-foreground text-xs">{emitter.source}</div>
        <div className="mt-0.5 truncate text-muted-foreground">{emitter.lastTitle}</div>
      </td>
      <td className={cellClassName}>{format.format(emitter.shown)}</td>
      <td className={cellClassName}>{format.format(emitter.toasts)}</td>
      <td className={cellClassName}>{format.format(emitter.logged)}</td>
      <td className={cellClassName}>{format.format(emitter.clicked)}</td>
      <td className={cellClassName}>{format.format(emitter.dismissed)}</td>
      <td className={cellClassName}>{format.format(emitter.autoDismissed)}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
        <RelativeTime timestamp={new Date(emitter.lastAt).toISOString()} />
      </td>
    </tr>
  );
}

/** Which parts of this window raise the most notices, from the in-memory notice log. */
export function RecentNoticesDiagnostics() {
  const records = useSyncExternalStore(noticeLog.subscribe, noticeLog.getSnapshot);
  const emitters = summarizeNoticeEmitters(records);
  const format = new Intl.NumberFormat(getFormattingLocale());
  const headers = [
    t("Source"),
    t("Shown"),
    t("Toasts"),
    t("In background"),
    t("Clicked"),
    t("Closed by you"),
    t("Auto-dismissed"),
    t("Last"),
  ];

  return (
    <SettingsSection
      id="recent-notices"
      title={t("Recent notices")}
      headerAction={
        <span className="text-muted-foreground text-xs">
          {t("Last {count} in this window", { count: NOTICE_LOG_CAPACITY })}
        </span>
      }
    >
      {emitters.length > 0 ? (
        <ScrollArea
          radius="none"
          chainVerticalScroll
          scrollFade
          hideScrollbars
          className="w-full max-w-full"
        >
          <table className="w-full min-w-[840px] table-fixed text-left text-xs">
            <colgroup>
              <col className="w-[30%]" />
              {headers.slice(1).map((header) => (
                <col key={header} className="w-[10%]" />
              ))}
            </colgroup>
            <thead className="border-b border-border/60 text-2xs text-muted-foreground uppercase tracking-widest">
              <tr>
                {headers.map((header) => (
                  <th
                    key={header}
                    className="px-4 py-2.5 font-medium first:sm:pl-5 last:sm:pr-5"
                    scope="col"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {emitters.map((emitter) => (
                <EmitterRow key={emitter.source} emitter={emitter} format={format} />
              ))}
            </tbody>
          </table>
        </ScrollArea>
      ) : (
        <div className="px-4 py-4 text-muted-foreground text-xs sm:px-5">
          {t("No notices since this window opened.")}
        </div>
      )}
    </SettingsSection>
  );
}
