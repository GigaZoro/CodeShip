import {
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
} from "@t3tools/contracts";
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
