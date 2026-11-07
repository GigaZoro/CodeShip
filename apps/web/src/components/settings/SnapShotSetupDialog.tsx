import { msg, t } from "~/i18n";
import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import {
  isModifierPairShortcut,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";
import {
  captureSetupAccessReady,
  captureSetupBackend,
  captureSetupCheckMessage,
  captureSetupDesktopName,
  captureSetupInitialStep,
  captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const SETUP_STEPS = [
  { id: "access", label: msg("Access") },
  { id: "shortcut", label: msg("Shortcut") },
] as const;

const GNOME_ACCESS_COPY = {
  "not-installed": {
    title: msg("Install the extension"),
    description: msg(
      "The T3.CodeShip GNOME extension lets you capture other windows and bring them into your draft. Sign out once after installing.",
    ),
  },
  "restart-required": {
    title: msg("Extension installed"),
    description: msg("Save your work, then sign out and back in. Your setup will be waiting here."),
  },
  "update-required": {
    title: msg("Update the extension"),
    description: msg("Install the update, then sign out and back in."),
  },
  "extensions-disabled": {
    title: msg("Allow GNOME extensions"),
    description: msg("Open GNOME Extensions and turn on extensions, then check again."),
  },
  disabled: {
    title: msg("Enable the extension"),
    description: msg("Enable T3.CodeShip SnapShots to start capturing windows."),
  },
  enabled: {
    title: msg("Capture is ready"),
    description: msg("Next, choose your shortcut."),
  },
  unsupported: {
    title: msg("Automatic capture isn't available"),
    description: msg("Use Take snapshot from the command palette to choose a window."),
  },
  error: {
    title: msg("Couldn't set up the extension"),
    description: msg("Check T3.CodeShip SnapShots in GNOME Extensions, then try again."),
  },
};

export function SnapShotSetupDialog({
  state,
  initialStep,
  wasEnabled,
  includeAccessibility,
  busy: actionBusy,
  error,
  shortcutInput,
  shortcutStatus,
  shortcutChanged,
  canSaveShortcut,
  onSaveShortcut,
  onEnable,
  onAction,
  onRefresh,
  onClose,
  onLeaveStep,
}: {
  state: DesktopSnapShotState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  includeAccessibility: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: ReactNode;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopSnapShotSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopSnapShotState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const [step, setStep] = useState(() => captureSetupInitialStep(state, initialStep));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const busy = actionBusy || checking || configBusy;
  const backend = captureSetupBackend(state);
  const configShortcut = backend === "niri" || backend === "hyprland";
  const desktop = captureSetupDesktopName(state);
  const extension = state.gnomeExtension;
  const helper = backend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
  const helperBackend = backend === "kde" || backend === "hyprland";
  const installHelper = backend === "hyprland" ? "install-hyprland-helper" : "install-kde-helper";
  const removeHelper = backend === "hyprland" ? "remove-hyprland-helper" : "remove-kde-helper";
  const accessReady = captureSetupAccessReady(state);
  const permissionStatus = usePermissionStatus(
    async () => {
      const refreshed = await onRefresh();
      if (!refreshed?.macPermissions) throw new Error(t("Permission status unavailable"));
      return refreshed.macPermissions;
    },
    state.macPermissions ?? { screenRecording: false, accessibility: false },
    Boolean(state.macPermissions) && step === "access" && !busy,
  );
  const macPermissions = state.macPermissions ? permissionStatus.status : undefined;
  const macPermissionsReady =
    !macPermissions ||
    permissionStatus.isReady(
      includeAccessibility ? ["screenRecording", "accessibility"] : ["screenRecording"],
    );
  const shortcutReady = captureSetupShortcutReady(state, shortcutChanged);
  const install = extension?.status === "not-installed" || extension?.status === "update-required";
  const enable = extension?.status === "disabled";
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setChecked(false);
    setStep(next);
  };
  const checkAgain = async () => {
    if (busy) return;
    setChecking(true);
    setChecked(false);
    const refreshed = await onRefresh().finally(() => setChecking(false));
    setChecked(refreshed !== undefined);
  };
  const accessCopy =
    state.message && !macPermissions
      ? {
          title: msg("Let's try that again"),
          description: msg("Couldn't check snapshots. Try again to continue."),
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: msg("Check capture access"),
              description: msg("The extension isn't ready yet. Try again in a moment."),
            }
          : GNOME_ACCESS_COPY[extension.status]
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: msg("Capture is ready"),
                description: msg("Next, choose your shortcut."),
              }
            : helper?.status === "error"
              ? {
                  title: msg("Let's fix capture access"),
                  description: msg("Try reinstalling the capture helper, then check again."),
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? msg("Update the capture helper")
                      : msg("Allow snapshots"),
                  description: msg(
                    "T3.CodeShip's capture helper lets you capture other apps and return to your draft. It's included with T3.CodeShip.",
                  ),
                }
          : backend === "niri"
            ? {
                title: msg("Capture is ready"),
                description: msg("Next, choose your shortcut."),
              }
            : backend === "picker"
              ? {
                  title: msg("Choose a window each time"),
                  description: msg(
                    "Your desktop doesn't support automatic capture. You'll choose the window to capture instead.",
                  ),
                }
              : {
                  title: msg("Allow snapshots"),
                  description:
                    backend === "portal"
                      ? msg("Your desktop may ask for permission when you first capture.")
                      : macPermissions
                        ? macPermissionsReady
                          ? msg(
                              "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded.",
                            )
                          : msg("Allow each permission, then continue.")
                        : msg("Allow access when prompted to start capturing windows."),
                };
  const title = step === "access" ? t(accessCopy.title) : t("Choose your shortcut");
  const description =
    step === "access"
      ? t(accessCopy.description)
      : configShortcut
        ? t("Click the shortcut, then press the keys you want.")
        : state.mode === "portal"
          ? t("Choose your keys, then approve the permission prompt if asked.")
          : t("Use both Shift keys, or record a different shortcut.");
  const stepIndex = SETUP_STEPS.findIndex(({ id }) => id === step);
  const details = [
    ...new Set(
      [
        error,
        ...(step === "access"
          ? [
              state.message,
              backend === "gnome" &&
              (extension?.status === "error" || extension?.status === "unsupported")
                ? extension.message
                : null,
              helperBackend && helper?.status === "error" ? helper.message : null,
            ]
          : []),
      ].filter((detail) => detail !== null),
    ),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onClose(false);
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        <WizardHeader
          title={desktop ? t("Set up snapshots for {desktop}", { desktop }) : t("Set up snapshots")}
        >
          <WizardSteps
            steps={SETUP_STEPS.map((item) => t(item.label))}
            currentStep={stepIndex}
            isStepDisabled={(index) => busy || index > stepIndex}
            onStepChange={(index) => {
              const next = SETUP_STEPS[index];
              if (next && next.id !== step) changeStep(next.id);
            }}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="space-y-4 text-sm">
            <div className="space-y-2" aria-live="polite">
              <h3 className="flex items-center gap-2 font-medium">{title}</h3>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {step === "access" ? (
              <>
                <p
                  role="status"
                  aria-atomic="true"
                  className={
                    checked && !busy && !error ? "text-xs text-muted-foreground" : "sr-only"
                  }
                >
                  {checked && !busy && !error ? captureSetupCheckMessage(state) : null}
                </p>
                {macPermissions ? (
                  <PermissionChecklist
                    busy={busy}
                    permissions={[
                      {
                        id: "screenRecording",
                        icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("Screen Recording"),
                        description: t("Capture the window you're using."),
                        granted: macPermissions.screenRecording,
                        onAllow: () => void onAction("allow-screen-recording"),
                      },
                      {
                        id: "accessibility",
                        icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("Accessibility"),
                        description: includeAccessibility
                          ? t("Include text and controls from the captured app.")
                          : t("Optional. Include text and controls from the captured app."),
                        granted: macPermissions.accessibility,
                        onAllow: () => void onAction("allow-accessibility"),
                      },
                    ]}
                  />
                ) : null}
                {permissionStatus.error && macPermissions ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {permissionStatus.error}
                  </p>
                ) : null}
                {helperBackend && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction(installHelper)}
                  >
                    {t("Reinstall helper")}
                  </Button>
                ) : null}
              </>
            ) : configShortcut ? (
              <CaptureShortcutConfig
                state={state}
                disabled={actionBusy || checking || !accessReady}
                onBusyChange={setConfigBusy}
                onSaved={onRefresh}
                onComplete={() => onClose(true)}
              />
            ) : (
              <div className="space-y-3">
                {shortcutInput}
                {shortcutStatus ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {shortcutStatus}
                  </p>
                ) : null}
                {!shortcutChanged &&
                !state.shortcutRegistered &&
                !state.shortcutPending &&
                state.shortcutCanRetry !== false &&
                !isModifierPairShortcut(state.shortcut) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onAction("retry-shortcut")}
                  >
                    {state.mode === "portal" ? t("Shortcut permissions") : t("Try again")}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive-foreground">
                {t("Capture needs attention. Go back to check access.")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive-foreground">
                {t("Couldn't finish this step. Try again or check Advanced for help.")}
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("Advanced")}</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>{t("Included with T3.CodeShip. No download needed.")}</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      {t("Disable extension")}
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      {t("Remove capture helper")}
                    </Button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </WizardPanel>
        <WizardFooter>
          {step !== "access" ? (
            <Button variant="ghost" disabled={busy} onClick={() => changeStep("access")}>
              {t("Back")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? t("Close") : t("Finish later")}
          </Button>
          {step === "access" ? (
            helperBackend && !accessReady && helper?.status !== "ready" ? (
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void (helper?.status === "error" ? checkAgain() : onAction(installHelper))
                }
              >
                {checking
                  ? t("Checking…")
                  : busy
                    ? t("Installing…")
                    : helper?.status === "error"
                      ? t("Check again")
                      : helper?.status === "update-required"
                        ? t("Update helper")
                        : t("Install helper")}
              </Button>
            ) : backend === "gnome" && !accessReady && extension?.status !== "enabled" ? (
              <Button
                disabled={busy}
                aria-busy={checking}
                onClick={() =>
                  void (install
                    ? onAction("install-extension")
                    : enable
                      ? onAction("enable-extension")
                      : checkAgain())
                }
              >
                {checking
                  ? t("Checking…")
                  : busy
                    ? install
                      ? t("Installing…")
                      : enable
                        ? t("Enabling…")
                        : t("Working…")
                    : install
                      ? extension?.status === "update-required"
                        ? t("Update extension")
                        : t("Install extension")
                      : enable
                        ? t("Enable extension")
                        : t("Check again")}
              </Button>
            ) : (
              <PermissionContinueButton
                ready={macPermissionsReady}
                busy={busy}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy
                  ? t("Working…")
                  : macPermissions
                    ? t("Test capture and continue")
                    : backend === "direct"
                      ? t("Allow capture")
                      : !accessReady && !macPermissions
                        ? t("Try again")
                        : t("Continue")}
              </PermissionContinueButton>
            )
          ) : !configShortcut ? (
            <Button
              disabled={
                busy || !accessReady || (shortcutChanged ? !canSaveShortcut : !shortcutReady)
              }
              onClick={async () => {
                if (!shortcutChanged || (await onSaveShortcut())) await onClose(true);
              }}
            >
              {busy ? t("Saving…") : shortcutChanged ? t("Save and finish") : t("Done")}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
