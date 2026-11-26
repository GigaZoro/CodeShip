import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, MonitoringFindingCode, ThreadId } from "@t3tools/contracts";
import {
  createFixChatView,
  fixChatRequest,
  fixChatViewKey,
  type MonitoringFixChatTarget,
  settleFixChat,
} from "@t3tools/client-runtime/monitoring";
import {
  FINDING_TEXT,
  monitoringFixChatFailureMessage,
} from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useLayoutEffect, useState } from "react";
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
 * opens it. Renders nothing when no chat shows the weak point, or its machine cannot start one
 * for this client.
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
  const available = useAtomValue(
    serverEnvironment.monitoringFixChatsAvailable(target?.environmentId ?? null),
  );
  const navigation = useNavigation();
  const openThread = useOpenScheduledTaskThread();
  const key = fixChatViewKey(target, code);
  const idle = () => ({
    view: createFixChatView(key),
    pending: false,
    failure: null,
    started: null,
  });
  const [stored, setStored] = useState<{
    readonly view: ReturnType<typeof createFixChatView>;
    readonly pending: boolean;
    readonly failure: string | null;
    readonly started: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  }>(idle);
  const state = stored.view.key === key ? stored : idle();
  if (state !== stored) setStored(state);
  const { view, pending, failure, started } = state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the reply's navigation listener when its view changes or unmounts
  useLayoutEffect(() => view.cancelReply, [view]);
  const canStart = target !== null && available;
  if (!canStart && failure === null && started === null) return null;

  const open = (environmentId: EnvironmentId, threadId: ThreadId) => {
    try {
      openThread(environmentId, threadId);
    } catch (error) {
      console.error("Could not open the monitoring fix chat", error);
    }
  };

  const start = () => {
    if (target === null || !available || !navigation.isFocused()) return;
    const reply = view.watchReply(
      (leave) => navigation.addListener("blur", leave),
      () => setStored({ ...state, pending: false, failure: null }),
    );
    if (reply === null) return;
    const request = fixChatRequest(target, code, "mobile", uuidv4);
    const { environmentId } = request;
    setStored({ ...state, pending: true, failure: null });
    void run(request).then((result) => {
      const current = !reply.signal.aborted;
      reply.abort();
      const failure = result._tag === "Failure" ? result.cause : null;
      settleFixChat(target, code, request, failure);
      if (!current) return;
      if (!navigation.isFocused()) {
        setStored({ ...state, pending: false, failure: null });
        return;
      }
      if (result._tag === "Success") {
        const started = { environmentId, threadId: result.value.threadId };
        setStored({ ...state, pending: false, started, failure: null });
        open(environmentId, result.value.threadId);
      } else {
        setStored({
          ...state,
          pending: false,
          failure: isAtomCommandInterrupted(result)
            ? null
            : monitoringFixChatFailureMessage(result.cause),
        });
      }
    });
  };

  return (
    <View className="items-start gap-1.5 pt-1">
      {canStart ? (
        <Button
          label={pending ? t("Starting chat…") : t("Fix root cause")}
          accessibilityLabel={
            pending
              ? t("Starting chat…")
              : t("Fix root cause: {weakPoint}", { weakPoint: t(FINDING_TEXT[code].title) })
          }
          icon="wrench.and.screwdriver"
          loading={pending}
          onPress={start}
        />
      ) : null}
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
            onPress={() => open(started.environmentId, started.threadId)}
          />
        </>
      )}
    </View>
  );
}
