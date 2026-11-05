import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Agents can start a thread in plan mode; this is the only place a user sees that and leaves it. */
export function ComposerPlanModeChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode);
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    setLeaving(true);
    await setInteractionMode({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, interactionMode: "default" },
    });
    setLeaving(false);
  };
  return (
    <View className="mb-2 flex-row items-center gap-2 self-start rounded-full bg-card pl-3">
      <Text className="text-xs font-t3-bold text-foreground">Plan mode</Text>
      <Button label="Leave" tone="text" loading={leaving} onPress={() => void leave()} />
    </View>
  );
}
