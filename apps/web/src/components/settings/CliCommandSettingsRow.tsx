import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { t } from "~/i18n";

export function CliCommandSettingsRow() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const state = query.data;
  const [pending, setPending] = useState(false);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "install" ? t("Could not install t3") : t("Could not remove t3"),
            description: error instanceof Error ? error.message : t("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("Another t3 at {path} runs first in a new terminal. Remove it to use T3.CodeShip's.", {
        path: state.shadowedBy,
      })
    : !installed
      ? t("Run T3.CodeShip's CLI as `t3` from any terminal.")
      : state.onPath
        ? t("Installed at {path}. Open a new terminal to use it.", { path: state.installedPath })
        : t(
            "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `t3`.",
            { path: state.installedPath },
          );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending || query.isPending || (!installed && Boolean(state.shadowedBy))}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? t("Remove") : t("Install")}
        </Button>
      }
    />
  );
}
