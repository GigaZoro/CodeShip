import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ProviderDriverError } from "./Errors.ts";
import type * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

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
  readonly checkAccount?: Effect.Effect<void, C>;
  readonly snapshot: Pick<ManagedServerProvider, "getSnapshot" | "refresh">;
}): NonNullable<ProviderInstance["consumeResetCredit"]> {
  const failure = (detail: string, cause?: unknown) =>
    new ProviderDriverError({ driver: DRIVER, instanceId: input.instanceId, detail, cause });
  return () =>
    input.coordinator
      .redeem(input.accountHome, (idempotencyKey) =>
        Effect.gen(function* () {
          if (input.checkAccount) yield* input.checkAccount;
          const client = yield* input.openClient;
          const response = yield* client.request("account/rateLimitResetCredit/consume", {
            idempotencyKey,
          });
          return response.outcome;
        }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProviderDriverError(cause)
            ? cause
            : failure("Codex could not redeem the reset credit.", cause),
        ),
        // The windows just changed; re-probe so the snapshot says so. A failed probe republishes
        // the pre-redemption limits rather than marking them failed, so "confirmed" means
        // `checkedAt` moved past what was published before the redemption started. The credit is
        // spent either way, so an unconfirmed reset still succeeds.
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            const before = (yield* input.snapshot.getSnapshot).usageLimits?.checkedAt;
            const refreshed = yield* input.snapshot.refresh;
            const after = refreshed.usageLimits?.checkedAt;
            return outcome === "reset" &&
              (after === undefined ||
                after === before ||
                refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ? {
                  outcome,
                  warning:
                    "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                }
              : { outcome };
          }),
        ),
      );
}
