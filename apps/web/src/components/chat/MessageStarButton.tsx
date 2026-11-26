import { useAtomValue } from "@effect/atom-react";
import { CommandId, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { messageStarFailureMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { messageStarCommand } from "@t3tools/client-runtime/state/threads";
import { StarIcon, XIcon } from "lucide-react";
import { use, useState } from "react";

import { t } from "~/i18n";
import { cn, randomUUID } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { serverEnvironment } from "~/state/server";
import { environmentThreadDetails } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

const command = orchestrationEnvironment.v2.dispatchCommand;

export function MessageStarButton({ messageId }: { readonly messageId: MessageId }) {
  const { threadRef } = use(TimelineRowCtx);
  return <MessageStarAction threadRef={threadRef} messageId={messageId} />;
}

export function MessageStarAction({
  threadRef,
  messageId,
  unstarLabel,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: MessageId;
  readonly unstarLabel?: string;
}) {
  const starred = useAtomValue(environmentThreadDetails.isMessageStarredAtom(threadRef, messageId));
  const allowed = useAtomValue(
    command.permissionAtom(threadRef?.environmentId ?? null, messageStarCommand),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef?.environmentId ?? null));
  const dispatch = useAtomCommand(command, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (
    threadRef === null ||
    !allowed ||
    config?.environment.capabilities.threadMessageStars !== true
  )
    return null;

  const unstarOnly = unstarLabel !== undefined;
  const label = starred || unstarOnly ? t("Unstar message") : t("Star message");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={unstarOnly ? "icon-xs" : "xs"}
            variant="ghost-muted"
            aria-label={unstarOnly ? t("Unstar {label}", { label: unstarLabel }) : label}
            aria-pressed={unstarOnly ? undefined : starred}
            disabled={pending}
            onClick={() => {
              setPending(true);
              void dispatch({
                environmentId: threadRef.environmentId,
                input: {
                  ...messageStarCommand,
                  commandId: CommandId.make(randomUUID()),
                  threadId: threadRef.threadId,
                  messageId,
                  starred: !unstarOnly && !starred,
                },
              })
                .then((result) => {
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    toastManager.add({
                      type: "error",
                      title: messageStarFailureMessage(squashAtomCommandFailure(result)),
                    });
                  }
                })
                .finally(() => setPending(false));
            }}
          />
        }
      >
        {unstarOnly ? (
          <XIcon className="size-3" />
        ) : (
          <StarIcon className={cn("size-3", starred && "fill-current text-primary")} />
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function MessageStarMarker({ messageId }: { readonly messageId: MessageId }) {
  const { threadRef } = use(TimelineRowCtx);
  const starred = useAtomValue(environmentThreadDetails.isMessageStarredAtom(threadRef, messageId));
  if (!starred) return null;
  return (
    <StarIcon role="img" aria-label={t("Starred")} className="size-3 fill-current text-primary" />
  );
}
