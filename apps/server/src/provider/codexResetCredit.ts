import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import { usageAccountKey } from "@t3tools/provider-core/server/usageLimits";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ProviderDriverError } from "./Errors.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const DRIVER = ProviderDriverKind.make("codex");
const isProviderDriverError = Schema.is(ProviderDriverError);

/**
 * Redemption spends the credit of the Codex login in `accountHome`, so instances sharing that
 * auth.json directory serialize on it. The wait is bounded so a hung app-server cannot hold the lock.
 */
export function makeCodexConsumeResetCredit<E, C>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly accountHome: string;
  readonly coordinator: ResetCreditCoordinator.ResetCreditCoordinator["Service"];
  readonly openClient: Effect.Effect<CodexClient.CodexAppServerClient["Service"], E, Scope.Scope>;
  /** Fails when the login can no longer spend credits for the account this instance reports. */
  readonly checkAccount?: (accountId: string | null | undefined) => Effect.Effect<void, C>;
  readonly snapshot: Pick<ManagedServerProvider, "refreshAfterRedemption">;
}): NonNullable<ProviderInstance["consumeResetCredit"]> {
  const failure = (detail: string, cause?: unknown) =>
    new ProviderDriverError({ driver: DRIVER, instanceId: input.instanceId, detail, cause });
  return (request) =>
    ResetCreditCoordinator.redeemThenReadUsage({
      redeem: input.coordinator
        .redeem(
          input.accountHome,
          (idempotencyKey) =>
            Effect.gen(function* () {
              const client = yield* input.openClient;
              // The login can switch accounts after the claim was decided; never spend another's.
              if (input.checkAccount || request?.accountKey !== undefined) {
                const read = yield* client.request("account/rateLimits/read", null);
                if (input.checkAccount) yield* input.checkAccount(read.accountId);
                if (
                  request?.accountKey !== undefined &&
                  usageAccountKey(read.accountId) !== request.accountKey
                ) {
                  return yield* failure(
                    "The Codex login now holds another account, so its reset was not used.",
                  );
                }
              }
              const response = yield* client.request("account/rateLimitResetCredit/consume", {
                idempotencyKey,
              });
              return response.outcome;
            }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
          undefined,
          request?.attemptKey,
        )
        .pipe(
          Effect.mapError((cause) =>
            isProviderDriverError(cause)
              ? cause
              : failure("Codex could not redeem the reset credit.", cause),
          ),
        ),
      readUsage: input.snapshot.refreshAfterRedemption,
      provider: "Codex",
    });
}
