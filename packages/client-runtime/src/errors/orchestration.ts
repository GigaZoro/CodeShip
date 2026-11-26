import {
  MAX_THREAD_STARRED_MESSAGES,
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationV2DispatchCommandError = Schema.is(OrchestrationV2DispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}

/** The server refused a command because the thread changed since the caller read it. */
export function wasThreadChangedMeanwhile(error: unknown): boolean {
  return isOrchestrationV2DispatchCommandError(error) && error.stale === true;
}

export function messageStarFailureMessage(error: unknown): string {
  const reason = isOrchestrationV2DispatchCommandError(error) ? error.messageStarReason : undefined;
  switch (reason) {
    case "message-not-found":
      return t("This message is no longer in the conversation.");
    case "limit-reached":
      return t("This chat has reached the limit of {limit} starred messages.", {
        limit: MAX_THREAD_STARRED_MESSAGES,
      });
    default:
      return t("Could not change the message star.");
  }
}
