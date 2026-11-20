import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, MonitoringFindingCode, ThreadId } from "@t3tools/contracts";
import {
  fixChatInput,
  type MonitoringFixChatTarget,
  settleFixChat,
} from "@t3tools/client-runtime/monitoring";
import {
  FINDING_TEXT,
  monitoringFixChatFailureMessage,
} from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenScheduledTaskThread } from "../settings/ScheduledTaskRunsRouteScreen";

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
    serverEnvironment.startMonitoringFixChat.permissionAtom(target?.environmentId ?? null),
  );
  const navigation = useNavigation();
  const openThread = useOpenScheduledTaskThread();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null>(null);
  if (target === null || !allowed) return null;

  const start = () => {
    if (pending) return;
    const { environmentId } = target;
    setPending(true);
    setFailure(null);
    void run({ environmentId, input: fixChatInput(target, code, "mobile", uuidv4) }).then(
      (result) => {
        setPending(false);
        if (result._tag === "Success") {
          settleFixChat(target, code);
          setStarted({ environmentId, threadId: result.value.threadId });
          // The chat opens only while the user is still here; otherwise the row offers it.
          if (navigation.isFocused()) openThread(environmentId, result.value.threadId);
        } else if (!isAtomCommandInterrupted(result)) {
          setFailure(monitoringFixChatFailureMessage(result.cause));
        }
      },
    );
  };

  return (
    <View className="items-start gap-1.5 pt-1">
      <Button
        label={pending ? t("Starting chat…") : t("Fix root cause")}
        // Every weak point has this button, so its name says which one it fixes.
        {...(pending
          ? {}
          : {
              accessibilityLabel: t("Fix root cause: {weakPoint}", {
                weakPoint: t(FINDING_TEXT[code].title),
              }),
            })}
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
