import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  databaseReclaimMinutes,
  type DatabaseStorageStatus,
  type EnvironmentId,
  offlineVacuumBytes,
} from "@t3tools/contracts";
import { describeDatabaseChange } from "@t3tools/client-runtime/host-resources";
import { formatBytes } from "@t3tools/shared/formatBytes";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { t, msg } from "~/i18n";

const DismissedEnvironmentIds = Schema.Array(Schema.String);
const reclaimPermissionsAtom = environmentAtomList(
  "web-database-reclaim-permissions",
  serverEnvironment.reclaimDatabaseSpace.permissionAtom,
);

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Shows each machine's database size and daily growth and offers to reclaim freed space. */
export function DatabaseStorageNotice({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const environmentIds = environments.map((environment) => environment.environmentId);
  const idsJson = JSON.stringify(environmentIds);
  const statuses = useAtomValue(serverEnvironment.databaseStorageStatuses(idsJson));
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(idsJson),
  );
  const permissions = useAtomValue(reclaimPermissionsAtom(environmentIdsKey(environmentIds)));
  const [dismissed, setDismissed] = useLocalStorage(
    "database-storage-notice-dismissed",
    [],
    DismissedEnvironmentIds,
  );
  const { copyToClipboard } = useCopyToClipboard({
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const visible = recommendations
    .filter((recommendation) => !dismissed.includes(recommendation.environmentId))
    .map((recommendation) => ({
      ...recommendation,
      label: labelOf(recommendation.environmentId),
      reclaimable:
        recommendation.status.canReclaim === true &&
        permissions[environmentIds.indexOf(recommendation.environmentId)] === true,
    }));
  if (statuses.length === 0) return null;
  return (
    <SettingsSection id="storage-database" title={t("Database")}>
      {statuses.map(({ environmentId, status }) => (
        <SettingsRow
          key={`size-${environmentId}`}
          title={t("Database on {environment}", { environment: labelOf(environmentId) })}
          description={describeDatabaseChange(status).join(" · ") || undefined}
          control={
            <span className="text-sm tabular-nums">{formatBytes(status.databaseBytes)}</span>
          }
        />
      ))}
      {visible.length > 0 ? (
        <SettingsRow
          title={t("Reclaim freed database space")}
          description={
            visible.every((recommendation) => recommendation.reclaimable)
              ? t("These databases still hold space freed by history cleanup.")
              : t(
                  "These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
                )
          }
        />
      ) : null}
      {visible.map(({ environmentId, status, label, reclaimable }) => {
        const dismiss = (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDismissed((current) => [...current, environmentId])}
          >
            {t("Dismiss")}
          </Button>
        );
        return reclaimable ? (
          <ReclaimRow
            key={environmentId}
            environmentId={environmentId}
            label={label}
            status={status}
            dismiss={dismiss}
          />
        ) : (
          <SettingsRow
            key={environmentId}
            title={t("{size} on {environment}", {
              size: formatGiB(offlineVacuumBytes(status)),
              environment: label,
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
                {dismiss}
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

function ReclaimRow({
  environmentId,
  label,
  status,
  dismiss,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: DatabaseStorageStatus;
  readonly dismiss: ReactNode;
}) {
  const reclaim = useAtomCommand(serverEnvironment.reclaimDatabaseSpace);
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);
  // A failed repair reports back after the restart, which ends the wait.
  const restarting = requested && status.reclaimFailure === undefined;
  const minutes = databaseReclaimMinutes(status);
  const amount = formatGiB(offlineVacuumBytes(status));
  const start = async () => {
    setConfirming(false);
    setRequested(true);
    const result = await reclaim({ environmentId, input: {} });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("Reclaiming {amount} on {environment}", { amount, environment: label }),
        description: t("T3.CodeShip there restarts and is back in about {minutes} min.", {
          minutes,
        }),
      });
      return;
    }
    setRequested(false);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: t("Could not reclaim space on {environment}", { environment: label }),
      description:
        error instanceof Error
          ? (thrownErrorMessage(error) ?? error.message)
          : t("An error occurred."),
    });
  };
  return (
    <SettingsRow
      title={t("{amount} on {environment}", { amount, environment: label })}
      description={
        status.reclaimFailure === undefined
          ? t("Restarts T3.CodeShip there. It will be offline for about {minutes} min.", {
              minutes,
            })
          : t("The last attempt failed: {reason}", { reason: status.reclaimFailure })
      }
      control={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={restarting}
            onClick={() => setConfirming(true)}
          >
            {restarting ? t("Restarting…") : t("Reclaim")}
          </Button>
          {dismiss}
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("Reclaim {amount} on {environment}?", { amount, environment: label })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "T3.CodeShip on {environment} stops, rebuilds its database, and starts again. It will be offline for about {minutes} min. Running agents stop when it restarts.",
                    { environment: label, minutes },
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>
                  {t("Cancel")}
                </AlertDialogClose>
                <Button onClick={() => void start()}>{t("Restart and reclaim")}</Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      }
    />
  );
}
