import { describe, expect, it } from "@effect/vitest";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClaudeSettingsResolveError,
  claudeSettingsWorkerFailureKind,
  retryTimedOutClaudeWorker,
} from "./ClaudeSettingsCascade.ts";
import { ClaudeWorkerError } from "./ClaudeWorker.ts";

const decodeWorkerOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const SECRET = "sk-ant-secret-token-123";

describe("Claude settings resolution failures", () => {
  it.effect("tells each worker failure kind apart", () =>
    Effect.gen(function* () {
      const decodeFailure = yield* Effect.flip(decodeWorkerOutput("not json"));
      expect([
        claudeSettingsWorkerFailureKind({ _tag: "TimeoutError" }),
        claudeSettingsWorkerFailureKind(
          new ClaudeWorkerError({ method: "resolveSettings", cause: SECRET }),
        ),
        claudeSettingsWorkerFailureKind(decodeFailure),
        claudeSettingsWorkerFailureKind({ _tag: "PlatformError" }),
        claudeSettingsWorkerFailureKind({ _tag: "ProviderCommandNotFoundError" }),
        claudeSettingsWorkerFailureKind(new Error(SECRET)),
      ]).toEqual(["timeout", "nonzero-exit", "invalid-output", "spawn", "spawn", "sdk-error"]);
    }),
  );

  // regression: account-worker timeouts on a busy machine failed delegated turns that a second read would have started
  it.effect("reads a timed-out account worker once more, and nothing else again", () =>
    Effect.gen(function* () {
      const attempts = (failures: ReadonlyArray<unknown>) => {
        let calls = 0;
        const read = Effect.suspend(() => {
          const failure = failures[calls++];
          return failure === undefined ? Effect.succeed("[]") : Effect.fail(failure);
        });
        return { read, calls: () => calls };
      };
      const timeout = new Cause.TimeoutError();

      const recovered = attempts([timeout]);
      expect(yield* retryTimedOutClaudeWorker(recovered.read)).toBe("[]");
      expect(recovered.calls()).toBe(2);

      const stuck = attempts([timeout, timeout]);
      expect(yield* Effect.flip(retryTimedOutClaudeWorker(stuck.read))).toBe(timeout);
      expect(stuck.calls()).toBe(2);

      const refused = new ClaudeWorkerError({ method: "resolveSettings", cause: SECRET });
      const exited = attempts([refused]);
      expect(yield* Effect.flip(retryTimedOutClaudeWorker(exited.read))).toBe(refused);
      expect(exited.calls()).toBe(1);
    }),
  );

  it("keeps the phase and kind, and never the cause text, in the persisted failure message", () => {
    const error = new ClaudeSettingsResolveError({
      phase: "account-worker",
      kind: "nonzero-exit",
      cause: new ClaudeWorkerError({ method: "resolveSettings", cause: `stderr ${SECRET}` }),
    });
    const message = knownProviderFailureMessage(error);
    expect(message).toBe("Claude's settings could not be resolved (account-worker: nonzero-exit).");
    expect(message).not.toContain(SECRET);
  });
});
