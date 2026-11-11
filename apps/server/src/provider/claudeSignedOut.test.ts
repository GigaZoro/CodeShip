import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { CLAUDE_SIGNED_OUT_MESSAGE, makeClaudeAuthenticationFailure } from "./claudeSignedOut.ts";

const probed: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent_2"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.322",
  status: "ready",
  auth: { status: "authenticated", email: "person@example.com" },
  checkedAt: "2026-11-11T07:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const setup = Effect.gen(function* () {
  const login = yield* Ref.make<string | undefined>("2026-12-01T00:00:00.000Z");
  const failure = yield* makeClaudeAuthenticationFailure(Ref.get(login));
  return { login, failure };
});

it.effect("a probe that still reads signed in is overruled by the failed turn", () =>
  Effect.gen(function* () {
    const { failure } = yield* setup;
    assert.deepEqual(yield* failure.apply(probed), probed);
    yield* failure.record;
    const marked = yield* failure.apply(probed);
    assert.equal(marked.auth.status, "unauthenticated");
    assert.equal(marked.status, "error");
    assert.equal(marked.message, CLAUDE_SIGNED_OUT_MESSAGE);
    assert.equal(marked.auth.email, "person@example.com");
  }),
);

it.effect("a new sign-in changes the saved login and ends the failure without a restart", () =>
  Effect.gen(function* () {
    const { login, failure } = yield* setup;
    yield* failure.record;
    yield* Ref.set(login, "2027-01-15T00:00:00.000Z");
    assert.deepEqual(yield* failure.apply(probed), probed);
    // The failure is forgotten, not just skipped once.
    yield* Ref.set(login, "2026-12-01T00:00:00.000Z");
    assert.deepEqual(yield* failure.apply(probed), probed);
  }),
);

it.effect("a turn that ran on the login ends the failure", () =>
  Effect.gen(function* () {
    const { failure } = yield* setup;
    assert.isFalse(yield* failure.clear);
    yield* failure.record;
    assert.isTrue(yield* failure.clear);
    assert.deepEqual(yield* failure.apply(probed), probed);
  }),
);

it.effect("an account that already reads signed out or unknown keeps its own status", () =>
  Effect.gen(function* () {
    const { failure } = yield* setup;
    yield* failure.record;
    const unknown: ServerProvider = { ...probed, status: "warning", auth: { status: "unknown" } };
    assert.deepEqual(yield* failure.apply(unknown), unknown);
  }),
);
