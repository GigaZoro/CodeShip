import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import type { ThreadFamilyRead } from "./threads.ts";

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  /**
   * Set when the shell can leave idle subagent children out: absence alone is not deletion there,
   * only a settled family read without the row is.
   */
  readonly familyRead?: ThreadFamilyRead;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    if (input.threadExists) {
      return "remove";
    }
    // Wait for live shells; an unsynchronized list can hide delivered creations and cause duplicate re-issuance.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" &&
      (input.familyRead === undefined || input.familyRead === "settled")
      ? "remove"
      : "wait";
  }
  return input.environmentConnected ? "send" : "wait";
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

/** Dispatch/auth rejections invalidate payloads; other typed failures may be disconnected transports and must retry. */
export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
        return false;
      case "ConnectionTransientError":
      case "RpcClientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return true;
      default:
        break;
    }
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}
