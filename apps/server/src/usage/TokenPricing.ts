import type { UsageReadError, UsageTokenTotals } from "@t3tools/contracts/usage";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class TokenPricing extends Context.Service<
  TokenPricing,
  {
    readonly priceTokens: (
      items: ReadonlyArray<{ readonly model: string; readonly totals: UsageTokenTotals }>,
    ) => Effect.Effect<ReadonlyArray<number | null>, UsageReadError>;
  }
>()("t3/usage/TokenPricing") {}
