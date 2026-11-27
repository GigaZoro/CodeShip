import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { requestConfirmDialog } from "../confirmDialog";
import { shortcutLabelForCommand } from "../keybindings";
import { downloadMarkdownFile } from "../proposedPlan";
import { primaryServerKeybindingsAtom } from "../state/server";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { getFormattingLocale, msg, t, type Message } from "~/i18n";
import {
  clearUiCaptures,
  deleteUiCapture,
  getUiCaptureScreenshot,
  loadUiCaptures,
  readUiCapturesSnapshot,
  subscribeUiCaptures,
  type UiCapture,
} from "./captureStore";
import { readReminderState, UiFeedbackReminderMode, writeReminderState } from "./reminder";
import {
  buildUiFeedbackMarkdown,
  refreshDesktopUiFeedbackExport,
  uiFeedbackExportFilename,
  writeDesktopUiFeedbackExport,
} from "./uiFeedbackExport";
import { clearUsageCounters, readUsageCounters, subscribeUsageCounters } from "./usageCounters";
import { USAGE_AREAS, type UsageArea } from "./usageTarget";

const REMINDER_LABELS: Readonly<Record<UiFeedbackReminderMode, Message>> = {
  auto: msg("After two days without a capture"),
  on: msg("Every evening"),
  off: msg("Off"),
};

const AREA_TITLES: Readonly<Record<UsageArea, Message>> = {
  nav: msg("Nav rail"),
  details: msg("Thread details"),
  composer: msg("Composer"),
};

const isReminderMode = Schema.is(UiFeedbackReminderMode);

function CaptureScreenshot({ id }: { id: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this capture's image from IndexedDB only when its row is shown
  useEffect(() => {
    let cancelled = false;
    getUiCaptureScreenshot(id).then(
      (value) => {
        if (!cancelled) setDataUrl(value);
      },
      (cause: unknown) => console.warn("Could not read a UI feedback screenshot.", cause),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (dataUrl === null) return null;
  return (
    <img
      src={dataUrl}
      alt={t("Screenshot of the window at this capture")}
      className="mt-2 max-h-48 w-auto max-w-full rounded-md border border-border/60"
      loading="lazy"
    />
  );
}

function CaptureItem({ capture }: { capture: UiCapture }) {
  const time = formatRelativeTimeLabel(capture.createdAt);
  return (
    <li className="flex gap-3 border-border/60 border-t px-4 py-3 first:border-t-0 sm:px-5">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-foreground">
          {capture.note.length > 0 ? capture.note : t("No note")}
        </p>
        <p className="text-xs text-muted-foreground">
          <time dateTime={capture.createdAt}>{time}</time>
          {" · "}
          <span className="font-mono">{capture.route}</span>
        </p>
        {capture.componentIds[0] ? (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {capture.componentIds[0]}
          </p>
        ) : null}
        {capture.hasScreenshot ? <CaptureScreenshot id={capture.id} /> : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("Delete capture from {time}", { time })}
        onClick={() => {
          deleteUiCapture(capture.id).then(refreshDesktopUiFeedbackExport, (cause: unknown) => {
            console.error("Could not delete a UI feedback capture.", cause);
            toastManager.add({ type: "error", title: t("Could not delete the capture") });
          });
        }}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    </li>
  );
}

function UsageCounterTables() {
  const counters = useSyncExternalStore(subscribeUsageCounters, readUsageCounters);
  const entries = Object.entries(counters.counts);
  if (entries.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">
        {t("No clicks counted yet.")}
      </p>
    );
  }
  return (
    <div className="grid gap-4 px-4 py-3 sm:grid-cols-3 sm:px-5">
      {USAGE_AREAS.map((prefix) => {
        const rows = entries
          .filter(([key]) => key.startsWith(`${prefix}:`))
          .toSorted(([, left], [, right]) => right - left);
        return (
          <table key={prefix} className="w-full self-start text-xs">
            <caption className="pb-1 text-left font-medium text-foreground">
              {t(AREA_TITLES[prefix])}
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">{t("Control")}</th>
                <th scope="col">{t("Clicks")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="text-muted-foreground">{t("No clicks yet")}</td>
                </tr>
              ) : (
                rows.map(([key, count]) => (
                  <tr key={key}>
                    <td className="py-0.5 pr-2 font-mono break-all text-muted-foreground">
                      {key.slice(prefix.length + 1)}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

export function UiFeedbackSettingsSection() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "uiFeedback.capture");
  const captures = useSyncExternalStore(subscribeUiCaptures, readUiCapturesSnapshot);
  const counters = useSyncExternalStore(subscribeUsageCounters, readUsageCounters);
  const [reminder, setReminder] = useState(() => readReminderState());
  const [loadError, setLoadError] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the captures from IndexedDB once the section mounts
  useEffect(() => {
    loadUiCaptures().catch((cause: unknown) => {
      console.error("Could not load UI feedback captures.", cause);
      setLoadError(true);
    });
  }, []);

  const exportMarkdown = async () => {
    let markdown: string;
    try {
      markdown = await buildUiFeedbackMarkdown();
      downloadMarkdownFile(uiFeedbackExportFilename(), markdown);
    } catch (cause) {
      console.error("Could not export UI feedback.", cause);
      toastManager.add({ type: "error", title: t("Could not export UI feedback") });
      return;
    }
    const desktopPath = await writeDesktopUiFeedbackExport(markdown).catch((cause: unknown) => {
      console.warn("Could not write the UI feedback export file.", cause);
      return null;
    });
    toastManager.add({
      type: "success",
      title: t("Exported UI feedback"),
      ...(desktopPath ? { description: desktopPath } : {}),
    });
  };

  const clearAll = async () => {
    const confirmed = await requestConfirmDialog(
      t("Delete every UI feedback capture and reset the click counters?"),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    try {
      await clearUiCaptures();
      clearUsageCounters();
      refreshDesktopUiFeedbackExport();
    } catch (cause) {
      console.error("Could not clear UI feedback.", cause);
      toastManager.add({ type: "error", title: t("Could not clear UI feedback") });
    }
  };

  const isEmpty = (captures?.length ?? 0) === 0 && Object.keys(counters.counts).length === 0;

  return (
    <SettingsSection
      id="ui-feedback"
      title={t("UI feedback")}
      headerAction={
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => void exportMarkdown()}>
            <DownloadIcon aria-hidden="true" />
            {t("Export as Markdown")}
          </Button>
          <Button size="xs" variant="outline" disabled={isEmpty} onClick={() => void clearAll()}>
            {t("Clear")}
          </Button>
        </div>
      }
    >
      <SettingsRow
        title={t("Capture key")}
        description={
          shortcut
            ? t(
                "Press {shortcut} when something annoys you. The app saves where you are, the control under the pointer and a short note, on this device only.",
                { shortcut },
              )
            : t("Set a key for Capture UI Feedback in Keybindings to save what annoys you.")
        }
      />
      <SettingsRow
        {...searchableSetting("ui-feedback-reminder")}
        description={t("An evening note that asks what annoyed you today.")}
        control={
          <div className="w-full sm:w-56">
            <Select
              value={reminder.mode}
              onValueChange={(value) => {
                if (!isReminderMode(value)) return;
                const next = { ...reminder, mode: value };
                writeReminderState(next);
                setReminder(next);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0"
                aria-label={t("Evening reminder")}
              >
                <SelectValue>{t(REMINDER_LABELS[reminder.mode])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="auto">{t(REMINDER_LABELS.auto)}</SelectItem>
                <SelectItem value="on">{t(REMINDER_LABELS.on)}</SelectItem>
                <SelectItem value="off">{t(REMINDER_LABELS.off)}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <div>
        <h3 className="px-4 pt-3 text-xs font-medium text-muted-foreground sm:px-5">
          {t("Captures")}
        </h3>
        {loadError ? (
          <p className="px-4 py-3 text-sm text-destructive-foreground sm:px-5">
            {t("Could not read the captures saved in this browser.")}
          </p>
        ) : captures === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">{t("Loading…")}</p>
        ) : captures.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">{t("No captures yet.")}</p>
        ) : (
          <ul>
            {captures.map((capture) => (
              <CaptureItem key={capture.id} capture={capture} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="px-4 pt-3 text-xs font-medium text-muted-foreground sm:px-5">
          {t("Clicks since {date}", {
            date: new Date(counters.since).toLocaleDateString(getFormattingLocale()),
          })}
        </h3>
        <UsageCounterTables />
      </div>
    </SettingsSection>
  );
}
