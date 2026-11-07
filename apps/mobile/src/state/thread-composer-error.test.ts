import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import {
  clearThreadComposerErrorsForEnvironment,
  reportThreadCommandFailure,
  setThreadComposerError,
  threadComposerErrorsAtom,
} from "./thread-composer-error";

afterEach(() => {
  appAtomRegistry.set(threadComposerErrorsAtom, {});
});

describe("thread composer errors", () => {
  it("clears every thread's error for a removed environment and no others", () => {
    setThreadComposerError("environment-1:thread-1", "one");
    setThreadComposerError("environment-1:thread-2", "two");
    setThreadComposerError("environment-10:thread-1", "other environment");

    clearThreadComposerErrorsForEnvironment("environment-1");

    expect(Object.keys(appAtomRegistry.get(threadComposerErrorsAtom))).toEqual([
      "environment-10:thread-1",
    ]);
  });

  it.each([
    [
      "a failure's own message",
      AsyncResult.failure(Cause.fail(new Error("Run is gone"))),
      "Run is gone",
    ],
    [
      "the fallback for a non-error failure",
      AsyncResult.failure(Cause.fail("rejected")),
      "Stop failed",
    ],
    ["nothing for an interrupted command", AsyncResult.failure(Cause.interrupt()), undefined],
    ["nothing for a success", AsyncResult.success(undefined), undefined],
  ])("reports %s to the thread's composer", (_case, result, message) => {
    reportThreadCommandFailure("environment-1:thread-1", result, "Stop failed");

    expect(appAtomRegistry.get(threadComposerErrorsAtom)["environment-1:thread-1"]?.message).toBe(
      message,
    );
  });
});
