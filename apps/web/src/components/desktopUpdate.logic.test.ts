import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateActionError,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdatePendingAction,
  waitToInstallAutomatically,
  installDesktopUpdate,
} from "./desktopUpdate.logic";
import {
  resolveAutoDesktopUpdateStep,
  resolveDesktopUpdateButtonAction,
} from "@t3tools/shared/desktopAutoUpdate";
import type { HostedWorkNow, HostedWorkWait } from "./sidebar/localInstallWait";

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

  it("shows the download failure after returning to available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Download failed for 1.1.0. Click to retry.");
    expect(getDesktopUpdateButtonTooltip({ ...state, notAppliedVersion: "1.1.0" })).toBe(
      "Update 1.1.0 did not apply. Click to retry.",
    );
  });

  it("shows the install failure after the desktop returns to downloaded", () => {
    // reduceDesktopUpdateStateOnInstallFailure: a refused macOS install prompt lands here.
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      message: "Desktop updater install operation reported an error.",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Install failed for 1.1.0. Click to retry.");
  });

  it("reports an install the desktop refuses after accepting it", async () => {
    const downloaded: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    const failed: DesktopUpdateState = {
      ...downloaded,
      message: "OSStatus error -60006.",
      errorContext: "install",
      canRetry: true,
    };
    const listeners = new Set<(state: DesktopUpdateState) => void>();
    const emit = (state: DesktopUpdateState) => listeners.forEach((listener) => listener(state));
    const install = installDesktopUpdate(
      {
        onUpdateState: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        installUpdate: async (expectedVersion, options) => {
          expect(expectedVersion).toBe("1.1.0");
          expect(options).toEqual({ resumeThreads: true });
          // A retry's pre-install check can restore the previous failure before the restart starts.
          emit(failed);
          return { accepted: true, completed: false, state: downloaded };
        },
      },
      "1.1.0",
      { resumeThreads: true },
    );
    let settled = false;
    void install.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    emit(failed);
    const result = await install;
    expect(getDesktopUpdateActionError(result)).toBe("OSStatus error -60006.");
    expect(listeners.size).toBe(0);
  });

  it("never calls a build on the other track up to date", () => {
    // A Stable build whose switch to Nightly did not finish; the updater discards every release.
    const state: DesktopUpdateState = {
      ...baseState,
      status: "up-to-date",
      channel: "nightly",
      currentVersion: "0.1.5",
      checkedAt: "2026-11-18T00:00:00.000Z",
    };
    expect(getDesktopUpdateButtonTooltip(state)).not.toBe("Up to date");
    expect(
      getDesktopUpdateButtonTooltip({ ...state, currentVersion: "0.1.6-nightly.20261118.1" }),
    ).toBe("Up to date");
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

describe("resolveAutoDesktopUpdateStep", () => {
  const noAttempts = { download: null, install: null };
  const step = (
    patch: Partial<DesktopUpdateState>,
    options: {
      readonly enabled?: boolean;
      readonly waitingToInstall?: boolean;
      readonly attempts?: { download: string | null; install: string | null };
    } = {},
  ) =>
    resolveAutoDesktopUpdateStep({
      enabled: options.enabled ?? true,
      state: { ...baseState, ...patch },
      waitingToInstall: options.waitingToInstall ?? false,
      attempts: options.attempts ?? noAttempts,
    });
  const available = { status: "available", availableVersion: "1.1.0" } as const;
  const downloaded = { status: "downloaded", downloadedVersion: "1.1.0" } as const;

  it.each([
    ["downloads a found update", available, {}, "download"],
    ["installs a downloaded update", downloaded, {}, "install"],
    [
      "only waits while an install already waits for idle",
      downloaded,
      { waitingToInstall: true },
      "wait",
    ],
    [
      "does nothing while downloading",
      { status: "downloading", availableVersion: "1.1.0" },
      {},
      "none",
    ],
    ["does nothing with the setting off", available, { enabled: false }, "none"],
    ["does nothing with nothing to update", {}, {}, "none"],
    ["does nothing when the updater is disabled", { ...available, enabled: false }, {}, "none"],
    [
      "does not download a version it already tried",
      available,
      { attempts: { download: "1.1.0", install: null } },
      "none",
    ],
    [
      "does not install a version it already tried",
      downloaded,
      { attempts: { download: null, install: "1.1.0" } },
      "none",
    ],
    [
      "downloads a newer version after a failed one",
      { ...available, availableVersion: "1.2.0" },
      { attempts: { download: "1.1.0", install: null } },
      "download",
    ],
    [
      "leaves a version that did not apply to the update button",
      { ...downloaded, notAppliedVersion: "1.1.0" },
      {},
      "none",
    ],
  ] as const)("%s", (_name, patch, options, expected) => {
    expect(step(patch, options)).toBe(expected);
  });
});

describe("waitToInstallAutomatically", () => {
  const run = (
    waits: ReadonlyArray<HostedWorkWait>,
    nows: ReadonlyArray<HostedWorkNow>,
    isStillEnabled: () => boolean = () => true,
  ) => {
    const calls: Array<string> = [];
    const readiness = waitToInstallAutomatically({
      waitUntilIdle: async () => {
        calls.push("wait");
        return waits[calls.filter((call) => call === "wait").length - 1]!;
      },
      readWorkNow: async () => {
        calls.push("read");
        return nows[calls.filter((call) => call === "read").length - 1]!;
      },
      isStillEnabled,
    });
    return readiness.then((result) => ({ result, calls }));
  };

  it("installs once idle and still idle right before installing", async () => {
    expect(await run([{ status: "clear" }], [{ status: "idle" }])).toEqual({
      result: { status: "install" },
      calls: ["wait", "read"],
    });
  });

  it("waits again when a chat started work right before the install", async () => {
    expect(
      await run(
        [{ status: "clear" }, { status: "clear" }],
        [{ status: "busy" }, { status: "idle" }],
      ),
    ).toEqual({ result: { status: "install" }, calls: ["wait", "read", "wait", "read"] });
  });

  it("stops when the setting was turned off, or the wait was cancelled", async () => {
    expect((await run([{ status: "clear" }], [{ status: "idle" }], () => false)).result).toEqual({
      status: "stop",
    });
    expect((await run([{ status: "cancelled" }], [])).result).toEqual({ status: "stop" });
  });

  it("installs at once when the user chose to update now", async () => {
    expect(await run([{ status: "update-now" }], [])).toEqual({
      result: { status: "install" },
      calls: ["wait"],
    });
  });
});
