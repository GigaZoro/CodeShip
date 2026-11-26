// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous routing needs deterministic opaque identifiers.
import * as NodeCrypto from "node:crypto";
import type {
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
const recoveryRequestKey = (command: Dispatch) => evidenceKey(stableStringify(command));

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

type Observations = ReturnType<typeof boundedCandidates>;

interface DecisionInput {
  source: RunId;
  heldAttempt: RunAttemptId | undefined;
  evidence: ReturnType<typeof limitFailoverDecision>["evidence"];
  command: Dispatch | null;
  nowMs: number;
}

// Evidence never gates the continuation it describes: a failed write is logged and skipped.
const logFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("usage-stop-decision.record-failed", { operation, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

const RECENT_DECISIONS = 4096;

/**
 * Records one decision and returns its key, or undefined when the write failed. `recent` holds keys
 * this process already wrote, so a sweep that sees the same decision again takes no write lock.
 */
export const recordStopDecision = Effect.fn("StopDecisionEvidence.record")(function* (
  input: DecisionInput,
  options: {
    dispatch?: { selected: string | null; observations: Observations };
    recent?: Set<string>;
  } = {},
) {
  const { dispatch, recent } = options;
  const snapshot = encodeJson(
    dispatch
      ? { ...input.evidence, dispatch: { ...dispatch.observations, selected: dispatch.selected } }
      : input.evidence,
  );
  const source = evidenceKey(input.source);
  const occurrence =
    input.heldAttempt === undefined ? source : evidenceKey(encodeJson([source, input.heldAttempt]));
  const request = input.command === null ? null : recoveryRequestKey(input.command);
  const key = evidenceKey(encodeJson([source, input.heldAttempt, request, snapshot]));
  if (recent?.has(key)) return key;
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO usage_stop_decisions
      (decision_key, source_key, occurrence_key, request_key, selected_key, snapshot, observed_ms)
      VALUES (${key}, ${source}, ${occurrence}, ${request}, ${dispatch?.selected ?? input.evidence.selected}, ${snapshot}, ${input.nowMs})
      ON CONFLICT(decision_key) DO UPDATE SET occurrence_key = excluded.occurrence_key
      WHERE usage_stop_decisions.occurrence_key IS NULL`;
    if (recent) {
      recent.add(key);
      if (recent.size > RECENT_DECISIONS) recent.delete(recent.values().next().value!);
    }
    return key as string | undefined;
  }).pipe(logFailure("record"));
});

export const recordDispatchFailure = Effect.fn("StopDecisionEvidence.dispatchFailure")(function* (
  decisionKey: string,
  outcome: "refused" | "failed",
) {
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE usage_stop_decisions SET outcome = ${outcome}
      WHERE decision_key = ${decisionKey} AND outcome IN ('planned','failed')`;
  }).pipe(logFailure("dispatch-failure"));
});

const recordCommittedContinuation = Effect.fn("StopDecisionEvidence.commit")(function* (
  command: Dispatch,
  decisionKey: string,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  const requestKey = recoveryRequestKey(command);
  for (const { event } of events) {
    if (
      (event.type !== "run.created" && event.type !== "run.updated") ||
      String(event.payload.userMessageId) !== String(command.commandId)
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
      WHERE decision_key = ${decisionKey} AND request_key = ${requestKey} AND source_key = ${evidenceKey(source)}`;
    return;
  }
  yield* sql`UPDATE usage_stop_decisions SET outcome = 'accepted_without_attempt'
    WHERE decision_key = ${decisionKey} AND request_key = ${requestKey} AND outcome IN ('planned','failed','refused')`;
});

/**
 * Thread management reports a continuation's routing through this: the account Auto picked, before
 * any guard can refuse it, and the attempt its committed events started.
 */
export interface DispatchRecorder {
  readonly route: (selected: string | null, observations: Observations) => Effect.Effect<void>;
  readonly committed: (events: ReadonlyArray<OrchestrationV2StoredEvent>) => Effect.Effect<void>;
  /** The routed decision's key, once `route` recorded it. */
  readonly decisionKey: () => string | undefined;
}

export const makeDispatchRecorder = (
  input: DecisionInput & { command: Dispatch },
  sql: SqlClient.SqlClient,
): DispatchRecorder => {
  let decisionKey: string | undefined;
  return {
    route: (selected, observations) =>
      recordStopDecision(input, { dispatch: { selected, observations } }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.map((key) => {
          decisionKey = key;
        }),
      ),
    committed: (events) =>
      decisionKey === undefined
        ? Effect.void
        : recordCommittedContinuation(input.command, decisionKey, events).pipe(
            logFailure("commit"),
            Effect.asVoid,
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
    decisionKey: () => decisionKey,
  };
};
