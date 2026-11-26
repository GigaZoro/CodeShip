import { useAtomValue } from "@effect/atom-react";
import { messageStarFailureMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { messageStarCommand } from "@t3tools/client-runtime/state/threads";
import { CommandId, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { t } from "../../lib/i18n";
import { minimumTouchSlop } from "../../lib/designTokens";
import { uuidv4 } from "../../lib/uuid";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function useThreadMessageStar(thread: ScopedThreadRef | null, messageId: MessageId) {
  const command = orchestrationEnvironment.v2.dispatchCommand;
  const starred = useAtomValue(environmentThreadDetails.isMessageStarredAtom(thread, messageId));
  const environmentId = thread?.environmentId ?? null;
  const permitted = useAtomValue(command.permissionAtom(environmentId, messageStarCommand));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = permitted && config?.environment.capabilities.threadMessageStars === true;
  const dispatch = useAtomCommand(command, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const setStarred = (next: boolean) => {
    if (!thread || !allowed || pending) return;
    setPending(true);
    void dispatch({
      environmentId: thread.environmentId,
      input: {
        ...messageStarCommand,
        commandId: CommandId.make(uuidv4()),
        threadId: thread.threadId,
        messageId,
        starred: next,
      },
    })
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          Dialog.alert(messageStarFailureMessage(squashAtomCommandFailure(result)));
        }
      })
      .finally(() => setPending(false));
  };
  return {
    starred,
    allowed,
    pending,
    label: starred ? t("Unstar message") : t("Star message"),
    toggle: () => setStarred(!starred),
    setStarred,
  };
}

export function ThreadMessageStarButton(props: {
  readonly thread: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly color: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
}) {
  const star = useThreadMessageStar(props.thread, props.messageId);
  if (!star.allowed) {
    return star.starred ? (
      <SymbolView
        accessibilityLabel={t("Starred")}
        name="star.fill"
        size={props.iconSize}
        tintColorClassName="accent-warning-foreground"
      />
    ) : null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={star.label}
      accessibilityState={{ selected: star.starred, disabled: star.pending }}
      disabled={star.pending}
      hitSlop={minimumTouchSlop(props.buttonSize)}
      className="items-center justify-center"
      style={{ width: props.buttonSize, height: props.buttonSize }}
      onPress={star.toggle}
    >
      <SymbolView
        name={star.starred ? "star.fill" : "star"}
        size={props.iconSize}
        {...(star.starred
          ? { tintColorClassName: "accent-warning-foreground" }
          : { tintColor: props.color })}
      />
    </Pressable>
  );
}
