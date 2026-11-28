import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerSelfUpdateMethod } from "./environment.ts";
import { DesktopUpdateChannelSchema } from "./settingsPrimitives.ts";

export const ServerSelfUpdateOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateOutcome = typeof ServerSelfUpdateOutcome.Type;

export const ServerSelfUpdateInput = Schema.Struct({
  /** Exact npm version, never a dist-tag, so server and client agree on the request. */
  targetVersion: TrimmedNonEmptyString,
  /** Desktop-managed hosts move their app to this update track first. Sent only for a track switch. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  /** The target release's highest migration; the host refuses to leave Nightly without it. */
  targetDatabaseMigration: Schema.optionalKey(Schema.Int),
});
export type ServerSelfUpdateInput = typeof ServerSelfUpdateInput.Type;

export const ServerSelfUpdateResult = Schema.Struct({
  targetVersion: TrimmedNonEmptyString,
  method: ServerSelfUpdateMethod,
  updateId: Schema.optionalKey(TrimmedNonEmptyString),
  desktopUpdateToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateResult = typeof ServerSelfUpdateResult.Type;

export const DesktopUpdateCommitInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type DesktopUpdateCommitInput = typeof DesktopUpdateCommitInput.Type;

export const ServerSelfUpdateProgressStage = Schema.Literals(["downloading", "installing"]);
export type ServerSelfUpdateProgressStage = typeof ServerSelfUpdateProgressStage.Type;

export const ServerSelfUpdateProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: ServerSelfUpdateProgressStage,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    result: ServerSelfUpdateResult,
  }),
]);
export type ServerSelfUpdateProgressEvent = typeof ServerSelfUpdateProgressEvent.Type;

export class ServerSelfUpdateError extends Schema.TaggedError<ServerSelfUpdateError>()(
  "ServerSelfUpdateError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update failed: ${this.reason}`;
  }
}
