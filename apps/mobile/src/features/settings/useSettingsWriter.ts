import { t } from "../../lib/i18n";
import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

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

  /** Resolves to each environment that saved its write, with the settings it now has. */
  return async (
    targets: readonly ScopedMobileSettingsTarget[],
    writes: readonly {
      readonly environmentId: EnvironmentId;
      readonly patch: ServerSettingsPatch;
    }[],
  ): Promise<ReadonlyArray<SavedSettingsWrite>> => {
    const outcomes = await Promise.all(
      writes.map(async (entry) => {
        const result = await updateSettings({
          environmentId: entry.environmentId,
          input: { patch: entry.patch },
        });
        const target = targets.find(
          (candidate) => candidate.environment.environmentId === entry.environmentId,
        );
        const label = target?.environment.label ?? entry.environmentId;
        if (result._tag === "Success") {
          if (target === undefined) return null;
          const saved: SavedSettingsWrite = {
            environmentId: entry.environmentId,
            label,
            previous: target.environment.serverConfig.settings,
            settings: result.value,
          };
          return { saved };
        }
        if (isAtomCommandInterrupted(result)) return null;
        const error = squashAtomCommandFailure(result);
        return {
          failure: t("{label}: {message}", {
            label,
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      }),
    );
    const failures = outcomes.flatMap((outcome) => (outcome?.failure ? [outcome.failure] : []));
    if (failures.length > 0) {
      Dialog.alert(t("Could not save settings"), failures.join("\n\n"));
    }
    return outcomes.flatMap((outcome) => (outcome?.saved ? [outcome.saved] : []));
  };
}
