import { t } from "../../../lib/i18n";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { formatBytes } from "@t3tools/shared/formatBytes";

import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/** Shows each machine's database size, and suggests `t3 doctor` where it still holds at least 1 GiB of freed pages. */
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
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
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
          value={
            status.reclaimableBytes > 0
              ? t("{size} ({reclaimable} can be reclaimed)", {
                  size: formatBytes(status.databaseBytes),
                  reclaimable: formatBytes(status.reclaimableBytes),
                })
              : formatBytes(status.databaseBytes)
          }
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
          "Old history is cleaned up automatically, but these databases still hold the freed space. Run the command on each machine to return it to disk; it pauses and restarts the background service. Quit the desktop app first if it hosts the environment.",
        )}
      >
        {visible.map(({ environmentId, status }) => (
          <SettingsActionRow
            key={environmentId}
            icon="doc.on.doc"
            label={targets.find((target) => target.environmentId === environmentId)?.label ?? ""}
            description={status.compactCommand}
            detail={t("{size} GiB", { size: (status.reclaimableBytes / 1024 ** 3).toFixed(1) })}
            onPress={() => copyTextWithHaptic(status.compactCommand, { target: "command" })}
          />
        ))}
        <SettingsActionRow
          icon="xmark"
          label={t("Dismiss")}
          onPress={() =>
            updatePreferences({
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
