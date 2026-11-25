import {
  MonitoringError,
  MonitoringThreadSummary,
  MonitoringThreadDetail,
  type MonitoringChange,
  type MonitoringChatSort,
  type MonitoringChatsInput,
  type MonitoringChatsResult,
  type MonitoringListedChat,
  type MonitoringOverviewInput,
  type MonitoringOverviewResult,
  type MonitoringThreadAnswer,
  type MonitoringUnanalyzed,
  type OrchestrationV2AppThread,
  isListedThreadLineage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { priceTurns } from "../usage/TurnPricing.ts";
import * as UsageService from "../usage/UsageService.ts";
import { makeMonitoringGroups } from "./monitoringGroups.ts";
import { readThreadAnalysis, settledListedThread } from "./ThreadAnalysisReader.ts";
import { ANALYZER_VERSION, analyzeThread, type AnalysisTurn } from "./ThreadAnalyzer.ts";

const ANALYSIS_BATCH = 25;
const CHANGE_WINDOW = Duration.seconds(3);
const RETRY_SWEEP_INTERVAL = Duration.minutes(30);
const MAX_ANALYSIS_ATTEMPTS = 6;
/** Analyses the overview reads per query, so a long window never loads every row at once. */
const OVERVIEW_BATCH = 500;
const ANALYSIS_ERROR_LENGTH = 300;
const UNREADABLE_ANALYSIS = "The stored analysis could not be read.";

interface OverviewCursor {
  readonly settledAt: string;
  readonly threadId: string;
}

interface StoredAnalysis {
  readonly thread_id: string;
  readonly settled_at: string;
  readonly summary_json: string;
  /** The chat's own, which a rename or move changes without a new analysis. */
  readonly title: string;
  readonly project_id: ProjectId;
}

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
const decodeSummaryJson = Schema.decodeEffect(SummaryJson);
const decodeSummary = (json: string) => decodeSummaryJson(json).pipe(Effect.option);
const encodeSummary = Schema.encodeEffect(SummaryJson);
const DetailJson = Schema.fromJsonString(
  MonitoringThreadDetail.mapFields(Struct.omit(["summary"])),
);
const decodeDetail = Schema.decodeEffect(DetailJson);
const encodeDetail = Schema.encodeEffect(DetailJson);

/**
 * The instant a time names, only in the ISO form T3 writes. Stored times are compared as text and
 * sorted in SQLite, where only that form orders and parses the same, and any other form of a
 * client's time could name another instant: February 30 parses as March 2.
 */
const isoInstant = (text: string) =>
  Option.filter(DateTime.make(text), (instant) => DateTime.formatIso(instant) === text);

/**
 * A stored analysis, with the chat's current title and project, and its settle instant; none when
 * it no longer reads or its summary shows another settle time than its row, by which the window,
 * the days and the list order date it.
 */
const readStored = (row: StoredAnalysis) =>
  Option.match(isoInstant(row.settled_at), {
    onNone: () => Effect.succeedNone,
    onSome: (settledAt) =>
      decodeSummary(row.summary_json).pipe(
        Effect.map((decoded) =>
          Option.map(
            Option.filter(decoded, (summary) => summary.settledAt === row.settled_at),
            (summary) => ({
              summary: { ...summary, title: row.title, projectId: row.project_id },
              settledAt,
            }),
          ),
        ),
      ),
  });

/** The settle time in the epoch milliseconds environments merge on. */
const SETTLED_MS = "CAST(round(unixepoch(m.settled_at, 'subsec') * 1000) AS INTEGER)";

/** Each value is a fixed SQL expression over `m`; never built from input. */
const CHAT_SORT_SQL: Record<MonitoringChatSort, string> = {
  settledAt: SETTLED_MS,
  lifetimeMs: "json_extract(m.summary_json, '$.lifetimeMs')",
  activeMs: "json_extract(m.summary_json, '$.activeMs')",
  costUsd: "json_extract(m.summary_json, '$.costUsd')",
  findings: "json_array_length(m.summary_json, '$.findings')",
  failures:
    "json_extract(m.summary_json, '$.runs.failed') + json_extract(m.summary_json, '$.commands.failed')",
};

interface StaleChat {
  readonly thread_id: ThreadId;
  readonly settled_at: string;
  readonly error: string | null;
  readonly attempts: number;
}

function staleAnalysisCandidates(sql: SqlClient.SqlClient, now: string) {
  return sql`
    FROM orchestration_v2_projection_threads t
    LEFT JOIN monitoring_thread_analyses m
      ON m.thread_id = t.thread_id
      AND m.analyzer_version = ${ANALYZER_VERSION}
      AND m.settled_at = json_extract(t.payload_json, '$.settledAt')
    WHERE ${settledListedThread(sql)}
      AND (m.thread_id IS NULL
        OR (m.error IS NULL AND m.detail_json IS NULL)
        OR (m.error IS NOT NULL AND (m.attempts = 0 OR m.retry_at <= ${now})))
  `;
}

export class MonitoringService extends Context.Service<
  MonitoringService,
  {
    /** Every analyzed chat of the window, summed into groups. */
    readonly overview: (
      input: MonitoringOverviewInput,
    ) => Effect.Effect<MonitoringOverviewResult, MonitoringError>;
    readonly chats: (
      input: MonitoringChatsInput,
    ) => Effect.Effect<MonitoringChatsResult, MonitoringError>;
    /** The current stored analysis, with its read revision. */
    readonly thread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<MonitoringThreadAnswer, MonitoringError>;
    readonly subscribeChanges: Stream.Stream<MonitoringChange>;
    /** Analyzes every settled chat that has no current analysis, then each chat as it settles. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/monitoring/MonitoringService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const serverEpoch = yield* random.uuidV4().pipe(Effect.orDie);
  const changes = yield* PubSub.sliding<MonitoringChange>({ capacity: 16, replay: 1 });
  let revision = 0;
  const changedThreadIds = new Set<ThreadId>();
  const changeWake = yield* Queue.sliding<void>(1);
  const wake = yield* Queue.sliding<void>(1);
  const work = new Set<ThreadId>();

  const markChanged = Effect.fn("MonitoringService.markChanged")(function* (threadId: ThreadId) {
    revision++;
    changedThreadIds.add(threadId);
    yield* Queue.offer(changeWake, undefined);
  });

  const announceChanges = Effect.gen(function* () {
    let sinceRevision = 0;
    for (;;) {
      yield* Queue.take(changeWake);
      yield* Effect.sleep(CHANGE_WINDOW);
      yield* Queue.clear(changeWake);
      if (changedThreadIds.size === 0) continue;
      const batch = { serverEpoch, revision, sinceRevision, threadIds: [...changedThreadIds] };
      changedThreadIds.clear();
      sinceRevision = revision;
      yield* PubSub.publish(changes, batch);
    }
  });

  const toError = (message: string) => (cause: unknown) => new MonitoringError({ message, cause });

  /**
   * Reads, prices and analyzes one chat; null when it is not a settled listed chat. `settledKey` is
   * the settle time as stored, which the stale queries compare and the summary repeats.
   */
  const analyze = Effect.fn("MonitoringService.analyze")(function* (threadId: ThreadId) {
    const read = yield* readThreadAnalysis(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      sql.withTransaction,
      NodeSqliteClient.readOnly,
      NodeSqliteClient.inBackground,
    );
    if (read === null) return null;
    // Such a chat falls on no day of the overview, so it fails here and counts as failed.
    if (Option.isNone(isoInstant(read.thread.settledAt))) {
      return yield* new MonitoringError({
        message: "The chat's stored settle time is damaged.",
      });
    }
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
    readonly detailJson: string | null;
    readonly error: string | null;
    readonly attempts: number;
    readonly previousError: string | null;
  }) {
    const now = yield* DateTime.now;
    const analyzedAt = DateTime.formatIso(now);
    const retryAt =
      row.error !== null && row.attempts < MAX_ANALYSIS_ATTEMPTS
        ? DateTime.formatIso(
            DateTime.addDuration(now, Duration.minutes(30 * 2 ** (row.attempts - 1))),
          )
        : null;
    const announcesChange = row.error === null || row.error !== row.previousError;
    const stored = yield* sql<{ readonly thread_id: string }>`
      INSERT INTO monitoring_thread_analyses
        (thread_id, settled_at, analyzer_version, analyzed_at, summary_json, detail_json, error,
         attempts, retry_at, announced_title, announced_project_id, announced_settled_at)
      SELECT t.thread_id, ${row.settledKey}, ${ANALYZER_VERSION}, ${analyzedAt},
        ${row.summaryJson}, ${row.detailJson}, ${row.error}, ${row.attempts}, ${retryAt},
        t.title, t.project_id, ${row.settledKey}
      FROM orchestration_v2_projection_threads t
      WHERE t.thread_id = ${row.threadId}
        AND ${settledListedThread(sql)}
        AND json_extract(t.payload_json, '$.settledAt') = ${row.settledKey}
      ON CONFLICT (thread_id) DO UPDATE SET
        settled_at = excluded.settled_at,
        analyzer_version = excluded.analyzer_version, analyzed_at = excluded.analyzed_at,
        summary_json = excluded.summary_json, detail_json = excluded.detail_json,
        error = excluded.error, attempts = excluded.attempts, retry_at = excluded.retry_at
        ${
          announcesChange
            ? sql`,
          announced_title = excluded.announced_title,
          announced_project_id = excluded.announced_project_id,
          announced_settled_at = excluded.announced_settled_at
        `
            : sql``
        }
      RETURNING thread_id
    `;
    if (stored.length > 0 && announcesChange) {
      yield* markChanged(row.threadId);
    }
    return stored.length > 0;
  });

  const deleteAnalysis = Effect.fn("MonitoringService.deleteAnalysis")(function* (
    threadId: ThreadId,
  ) {
    const obsolete = sql`
      thread_id = ${threadId}
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads t
        WHERE t.thread_id = ${threadId} AND ${settledListedThread(sql)}
          AND json_extract(t.payload_json, '$.settledAt') = monitoring_thread_analyses.settled_at
      )
    `;
    const existing = yield* sql`
      SELECT thread_id FROM monitoring_thread_analyses WHERE ${obsolete}
    `.pipe(NodeSqliteClient.readOnly);
    if (existing.length === 0) return;
    const removed = yield* sql`
      DELETE FROM monitoring_thread_analyses WHERE ${obsolete} RETURNING thread_id
    `;
    if (removed.length > 0) yield* markChanged(threadId);
  });

  const resolveWindow = Effect.fn("MonitoringService.resolveWindow")(function* (input: {
    readonly since: string;
    readonly until?: string | undefined;
  }) {
    const sinceTime = isoInstant(input.since);
    const untilTime =
      input.until === undefined ? Option.some(yield* DateTime.now) : isoInstant(input.until);
    if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
      return yield* new MonitoringError({ message: "The monitoring window is not a valid time." });
    }
    if (!DateTime.isGreaterThan(untilTime.value, sinceTime.value)) {
      return yield* new MonitoringError({
        message: "The monitoring window must end after it starts.",
      });
    }
    return {
      since: DateTime.formatIso(sinceTime.value),
      until: DateTime.formatIso(untilTime.value),
    };
  });

  /**
   * The viewer's days as epoch milliseconds, and the window they span. Refused unless each day is
   * a real date that starts after the one before, and `until` comes after the last start.
   */
  const resolveDays = Effect.fn("MonitoringService.resolveDays")(function* (
    input: MonitoringOverviewInput,
  ) {
    // A time in another form reads as NaN, which no comparison passes, so the checks refuse it.
    const millisOf = (time: string) =>
      isoInstant(time).pipe(
        Option.map(DateTime.toEpochMillis),
        Option.getOrElse(() => Number.NaN),
      );
    const days = Arr.map(input.days, (entry) => ({
      day: entry.day,
      startMs: millisOf(entry.since),
    }));
    const starts = [...days.map((entry) => entry.startMs), millisOf(input.until)];
    const valid =
      days.every((entry) => !Number.isNaN(millisOf(`${entry.day}T00:00:00.000Z`))) &&
      starts.every((ms, index) => ms > (starts[index - 1] ?? Number.NEGATIVE_INFINITY));
    if (!valid) {
      return yield* new MonitoringError({
        message: "The monitoring days are not valid days, each starting after the one before.",
      });
    }
    const untilMs = starts[starts.length - 1] ?? Number.NaN;
    return {
      window: {
        since: DateTime.formatIso(DateTime.makeUnsafe(days[0].startMs)),
        until: DateTime.formatIso(DateTime.makeUnsafe(untilMs)),
      },
      days,
    };
  });

  /**
   * Current analyses of settled listed chats that settled in the window, as `m` joined to `t`;
   * with `before`, only those before it in (settled_at, thread_id) order. The cursor replaces the
   * window's end because SQLite seeks on one upper bound and would rescan from the end.
   */
  const analyzedInWindow = (
    window: { readonly since: string; readonly until: string },
    before: OverviewCursor | null = null,
  ) => sql`
    ${settledListedThread(sql)}
    AND json_extract(t.payload_json, '$.settledAt') = m.settled_at
    AND m.analyzer_version = ${ANALYZER_VERSION}
    AND m.summary_json IS NOT NULL
    AND m.settled_at >= ${window.since}
    AND ${
      before === null
        ? sql`m.settled_at < ${window.until}`
        : sql`(m.settled_at, m.thread_id) < (${before.settledAt}, ${before.threadId})`
    }
  `;

  /**
   * Marks analyses that no longer read (see {@link readStored}) as failed, so the chat counts as
   * failed and is analyzed again instead of leaving the sums and pages. A row stored since is kept.
   */
  const markUnreadable = Effect.fn("MonitoringService.markUnreadable")(function* (
    rows: ReadonlyArray<StoredAnalysis & { readonly detail_json?: string | null }>,
  ) {
    yield* Effect.logWarning("Stored chat analyses could not be read; they are analyzed again.", {
      threadIds: rows.map((row) => row.thread_id),
    });
    const analyzedAt = DateTime.formatIso(yield* DateTime.now);
    for (const row of rows) {
      const updated = yield* sql<{ readonly thread_id: string }>`
        UPDATE monitoring_thread_analyses
        SET summary_json = NULL, detail_json = NULL, error = ${UNREADABLE_ANALYSIS},
          analyzed_at = ${analyzedAt}, attempts = 0, retry_at = NULL
        WHERE thread_id = ${row.thread_id}
          AND settled_at = ${row.settled_at}
          AND summary_json = ${row.summary_json}
          ${row.detail_json === undefined ? sql`` : sql`AND detail_json IS ${row.detail_json}`}
        RETURNING thread_id
      `;
      if (updated.length > 0) yield* markChanged(row.thread_id as ThreadId);
    }
  });

  /** Runs `read` again after marking the analyses it could not decode, until it decodes all. */
  const readDecoded = Effect.fn("MonitoringService.readDecoded")(function* <A>(
    read: Effect.Effect<
      { readonly result: A; readonly unreadable: ReadonlyArray<StoredAnalysis> },
      MonitoringError
    >,
  ) {
    for (;;) {
      const { result, unreadable } = yield* read;
      if (unreadable.length === 0) return result;
      yield* markUnreadable(unreadable).pipe(
        Effect.mapError(toError("Could not mark the unreadable chat analyses.")),
      );
    }
  });

  const overview: MonitoringService["Service"]["overview"] = Effect.fn(
    "MonitoringService.overview",
  )(function* (input) {
    const { window, days } = yield* resolveDays(input);

    return yield* readDecoded(
      Effect.gen(function* () {
        const readRevision = revision;
        const groups = makeMonitoringGroups(days);
        const read = yield* readOverview(window, groups);
        return {
          result: {
            serverEpoch,
            revision: readRevision,
            groups: groups.groups(),
            unanalyzed: read.unanalyzed,
          },
          unreadable: read.unreadable,
        };
      }),
    );
  });

  /** One read transaction, so every batch sees the same chats. */
  const readOverview = Effect.fn("MonitoringService.readOverview")(
    function* (
      window: { readonly since: string; readonly until: string },
      groups: ReturnType<typeof makeMonitoringGroups>,
    ) {
      const unreadable: Array<StoredAnalysis> = [];
      let before: OverviewCursor | null = null;
      while (true) {
        const rows: ReadonlyArray<StoredAnalysis> = yield* sql<StoredAnalysis>`
          SELECT m.thread_id, m.settled_at, m.summary_json, t.title, t.project_id
          FROM monitoring_thread_analyses m
          JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
          WHERE ${analyzedInWindow(window, before)}
          ORDER BY m.settled_at DESC, m.thread_id DESC
          LIMIT ${OVERVIEW_BATCH}
        `;
        for (const row of rows) {
          const stored = yield* readStored(row);
          if (Option.isNone(stored)) unreadable.push(row);
          else groups.add(stored.value.summary, stored.value.settledAt);
        }
        const last = rows.at(-1);
        if (rows.length < OVERVIEW_BATCH || last === undefined) break;
        before = { settledAt: last.settled_at, threadId: last.thread_id };
      }
      // By project, so the project filter applies to them; kind and model are not known yet.
      const counts = yield* sql<{
        readonly project_id: ProjectId;
        readonly pending: number;
        readonly failed: number;
      }>`
        SELECT t.project_id,
          COUNT(*) FILTER (WHERE m.thread_id IS NULL) AS pending,
          COUNT(*) FILTER (WHERE m.error IS NOT NULL) AS failed
        FROM orchestration_v2_projection_threads t
        LEFT JOIN monitoring_thread_analyses m
          ON m.thread_id = t.thread_id
          AND m.analyzer_version = ${ANALYZER_VERSION}
          AND m.settled_at = json_extract(t.payload_json, '$.settledAt')
        WHERE ${settledListedThread(sql)}
          AND json_extract(t.payload_json, '$.settledAt') >= ${window.since}
          AND json_extract(t.payload_json, '$.settledAt') < ${window.until}
        GROUP BY t.project_id
        HAVING pending > 0 OR failed > 0
        ORDER BY t.project_id
      `;
      const unanalyzed = counts.map((row): MonitoringUnanalyzed => ({
        projectId: row.project_id,
        pending: row.pending,
        failed: row.failed,
      }));
      return { unanalyzed, unreadable };
    },
    sql.withTransaction,
    NodeSqliteClient.readOnly,
    NodeSqliteClient.inBackground,
    Effect.mapError(toError("Could not read the monitoring overview.")),
  );

  const chats: MonitoringService["Service"]["chats"] = Effect.fn("MonitoringService.chats")(
    function* (input) {
      const window = yield* resolveWindow(input);
      const direction = sql.literal(input.direction === "asc" ? "ASC" : "DESC");
      const matching = () => sql`
        ${analyzedInWindow(window)}
          ${input.projectId === undefined ? sql`` : sql`AND t.project_id = ${input.projectId}`}
          ${
            input.kind === undefined
              ? sql``
              : sql`AND json_extract(m.summary_json, '$.kind') = ${input.kind}`
          }
          ${
            input.model === undefined
              ? sql``
              : sql`AND coalesce(json_extract(m.summary_json, '$.models[0]'), '') = ${input.model}`
          }
          ${
            input.findingCode === undefined
              ? sql``
              : sql`AND EXISTS (
                  SELECT 1 FROM json_each(m.summary_json, '$.findings') f
                  WHERE json_extract(f.value, '$.code') = ${input.findingCode}
                )`
          }
      `;
      const countMatching = sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total
        FROM monitoring_thread_analyses m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE ${matching()}
      `.pipe(Effect.map((rows) => rows[0]?.total ?? 0));
      const readPage = Effect.gen(function* () {
        const readRevision = revision;
        // The sort holds only each chat's keys; summaries are read for the one page it keeps.
        const rows = yield* sql<
          StoredAnalysis & { readonly sort_value: number | null; readonly total: number }
        >`
          SELECT page.thread_id, a.settled_at, a.summary_json, chat.title, chat.project_id,
            page.total, page.sort_value
          FROM (
            SELECT thread_id, sort_value, settled_ms, COUNT(*) OVER () AS total
            FROM (
              SELECT m.thread_id,
                ${sql.literal(CHAT_SORT_SQL[input.sort])} AS sort_value,
                ${sql.literal(SETTLED_MS)} AS settled_ms
              FROM monitoring_thread_analyses m
              JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
              WHERE ${matching()}
            )
            ORDER BY sort_value ${direction}, settled_ms DESC, thread_id
            LIMIT ${input.limit} OFFSET ${input.offset}
          ) page
          JOIN monitoring_thread_analyses a ON a.thread_id = page.thread_id
          JOIN orchestration_v2_projection_threads chat ON chat.thread_id = page.thread_id
          ORDER BY page.sort_value ${direction}, page.settled_ms DESC, page.thread_id
        `;
        // A page past the end has no row to carry the count.
        const total = rows[0]?.total ?? (input.offset === 0 ? 0 : yield* countMatching);
        const chats: Array<MonitoringListedChat> = [];
        const unreadable: Array<StoredAnalysis> = [];
        for (const row of rows) {
          const stored = yield* readStored(row);
          if (Option.isSome(stored) && row.sort_value !== null) {
            chats.push({ summary: stored.value.summary, sortValue: row.sort_value });
          } else {
            unreadable.push(row);
          }
        }
        return { result: { serverEpoch, revision: readRevision, chats, total }, unreadable };
      }).pipe(
        sql.withTransaction,
        NodeSqliteClient.readOnly,
        NodeSqliteClient.inBackground,
        Effect.mapError(toError("Could not read the monitored chats.")),
      );
      return yield* readDecoded(readPage);
    },
  );

  const thread: MonitoringService["Service"]["thread"] = Effect.fn("MonitoringService.thread")(
    function* ({ threadId }) {
      const readRevision = revision;
      const rows = yield* sql<
        Omit<StoredAnalysis, "summary_json"> & {
          readonly summary_json: string | null;
          readonly detail_json: string | null;
          readonly error: string | null;
        }
      >`
        SELECT m.thread_id, m.settled_at, m.summary_json, m.detail_json, m.error, t.title, t.project_id
        FROM monitoring_thread_analyses m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE m.thread_id = ${threadId} AND ${settledListedThread(sql)}
          AND m.settled_at = json_extract(t.payload_json, '$.settledAt')
          AND m.analyzer_version = ${ANALYZER_VERSION}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toError("Could not read the stored chat analysis.")),
      );
      const row = rows[0];
      if (row?.error != null) return yield* new MonitoringError({ message: row.error });
      if (row?.summary_json == null || row.detail_json === null) {
        return { serverEpoch, revision: readRevision, detail: null };
      }
      const stored = { ...row, summary_json: row.summary_json };
      const summary = yield* readStored(stored);
      const detail = yield* decodeDetail(row.detail_json).pipe(Effect.option);
      if (Option.isNone(summary) || Option.isNone(detail)) {
        yield* markUnreadable([stored]).pipe(
          Effect.mapError(toError("Could not mark the unreadable chat analysis.")),
        );
        return yield* new MonitoringError({ message: UNREADABLE_ANALYSIS });
      }
      const current = summary.value.summary;
      return {
        serverEpoch,
        revision: readRevision,
        detail: {
          ...detail.value,
          summary: current,
          lanes: detail.value.lanes.map((lane) =>
            lane.kind === "chat" ? { ...lane, label: current.title } : lane,
          ),
        },
      };
    },
  );

  const readCandidates = <A>(query: Effect.Effect<ReadonlyArray<A>, SqlError>) =>
    query.pipe(
      NodeSqliteClient.readOnly,
      NodeSqliteClient.inBackground,
      Effect.catchCauseIf(notInterrupt, (cause) =>
        Effect.logWarning("Monitoring could not select chats to analyze.", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
    );

  const selectStale = Effect.fn("MonitoringService.selectStale")(function* (threadId: ThreadId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* readCandidates(sql<StaleChat>`
        SELECT t.thread_id, json_extract(t.payload_json, '$.settledAt') AS settled_at,
          m.error, coalesce(m.attempts, 0) AS attempts
        ${staleAnalysisCandidates(sql, now)} AND t.thread_id = ${threadId}
      `);
  });

  const analyzeAndStore = Effect.fn("MonitoringService.analyzeAndStore")(
    function* (stale: StaleChat) {
      const encoded = yield* Effect.gen(function* () {
        const analyzed = yield* analyze(stale.thread_id);
        if (analyzed === null || analyzed.settledKey !== stale.settled_at) return null;
        const { summary, ...detail } = analyzed.detail;
        return {
          summaryJson: yield* encodeSummary(summary),
          detailJson: yield* encodeDetail(detail),
        };
      }).pipe(Effect.exit);
      if (Exit.isFailure(encoded)) {
        if (!notInterrupt(encoded.cause)) return yield* Effect.failCause(encoded.cause);
        yield* Effect.logWarning("A chat could not be analyzed.", {
          threadId: stale.thread_id,
          cause: Cause.pretty(encoded.cause),
        });
        return yield* storeRow({
          threadId: stale.thread_id,
          settledKey: stale.settled_at,
          summaryJson: null,
          detailJson: null,
          attempts: stale.attempts + 1,
          previousError: stale.error,
          error: failureMessage(encoded.cause),
        });
      }
      if (encoded.value === null) return false;
      return yield* storeRow({
        threadId: stale.thread_id,
        settledKey: stale.settled_at,
        ...encoded.value,
        attempts: 0,
        previousError: stale.error,
        error: null,
      });
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

  const selectCandidates = Effect.fn("MonitoringService.selectCandidates")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* readCandidates(sql<{ readonly thread_id: ThreadId }>`
      SELECT t.thread_id
      ${staleAnalysisCandidates(sql, now)}
      ORDER BY m.thread_id IS NOT NULL, json_extract(t.payload_json, '$.settledAt') DESC, t.thread_id
    `);
  });

  const enqueue = Effect.fn("MonitoringService.enqueue")(function* (threadId: ThreadId) {
    work.add(threadId);
    yield* Queue.offer(wake, undefined);
  });

  const analysisLoop = Effect.gen(function* () {
    let candidates = yield* selectCandidates();
    let index = 0;
    let nextSweep = DateTime.addDuration(yield* DateTime.now, RETRY_SWEEP_INTERVAL);
    for (;;) {
      const pending = Array.from(work);
      work.clear();
      for (const threadId of pending) {
        const [candidate] = yield* selectStale(threadId);
        if (candidate !== undefined) yield* analyzeAndStore(candidate);
      }
      const now = yield* DateTime.now;
      if (index >= candidates.length && DateTime.isGreaterThanOrEqualTo(now, nextSweep)) {
        candidates = yield* selectCandidates();
        index = 0;
        nextSweep = DateTime.addDuration(now, RETRY_SWEEP_INTERVAL);
      }
      const end = Math.min(index + ANALYSIS_BATCH, candidates.length);
      for (; index < end; index++) {
        const candidate = candidates[index]!;
        const [current] = yield* selectStale(candidate.thread_id);
        if (current !== undefined) yield* analyzeAndStore(current);
      }
      if (index >= candidates.length && work.size === 0) {
        yield* Queue.take(wake).pipe(Effect.timeoutOption(DateTime.distance(now, nextSweep)));
      }
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

  const announceMetadataChange = Effect.fn("MonitoringService.announceMetadataChange")(
    function* ({
      payload,
      threadId,
    }: {
      readonly threadId: ThreadId;
      readonly payload: OrchestrationV2AppThread;
    }) {
      if (payload.deletedAt !== null || !isListedThreadLineage(payload.lineage)) return;

      const same = yield* sql`
        SELECT 1
        FROM monitoring_thread_analyses m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE m.thread_id = ${threadId}
          AND ${settledListedThread(sql)}
          AND m.announced_title = t.title
          AND m.announced_project_id = t.project_id
          AND m.announced_settled_at = json_extract(t.payload_json, '$.settledAt')
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      if (same.length > 0) return;

      yield* sql`
        UPDATE monitoring_thread_analyses
        SET announced_title = t.title, announced_project_id = t.project_id,
          announced_settled_at = json_extract(t.payload_json, '$.settledAt')
        FROM orchestration_v2_projection_threads t
        WHERE monitoring_thread_analyses.thread_id = ${threadId}
          AND t.thread_id = ${threadId} AND ${settledListedThread(sql)}
      `;
      yield* markChanged(threadId);
    },
    (effect, { threadId }) =>
      effect.pipe(
        Effect.catchCauseIf(notInterrupt, (cause) =>
          Effect.logWarning("Monitoring could not compare the chat's announced metadata.", {
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.andThen(markChanged(threadId))),
        ),
      ),
  );

  const start: MonitoringService["Service"]["start"] = Effect.fn("MonitoringService.start")(
    function* () {
      const events = orchestrator.streamDomainEvents;
      yield* forkParked(announceChanges);
      yield* forkParked(
        Stream.runForEach(events, (event) => {
          switch (event.type) {
            case "thread.settled":
              return enqueue(event.threadId);
            case "thread.unsettled":
            case "thread.deleted":
              return removeAnalysis(event.threadId);
            // A pin and a skipped scheduled recovery change the settle with no settle event.
            case "thread.pinned":
              return isSettled(event.payload)
                ? enqueue(event.threadId)
                : removeAnalysis(event.threadId);
            // So can a metadata update, which also carries a rename or a move.
            case "thread.metadata-updated":
              return isSettled(event.payload)
                ? enqueue(event.threadId).pipe(Effect.andThen(announceMetadataChange(event)))
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
      yield* forkParked(analysisLoop);
    },
  );

  return MonitoringService.of({
    overview,
    chats,
    thread,
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
