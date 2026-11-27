import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { registerCommands } from "../shortcuts/dispatcher";
import { t } from "~/i18n";
import { collectCaptureContext, type UiCaptureContext } from "./captureContext";
import {
  addUiCapture,
  loadUiCaptures,
  MAX_UI_CAPTURE_NOTE_LENGTH,
  type UiCapture,
} from "./captureStore";
import { REMINDER_HOUR, claimEveningReminder, msUntilNextReminderCheck } from "./reminder";
import { hasDesktopUiFeedbackBridge, refreshDesktopUiFeedbackExport } from "./uiFeedbackExport";
import {
  flushUsageCounters,
  recordUsage,
  syncUsageCounters,
  USAGE_COUNTERS_STORAGE_KEY,
} from "./usageCounters";
import { resolveUsageTarget } from "./usageTarget";

interface PendingCapture {
  readonly createdAt: string;
  readonly context: UiCaptureContext;
  /** Taken when the key was pressed so the dialog is not in it; kept only if the person opts in. */
  readonly screenshot: Promise<string | null> | null;
}

const useCaptureRequest = create<{ pending: PendingCapture | null }>(() => ({ pending: null }));

let lastPointer: { x: number; y: number } | null = null;
// A keyboard user's focus beats a pointer parked elsewhere: whichever moved last describes the capture.
let focusMovedSincePointer = false;
const REMINDER_CHECK_AFTER_LOAD_MS = 60_000;
const DESKTOP_EXPORT_INTERVAL_MS = 3_600_000;

function captureWindowScreenshot(): Promise<string | null> | null {
  const bridge = window.desktopBridge?.uiFeedback;
  if (bridge === undefined) return null;
  return bridge.captureWindow().then(
    (screenshot) => screenshot?.dataUrl ?? null,
    (cause: unknown) => {
      console.warn("Could not capture the window for UI feedback.", cause);
      return null;
    },
  );
}

/** Opens the capture dialog with what is on screen now. */
function openUiFeedbackCapture(route: string): void {
  if (useCaptureRequest.getState().pending !== null) return;
  useCaptureRequest.setState({
    pending: {
      createdAt: new Date().toISOString(),
      context: collectCaptureContext({
        document,
        route,
        pointer: focusMovedSincePointer ? null : lastPointer,
      }),
      screenshot: captureWindowScreenshot(),
    },
  });
}

function useUiFeedbackListeners(readRoute: () => string) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs document listeners and the capture keybinding for the app's lifetime
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      focusMovedSincePointer = false;
    };
    const onFocusIn = () => {
      focusMovedSincePointer = true;
    };
    const onClick = (event: MouseEvent) => {
      const key = resolveUsageTarget(event.target instanceof Element ? event.target : null);
      if (key !== null) recordUsage(key);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === USAGE_COUNTERS_STORAGE_KEY) syncUsageCounters();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushUsageCounters();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
    document.addEventListener("focusin", onFocusIn, { passive: true, capture: true });
    document.addEventListener("click", onClick, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flushUsageCounters);
    window.addEventListener("storage", onStorage);
    const disposeCommands = registerCommands({
      "uiFeedback.capture": (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        openUiFeedbackCapture(readRoute());
      },
    });
    const exportTimer = hasDesktopUiFeedbackBridge()
      ? window.setInterval(refreshDesktopUiFeedbackExport, DESKTOP_EXPORT_INTERVAL_MS)
      : null;
    return () => {
      window.removeEventListener("pointermove", onPointerMove, { capture: true });
      document.removeEventListener("focusin", onFocusIn, { capture: true });
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flushUsageCounters);
      window.removeEventListener("storage", onStorage);
      disposeCommands();
      if (exportTimer !== null) window.clearInterval(exportTimer);
      flushUsageCounters();
    };
  }, [readRoute]);
}

async function maybeShowReminder(readRoute: () => string): Promise<void> {
  const claimed = await claimEveningReminder(new Date(), async () => {
    const captures = await loadUiCaptures();
    return captures[0]?.createdAt ?? null;
  });
  if (!claimed) return;
  const toastId = toastManager.add({
    type: "info",
    title: t("Anything annoy you today?"),
    description: t("Capture it in a few words. It stays on this device."),
    timeout: 0,
    actionProps: {
      children: t("Capture"),
      onClick: () => {
        toastManager.close(toastId);
        openUiFeedbackCapture(readRoute());
      },
    },
  });
}

function useEveningReminder(readRoute: () => string) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules the once-a-day evening reminder against the wall clock
  useEffect(() => {
    let timer: number | undefined;
    const check = () => {
      maybeShowReminder(readRoute).catch((cause: unknown) => {
        console.warn("Could not check the UI feedback reminder.", cause);
      });
    };
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        check();
        schedule(msUntilNextReminderCheck(new Date()));
      }, delay);
    };
    const now = new Date();
    // Already evening: check after the app settles instead of during startup.
    schedule(
      now.getHours() >= REMINDER_HOUR
        ? REMINDER_CHECK_AFTER_LOAD_MS
        : msUntilNextReminderCheck(now),
    );
    // Timers stall while a laptop sleeps; coming back to the window catches up.
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [readRoute]);
}

export function UiFeedbackHost() {
  const router = useRouter();
  const readRoute = () => router.state.location.pathname;
  useUiFeedbackListeners(readRoute);
  useEveningReminder(readRoute);
  const pending = useCaptureRequest((state) => state.pending);
  return pending ? <UiFeedbackCaptureDialog pending={pending} /> : null;
}

function close() {
  useCaptureRequest.setState({ pending: null });
}

function UiFeedbackCaptureDialog({ pending }: { pending: PendingCapture }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [attachScreenshot, setAttachScreenshot] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the window image, taken asynchronously by the desktop app, so it can be checked before saving
  useEffect(() => {
    if (!attachScreenshot || pending.screenshot === null) return;
    let cancelled = false;
    void pending.screenshot.then((dataUrl) => {
      if (!cancelled) setPreview(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [attachScreenshot, pending.screenshot]);

  const save = async () => {
    setSaving(true);
    try {
      const screenshot = attachScreenshot && pending.screenshot ? await pending.screenshot : null;
      const capture: UiCapture = {
        ...pending.context,
        id: randomUUID(),
        createdAt: pending.createdAt,
        note: note.trim(),
        hasScreenshot: screenshot !== null,
      };
      await addUiCapture(capture, screenshot);
      close();
      toastManager.add({ type: "success", title: t("UI feedback saved"), timeout: 2000 });
      refreshDesktopUiFeedbackExport();
    } catch (cause) {
      console.error("Could not save UI feedback.", cause);
      setSaving(false);
      toastManager.add({
        type: "error",
        title: t("Could not save UI feedback"),
        description: t("Try again, or check that this browser allows site storage."),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) close();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("What annoyed you?")}</DialogTitle>
            <DialogDescription>
              {t(
                "Saves where you are, the control under the pointer and your note, on this device only.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor={`${id}-note`}>{t("Note (optional)")}</Label>
                  <span id={`${id}-count`} className="text-xs tabular-nums text-muted-foreground">
                    {note.length} / {MAX_UI_CAPTURE_NOTE_LENGTH}
                  </span>
                </div>
                <Input
                  nativeInput
                  id={`${id}-note`}
                  autoFocus
                  maxLength={MAX_UI_CAPTURE_NOTE_LENGTH}
                  aria-describedby={`${id}-count`}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              {pending.screenshot !== null ? (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={attachScreenshot}
                    onCheckedChange={(checked) => setAttachScreenshot(checked === true)}
                  />
                  <span>
                    {t("Attach a screenshot of the window")}
                    <span className="block text-xs text-muted-foreground">
                      {t("Check it for secrets first: it is kept with this capture.")}
                    </span>
                  </span>
                </label>
              ) : null}
              {attachScreenshot && preview !== null ? (
                // Full size in a scrolling frame, so small text can be read before saving.
                <div
                  role="region"
                  aria-label={t("Screenshot preview")}
                  tabIndex={0}
                  className="max-h-64 overflow-auto rounded-md border border-border/60"
                >
                  <img
                    src={preview}
                    alt={t("Screenshot of the window at this capture")}
                    className="max-w-none"
                  />
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={saving}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
