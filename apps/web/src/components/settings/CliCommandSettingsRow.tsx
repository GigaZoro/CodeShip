import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
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
import { msg, t } from "~/i18n";

const FAILURE_TITLES = {
  install: msg("Could not install t3"),
  uninstall: msg("Could not remove t3"),
  addToPath: msg("Could not add t3 to PATH"),
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t(FAILURE_TITLES[action]),
            description:
              error instanceof Error
                ? (thrownErrorMessage(error) ?? error.message)
                : t("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("Another t3 at {path} runs first in a new terminal. Remove it to use T3.CodeShip's.", {
        path: state.shadowedBy,
      })
    : !installed
      ? t("Run T3.CodeShip's CLI as `t3` from any terminal.")
      : state.onPath
        ? t("Installed at {path}. Open a new terminal to use it.", { path: state.installedPath })
        : state.pathSetup?.added
          ? t("Installed at {path} and added to PATH in {file}. Open a new terminal to use it.", {
              path: state.installedPath,
              file: state.pathSetup.file,
            })
          : state.pathSetup
            ? t("Installed at {path}, which is not on your PATH yet.", {
                path: state.installedPath,
              })
            : t(
                "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `t3`.",
                { path: state.installedPath },
              );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              {t("Add to PATH")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? t("Remove") : t("Install")}
          </Button>
        </div>
      }
    />
  );
}
