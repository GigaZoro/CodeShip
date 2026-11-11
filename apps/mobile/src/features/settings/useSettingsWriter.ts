import { t } from "../../lib/i18n";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { persistSharedSettingsWrites } from "@t3tools/client-runtime/state/shared-settings";
import * as Cause from "effect/Cause";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MobileSettingsWritePlan, ScopedMobileSettingsTarget } from "./settings-scoped-server";

export interface SavedSettingsWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly previous: ServerSettings;
  readonly settings: ServerSettings;
}

export function useSettingsWriter() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const shareSettings = useAtomCommand(serverEnvironment.shareSettings, {
    label: "environment settings share",
    reportFailure: true,
  });

  /** Resolves to each environment that saved its write, with the settings it now has. */
  return async (
    targets: readonly ScopedMobileSettingsTarget[],
    plan: MobileSettingsWritePlan,
  ): Promise<ReadonlyArray<SavedSettingsWrite>> => {
    if (plan.noFollowerConnected) {
      Dialog.alert(
        t("Setting not saved"),
        t("Connect a machine that follows shared settings to save this for all machines."),
      );
      return [];
    }
    const outcomes = await persistSharedSettingsWrites(plan, {
      update: updateSettings,
      share: shareSettings,
    });
    const failures = outcomes.flatMap(({ write, result }) => {
      if (result._tag === "Success" || Cause.hasInterruptsOnly(result.cause)) return [];
      const error = Cause.squash(result.cause);
      return [
        t("{label}: {message}", {
          label: write.label,
          message: error instanceof Error ? error.message : String(error),
        }),
      ];
    });
    if (failures.length > 0) {
      Dialog.alert(t("Could not save settings"), failures.join("\n\n"));
    }
    return outcomes.flatMap(({ write, result }) => {
      const target = targets.find(
        (candidate) => candidate.environment.environmentId === write.environmentId,
      );
      return result._tag === "Success" && target !== undefined
        ? [
            {
              environmentId: write.environmentId,
              label: write.label,
              previous: target.environment.serverConfig.settings,
              settings: result.value,
            },
          ]
        : [];
    });
  };
}
