import type { DesktopUpdateState } from "@t3tools/contracts/ipc";

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
