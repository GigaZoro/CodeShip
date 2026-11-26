import { t } from "../../../lib/i18n";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { describeDatabaseChange } from "@t3tools/client-runtime/host-resources";
import { offlineVacuumBytes } from "@t3tools/contracts";
import { formatBytes } from "@t3tools/shared/formatBytes";

import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../state/preferences";
import { useAtomCommand } from "../../../state/use-atom-command";
import { serverEnvironment } from "../../../state/server";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/** Shows each machine's database size and daily growth, and suggests `t3 doctor` where it still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  targets,
}: {
  readonly targets: readonly SettingsTarget[];
}) {
  const environmentIdsKey = JSON.stringify(targets.map((target) => target.environmentId));
  const statuses = useAtomValue(serverEnvironment.databaseStorageStatuses(environmentIdsKey));
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(environmentIdsKey),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomCommand(saveMobilePreferences);
  const dismissed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.dismissedDatabaseStorageNotices ?? [])
    : [];
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (statuses.length === 0) return null;
  const sizes = (
    <SettingsSection title={t("Database")}>
      {statuses.map(({ environmentId, status }) => (
        <SettingsRow
          key={environmentId}
          icon="internaldrive"
          label={targets.find((target) => target.environmentId === environmentId)?.label ?? ""}
          value={[formatBytes(status.databaseBytes), ...describeDatabaseChange(status)].join(" · ")}
          valuePosition="below"
        />
      ))}
    </SettingsSection>
  );
  if (visible.length === 0) return sizes;
  return (
    <>
      {sizes}
      <SettingsSection
        title={t("Reclaim database space")}
        footer={t(
          "These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
        )}
      >
        {visible.map(({ environmentId, status }) => (
          <SettingsActionRow
            key={environmentId}
            icon="doc.on.doc"
            label={targets.find((target) => target.environmentId === environmentId)?.label ?? ""}
            description={status.compactCommand}
            detail={t("{size} GiB", { size: (offlineVacuumBytes(status) / 1024 ** 3).toFixed(1) })}
            onPress={() => copyTextWithHaptic(status.compactCommand, { target: "command" })}
          />
        ))}
        <SettingsActionRow
          icon="xmark"
          label={t("Dismiss")}
          onPress={() =>
            void updatePreferences({
              transform: (current) => ({
                dismissedDatabaseStorageNotices: [
                  ...new Set([
                    ...(current.dismissedDatabaseStorageNotices ?? []),
                    ...visible.map((recommendation) => recommendation.environmentId),
                  ]),
                ],
              }),
            })
          }
        />
      </SettingsSection>
    </>
  );
}
