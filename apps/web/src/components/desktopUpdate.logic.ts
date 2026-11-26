import { t, msg, tn } from "~/i18n";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
  type DesktopUpdateButtonAction,
} from "@t3tools/shared/desktopAutoUpdate";
import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import type { HostedWorkNow, HostedWorkWait } from "./sidebar/localInstallWait";
import { desktopTrackMismatchText } from "@t3tools/client-runtime/state/server";
import { resolveMarkedMessage } from "@t3tools/shared/markedMessage";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";

import { channelSwitchLabel } from "./sidebar/updateEverything.logic";

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

export type AutoInstallReadiness =
  | { readonly status: "install" }
  | { readonly status: "stop" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * The wait before an automatic install: until no chat on this app's servers is answering or has
 * background work, work and turns that started meanwhile included, then one more look right
 * before installing. A chat that started in between sends it back to waiting. The setting turned off or a cancel stops it;
 * the user choosing "Update now" installs at once, as for any wait.
 */
export async function waitToInstallAutomatically(input: {
  readonly waitUntilIdle: () => Promise<HostedWorkWait>;
  readonly readWorkNow: () => Promise<HostedWorkNow>;
  readonly isStillEnabled: () => boolean;
}): Promise<AutoInstallReadiness> {
  for (;;) {
    const wait = await input.waitUntilIdle();
    if (wait.status === "failed") return wait;
    if (wait.status === "cancelled") return { status: "stop" };
    if (wait.status === "update-now") return { status: "install" };
    const now = await input.readWorkNow();
    if (now.status === "failed") return now;
    if (!input.isStillEnabled()) return { status: "stop" };
    if (now.status === "idle") return { status: "install" };
  }
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(
  state: DesktopUpdateState,
  resolve: typeof t = t,
): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return resolve(msg("This install is using the correct architecture."));
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
      ),
    );
  }
  if (action === "install") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
      ),
    );
  }
  return resolve(
    msg(
      "This Mac has Apple Silicon, but T3.CodeShip is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
    ),
  );
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  resolve: typeof t = t,
): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return resolve(msg("Update {version} did not apply. Click to retry."), {
      version: state.notAppliedVersion,
    });
  }
  if (state.status === "checking") return resolve(msg("Checking for updates…"));
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return resolve(msg("Download failed for {version}. Click to retry."), {
      version: state.availableVersion,
    });
  }
  if (state.status === "available") {
    return state.availableVersion === null
      ? resolve(msg("Update ready to download"))
      : resolve(msg("Update {version} ready to download"), { version: state.availableVersion });
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? resolve(msg("Downloading update ({percent}%)"), {
          percent: Math.floor(state.downloadPercent),
        })
      : resolve(msg("Downloading update"));
  }
  if (state.status === "downloaded") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return resolve(msg("Install failed for {version}. Click to retry."), {
        version: state.downloadedVersion,
      });
    }
    const version = state.downloadedVersion ?? state.availableVersion;
    return version === null
      ? resolve(msg("Update downloaded. Click to restart and install."))
      : resolve(msg("Update {version} downloaded. Click to restart and install."), { version });
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return resolve(msg("Install failed for {version}. Click to retry."), {
        version: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return resolve(msg("Update {version} downloaded. Click to restart and install."), {
        version: state.downloadedVersion,
      });
    }
    if (state.trackMismatch !== undefined) {
      return resolveMarkedMessage(
        desktopTrackMismatchText({
          buildChannel: state.trackMismatch.buildChannel,
          savedChannel: state.channel,
        }),
        resolve,
      );
    }
    return state.message ?? resolve(msg("Update failed"));
  }
  // The updater discards every release of the other track, so "up to date" would be false here.
  const buildChannel = desktopUpdateChannelOf(state.currentVersion);
  if (state.status === "up-to-date" && buildChannel !== state.channel) {
    return resolve(
      msg(
        "This {build} build ignores {track} releases. Review the update track in Settings to finish the switch.",
      ),
      {
        build: channelSwitchLabel(buildChannel, resolve),
        track: channelSwitchLabel(state.channel, resolve),
      },
    );
  }
  return resolve(msg("Up to date"));
}

export function getSafeUpdateButtonTooltip(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  runningThreads: number,
  commands: number,
): string {
  const version = getDesktopUpdateDownloadedVersion(state);
  const threads =
    runningThreads === 0
      ? version
        ? t("Update {version} downloaded. Click for a safe update.", { version })
        : t("Update downloaded. Click for a safe update.")
      : version
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
  return commands === 0 ? threads : `${threads} ${commandsCarryOnLabel(commands)}`;
}

/** Running and queued alike: neither stops for an update. */
export function commandsCarryOnLabel(count: number): string {
  return tn(
    count,
    "{count} command carries on through the update.",
    "{count} commands carry on through the update.",
  );
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  resolve: typeof t = t,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return version
    ? resolve(
        msg(
          "Install update {version} and restart T3.CodeShip?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
        ),
        { version },
      )
    : resolve(
        msg(
          "Install update and restart T3.CodeShip?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
        ),
      );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

/**
 * macOS can refuse the restart after installUpdate resolves; the desktop then reports it as a
 * later state with errorContext "install". Success quits the app, so this never resolves then.
 */
export async function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate" | "onUpdateState">,
  expectedVersion?: string,
  options?: Parameters<DesktopBridge["installUpdate"]>[1],
): Promise<DesktopUpdateActionResult> {
  let awaitingFailure = false;
  let reportFailure: (state: DesktopUpdateState) => void = () => {};
  const failure = new Promise<DesktopUpdateState>((resolve) => {
    reportFailure = resolve;
  });
  const unsubscribe = bridge.onUpdateState((state) => {
    if (awaitingFailure && state.errorContext === "install") reportFailure(state);
  });
  try {
    const result = await (options === undefined
      ? bridge.installUpdate(expectedVersion)
      : bridge.installUpdate(expectedVersion, options));
    if (!result.accepted || result.completed || getDesktopUpdateActionError(result) !== null) {
      return result;
    }
    awaitingFailure = true;
    return { ...result, state: await failure };
  } finally {
    unsubscribe();
  }
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: typeof t = t,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return (
    state.message?.trim() || resolve(msg("Automatic updates are not available in this build."))
  );
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: typeof t = t,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial, resolve);
  return disabledReason
    ? { title: resolve(msg("Updates unavailable")), detail: disabledReason }
    : { title: resolve(msg("Check for updates")), detail: null };
}
