import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { runClaudeHistoryWorker } from "../claudeHistoryWorker.ts";

/** Single-executable builds lack Node, so they use this subcommand instead of claudeHistoryWorker.mjs. */
export const claudeHistoryCommand = Command.make("__claude-history", {
  method: Argument.String("method"),
  input: Argument.String("input"),
  options: Argument.String("options").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ method, input, options }) =>
    Effect.promise(() =>
      runClaudeHistoryWorker(method, input, options._tag === "Some" ? options.value : undefined),
    ),
  ),
);
