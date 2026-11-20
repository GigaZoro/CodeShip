import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const JOURNAL_FILE = "scheduled-task-launches.ndjson";
// About 200 bytes a line: a few MB hold months of launches, unlike the span trace, which fills in minutes.
const JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_MAX_FILES = 3;

const encodeLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface LaunchMilestone {
  readonly taskId: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly milestone:
    | "started"
    | "prompt_ready"
    | "launching"
    | "chat_created"
    | "prompt_sent"
    | "worktree_prepared"
    | "deferred"
    | "launched"
    | "finished"
    | "skipped";
  /** The reason it skipped, the outcome it finished with, or the chat it launched. */
  readonly detail?: string;
}

/**
 * A small log of where each scheduled run got to, kept apart from the span trace so a run that never
 * reached a chat still shows its last step days later. A run with `started` and no `finished` stopped
 * after its last line. Writing never fails a run.
 */
export class LaunchJournal extends Context.Reference<{
  readonly record: (milestone: LaunchMilestone) => Effect.Effect<void>;
}>("t3/scheduledTasks/LaunchJournal", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const filePath = path.join(path.dirname(serverTracePath), JOURNAL_FILE);
    const sink = yield* makeAsyncRotatingFileSink({
      filePath,
      maxBytes: JOURNAL_MAX_BYTES,
      maxFiles: JOURNAL_MAX_FILES,
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("scheduled task launch journal unavailable", { filePath }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    return Layer.succeed(
      LaunchJournal,
      LaunchJournal.of({
        record: Effect.fn("LaunchJournal.record")(function* (milestone) {
          if (sink === undefined) return;
          const now = yield* DateTime.now;
          yield* encodeLine({ time: DateTime.formatIso(now), ...milestone }).pipe(
            Effect.flatMap((line) => sink.write(`${line}\n`)),
            Effect.catch(() =>
              Effect.logWarning("scheduled task launch journal write failed", { filePath }),
            ),
          );
        }),
      }),
    );
  }),
);
