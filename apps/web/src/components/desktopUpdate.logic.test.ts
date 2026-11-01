import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdatePendingAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("resolveDesktopUpdatePendingAction", () => {
  it.each([
    ["a first check", { status: "checking" }, "none"],
    ["a recheck after a download", { status: "checking", downloadedVersion: "1.1.0" }, "install"],
    ["a recheck before a download", { status: "checking", availableVersion: "1.1.0" }, "download"],
  ] as const)("shows %s as %s", (_name, patch, expected) => {
    expect(resolveDesktopUpdatePendingAction({ ...baseState, ...patch })).toBe(expected);
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
      );
    },
  );
});
