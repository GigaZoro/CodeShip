import { describe, expect, it } from "@effect/vitest";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClaudeSettingsResolveError,
  claudeSettingsWorkerFailureKind,
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
