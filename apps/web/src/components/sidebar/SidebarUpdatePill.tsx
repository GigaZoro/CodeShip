import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type DesktopUpdateButtonAction,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmationMessage,
  getSafeUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdatePendingAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
  waitToInstallAutomatically,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { restartHoldTooltip } from "../restartHold.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SafeUpdateDialog, useThisAppRunningThreads } from "./SafeUpdateDialog";
import {
  pendingLocalInstallAtom,
  readHostedBackgroundWork,
  usePendingLocalInstall,
  usePendingLocalInstallWork,
  waitForHostedBackgroundWork,
} from "./localInstallWait";
import { PendingLocalInstallDialog } from "./PendingLocalInstallDialog";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type {
  UpdateEverythingRun,
  UpdateEverythingSelection,
  UpdateRunLocalState,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";

import { t } from "~/i18n";
type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && (state?.releaseNotes.length ?? 0) > 0;
}

function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
}: {
  readonly action: DesktopUpdateButtonAction;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = isDownloading
    ? "downloading"
    : run !== null
      ? run.localVersion !== null && action === "install"
        ? "downloaded"
        : "everything"
      : showsEverything
        ? "everything"
        : action === "install"
          ? "downloaded"
          : "available";

  return { iconStatus, showUpdateDetails } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t("Intel build on Apple Silicon")}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

export async function downloadLocalUpdate(
  bridge: DesktopBridge,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
  }: { readonly notifyDownloaded: boolean; readonly reportError?: ReportLocalUpdateError },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) reportError(t("Could not download update"), actionError);
    return result.completed;
  } catch (error) {
    reportError(
      t("Could not start update download"),
      error instanceof Error ? error.message : t("An unexpected error occurred."),
    );
    return false;
  }
}

export async function installLocalUpdate(
  bridge: DesktopBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
  expectedVersion?: string,
): Promise<boolean> {
  try {
    // Every install started here resumes running threads, whatever the restart setting says.
    const result = await bridge.installUpdate(expectedVersion, { resumeThreads: true });
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return false;
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (!actionError) return true;
    reportError(t("Could not install update"), actionError);
    return false;
  } catch (error) {
    reportError(
      t("Could not install update"),
      error instanceof Error ? error.message : t("An unexpected error occurred."),
    );
    return false;
  }
}

/**
 * Installs once no chat on this app's servers waits on background work, which an install would
 * stop. Every surface reads `pendingLocalInstallAtom` to show the wait.
 */
export async function installLocalUpdateWhenIdle(
  bridge: DesktopBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
  expectedVersion?: string,
): Promise<boolean> {
  if (appAtomRegistry.get(pendingLocalInstallAtom) !== null) return false;
  appAtomRegistry.set(pendingLocalInstallAtom, { version: expectedVersion ?? null });
  try {
    const wait = await waitForHostedBackgroundWork();
    if (wait.status === "cancelled") return false;
    if (wait.status === "failed") {
      reportError(
        t("Could not wait for background work"),
        wait.error instanceof Error ? wait.error.message : t("An unexpected error occurred."),
      );
      return false;
    }
  } finally {
    appAtomRegistry.set(pendingLocalInstallAtom, null);
  }
  return installLocalUpdate(bridge, reportError, expectedVersion);
}

/**
 * "Install updates automatically when idle": installs once no chat on this app's servers has
 * background work, and only while the setting stays on (`isStillEnabled`, read right before).
 */
export async function installLocalUpdateAutomatically(
  bridge: DesktopBridge,
  version: string,
  isStillEnabled: () => boolean,
): Promise<boolean> {
  if (appAtomRegistry.get(pendingLocalInstallAtom) !== null) return false;
  appAtomRegistry.set(pendingLocalInstallAtom, { version, automatic: true });
  try {
    const readiness = await waitToInstallAutomatically({
      waitUntilIdle: () => waitForHostedBackgroundWork({ untilIdle: true }),
      readWorkNow: readHostedBackgroundWork,
      isStillEnabled,
    });
    if (readiness.status === "stop") return false;
    if (readiness.status === "failed") {
      toastUpdateError(
        t("Could not wait for background work"),
        readiness.error instanceof Error
          ? readiness.error.message
          : t("An unexpected error occurred."),
      );
      return false;
    }
  } finally {
    appAtomRegistry.set(pendingLocalInstallAtom, null);
  }
  return installLocalUpdate(bridge, toastUpdateError, version);
}

export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [isConfirmingSafeUpdate, setIsConfirmingSafeUpdate] = useState(false);
  const [isShowingPendingInstall, setIsShowingPendingInstall] = useState(false);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const pendingAction = resolveDesktopUpdatePendingAction(state);
  const thisAppThreads = useThisAppRunningThreads(pendingAction === "install");
  // The updater holds a found update until its background recheck finishes.
  const isWaitingOnRecheck = state?.status === "checking" && pendingAction !== "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && pendingAction !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const pendingInstall = usePendingLocalInstall();
  const pendingWork = usePendingLocalInstallWork();
  const isRunningEverything = run !== null;
  const { iconStatus, showUpdateDetails } = resolveSidebarUpdatePresentation({
    action: pendingAction,
    showsEverything: runsEverything,
    run,
    isDownloading,
  });
  const tooltip =
    pendingInstall !== null
      ? restartHoldTooltip(pendingWork)
      : runsEverything && !isWaitingOnRecheck
        ? everything.summary
        : state && action === "install" && thisAppThreads.count > 0
          ? getSafeUpdateButtonTooltip(state, thisAppThreads.count)
          : state
            ? getDesktopUpdateButtonTooltip(state)
            : t("Update available");
  const disabled = isWaitingOnRecheck || isDesktopUpdateButtonDisabled(state);
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;
  const showReleaseNotesPopover =
    !isRunningEverything && shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state);

  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesTriggerFocusVisible, setReleaseNotesTriggerFocusVisible] = useState(false);
  // Release notes close when they stop applying, and open when they start
  // applying while the trigger already holds keyboard focus.
  const [releaseNotesShownBefore, setReleaseNotesShownBefore] = useState(showReleaseNotesPopover);
  if (releaseNotesShownBefore !== showReleaseNotesPopover) {
    setReleaseNotesShownBefore(showReleaseNotesPopover);
    setReleaseNotesOpen(showReleaseNotesPopover && releaseNotesTriggerFocusVisible);
  }

  const handleAction = async () => {
    const bridge = window.desktopBridge;
    if (isInteractionDisabled) return;

    if (pendingInstall !== null) {
      setIsShowingPendingInstall(true);
      return;
    }

    if (runsEverything) {
      setIsConfirmingEverything(true);
      return;
    }

    if (!bridge || !state || action === "none") return;
    if (action === "install" && thisAppThreads.busy) {
      setIsConfirmingSafeUpdate(true);
      return;
    }
    setIsActionPending(true);

    if (action === "download") {
      void downloadLocalUpdate(bridge, { notifyDownloaded: true }).finally(() =>
        setIsActionPending(false),
      );
      return;
    }

    let confirmed = false;
    try {
      confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(state),
      );
    } catch (error) {
      setIsActionPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not confirm update"),
          description: error instanceof Error ? error.message : t("Update confirmation failed."),
        }),
      );
      return;
    }
    if (!confirmed) {
      setIsActionPending(false);
      return;
    }
    void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
  };

  const runEverything = async ({ local, excluded }: UpdateEverythingSelection) => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        excluded,
        ...(local && bridge && action === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(local && bridge && action !== "none"
          ? { installLocal: (reportError) => installLocalUpdateWhenIdle(bridge, reportError) }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not update everything"),
          description: error instanceof Error ? error.message : t("An unexpected error occurred."),
        }),
      );
    }
    setIsActionPending(false);
  };

  // Updates are checked automatically, so there is no button until one is found.
  if (!showUpdateDetails) return null;

  const statusIcon = (
    <DesktopUpdateStatusIcon downloadPercent={state?.downloadPercent ?? null} status={iconStatus} />
  );
  const confirmDialog = (
    <>
      <UpdateEverythingDialog
        open={isConfirmingEverything}
        onOpenChange={setIsConfirmingEverything}
        version={everything.version}
        rows={everything.rows}
        restarts={everything.restarts}
        selectable
        onConfirm={(selection) => void runEverything(selection)}
      />
      <SafeUpdateDialog
        open={isConfirmingSafeUpdate}
        onOpenChange={setIsConfirmingSafeUpdate}
        version={state ? getDesktopUpdateDownloadedVersion(state) : null}
        environmentIds={thisAppThreads.key}
        onConfirm={() => {
          const bridge = window.desktopBridge;
          setIsConfirmingSafeUpdate(false);
          if (!bridge) return;
          setIsActionPending(true);
          void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
        }}
        onConfirmWhenIdle={() => {
          const bridge = window.desktopBridge;
          setIsConfirmingSafeUpdate(false);
          if (bridge) void installLocalUpdateWhenIdle(bridge);
        }}
      />
      <PendingLocalInstallDialog
        open={isShowingPendingInstall}
        onOpenChange={setIsShowingPendingInstall}
      />
    </>
  );

  // A run shows its progress in the sidebar footer, where the text fits.
  if (run !== null) return confirmDialog;

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-sidebar-row-hover",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
        setReleaseNotesTriggerFocusVisible(false);
      }}
      onFocus={(event) => {
        const focusVisible = event.currentTarget.matches(":focus-visible");
        setReleaseNotesTriggerFocusVisible(focusVisible);
        if (!showReleaseNotesPopover || !focusVisible) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      {statusIcon}
    </button>
  );

  return (
    <SidebarMenuItem>
      <Popover
        handle={releaseNotesPopoverHandle}
        open={releaseNotesOpen && showReleaseNotesPopover}
        triggerId={releaseNotesTriggerId}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
          if (!details.isCanceled) setReleaseNotesOpen(open);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup side="right" variant="glass">
              <span className="whitespace-pre-line">{tooltip}</span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            aria-label={t("Update release notes")}
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="right"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
      {confirmDialog}
    </SidebarMenuItem>
  );
}

/** An Update everything run, in the sidebar footer so its progress text has room. */
export function SidebarUpdateRunCapsule() {
  const state = useDesktopUpdateState();
  const run = useUpdateEverythingRun();
  if (run === null) return null;

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const pendingAction = resolveDesktopUpdatePendingAction(state);
  const localUpdateVersion =
    state && pendingAction !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const { iconStatus } = resolveSidebarUpdatePresentation({
    action: pendingAction,
    showsEverything: false,
    run,
    isDownloading: state?.status === "downloading",
  });
  const local: UpdateRunLocalState =
    run.localVersion === null
      ? null
      : state?.status === "downloading"
        ? { status: "downloading", percent: state.downloadPercent }
        : { status: "waiting" };

  return (
    <SidebarMenuItem className="ml-auto flex flex-1">
      <SidebarUpdateCapsule
        run={run}
        local={local}
        icon={
          <DesktopUpdateStatusIcon
            downloadPercent={state?.downloadPercent ?? null}
            status={iconStatus}
          />
        }
        {...(run.localVersion === null && action === "install" && window.desktopBridge
          ? {
              onRestart: async () => {
                saveUpdateEverythingResult({
                  localVersion: localUpdateVersion,
                  updatedServers: 0,
                  updatedProviders: 0,
                  failures: [],
                  restarting: [],
                });
                if (!(await installLocalUpdateWhenIdle(window.desktopBridge!))) {
                  clearSavedUpdateEverythingResult();
                }
              },
            }
          : {})}
      />
    </SidebarMenuItem>
  );
}
