import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderMcpServerName } from "./providerMcp.ts";
import { ModelSelection } from "./modelSelection.ts";

/** `needs-you` is a money decision; `hands-on` is a step only a person can do. */
export const ManualStepKind = Schema.Literals(["needs-you", "hands-on"]);
export type ManualStepKind = typeof ManualStepKind.Type;

/** A Waiting thread on one machine's pending list in ThreadPage. */
export const ManualStep = Schema.Struct({
  /** The ThreadPage thread's id; several machines list the same thread under this id. */
  threadId: Schema.String,
  title: Schema.String,
  /** The thread's description without its `Needs you:` or `Hands-on:` prefix, on one line. */
  step: Schema.String,
  kind: ManualStepKind,
  /** The machine folder the thread sits in. */
  machine: Schema.String,
  /** When a note in the thread last changed: the step has waited at least since then. */
  updatedAt: Schema.String,
  url: Schema.String,
  /** The chat that holds the step, from a `Chat: <t3-thread://v2/…>` line in the description. */
  chat: Schema.optional(ScopedThreadRef),
});
export type ManualStep = typeof ManualStep.Type;

export const ManualStepsListResult = Schema.Union([
  /** This server has no ThreadPage token. */
  Schema.TaggedStruct("NotConnected", {}),
  Schema.TaggedStruct("Listed", {
    steps: Schema.Array(ManualStep),
    checkedAt: Schema.String,
  }),
]);
export type ManualStepsListResult = typeof ManualStepsListResult.Type;

/** Why ThreadPage could not be read, for clients to explain in their own words. */
export const ManualStepsListFailure = Schema.Literals([
  /** ThreadPage refused the token: revoked, replaced or expired. */
  "token-rejected",
  /** The token's access does not cover reading threads. */
  "access-denied",
  /** The owner paused the connection in ThreadPage. */
  "paused",
  "rate-limited",
  /** No folder named Machine inbox is visible to the token. */
  "no-inbox",
  "unreachable",
]);
export type ManualStepsListFailure = typeof ManualStepsListFailure.Type;

export class ManualStepsListError extends Schema.TaggedError<ManualStepsListError>()(
  "ManualStepsListError",
  { reason: ManualStepsListFailure, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Why a machine found a step on its own, without ThreadPage. */
export const DetectedManualStepKind = Schema.Literals([
  /** An enabled provider account is not signed in. */
  "signed-out",
  /** A saved login stops renewing within days. */
  "login-expiring",
  /** A saved login stopped renewing; every request fails until it is signed in again. */
  "login-expired",
  /** An MCP server of a provider account needs signing in. */
  "mcp-needs-auth",
]);
export type DetectedManualStepKind = typeof DetectedManualStepKind.Type;

/**
 * A sign-in a server noticed on its own machine. The fix opens in that machine's settings: the
 * account's card for the first three kinds, the server's row on the MCP page for the last.
 */
export const DetectedManualStep = Schema.Struct({
  /** Unique on its machine: one per provider instance, kind and MCP server. */
  id: TrimmedNonEmptyString,
  kind: DetectedManualStepKind,
  /** The machine's name, as its environment is labelled. */
  machine: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  /** The account's name in the provider list; absent for the driver's default account. */
  accountName: Schema.optional(TrimmedNonEmptyString),
  /** The MCP server, for `mcp-needs-auth`. */
  serverName: Schema.optional(ProviderMcpServerName),
  serverDisplayName: Schema.optional(Schema.String),
  /** When the login stops renewing, for `login-expiring` and `login-expired`. */
  expiresAt: Schema.optional(IsoDateTime),
});
export type DetectedManualStep = typeof DetectedManualStep.Type;

export const DetectedManualStepsResult = Schema.Struct({
  steps: ForwardCompatibleArray(DetectedManualStep),
  checkedAt: IsoDateTime,
});
export type DetectedManualStepsResult = typeof DetectedManualStepsResult.Type;
/** One way to get a manual step done, as the AI review suggests it. */
export const ManualStepSolution = Schema.Struct({
  title: Schema.String,
  /** How, in one to three sentences. */
  detail: Schema.String,
  /** The exact command to run, when the solution has one. */
  command: Schema.optional(Schema.String),
  /** An agent could do this without the user. */
  agentCanDo: Schema.Boolean,
});
export type ManualStepSolution = typeof ManualStepSolution.Type;

/** An AI review of one manual step: whether it really needs a person, and ways to get it done. */
export const ManualStepReview = Schema.Struct({
  threadId: Schema.String,
  /** The step's `updatedAt` when it was reviewed; a newer note makes the review stale. */
  updatedAt: Schema.String,
  /** What the step is really waiting for, in one or two sentences. */
  summary: Schema.String,
  /** False when an agent could do the whole step without the user. */
  needsPerson: Schema.Boolean,
  /** Best first, one to three. */
  solutions: Schema.Array(ManualStepSolution),
  generatedAt: Schema.String,
  modelSelection: ModelSelection,
});
export type ManualStepReview = typeof ManualStepReview.Type;

export const ManualStepReviewInput = Schema.Struct({
  threadId: Schema.String,
  /**
   * The step version the client shows. A stored review of an older version is replaced, and a
   * new review is stored under at least this version so the client finds it under its own key.
   */
  updatedAt: Schema.String,
});
export type ManualStepReviewInput = typeof ManualStepReviewInput.Type;

export const ManualStepReviewFailure = Schema.Literals([
  ...ManualStepsListFailure.literals,
  /** This server has no ThreadPage token. */
  "not-connected",
  /** The thread is no longer a Waiting step in the Machine inbox. */
  "not-found",
  /** The model failed or answered in a form that could not be read. */
  "generation-failed",
]);
export type ManualStepReviewFailure = typeof ManualStepReviewFailure.Type;

export class ManualStepReviewError extends Schema.TaggedError<ManualStepReviewError>()(
  "ManualStepReviewError",
  { reason: ManualStepReviewFailure, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const MANUAL_STEP_DECISION_MAX_LENGTH = 2000;

/** What the user decided for a step: one of its review's solutions, or their own words. */
export const ManualStepDecision = Schema.Union([
  Schema.TaggedStruct("Solution", {
    title: Schema.String,
    detail: Schema.String,
    command: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Other", {
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(MANUAL_STEP_DECISION_MAX_LENGTH)),
  }),
]);
export type ManualStepDecision = typeof ManualStepDecision.Type;

/**
 * The step travels with the request, so a machine without a ThreadPage token can run the chat:
 * a step is best carried out on the machine whose list it is on.
 */
export const ManualStepStartChatInput = Schema.Struct({
  /**
   * The chat's thread takes this id, so a retry with the same id opens the chat the first
   * attempt started, and a client can tell from its thread list that an attempt went through.
   */
  commandId: CommandId,
  /** Where the user decided; absent means web. */
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
  step: ManualStep.mapFields(Struct.pick(["threadId", "title", "step", "kind", "machine", "url"])),
  decision: ManualStepDecision,
});
export type ManualStepStartChatInput = typeof ManualStepStartChatInput.Type;

export const ManualStepStartChatResult = Schema.Struct({ threadId: ThreadId });
export type ManualStepStartChatResult = typeof ManualStepStartChatResult.Type;

export const ManualStepStartChatFailure = Schema.Literals([
  /** No provider account on this machine is signed in and enabled. */
  "no-model",
  /** The chat could not be created or its first message was not accepted. */
  "launch-failed",
]);
export type ManualStepStartChatFailure = typeof ManualStepStartChatFailure.Type;

export class ManualStepStartChatError extends Schema.TaggedError<ManualStepStartChatError>()(
  "ManualStepStartChatError",
  { reason: ManualStepStartChatFailure, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
