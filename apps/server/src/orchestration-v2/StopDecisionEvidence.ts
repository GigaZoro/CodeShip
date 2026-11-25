// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous routing needs deterministic opaque identifiers.
import * as NodeCrypto from "node:crypto";
import type {
  CommandId,
  OrchestrationV2ServerCommand,
  OrchestrationV2StoredEvent,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AccountEligibility } from "./AccountRouting.ts";
import type { limitFailoverDecision } from "./UsageLimitRecoveryWorker.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const evidenceKey = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

type Dispatch = Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;
export const recoveryRequestKey = (command: Dispatch) => evidenceKey(stableStringify(command));

type Candidate = { id: string; reason: AccountEligibility | "source_account" };

export function boundedCandidates(all: Candidate[], selected: string | null) {
  const candidates = all.slice(0, 64);
  const omitted = all.length - candidates.length;
  if (omitted && selected && !candidates.some((entry) => entry.id === selected)) {
    const chosen = all.find((entry) => entry.id === selected);
    if (chosen) candidates[63] = chosen;
  }
  return { candidates, omitted };
}

export interface RecoveryRequest {
  readonly key: string;
  readonly decisionKey: string;
}

export type RecordRoute = (
  selected: string | null,
  observations: ReturnType<typeof boundedCandidates>,
) => Effect.Effect<RecoveryRequest>;

export const recordStopDecision = Effect.fn("StopDecisionEvidence.record")(function* (
  input: {
    source: RunId;
    heldAttempt: RunAttemptId | undefined;
    evidence: ReturnType<typeof limitFailoverDecision>["evidence"];
    command: Dispatch | null;
    nowMs: number;
  },
  dispatch?: { selected: string | null; observations: ReturnType<typeof boundedCandidates> },
) {
  const sql = yield* SqlClient.SqlClient;
  const snapshot = encodeJson(
    dispatch
      ? { ...input.evidence, dispatch: { ...dispatch.observations, selected: dispatch.selected } }
      : input.evidence,
  );
  const source = evidenceKey(input.source);
  const request = input.command === null ? null : recoveryRequestKey(input.command);
  const key = evidenceKey(encodeJson([source, input.heldAttempt, request, snapshot]));
  yield* sql`INSERT INTO usage_stop_decisions
    (decision_key, source_key, request_key, selected_key, snapshot, observed_ms)
    VALUES (${key}, ${source}, ${request}, ${dispatch?.selected ?? input.evidence.selected}, ${snapshot}, ${input.nowMs})
    ON CONFLICT(decision_key) DO NOTHING`;
  return key;
});

export const recordDispatchFailure = Effect.fn("StopDecisionEvidence.dispatchFailure")(function* (
  decisionKey: string,
  outcome: "refused" | "failed",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE usage_stop_decisions SET outcome = ${outcome}
    WHERE decision_key = ${decisionKey} AND outcome IN ('planned','failed')`;
});

export const recordCommittedContinuation = Effect.fn("StopDecisionEvidence.commit")(function* (
  sql: SqlClient.SqlClient,
  command: CommandId,
  request: RecoveryRequest,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  for (const { event } of events) {
    if (
      (event.type !== "run.created" && event.type !== "run.updated") ||
      String(event.payload.userMessageId) !== String(command)
    )
      continue;
    const run = event.payload;
    const created = events.find(
      ({ event: attempt }) =>
        attempt.type === "run-attempt.created" &&
        attempt.payload.id === run.activeAttemptId &&
        attempt.payload.runId === run.id,
    );
    if (created === undefined) continue;
    // A held run restarts in place; a terminal stop creates a run linked to its source.
    const source =
      created.event.type === "run-attempt.created" &&
      created.event.payload.reason === "steering_restart"
        ? run.id
        : run.automaticContinuationOfRunId;
    if (source === undefined) continue;
    const selected = evidenceKey(run.providerInstanceId);
    yield* sql`UPDATE usage_stop_decisions SET outcome = 'accepted', attempt_sequence = ${created.sequence},
        selected_key = ${selected}
      WHERE decision_key = ${request.decisionKey} AND request_key = ${request.key} AND source_key = ${evidenceKey(source)}`;
    return;
  }
  yield* sql`UPDATE usage_stop_decisions SET outcome = 'accepted_without_attempt'
    WHERE decision_key = ${request.decisionKey} AND request_key = ${request.key} AND outcome IN ('planned','failed','refused')`;
});
