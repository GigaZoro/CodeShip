import {
  MONITORING_OVERVIEW_LIMIT,
  MonitoringError,
  MonitoringThreadSummary,
  type MonitoringChange,
  type MonitoringOverviewInput,
  type MonitoringOverviewResult,
  type MonitoringThreadDetail,
  type OrchestrationV2AppThread,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { priceTurns } from "../usage/TurnPricing.ts";
import * as UsageService from "../usage/UsageService.ts";
import { readThreadAnalysis, settledListedThread } from "./ThreadAnalysisReader.ts";
import { ANALYZER_VERSION, analyzeThread, type AnalysisTurn } from "./ThreadAnalyzer.ts";

const ANALYSIS_BATCH = 25;
const ANALYSIS_ERROR_LENGTH = 300;
/** A failed analysis is tried again this long after it failed, and the loop wakes this often. */
const ANALYSIS_RETRY = Duration.minutes(30);

const notInterrupt = <E>(cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause);

const isSettled = (thread: OrchestrationV2AppThread) =>
  thread.settledOverride === "settled" && thread.settledAt !== null;

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (Schema.isSchemaError(error)) return "The chat's stored data could not be read.";
  const text =
    error instanceof Error ? (error.message === "" ? error.name : error.message) : String(error);
  return `The analysis failed: ${text}`.slice(0, ANALYSIS_ERROR_LENGTH);
};

const SummaryJson = Schema.fromJsonString(MonitoringThreadSummary);
const decodeSummary = Schema.decodeUnknownEffect(SummaryJson);
const encodeSummary = Schema.encodeEffect(SummaryJson);

interface AnalysisRow {
  readonly thread_id: string;
  readonly summary_json: string;
  readonly project_id: string;
  readonly title: string;
}

export class MonitoringService extends Context.Service<
  MonitoringService,
  {
    readonly overview: (
      input: MonitoringOverviewInput,
    ) => Effect.Effect<MonitoringOverviewResult, MonitoringError>;
    /** The chat's analysis, made now; null unless the chat is settled and listed. */
    readonly thread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<MonitoringThreadDetail | null, MonitoringError>;
    /** The current stored analyses of these chats; a chat that has none is left out. */
    readonly summaries: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<MonitoringThreadSummary>, MonitoringError>;
    readonly subscribeChanges: Stream.Stream<MonitoringChange>;
    /** Analyzes every settled chat that has no current analysis, then each chat as it settles. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/monitoring/MonitoringService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // A subscriber that connects late still learns the latest revision.
  const changes = yield* PubSub.sliding<MonitoringChange>({ capacity: 16, replay: 1 });
  const revision = yield* Ref.make(0);
  const wake = yield* Queue.sliding<void>(1);

  const publishChange = Effect.fn("MonitoringService.publishChange")(function* () {
    const next = yield* Ref.updateAndGet(revision, (current) => current + 1);
    yield* PubSub.publish(changes, { revision: next });
  });

  const toError = (message: string) => (cause: unknown) => new MonitoringError({ message, cause });

  /**
   * Reads, prices and analyzes one chat; null when it is not a settled listed chat. `settledKey` is
   * the settle time as stored, which the stale queries compare: the summary's own is clamped.
   */
  const analyze = Effect.fn("MonitoringService.analyze")(function* (threadId: ThreadId) {
    const read = yield* readThreadAnalysis(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      NodeSqliteClient.readOnly,
    );
    if (read === null) return null;
    const priced = yield* priceTurns(
      usage,
      read.turns.map((turn) => ({ usageJson: turn.usageJson, fallbackModel: turn.runModel })),
    );
    const turns = read.turns.flatMap((turn, index): ReadonlyArray<AnalysisTurn> => {
      const result = priced[index];
      if (result === null || result === undefined) return [];
      return [
        {
          runId: turn.runId,
          usage: result.usage,
          contextUsedTokens: turn.contextUsedTokens,
          contextMaxTokens: turn.contextMaxTokens,
          costUsd: result.costUsd,
        },
      ];
    });
    return { detail: analyzeThread({ ...read, turns }), settledKey: read.thread.settledAt };
  });

  /**
   * Stores a chat's analysis or failure only while the chat is still settled at `settledKey`, so a
   * slow analysis never replaces a newer one or brings back a row its unsettle removed.
   */
  const storeRow = Effect.fn("MonitoringService.storeRow")(function* (row: {
    readonly threadId: ThreadId;
    readonly settledKey: string;
    readonly summaryJson: string | null;
    readonly error: string | null;
  }) {
    const analyzedAt = DateTime.formatIso(yield* DateTime.now);
    const stored = yield* sql<{ readonly thread_id: string }>`
      INSERT INTO monitoring_thread_analyses
        (thread_id, project_id, settled_at, analyzer_version, analyzed_at, summary_json, error)
      SELECT t.thread_id, t.project_id, ${row.settledKey}, ${ANALYZER_VERSION}, ${analyzedAt},
        ${row.summaryJson}, ${row.error}
      FROM orchestration_v2_projection_threads t
      WHERE t.thread_id = ${row.threadId}
        AND ${settledListedThread(sql)}
        AND json_extract(t.payload_json, '$.settledAt') = ${row.settledKey}
      ON CONFLICT (thread_id) DO UPDATE SET
        project_id = excluded.project_id, settled_at = excluded.settled_at,
        analyzer_version = excluded.analyzer_version, analyzed_at = excluded.analyzed_at,
        summary_json = excluded.summary_json, error = excluded.error
      RETURNING thread_id
    `;
    return stored.length > 0;
  });

  const storeAnalysis = Effect.fn("MonitoringService.storeAnalysis")(function* ({
    detail: { summary },
    settledKey,
  }: {
    readonly detail: MonitoringThreadDetail;
    readonly settledKey: string;
  }) {
    const summaryJson = yield* encodeSummary(summary);
    return yield* storeRow({ threadId: summary.threadId, settledKey, summaryJson, error: null });
  });

  const deleteAnalysis = Effect.fn("MonitoringService.deleteAnalysis")(function* (
    threadId: ThreadId,
  ) {
    // Most chats an event names have no analysis; a read keeps them off the write lock.
    const existing = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM monitoring_thread_analyses WHERE thread_id = ${threadId}
    `.pipe(NodeSqliteClient.readOnly);
    if (existing.length === 0) return;
    const removed = yield* sql<{ readonly thread_id: string }>`
      DELETE FROM monitoring_thread_analyses WHERE thread_id = ${threadId} RETURNING thread_id
    `;
    if (removed.length > 0) yield* publishChange();
  });

  /**
   * Rows whose stored summary cannot be read are skipped, so one bad row hides no others. A chat
   * can move or be renamed after it settled, so its project and title come from the chat itself.
   */
  const decodeRows = (rows: ReadonlyArray<AnalysisRow>) =>
    Effect.forEach(rows, (row) =>
      decodeSummary(row.summary_json).pipe(
        Effect.map((summary) =>
          Option.some({ ...summary, projectId: ProjectId.make(row.project_id), title: row.title }),
        ),
        Effect.catch(() =>
          Effect.logWarning("A stored chat analysis could not be read.", {
            threadId: row.thread_id,
          }).pipe(Effect.as(Option.none<MonitoringThreadSummary>())),
        ),
      ),
    ).pipe(
      Effect.map((summaries) =>
        summaries.flatMap((summary) => (Option.isSome(summary) ? [summary.value] : [])),
      ),
    );

  const summaries: MonitoringService["Service"]["summaries"] = Effect.fn(
    "MonitoringService.summaries",
  )(function* (threadIds) {
    if (threadIds.length === 0) return [];
    const rows = yield* sql<AnalysisRow>`
      SELECT m.thread_id, m.summary_json, t.project_id, t.title
      FROM monitoring_thread_analyses m
      JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
      WHERE m.thread_id IN ${sql.in(threadIds)}
        AND ${settledListedThread(sql)}
        AND json_extract(t.payload_json, '$.settledAt') = m.settled_at
        AND m.analyzer_version = ${ANALYZER_VERSION}
        AND m.summary_json IS NOT NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toError("Could not read the chat analyses.")),
    );
    return yield* decodeRows(rows);
  });

  const overview: MonitoringService["Service"]["overview"] = Effect.fn(
    "MonitoringService.overview",
  )(function* (input) {
    const sinceTime = DateTime.make(input.since);
    const untilTime =
      input.until === undefined ? Option.some(yield* DateTime.now) : DateTime.make(input.until);
    if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
      return yield* new MonitoringError({ message: "The monitoring window is not a valid time." });
    }
    const since = DateTime.formatIso(sinceTime.value);
    const until = DateTime.formatIso(untilTime.value);

    const data = yield* Effect.gen(function* () {
      const rows = yield* sql<AnalysisRow>`
        SELECT m.thread_id, m.summary_json, t.project_id, t.title
        FROM monitoring_thread_analyses m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE ${settledListedThread(sql)}
          AND json_extract(t.payload_json, '$.settledAt') = m.settled_at
          AND m.analyzer_version = ${ANALYZER_VERSION}
          AND m.summary_json IS NOT NULL
          AND m.settled_at >= ${since} AND m.settled_at < ${until}
        ORDER BY m.settled_at DESC, m.thread_id
        LIMIT ${MONITORING_OVERVIEW_LIMIT + 1}
      `;
      const counts = yield* sql<{ readonly pending: number; readonly failed: number }>`
        SELECT
          COUNT(*) FILTER (WHERE m.thread_id IS NULL) AS pending,
          COUNT(*) FILTER (WHERE m.error IS NOT NULL) AS failed
        FROM orchestration_v2_projection_threads t
        LEFT JOIN monitoring_thread_analyses m
          ON m.thread_id = t.thread_id
          AND m.analyzer_version = ${ANALYZER_VERSION}
          AND m.settled_at = json_extract(t.payload_json, '$.settledAt')
        WHERE ${settledListedThread(sql)}
          AND json_extract(t.payload_json, '$.settledAt') >= ${since}
          AND json_extract(t.payload_json, '$.settledAt') < ${until}
      `;
      return { rows, pending: counts[0]?.pending ?? 0, failed: counts[0]?.failed ?? 0 };
    }).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toError("Could not read the monitoring overview.")),
    );

    return {
      threads: yield* decodeRows(data.rows.slice(0, MONITORING_OVERVIEW_LIMIT)),
      truncated: data.rows.length > MONITORING_OVERVIEW_LIMIT,
      pendingAnalysis: data.pending,
      failedAnalysis: data.failed,
    };
  });

  const thread: MonitoringService["Service"]["thread"] = Effect.fn("MonitoringService.thread")(
    function* ({ threadId }) {
      const analyzed = yield* analyze(threadId).pipe(
        Effect.mapError(toError("Could not analyze the chat.")),
      );
      if (analyzed === null) return null;
      const stored = yield* sql<{
        readonly settled_at: string;
        readonly analyzer_version: number;
        readonly summary_json: string | null;
      }>`
        SELECT settled_at, analyzer_version, summary_json
        FROM monitoring_thread_analyses WHERE thread_id = ${threadId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toError("Could not read the stored chat analysis.")),
      );
      const current = stored[0];
      if (
        current === undefined ||
        current.summary_json === null ||
        current.analyzer_version !== ANALYZER_VERSION ||
        current.settled_at !== analyzed.settledKey
      ) {
        const stored = yield* storeAnalysis(analyzed).pipe(
          Effect.mapError(toError("Could not store the chat analysis.")),
        );
        if (stored) yield* publishChange();
      }
      return analyzed.detail;
    },
  );

  /**
   * Settled listed chats with no analysis of the current version and settle, then those whose
   * analysis failed at least {@link ANALYSIS_RETRY} ago; newest settle first.
   */
  const selectStale = Effect.fn("MonitoringService.selectStale")(function* () {
    const retryBefore = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, ANALYSIS_RETRY),
    );
    return yield* sql<{ readonly thread_id: ThreadId; readonly settled_at: string }>`
      SELECT t.thread_id, json_extract(t.payload_json, '$.settledAt') AS settled_at
      FROM orchestration_v2_projection_threads t
      LEFT JOIN monitoring_thread_analyses m
        ON m.thread_id = t.thread_id
        AND m.analyzer_version = ${ANALYZER_VERSION}
        AND m.settled_at = json_extract(t.payload_json, '$.settledAt')
      WHERE ${settledListedThread(sql)}
        AND (m.thread_id IS NULL OR (m.error IS NOT NULL AND m.analyzed_at <= ${retryBefore}))
      ORDER BY m.thread_id IS NOT NULL, settled_at DESC, t.thread_id
      LIMIT ${ANALYSIS_BATCH}
    `.pipe(NodeSqliteClient.readOnly);
  });

  /**
   * True when a row was stored. A chat that cannot be analyzed is stored as failed, so it neither
   * holds back the chats behind it nor is tried again before {@link ANALYSIS_RETRY} has passed.
   */
  const analyzeAndStore = Effect.fn("MonitoringService.analyzeAndStore")(
    function* (stale: { readonly thread_id: ThreadId; readonly settled_at: string }) {
      const outcome = yield* analyze(stale.thread_id).pipe(
        Effect.map((analyzed) => ({ analyzed, cause: null })),
        Effect.catchCauseIf(notInterrupt, (cause) => Effect.succeed({ analyzed: null, cause })),
      );
      if (outcome.cause !== null) {
        yield* Effect.logWarning("A chat could not be analyzed.", {
          threadId: stale.thread_id,
          cause: Cause.pretty(outcome.cause),
        });
        return yield* storeRow({
          threadId: stale.thread_id,
          settledKey: stale.settled_at,
          summaryJson: null,
          error: failureMessage(outcome.cause),
        });
      }
      // The chat stopped being a settled listed chat after it was selected.
      if (outcome.analyzed === null) return false;
      return yield* storeAnalysis(outcome.analyzed);
    },
    (effect, stale) =>
      effect.pipe(
        Effect.catchCauseIf(notInterrupt, (cause) =>
          Effect.logWarning("A chat's analysis could not be stored.", {
            threadId: stale.thread_id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      ),
  );

  const analysisPass = Effect.fn("MonitoringService.analysisPass")(function* () {
    const stale = yield* selectStale();
    if (stale.length === 0) return false;
    const stored = yield* Effect.forEach(stale, analyzeAndStore);
    if (!stored.some(Boolean)) return false;
    yield* publishChange();
    return true;
  });

  const analysisLoop = Effect.gen(function* () {
    for (;;) {
      const progressed = yield* analysisPass().pipe(
        Effect.catchCauseIf(notInterrupt, (cause) =>
          Effect.logWarning("Monitoring could not select chats to analyze.", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (!progressed) yield* Queue.take(wake).pipe(Effect.timeoutOption(ANALYSIS_RETRY));
    }
  });

  const removeAnalysis = (threadId: ThreadId) =>
    deleteAnalysis(threadId).pipe(
      Effect.catchCauseIf(notInterrupt, (cause) =>
        Effect.logWarning("A chat's analysis could not be removed.", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: MonitoringService["Service"]["start"] = Effect.fn("MonitoringService.start")(
    function* () {
      const events = orchestrator.streamDomainEvents;
      yield* forkParked(analysisLoop);
      yield* forkParked(
        Stream.runForEach(events, (event) => {
          switch (event.type) {
            case "thread.settled":
              return Queue.offer(wake, undefined);
            case "thread.unsettled":
            case "thread.deleted":
              return removeAnalysis(event.threadId);
            // A pin and a skipped scheduled recovery change the settle with no settle event.
            case "thread.pinned":
            case "thread.metadata-updated":
              return isSettled(event.payload)
                ? Queue.offer(wake, undefined)
                : removeAnalysis(event.threadId);
            default:
              return Effect.void;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Monitoring event stream failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    },
  );

  return MonitoringService.of({
    overview,
    thread,
    summaries,
    subscribeChanges: Stream.unwrap(
      PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    ),
    start,
  });
});

export const layer = Layer.effect(MonitoringService, make);

/** The service with its analysis loop running, so every consumer shares one loop. */
export const layerStarted = Layer.effect(
  MonitoringService,
  make.pipe(Effect.tap((service) => service.start())),
);
