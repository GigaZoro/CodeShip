import type { EnvironmentId } from "@t3tools/contracts";

import { MachineLoadMeters, useMachineLoadPollable } from "../machines/MachineResources";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { t } from "~/i18n";

/** CPU, memory and disk of the machine this chat runs on; hidden while it is unreachable. */
export function ThreadMachineLoadPanel(props: { readonly environmentId: EnvironmentId }) {
  const pollable = useMachineLoadPollable(props.environmentId);
  if (!pollable) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-machine-load-heading" title={t("Machine load")}>
      <div className="px-2.5 pb-1">
        <MachineLoadMeters environmentId={props.environmentId} />
      </div>
    </ThreadDetailsSection>
  );
}
