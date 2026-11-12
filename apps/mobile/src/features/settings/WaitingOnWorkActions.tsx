import { decideRestartHold, type ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { Fragment } from "react";

import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { t, tn } from "../../lib/i18n";
import { appAtomRegistry } from "../../state/atom-registry";

/** The status line of an update that waits for chats' tool calls and background work. */
export function waitingOnWorkText(work: ReadonlyArray<unknown> | undefined) {
  const count = work?.length ?? 0;
  return count > 0
    ? tn(count, "Waiting for {count} task", "Waiting for {count} tasks")
    : t("Waiting for background work…");
}

export function isWaitingOnWork(state: ServerUpdateState): boolean {
  return state.status === "running" && state.stage === "waiting";
}

/** Lets the user install now or stop waiting; shown only while the update waits. */
export function WaitingOnWorkActions({
  environmentId,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: ServerUpdateState;
}) {
  if (!isWaitingOnWork(state)) return null;
  return (
    <Fragment>
      <SettingsActionRow
        icon="arrow.up.circle"
        label={t("Update now")}
        onPress={() => decideRestartHold(appAtomRegistry, environmentId, "update-now")}
      />
      <SettingsActionRow
        icon="xmark"
        label={t("Cancel")}
        onPress={() => decideRestartHold(appAtomRegistry, environmentId, "cancel")}
      />
    </Fragment>
  );
}
