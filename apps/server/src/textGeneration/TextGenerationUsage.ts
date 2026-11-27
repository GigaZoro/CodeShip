import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** One model's tokens in one provider call. Null is unknown, never zero; input includes cache. */
export interface TextGenerationCallUsage {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
}

export const unknownCallUsage = (model: string | null): TextGenerationCallUsage => ({
  model,
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
});

/**
 * Where a provider runner reports the measured usage of the calls it made. `TextGeneration` writes
 * what it collects once the generation ends. Must be synchronous and nonthrowing.
 */
export const TextGenerationUsageSink = Context.Reference<
  (usage: ReadonlyArray<TextGenerationCallUsage>) => void
>("t3/textGeneration/TextGenerationUsage/Sink", { defaultValue: () => () => {} });

/** The thread and demand a one-shot call serves. Left unset, its usage is unattributed. */
export const TextGenerationAttribution = Context.Reference<{
  readonly threadId: ThreadId | null;
  readonly demandId: string | null;
}>("t3/textGeneration/TextGenerationUsage/Attribution", {
  defaultValue: () => ({ threadId: null, demandId: null }),
});
