import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { APP_VERSION } from "~/branding";
import { t } from "~/i18n";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { primaryServerConfigAtom } from "../../state/server";
import {
  type AutoDesktopUpdateAttempts,
  getDesktopUpdateDownloadedVersion,
  resolveAutoDesktopUpdateStep,
} from "../desktopUpdate.logic";
import { downloadLocalUpdate, installLocalUpdateAutomatically } from "../sidebar/SidebarUpdatePill";
import { decideHostedRestartHold, usePendingLocalInstall } from "../sidebar/localInstallWait";
import { toastManager } from "../ui/toast";

const AUTO_INSTALL_RECORD_KEY = "t3.desktopAutoInstall";

function readAutoInstallTarget(): string | null {
  try {
    return window.localStorage.getItem(AUTO_INSTALL_RECORD_KEY);
  } catch {
    return null;
  }
}

function writeAutoInstallTarget(version: string | null): void {
  try {
    if (version === null) window.localStorage.removeItem(AUTO_INSTALL_RECORD_KEY);
    else window.localStorage.setItem(AUTO_INSTALL_RECORD_KEY, version);
  } catch {}
}

const readEnabled = () =>
  appAtomRegistry.get(primaryServerConfigAtom)?.settings.installUpdatesAutomatically === true;

/**
 * Runs "Install updates automatically when idle" for this app: downloads a found update in the
 * background and installs it once no chat on this app's servers has background work, checked
 * again right before it installs. The waiting shows on the update button like any other. The
 * setting is the bundled server's; turning it off ends the wait this started.
 */
export function DesktopAutoUpdateCoordinator() {
  const state = useDesktopUpdateState();
  const enabled =
    useAtomValue(primaryServerConfigAtom)?.settings.installUpdatesAutomatically === true;
  const pendingInstall = usePendingLocalInstall();
  const attempts = useRef<AutoDesktopUpdateAttempts>({ download: null, install: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the Electron updater, which lives outside React, from its state
  useEffect(() => {
    const bridge = window.desktopBridge;
    const version = state === null ? null : getDesktopUpdateDownloadedVersion(state);
    if (!bridge || version === null) return;
    const step = resolveAutoDesktopUpdateStep({
      enabled,
      state,
      waitingToInstall: pendingInstall !== null,
      attempts: attempts.current,
    });
    if (step === "download") {
      attempts.current = { ...attempts.current, download: version };
      void downloadLocalUpdate(bridge, { notifyDownloaded: false });
    } else if (step === "install") {
      attempts.current = { ...attempts.current, install: version };
      writeAutoInstallTarget(version);
      void installLocalUpdateAutomatically(bridge, version, readEnabled).then((started) => {
        if (!started) writeAutoInstallTarget(null);
      });
    }
  }, [enabled, state, pendingInstall]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the wait in the server's restart hold, which lives outside React, when the setting is turned off
  useEffect(() => {
    if (enabled || pendingInstall?.automatic !== true) return;
    // Turned on again later, it tries this version again.
    attempts.current = { ...attempts.current, install: null };
    decideHostedRestartHold("cancel");
  }, [enabled, pendingInstall]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the install record a previous run of the app left in browser storage
  useEffect(() => {
    const target = readAutoInstallTarget();
    if (target === null) return;
    writeAutoInstallTarget(null);
    if (target === APP_VERSION) {
      toastManager.add({
        type: "success",
        title: t("Updated to {version}.", { version: APP_VERSION }),
      });
    }
  }, []);

  return null;
}
