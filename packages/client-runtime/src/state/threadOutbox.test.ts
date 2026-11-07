import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";

import { EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/index.ts";
import {
  resolveThreadOutboxDeliveryAction,
  shouldRetryThreadOutboxDelivery,
} from "./threadOutbox.ts";

describe("thread outbox delivery", () => {
  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
  });

  it("removes a missing-thread message only after a settled family read when idle children can be omitted", () => {
    const missing = {
      isCreation: false,
      threadExists: false,
      shellStatus: "live",
      environmentConnected: true,
    } as const;
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "pending" })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "failed" })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "settled" })).toBe("remove");
  });

  it("sends existing-thread messages whenever connected so queued messages can steer", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
      }),
    ).toBe("wait");
  });

  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("remove");
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new OrchestrationDispatchCommandError({ message: "Thread no longer exists" }),
      ),
    ).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentAuthorizationError({
          message: "Missing scope",
          requiredScope: "orchestration:operate",
        }),
      ),
    ).toBe(false);
  });

  it("retries every in-flight transport failure by tag, not by message text", () => {
    const socketReasons = [
      new Socket.SocketReadError({ cause: new Error("The network connection was lost.") }),
      new Socket.SocketWriteError({ cause: new Error("Broken pipe") }),
      new Socket.SocketCloseError({ code: 1006 }),
      new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("timeout") }),
    ];
    for (const reason of socketReasons) {
      const error = new RpcClientError.RpcClientError({ reason });
      expect(isTransportConnectionErrorMessage(error.message)).toBe(
        reason._tag === "SocketCloseError" || reason._tag === "SocketOpenError",
      );
      expect(shouldRetryThreadOutboxDelivery(error)).toBe(true);
    }
    expect(
      shouldRetryThreadOutboxDelivery(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "Error decoding message",
            cause: new Error("Unexpected end of JSON input"),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentRpcUnavailableError({
          environmentId: "environment-1",
          message: "Home is not connected.",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentNotRegisteredError({ environmentId: EnvironmentId.make("environment-1") }),
      ),
    ).toBe(true);
  });
});
