import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  CommandId,
  type EnvironmentId,
  type MonitoringFindingCode,
  type ThreadId,
} from "@t3tools/contracts";
import type { MonitoringFixChatTarget } from "@t3tools/client-runtime/monitoring";
import { monitoringFixChatFailureMessage } from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenScheduledTaskThread } from "../settings/ScheduledTaskRunsRouteScreen";

const NO_FIX_CHAT_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("mobile-monitoring:fix-chat:none"),
);

/**
 * Starts a chat that traces one weak point in `target`'s chats to its root cause and fixes it, and
 * opens it. Renders nothing when no chat shows the weak point or this client may not start chats.
 */
export function MonitoringFixChatAction({
  target,
  code,
}: {
  readonly target: MonitoringFixChatTarget | null;
  readonly code: MonitoringFindingCode;
}) {
  const run = useAtomCommand(serverEnvironment.startMonitoringFixChat, {
    label: "monitoring start fix chat",
    reportFailure: false,
  });
  const allowed = useAtomValue(
    target === null
      ? NO_FIX_CHAT_PERMISSION_ATOM
      : serverEnvironment.startMonitoringFixChat.permissionAtom(target.environmentId),
  );
  const navigation = useNavigation();
  const openThread = useOpenScheduledTaskThread();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null>(null);
  // A retry keeps the failed attempt's id, so a start whose answer was lost opens that chat.
  const commandId = useRef<CommandId | null>(null);
  if (target === null || !allowed) return null;

  const start = () => {
    if (pending) return;
    const { environmentId } = target;
    const id = commandId.current ?? CommandId.make(uuidv4());
    commandId.current = id;
    setPending(true);
    setFailure(null);
    void run({
      environmentId,
      input: { commandId: id, creationSource: "mobile", code, threadIds: target.threadIds },
    }).then((result) => {
      setPending(false);
      if (result._tag === "Success") {
        commandId.current = null;
        setStarted({ environmentId, threadId: result.value.threadId });
        // The chat opens only while the user is still here; otherwise the row offers it.
        if (navigation.isFocused()) openThread(environmentId, result.value.threadId);
      } else if (!isAtomCommandInterrupted(result)) {
        setFailure(monitoringFixChatFailureMessage(result.cause));
      }
    });
  };

  return (
    <View className="items-start gap-1.5 pt-1">
      <Button
        label={pending ? t("Starting chat…") : t("Fix root cause")}
        icon="wrench.and.screwdriver"
        loading={pending}
        onPress={start}
      />
      {failure === null ? null : (
        <Text textRole="footnote" accessibilityRole="alert" className="text-danger-foreground">
          {failure}
        </Text>
      )}
      {started === null ? null : (
        <>
          <Text textRole="footnote" className="text-foreground-muted">
            {t("A chat is fixing this weak point.")}
          </Text>
          <Button
            label={t("Open that chat")}
            tone="text"
            onPress={() => openThread(started.environmentId, started.threadId)}
          />
        </>
      )}
    </View>
  );
}
