import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";
import { useEnvironmentScope } from "../../state/session";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { useArchivedThreadListActions } from "../home/useThreadListActions";

/** Takes the composer's place while a thread is archived: it reads, but takes no messages. */
export function ArchivedThreadBar(props: {
  readonly thread: EnvironmentThreadShell;
  readonly archivedAt: string;
}) {
  const canOperate = useEnvironmentScope(props.thread.environmentId, AuthOrchestrationOperateScope);
  const { unarchiveThread, confirmDeleteThread } = useArchivedThreadListActions((thread) =>
    refreshArchivedThreadsForEnvironment(thread.environmentId),
  );

  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
          {t("Archived")}
        </Text>
        <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
          <RelativeTime timestamp={props.archivedAt} />
          {" · "}
          {t("Unarchive it to send messages.")}
        </Text>
      </View>
      {canOperate ? (
        <>
          <Button
            label={t("Delete")}
            tone="text"
            onPress={() => confirmDeleteThread(props.thread)}
          />
          <Button
            label={t("Unarchive")}
            tone="secondary"
            onPress={() => unarchiveThread(props.thread)}
          />
        </>
      ) : null}
    </View>
  );
}
