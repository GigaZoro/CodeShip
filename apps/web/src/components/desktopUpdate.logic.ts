import { t, tn } from "~/i18n";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
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

/**
 * Updates are checked automatically, so update controls appear only for an update to act on.
 * A background recheck briefly reports "checking"; an update it already found stays on screen.
 */
export function resolveDesktopUpdatePendingAction(
  state: DesktopUpdateState | null,
): DesktopUpdateButtonAction {
  if (!state) return "none";
  if (state.status !== "checking") return resolveDesktopUpdateButtonAction(state);
  if (state.downloadedVersion) return "install";
  return state.availableVersion ? "download" : "none";
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

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return t("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return t(
      "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return t(
      "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return t(
    "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return t("Update {version} did not apply. Click to retry.", {
      version: state.notAppliedVersion,
    });
  }
  if (state.status === "checking") return t("Checking for updates…");
  if (state.status === "available") {
    return t("Update {version} ready to download", {
      version: state.availableVersion ?? t("available"),
    });
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? t("Downloading update ({percent}%)", { percent: Math.floor(state.downloadPercent) })
      : t("Downloading update");
  }
  if (state.status === "downloaded") {
    return t("Update {version} downloaded. Click to restart and install.", {
      version: state.downloadedVersion ?? state.availableVersion ?? t("ready"),
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return t("Download failed for {version}. Click to retry.", {
        version: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return t("Install failed for {version}. Click to retry.", {
        version: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return t("Update {version} downloaded. Click to restart and install.", {
        version: state.downloadedVersion,
      });
    }
    return state.message ?? t("Update failed");
  }
  return t("Up to date");
}

export function getSafeUpdateButtonTooltip(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  runningThreads: number,
): string {
  const version = getDesktopUpdateDownloadedVersion(state);
  return version
    ? tn(
        runningThreads,
        "Update {version} downloaded. Click for a safe update: {count} running chat resume after the restart.",
        "Update {version} downloaded. Click for a safe update: {count} running chats resume after the restart.",
        { version },
      )
    : tn(
        runningThreads,
        "Update downloaded. Click for a safe update: {count} running chat resume after the restart.",
        "Update downloaded. Click for a safe update: {count} running chats resume after the restart.",
      );
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return version
    ? t(
        "Install update {version} and restart T3.CodeShip?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
        { version },
      )
    : t(
        "Install update and restart T3.CodeShip?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
      );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || t("Automatic updates are not available in this build.");
}
