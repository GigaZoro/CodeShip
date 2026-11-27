import type { OrchestrationV2ProviderFailureClass, ThreadId } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The thread error above the timeline. It takes its own row, so it never covers messages. The
 * dismiss handler is built here from plain values, so a ChatView render that leaves the error
 * unchanged keeps the banner cached.
 */
export function ChatBannerLane(props: {
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  return (
    <div className="z-30 flex shrink-0 flex-col ps-(--chat-lane-inset-start,0px) pe-(--chat-lane-inset-end,0px) empty:hidden not-empty:pb-2">
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        onDismiss={() => {
          setThreadError(threadId, null);
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
    </div>
  );
}
