import { t } from "~/i18n";
import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return t("Checking snapshots…");
  if (state.mode === "unavailable") return state.message ?? t("Not supported on this platform.");
  if (!enabled) return t("Turn this on to set up snapshots.");
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message) return t("Capture needs attention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? t("Check capture access in setup")
      : t("Install the capture helper to continue");
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return t("Set up active-window snapshots");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? t("Check capture access in setup")
      : t("Install the capture helper to continue");
  if (captureSetupBackend(state) === "picker")
    return t("Manual capture only. You'll choose a window each time");
  if (!enabled) return t("Enable capture to continue");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? t("Connecting your shortcut…")
      : t("Waiting for shortcut permission");
  if (state.shortcutVerified) return t("Ready to capture");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return t("Use your shortcut from another app");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return t("Use your shortcut from another app");
  if (state.shortcutRegistered)
    return state.shortcutLabel ? t("Ready to capture") : t("Shortcut saved");
  return t("Finish shortcut setup");
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return t("Approve the shortcut permission prompt to continue.");
  if (state.shortcutRegistered) return state.mode === "portal" ? null : t("Shortcut saved.");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return t("Continue setup");
  if (captureSetupAccessReady(state)) return t("Manage capture");
  const desktop = captureSetupDesktopName(state);
  return desktop ? t("Set up {desktop} capture", { desktop }) : t("Continue setup");
}

export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? t("Capture effects aren't available on this desktop.")
      : t("Install or update the capture helper to enable effects.");
  if (state.linuxBackend === "niri") return t("Capture effects aren't available on Niri.");
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? t("Capture effects aren't available on this desktop.")
      : t("Install or update the capture helper to enable effects.");
  return state.linuxBackend === "gnome-extension"
    ? t("Update the GNOME extension, then sign out and back in to enable effects.")
    : captureSetupBackend(state) === "gnome"
      ? t("Finish extension setup to enable effects.")
      : t("Capture effects aren't available on this desktop.");
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? t("Automatic capture isn't available here. Choose a window instead.")
    : t("Capture a window and attach it to your current draft.");
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return t("This desktop only provides a screenshot.");
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? t("Update the desktop app to use snapshots.")
    : t("Only available in the desktop app.");
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
