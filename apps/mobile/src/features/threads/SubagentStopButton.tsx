import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
} from "./threadAgentsPresentation";
import { t } from "../../lib/i18n";

export function SubagentStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly className?: string;
}) {
  const target = resolveSubagentStopTarget(props.subagent);
  const canStop = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);

  if (target === null || !canStop) return null;

  const workflow = target.kind === "workflow";
  const label =
    props.subagent.workflow?.name ?? resolveSubagentRowPresentation(props.subagent).title;
  const stop = async () => {
    setStopping(true);
    const result = await (
      target.kind === "workflow"
        ? stopWorkflow({ environmentId: props.environmentId, input: target.input })
        : interruptTurn({ environmentId: props.environmentId, input: target.input })
    ).finally(() => setStopping(false));
    if (result._tag === "Failure") {
      Dialog.alert(workflow ? t("Could not stop workflow") : t("Could not stop agent"));
    }
  };

  return (
    <View className={props.className}>
      <IconButton
        icon="stop.fill"
        variant="danger"
        accessibilityLabel={
          stopping
            ? workflow
              ? t("Stopping workflow {label}", { label })
              : t("Stopping agent {label}", { label })
            : workflow
              ? t("Stop workflow {label}", { label })
              : t("Stop agent {label}", { label })
        }
        disabled={stopping}
        onPress={() =>
          Dialog.confirm({
            title: workflow ? t("Stop workflow?") : t("Stop agent?"),
            message: workflow
              ? t("Every running agent in {label} stops.", { label })
              : t("Stop {label}?", { label }),
            confirmText: t("Stop"),
            destructive: true,
            onConfirm: () => void stop(),
          })
        }
      />
    </View>
  );
}
