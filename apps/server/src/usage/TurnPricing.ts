import type { UsageReadError, UsageTokenTotals } from "@t3tools/contracts/usage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as UsageService from "./UsageService.ts";

const TurnUsageJson = Schema.fromJsonString(
  Schema.Struct({
    usageStatus: Schema.String,
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheCreationTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
    models: Schema.optional(Schema.Array(Schema.String)),
    localCommand: Schema.optional(Schema.Boolean),
  }),
);
const decodeTurnUsage = Schema.decodeUnknownOption(TurnUsageJson);

interface PricedTurn {
  /** Null when the stored usage could not be read. */
  readonly usage: typeof TurnUsageJson.Type | null;
  /** Null when the turn has no token counts or its model has no price. */
  readonly costUsd: number | null;
}

/**
 * Prices a provider turn's own `turnTokenUsage` at Usage's model prices, in input order. A turn the
 * user ran as a local shell command has no model cost and comes back `null`.
 */
export const priceTurns = Effect.fn("TurnPricing.priceTurns")(function* (
  usage: UsageService.UsageService["Service"],
  turns: ReadonlyArray<{
    readonly usageJson: string | null;
    readonly fallbackModel: string | null;
  }>,
): Effect.fn.Return<ReadonlyArray<PricedTurn | null>, UsageReadError> {
  const decoded = turns.map((turn) =>
    turn.usageJson === null ? Option.none() : decodeTurnUsage(turn.usageJson),
  );
  const priceable: Array<{
    readonly index: number;
    readonly model: string;
    readonly totals: UsageTokenTotals;
  }> = [];
  decoded.forEach((option, index) => {
    if (Option.isNone(option) || option.value.localCommand === true) return;
    const turnUsage = option.value;
    const model = turnUsage.models?.[0] ?? turns[index]!.fallbackModel;
    if (turnUsage.usageStatus === "unavailable" || model === null) return;
    const cached = turnUsage.cachedInputTokens ?? 0;
    const created = turnUsage.cacheCreationTokens ?? 0;
    priceable.push({
      index,
      model,
      totals: {
        uncachedInputTokens: Math.max(0, (turnUsage.inputTokens ?? 0) - cached - created),
        cachedInputTokens: cached,
        cacheCreationTokens: created,
        outputTokens: turnUsage.outputTokens ?? 0,
        reasoningTokens: turnUsage.reasoningTokens ?? 0,
      },
    });
  });
  const prices = yield* usage.priceTokens(priceable);
  const costs = new Map<number, number | null>();
  priceable.forEach((item, position) => costs.set(item.index, prices[position] ?? null));
  return decoded.map((option, index): PricedTurn | null => {
    if (Option.isSome(option) && option.value.localCommand === true) return null;
    return {
      usage: Option.isSome(option) ? option.value : null,
      costUsd: costs.get(index) ?? null,
    };
  });
});
