import { useAtomValue } from "@effect/atom-react";
import { formatBytes } from "@t3tools/shared/formatBytes";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { t } from "~/i18n";

const DismissedEnvironmentIds = Schema.Array(Schema.String);

/** Shows each machine's database size, and suggests `t3 doctor` where it still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const environmentIdsKey = JSON.stringify(
    environments.map((environment) => environment.environmentId),
  );
  const statuses = useAtomValue(serverEnvironment.databaseStorageStatuses(environmentIdsKey));
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(environmentIdsKey),
  );
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const [dismissed, setDismissed] = useLocalStorage(
    "database-storage-notice-dismissed",
    [],
    DismissedEnvironmentIds,
  );
  const { copyToClipboard } = useCopyToClipboard({ target: t("command") });
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (statuses.length === 0) return null;
  return (
    <SettingsSection id="storage-database" title={t("Database")}>
      {statuses.map(({ environmentId, status }) => (
        <SettingsRow
          key={`size-${environmentId}`}
          title={t("Database on {environment}", { environment: labelOf(environmentId) })}
          description={
            status.reclaimableBytes > 0
              ? t("{size} can be reclaimed", { size: formatBytes(status.reclaimableBytes) })
              : undefined
          }
          control={
            <span className="text-sm tabular-nums">{formatBytes(status.databaseBytes)}</span>
          }
        />
      ))}
      {visible.length > 0 ? (
        <SettingsRow
          title={t("Reclaim freed database space")}
          description={t(
            "Old history is cleaned up automatically, but these databases still hold the freed space. Run the command on each machine to return it to disk; it pauses and restarts the background service. Quit the desktop app first if it hosts the environment.",
          )}
        />
      ) : null}
      {visible.map(({ environmentId, status }) => (
        <SettingsRow
          key={environmentId}
          title={t("{size} GiB on {environment}", {
            size: (status.reclaimableBytes / 1024 ** 3).toFixed(1),
            environment: labelOf(environmentId),
          })}
          description={<code className="select-text break-all">{status.compactCommand}</code>}
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => copyToClipboard(status.compactCommand, undefined)}
              >
                {t("Copy command")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDismissed((current) => [...current, environmentId])}
              >
                {t("Dismiss")}
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
