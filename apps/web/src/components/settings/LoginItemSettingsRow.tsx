import type { DesktopLoginItemState } from "@t3tools/contracts";
import { useState } from "react";

import {
  desktopLoginItemStateAtom,
  getDesktopLoginItemBridge,
  refreshDesktopLoginItemState,
} from "~/state/desktopLoginItem";
import { useEnvironmentQuery } from "~/state/query";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { t } from "~/i18n";

export function LoginItemSettingsRow() {
  const bridge = getDesktopLoginItemBridge();
  const query = useEnvironmentQuery(bridge ? desktopLoginItemStateAtom : null);
  const [pending, setPending] = useState(false);
  // The state a toggle returned, shown until Settings mounts again and reads it from the atom.
  const [applied, setApplied] = useState<DesktopLoginItemState | null>(null);
  const state = applied ?? query.data;

  if (!bridge || !state?.supported) return null;
  // Registered but waiting for the user's approval in System Settings still counts as asked for.
  const checked = state.enabled || state.requiresApproval;

  const change = (enabled: boolean) => {
    if (pending) return;
    setPending(true);
    void bridge
      .setEnabled(enabled)
      .then(setApplied, (error: unknown) => {
        setApplied(null);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not change Open at login"),
            description: error instanceof Error ? error.message : t("Something went wrong."),
          }),
        );
      })
      .finally(() => {
        refreshDesktopLoginItemState();
        setPending(false);
      });
  };

  return (
    <SettingsRow
      {...searchableSetting("open-at-login")}
      description={
        state.requiresApproval
          ? t(
              "Allow T3.CodeShip in System Settings > General > Login Items to finish turning this on.",
            )
          : t("Start T3.CodeShip when you sign in to this computer.")
      }
      control={
        <Switch
          checked={checked}
          disabled={pending || query.isPending}
          onCheckedChange={(next) => change(Boolean(next))}
          aria-label={t("Open at login")}
        />
      }
    />
  );
}
