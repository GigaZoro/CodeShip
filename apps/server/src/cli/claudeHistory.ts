import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/** Single-executable builds lack Node, so they use this subcommand instead of claudeHistoryWorker.mjs. */
export const claudeHistoryCommand = Command.make("__claude-history", {
  method: Argument.String("method"),
  input: Argument.String("input"),
  options: Argument.String("options").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ method, input, options }) =>
    // Two effects, so an interrupt during the import never starts the worker.
    Effect.promise(() => import("../claudeHistoryWorker.ts")).pipe(
      Effect.flatMap(({ runClaudeHistoryWorker }) =>
        Effect.promise(() =>
          runClaudeHistoryWorker(
            method,
            input,
            options._tag === "Some" ? options.value : undefined,
          ),
        ),
      ),
    ),
  ),
);
