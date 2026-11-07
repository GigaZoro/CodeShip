import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { t } from "../../lib/i18n";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { defaultApprovalOptions } from "./PendingApprovalCard";

/**
 * A Needs you row's own approval, answered from the list. The thread keeps the full card with
 * every option; the list offers allow and decline.
 */
export function NeedsYouRowApproval(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly sidebarPane: boolean;
}) {
  const approval =
    useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef))?.approvals[0] ??
    null;
  const canRespond = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (approval === null || approval.responseCapability !== "live" || !canRespond) return null;
  const options = (approval.options ?? defaultApprovalOptions()).filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const summary = approval.detail?.trimStart().split("\n", 1)[0];
  return (
    <View className={cn("gap-2 pb-2.5", props.sidebarPane ? "px-3" : "px-5")}>
      {summary ? (
        <Text numberOfLines={1} className="font-mono text-xs text-foreground-secondary">
          {summary}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            accessibilityLabel={t("{action} for {title}", {
              action: option.label,
              title: props.title,
            })}
            tone={option.decision === "accept" ? "primary" : "secondary"}
            disabled={responding}
            onPress={() => {
              setResponding(true);
              setError(null);
              void respond({
                environmentId: props.threadRef.environmentId,
                input: {
                  threadId: props.threadRef.threadId,
                  requestId: approval.requestId,
                  decision: option.decision,
                },
              }).then((result) => {
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  const failure = squashAtomCommandFailure(result);
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : t("Failed to submit approval decision."),
                  );
                }
                setResponding(false);
              });
            }}
          />
        ))}
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
