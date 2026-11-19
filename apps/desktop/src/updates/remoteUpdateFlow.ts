import type { DesktopUpdateRemoteOutcome, DesktopUpdateState } from "@t3tools/contracts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

export type RemoteDesktopUpdateStep =
  | { readonly action: "check" }
  | { readonly action: "download" }
  | { readonly action: "install" }
  | { readonly action: "wait" }
  | {
      readonly action: "done";
      readonly outcome: DesktopUpdateRemoteOutcome;
      readonly reason?: string;
    };

/** Bound retries with counts: background poller races can repeat an already-handled status once. */
export interface RemoteDesktopUpdateAttempts {
  readonly checks: number;
  readonly downloads: number;
}

const MAX_REMOTE_UPDATE_CHECKS = 2;
export const MAX_REMOTE_UPDATE_DOWNLOADS = 3;

function isInstallableDesktopUpdateState(state: DesktopUpdateState): boolean {
  return (
    state.downloadedVersion !== null &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  );
}

export function nextRemoteDesktopUpdateStep(
  state: DesktopUpdateState,
  attempts: RemoteDesktopUpdateAttempts,
  disabledReason: string | null,
  minimumVersion?: string,
): RemoteDesktopUpdateStep {
  if (!state.enabled || state.status === "disabled") {
    return {
      action: "done",
      outcome: "failed",
      reason: disabledReason ?? "Automatic updates are disabled on this machine.",
    };
  }
  if (minimumVersion !== undefined) {
    if (state.channel !== desktopUpdateChannelOf(minimumVersion)) {
      return { action: "done", outcome: "failed", reason: "The desktop update track changed." };
    }
    const candidate =
      state.status === "available" ? state.availableVersion : state.downloadedVersion;
    if (
      state.status !== "checking" &&
      state.status !== "downloading" &&
      candidate !== null &&
      compareSemverVersions(candidate, minimumVersion) < 0
    ) {
      return attempts.checks === 0
        ? { action: "check" }
        : {
            action: "done",
            outcome: "failed",
            reason: `The desktop app found no build of ${minimumVersion} or later.`,
          };
    }
  }
  // Reinstalling a failed version disrupts threads without updating; retries require the local user.
  if (
    state.notAppliedVersion !== undefined &&
    (state.downloadedVersion ?? state.availableVersion) === state.notAppliedVersion
  ) {
    return {
      action: "done",
      outcome: "failed",
      reason: `Update ${state.notAppliedVersion} did not apply on this machine. Retry it from the desktop app there.`,
    };
  }
  // Match install admission, including retained downloads after unrelated background or earlier install errors.
  if (isInstallableDesktopUpdateState(state)) {
    return { action: "install" };
  }
  if (state.status === "downloading" || state.status === "checking") {
    return { action: "wait" };
  }
  if (state.status === "available") {
    if (attempts.downloads >= MAX_REMOTE_UPDATE_DOWNLOADS) {
      return {
        action: "done",
        outcome: "failed",
        reason: state.message ?? "The desktop app failed to download the update.",
      };
    }
    return { action: "download" };
  }
  // Background up-to-date/error states are stale until this request has issued its own check.
  if (state.status === "up-to-date") {
    if (attempts.checks === 0) {
      return { action: "check" };
    }
    return { action: "done", outcome: "up-to-date" };
  }
  if (state.status === "error") {
    if (attempts.checks === 0) {
      return { action: "check" };
    }
    return {
      action: "done",
      outcome: "failed",
      reason: state.message ?? "The desktop app update failed.",
    };
  }
  if (attempts.checks >= MAX_REMOTE_UPDATE_CHECKS) {
    return {
      action: "done",
      outcome: "failed",
      reason: "The desktop app did not report an update result.",
    };
  }
  return { action: "check" };
}

/** Blank reasons fail encoding and drop the terminal report, forcing the server to time out. */
export function normalizeRemoteUpdateReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : undefined;
}
