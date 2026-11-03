import * as Schema from "effect/Schema";

export const VISUAL_STUDIO_AUTO_CONTINUE_DEFAULT_MINUTES = 30;
const VISUAL_STUDIO_AUTO_CONTINUE_MAX_MINUTES = 240;

const solution = Schema.optional(
  Schema.String.annotate({
    description:
      "Part of the .sln path, when several Visual Studio windows are open. Default: the one that is debugging.",
  }),
);

export const VisualStudioMode = Schema.Literals(["design", "run", "break"]);
export type VisualStudioMode = typeof VisualStudioMode.Type;

export const VisualStudioException = Schema.Struct({
  type: Schema.String,
  details: Schema.optional(Schema.String),
});
export type VisualStudioException = typeof VisualStudioException.Type;

export const VisualStudioWindow = Schema.Struct({
  solution: Schema.String,
  mode: VisualStudioMode,
  process: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  exception: Schema.optional(Schema.NullOr(VisualStudioException)),
  location: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.Array(Schema.String)),
  locals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.NullOr(Schema.String),
        value: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});
export type VisualStudioWindow = typeof VisualStudioWindow.Type;

export const VisualStudioResumedBreak = Schema.Struct({
  reason: Schema.optional(Schema.String),
  exception: Schema.NullOr(VisualStudioException),
  location: Schema.optional(Schema.String),
  stack: Schema.Array(Schema.String),
});
export type VisualStudioResumedBreak = typeof VisualStudioResumedBreak.Type;

export const VisualStudioAutoContinueStop = Schema.Literals([
  "turned-off",
  "debugging-ended",
  "time-limit",
  "paused",
  "failed",
]);
export type VisualStudioAutoContinueStop = typeof VisualStudioAutoContinueStop.Type;

export const VisualStudioAutoContinue = Schema.Struct({
  on: Schema.Boolean,
  solution: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
  stopped: Schema.optional(VisualStudioAutoContinueStop),
  stoppedReason: Schema.optional(Schema.String),
  resumedCount: Schema.Int,
  recent: Schema.Array(VisualStudioResumedBreak),
});
export type VisualStudioAutoContinue = typeof VisualStudioAutoContinue.Type;

export const VisualStudioStatusInput = Schema.Struct({ solution });
export type VisualStudioStatusInput = typeof VisualStudioStatusInput.Type;

export const VisualStudioStatusResult = Schema.Struct({
  windows: Schema.Array(VisualStudioWindow),
  autoContinue: VisualStudioAutoContinue,
});
export type VisualStudioStatusResult = typeof VisualStudioStatusResult.Type;

export const VisualStudioEvalInput = Schema.Struct({
  expression: Schema.String.annotate({
    description: "C# expression in the paused frame, e.g. `order.Items.Count`.",
  }),
  solution,
});
export type VisualStudioEvalInput = typeof VisualStudioEvalInput.Type;

export const VisualStudioEvalResult = Schema.Struct({
  expression: Schema.String,
  valid: Schema.Boolean,
  type: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.String),
});
export type VisualStudioEvalResult = typeof VisualStudioEvalResult.Type;

export const VisualStudioControlInput = Schema.Struct({
  action: Schema.Literals(["continue", "start", "stop"]).annotate({
    description: "`continue` resumes a paused app (F5), `start` builds and debugs, `stop` ends it.",
  }),
  solution,
});
export type VisualStudioControlInput = typeof VisualStudioControlInput.Type;

export const VisualStudioAutoContinueInput = Schema.Struct({
  enabled: Schema.Boolean,
  solution,
  minutes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: VISUAL_STUDIO_AUTO_CONTINUE_MAX_MINUTES }),
    ).annotate({
      description: `Time limit. Default ${VISUAL_STUDIO_AUTO_CONTINUE_DEFAULT_MINUTES}.`,
    }),
  ),
  includeBreakpoints: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also continue past breakpoints. Default false: stop at the first one.",
    }),
  ),
});
export type VisualStudioAutoContinueInput = typeof VisualStudioAutoContinueInput.Type;

/** What the Visual Studio helper reported: not running, nothing paused, an ambiguous window. */
export class VisualStudioUnavailableError extends Schema.TaggedError<VisualStudioUnavailableError>()(
  "VisualStudioUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class VisualStudioHelperError extends Schema.TaggedError<VisualStudioHelperError>()(
  "VisualStudioHelperError",
  {
    stage: Schema.Literals(["run", "timeout", "output"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.stage === "timeout"
      ? "Visual Studio did not answer in time. It may be showing a dialog; ask the user to check it."
      : this.stage === "output"
        ? "CodeShip could not read the Visual Studio helper's answer."
        : "CodeShip could not run its Visual Studio helper (powershell.exe).";
  }
}

export const VisualStudioError = Schema.Union([
  VisualStudioUnavailableError,
  VisualStudioHelperError,
]);
export type VisualStudioError = typeof VisualStudioError.Type;
