import type { DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export type AutoDesktopUpdateStep = "none" | "download" | "wait" | "install";

/** Versions this app already tried to download or install by itself; it never retries them alone. */
export interface AutoDesktopUpdateAttempts {
  readonly download: string | null;
  readonly install: string | null;
}

/**
 * What an app with "Install updates automatically when idle" does next with its updater state.
 * "install" starts the wait-for-idle install, so "wait" only reports that one is already running.
 * A version that failed to apply, or that an attempt already failed or was cancelled, is left for
 * the update button, so a failing build can never loop.
 */
export function resolveAutoDesktopUpdateStep(input: {
  readonly enabled: boolean;
  readonly state: DesktopUpdateState | null;
  readonly waitingToInstall: boolean;
  readonly attempts: AutoDesktopUpdateAttempts;
}): AutoDesktopUpdateStep {
  const { state } = input;
  if (!input.enabled || state === null || !state.enabled || state.status === "disabled") {
    return "none";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  const version = getDesktopUpdateDownloadedVersion(state);
  if (action === "none" || version === null || version === state.notAppliedVersion) return "none";
  if (action === "download") return input.attempts.download === version ? "none" : "download";
  if (input.waitingToInstall) return "wait";
  return input.attempts.install === version ? "none" : "install";
}
