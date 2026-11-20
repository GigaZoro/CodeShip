import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  MonitoringFixChatError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";

import { monitoringFixChatFailureMessage } from "./text.ts";

describe("monitoringFixChatFailureMessage", () => {
  it.each([
    [
      "the server's reason",
      new MonitoringFixChatError({ reason: "no-model", detail: "" }),
      "No provider account on that machine is signed in. Sign in to one, then try again.",
    ],
    [
      "a refused grant",
      new EnvironmentAuthorizationError({
        message: "",
        requiredScope: AuthOrchestrationOperateScope,
      }),
      "This connection may not start chats on that machine.",
    ],
    [
      "any other failure as unreachable",
      new Error("socket closed"),
      "Could not reach the machine that runs the chat.",
    ],
  ])("words %s", (_, error, message) => {
    expect(monitoringFixChatFailureMessage(Cause.fail(error))).toBe(message);
  });
});
