import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { usageAccountKey } from "@t3tools/provider-core/server/usageLimits";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeCodexConsumeResetCredit } from "./codexResetCredit.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const consumeWith = Effect.fn("consumeWith")(function* (
  keys: Ref.Ref<ReadonlyArray<string>>,
  request: { readonly attemptKey: string; readonly accountKey?: string },
) {
  const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
  const client = {
    request: (method: string, params: { readonly idempotencyKey: string } | null) =>
      method === "account/rateLimits/read"
        ? Effect.succeed({ accountId: "account-b" })
        : Ref.update(keys, (seen) => [...seen, params!.idempotencyKey]).pipe(
            Effect.as({ outcome: "nothingToReset" as const }),
          ),
  };
  const consume = makeCodexConsumeResetCredit({
    instanceId: ProviderInstanceId.make("codex"),
    accountHome: "/home/codex",
    coordinator,
    openClient: Effect.succeed(client as never),
    snapshot: { refreshAfterRedemption: Effect.forkChild(Effect.succeed(true)) },
  });
  return yield* consume(request);
});

it.effect("sends the attempt key to the app-server as its idempotency key", () =>
  Effect.gen(function* () {
    const keys = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* consumeWith(keys, { attemptKey: "banked-reset:account:codex:1792065600" });
    yield* consumeWith(keys, { attemptKey: "banked-reset:account:codex:1792065600" });
    assert.deepEqual(yield* Ref.get(keys), [
      "banked-reset:account:codex:1792065600",
      "banked-reset:account:codex:1792065600",
    ]);
  }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
);

it.effect("spends nothing once the login holds another account", () =>
  Effect.gen(function* () {
    const keys = yield* Ref.make<ReadonlyArray<string>>([]);
    const attemptKey = "banked-reset:account:codex:1792065600";
    const other = yield* Effect.flip(
      consumeWith(keys, { attemptKey, accountKey: usageAccountKey("account-a")! }),
    );
    assert.include(other.detail, "another account");
    yield* consumeWith(keys, { attemptKey, accountKey: usageAccountKey("account-b")! });
    assert.deepEqual(yield* Ref.get(keys), [attemptKey]);
  }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
);
