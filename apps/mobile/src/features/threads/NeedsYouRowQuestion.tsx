import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { oneTapUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
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

/**
 * A Needs you row's own question. One tap answers a lone single-choice question from the list;
 * any other question is answered in the thread.
 */
export function NeedsYouRowQuestion(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly sidebarPane: boolean;
}) {
  const userInput =
    useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef))?.userInputs[0] ??
    null;
  const canRespond = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = userInput?.questions[0]?.question.trimStart().split("\n", 1)[0];
  if (userInput === null || !question) return null;
  const answers =
    canRespond && userInput.responseCapability !== "not_resumable"
      ? oneTapUserInputAnswers(userInput.questions)
      : null;
  return (
    <View className={cn("gap-2 pb-2.5", props.sidebarPane ? "px-3" : "px-5")}>
      <Text numberOfLines={2} className="text-xs text-foreground-secondary">
        {question}
      </Text>
      {answers !== null ? (
        <View className="flex-row flex-wrap gap-2">
          {answers.map((answer, index) => (
            <Button
              key={answer.value}
              label={answer.label}
              accessibilityLabel={t("{action} for {title}", {
                action: answer.label,
                title: props.title,
              })}
              tone={index === 0 ? "primary" : "secondary"}
              disabled={responding}
              onPress={() => {
                setResponding(true);
                setError(null);
                void respond({
                  environmentId: props.threadRef.environmentId,
                  input: {
                    threadId: props.threadRef.threadId,
                    requestId: userInput.requestId,
                    answers: answer.answers,
                  },
                }).then((result) => {
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    const failure = squashAtomCommandFailure(result);
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : t("Failed to submit user input."),
                    );
                  }
                  setResponding(false);
                });
              }}
            />
          ))}
        </View>
      ) : null}
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
