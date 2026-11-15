import {
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskRunStats,
  type ScheduledTaskStatsInput,
  type ScheduledTaskStatsResult,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageService from "../usage/UsageService.ts";

const SQL_CHUNK = 400;
// A run is stamped just before its message is dispatched.
const ORIGIN_SLACK_MS = 5_000;
const CONTINUATION_PREFIXES = [
  "limit-resume:",
  "message:restart-continuation:",
  "async-answer:",
] as const;
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "interrupted", "cancelled"]);

const TurnUsageJson = Schema.fromJsonString(
  Schema.Struct({
    usageStatus: Schema.String,
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheCreationTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
    models: Schema.optional(Schema.Array(Schema.String)),
    localCommand: Schema.optional(Schema.Boolean),
  }),
);
const decodeTurnUsage = Schema.decodeUnknownOption(TurnUsageJson);

interface ScheduledRunRow {
  readonly run_id: string;
  readonly task_id: string;
  readonly started_at: string;
  readonly outcome: string;
  readonly thread_id: string | null;
}

interface OrchestrationRun {
  readonly runId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly requestedAtMs: number;
  readonly messageId: string | null;
  readonly continuationOf: ReadonlyArray<string>;
  readonly model: string | null;
}

interface OrchestrationRunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly requested_at: string;
  readonly message_id: string | null;
  readonly automatic_of: string | null;
  readonly restart_of: string | null;
  readonly model: string | null;
}

interface Counters {
  runs: number;
  failed: number;
  usageLimited: number;
  costUsd: number;
  unpricedRuns: number;
}

const toOrchestrationRun = (row: OrchestrationRunRow): OrchestrationRun => ({
  runId: row.run_id,
  ordinal: row.ordinal,
  status: row.status,
  requestedAtMs: Date.parse(row.requested_at),
  messageId: row.message_id,
  continuationOf: [row.automatic_of, row.restart_of].filter((id): id is string => id !== null),
  model: row.model,
});

/**
 * Each scheduled run's own orchestration run in one thread. An exact message id wins; a webhook or
 * catch-up run, whose message id differs from its record, takes the earliest unclaimed run of its
 * task requested from its start on. Both lists are in time order, so one pass matches them.
 */
const matchOrigins = (
  threadRuns: ReadonlyArray<OrchestrationRun>,
  scheduledRuns: ReadonlyArray<ScheduledRunRow>,
): ReadonlyMap<string, OrchestrationRun> => {
  const byMessageId = new Map<string, OrchestrationRun>();
  for (const run of threadRuns) if (run.messageId !== null) byMessageId.set(run.messageId, run);
  const origins = new Map<string, OrchestrationRun>();
  const claimed = new Set<string>();
  for (const run of scheduledRuns) {
    const exact = byMessageId.get(`scheduled-task-message:${run.run_id}`);
    if (exact === undefined) continue;
    origins.set(run.run_id, exact);
    claimed.add(exact.runId);
  }
  const taskIds = [...new Set(scheduledRuns.map((run) => run.task_id))];
  const candidatesByTask = new Map<string, OrchestrationRun[]>();
  for (const run of threadRuns) {
    const messageId = run.messageId;
    if (messageId === null || claimed.has(run.runId)) continue;
    const taskId = taskIds.find((id) => messageId.startsWith(`scheduled-task-message:${id}:`));
    if (taskId === undefined) continue;
    const list = candidatesByTask.get(taskId) ?? [];
    list.push(run);
    candidatesByTask.set(taskId, list);
  }
  for (const list of candidatesByTask.values())
    list.sort((a, b) => a.requestedAtMs - b.requestedAtMs);
  const next = new Map<string, number>();
  const byStart = [...scheduledRuns].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
  );
  for (const run of byStart) {
    if (origins.has(run.run_id)) continue;
    const candidates = candidatesByTask.get(run.task_id) ?? [];
    const startedMs = Date.parse(run.started_at) - ORIGIN_SLACK_MS;
    let index = next.get(run.task_id) ?? 0;
    while (index < candidates.length && candidates[index]!.requestedAtMs < startedMs) index += 1;
    const origin = candidates[index];
    next.set(run.task_id, index + 1);
    if (origin !== undefined) origins.set(run.run_id, origin);
  }
  return origins;
};

/**
 * Every run that continues another, keyed by the run it continues: its explicit link, else, for a
 * continuation message without one, the run before it in the thread.
 */
const continuationsOf = (
  threadRuns: ReadonlyArray<OrchestrationRun>,
): ReadonlyMap<string, ReadonlyArray<OrchestrationRun>> => {
  const loaded = new Set(threadRuns.map((run) => run.runId));
  const children = new Map<string, OrchestrationRun[]>();
  threadRuns.forEach((run, index) => {
    const explicit = run.continuationOf.find((id) => loaded.has(id));
    const parent =
      explicit ??
      (run.continuationOf.length === 0 &&
      run.messageId !== null &&
      CONTINUATION_PREFIXES.some((prefix) => run.messageId!.startsWith(prefix))
        ? threadRuns[index - 1]?.runId
        : undefined);
    if (parent === undefined) return;
    const list = children.get(parent) ?? [];
    list.push(run);
    children.set(parent, list);
  });
  return children;
};

/** The origin and every run that continues it, in thread order. */
const chainFrom = (
  continuations: ReadonlyMap<string, ReadonlyArray<OrchestrationRun>>,
  origin: OrchestrationRun,
): ReadonlyArray<OrchestrationRun> => {
  const chain = [origin];
  for (let index = 0; index < chain.length; index += 1) {
    chain.push(...(continuations.get(chain[index]!.runId) ?? []));
  }
  return chain.sort((a, b) => a.ordinal - b.ordinal);
};

export class ScheduledTaskStats extends Context.Service<
  ScheduledTaskStats,
  {
    readonly stats: (
      input: ScheduledTaskStatsInput,
    ) => Effect.Effect<ScheduledTaskStatsResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskStats") {}

/**
 * Prices only the main agent's own turns (`turnTokenUsage`); `otherUsage` (subagents,
 * compaction) is left out. Run history keeps 90 days, the longest Usage window.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;

  const stats: ScheduledTaskStats["Service"]["stats"] = Effect.fn("ScheduledTaskStats.stats")(
    function* (input) {
      const sinceTime = DateTime.make(input.since);
      const untilTime =
        input.until === undefined ? Option.some(yield* DateTime.now) : DateTime.make(input.until);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new ScheduledTaskError({ message: "The stats window is not a valid time." });
      }
      const since = DateTime.formatIso(sinceTime.value);
      const until = DateTime.formatIso(untilTime.value);

      const read = Effect.fn("ScheduledTaskStats.read")(function* () {
        const tasks = yield* sql<{
          readonly task_id: string;
          readonly title: string;
          readonly label: string | null;
        }>`
          SELECT t.task_id, t.title, g.label
          FROM scheduled_tasks t LEFT JOIN scheduled_task_group g ON g.task_id = t.task_id
          ORDER BY t.task_id
        `;
        const scheduledRuns = yield* sql<ScheduledRunRow>`
          SELECT run_id, task_id, started_at, outcome, thread_id FROM scheduled_task_runs
          WHERE started_at >= ${since} AND started_at < ${until} AND outcome <> 'skipped'
        `;
        const threadIds = [
          ...new Set(
            scheduledRuns.flatMap((run) => (run.thread_id === null ? [] : [run.thread_id])),
          ),
        ];
        const floor = DateTime.formatIso(
          DateTime.subtract(sinceTime.value, { milliseconds: ORIGIN_SLACK_MS }),
        );

        const runsByThread = new Map<string, Array<OrchestrationRun>>();
        for (const chunk of Arr.chunksOf(threadIds, SQL_CHUNK)) {
          const rows = yield* sql<OrchestrationRunRow>`
            SELECT run_id, thread_id, ordinal, status, requested_at,
              json_extract(payload_json, '$.userMessageId') AS message_id,
              json_extract(payload_json, '$.automaticContinuationOfRunId') AS automatic_of,
              json_extract(payload_json, '$.restartContinuationOfRunId') AS restart_of,
              json_extract(payload_json, '$.modelSelection.model') AS model
            FROM orchestration_v2_projection_runs
            WHERE thread_id IN ${sql.in(chunk)} AND requested_at >= ${floor}
            ORDER BY thread_id, ordinal
          `;
          for (const row of rows) {
            const list = runsByThread.get(row.thread_id) ?? [];
            list.push(toOrchestrationRun(row));
            runsByThread.set(row.thread_id, list);
          }
        }

        const scheduledByThread = new Map<string, ScheduledRunRow[]>();
        for (const run of scheduledRuns) {
          if (run.thread_id === null) continue;
          const list = scheduledByThread.get(run.thread_id) ?? [];
          list.push(run);
          scheduledByThread.set(run.thread_id, list);
        }
        const chains = new Map<string, ReadonlyArray<OrchestrationRun>>();
        for (const [threadId, runs] of scheduledByThread) {
          const threadRuns = runsByThread.get(threadId) ?? [];
          const origins = matchOrigins(threadRuns, runs);
          const continuations = continuationsOf(threadRuns);
          for (const run of runs) {
            const origin = origins.get(run.run_id);
            chains.set(run.run_id, origin === undefined ? [] : chainFrom(continuations, origin));
          }
        }
        const chainRunIds = [
          ...new Set([...chains.values()].flatMap((chain) => chain.map((r) => r.runId))),
        ];

        const usageLimitedRuns = new Set<string>();
        const stoppedRuns = new Set<string>();
        for (const chunk of Arr.chunksOf(chainRunIds, SQL_CHUNK)) {
          const items = yield* sql<{
            readonly run_id: string;
            readonly type: string;
            readonly failure_class: string | null;
          }>`
            SELECT run_id, type, json_extract(payload_json, '$.failure.class') AS failure_class
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IN ${sql.in(chunk)} AND type IN ('error', 'run_interrupt_request')
          `;
          for (const item of items) {
            if (item.type === "run_interrupt_request") stoppedRuns.add(item.run_id);
            else if (item.failure_class === "usage_limit") usageLimitedRuns.add(item.run_id);
          }
        }

        const attemptRun = new Map<string, string>();
        for (const chunk of Arr.chunksOf(chainRunIds, SQL_CHUNK)) {
          const attempts = yield* sql<{ readonly attempt_id: string; readonly run_id: string }>`
            SELECT attempt_id, run_id FROM orchestration_v2_projection_run_attempts
            WHERE run_id IN ${sql.in(chunk)}
          `;
          for (const attempt of attempts) attemptRun.set(attempt.attempt_id, attempt.run_id);
        }

        const chainThreadIds = [
          ...new Set(
            scheduledRuns.flatMap((run) =>
              run.thread_id !== null && (chains.get(run.run_id)?.length ?? 0) > 0
                ? [run.thread_id]
                : [],
            ),
          ),
        ];
        const turns: Array<{ readonly runId: string; readonly usageJson: string | null }> = [];
        for (const chunk of Arr.chunksOf(chainThreadIds, SQL_CHUNK)) {
          const rows = yield* sql<{
            readonly run_attempt_id: string;
            readonly usage_json: string | null;
          }>`
            SELECT run_attempt_id, json_extract(payload_json, '$.turnTokenUsage') AS usage_json
            FROM orchestration_v2_projection_provider_turns
            WHERE thread_id IN ${sql.in(chunk)} AND run_attempt_id IS NOT NULL
              AND (started_at IS NULL OR started_at >= ${floor})
          `;
          for (const row of rows) {
            const runId = attemptRun.get(row.run_attempt_id);
            if (runId !== undefined) turns.push({ runId, usageJson: row.usage_json });
          }
        }

        return { tasks, scheduledRuns, chains, usageLimitedRuns, stoppedRuns, turns };
      });

      const data = yield* read().pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({ message: "Could not read scheduled task run stats.", cause }),
        ),
      );

      const modelByRun = new Map<string, string | null>();
      for (const chain of data.chains.values()) {
        for (const run of chain) modelByRun.set(run.runId, run.model);
      }
      const unpricedByRun = new Set<string>();
      const priceable: Array<{
        readonly runId: string;
        readonly model: string;
        readonly totals: UsageTokenTotals;
      }> = [];
      for (const turn of data.turns) {
        const decoded = turn.usageJson === null ? Option.none() : decodeTurnUsage(turn.usageJson);
        if (Option.isNone(decoded)) {
          unpricedByRun.add(turn.runId);
          continue;
        }
        const turnUsage = decoded.value;
        if (turnUsage.localCommand === true) continue;
        const model = turnUsage.models?.[0] ?? modelByRun.get(turn.runId) ?? null;
        if (turnUsage.usageStatus === "unavailable" || model === null) {
          unpricedByRun.add(turn.runId);
          continue;
        }
        const cached = turnUsage.cachedInputTokens ?? 0;
        const created = turnUsage.cacheCreationTokens ?? 0;
        priceable.push({
          runId: turn.runId,
          model,
          totals: {
            uncachedInputTokens: Math.max(0, (turnUsage.inputTokens ?? 0) - cached - created),
            cachedInputTokens: cached,
            cacheCreationTokens: created,
            outputTokens: turnUsage.outputTokens ?? 0,
            reasoningTokens: turnUsage.reasoningTokens ?? 0,
          },
        });
      }
      const prices = yield* usage
        .priceTokens(priceable)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ScheduledTaskError({ message: "Could not price scheduled runs.", cause }),
          ),
        );
      const costByRun = new Map<string, number>();
      priceable.forEach((item, index) => {
        const price = prices[index];
        if (price === null || price === undefined) unpricedByRun.add(item.runId);
        else costByRun.set(item.runId, (costByRun.get(item.runId) ?? 0) + price);
      });

      const counters = new Map<string, Counters>(
        data.tasks.map((task) => [
          task.task_id,
          { runs: 0, failed: 0, usageLimited: 0, costUsd: 0, unpricedRuns: 0 },
        ]),
      );
      for (const run of data.scheduledRuns) {
        const counter = counters.get(run.task_id);
        if (counter === undefined) continue;
        counter.runs += 1;
        if (run.outcome === "failed") {
          counter.failed += 1;
          continue;
        }
        const chain = data.chains.get(run.run_id) ?? [];
        const last = chain.at(-1);
        if (last === undefined) continue;
        const limited = chain.some((member) => data.usageLimitedRuns.has(member.runId));
        if (limited) counter.usageLimited += 1;
        else if (FAILED_STATUSES.has(last.status) && !data.stoppedRuns.has(last.runId)) {
          counter.failed += 1;
        }
        counter.costUsd += chain.reduce(
          (sum, member) => sum + (costByRun.get(member.runId) ?? 0),
          0,
        );
        if (chain.some((member) => unpricedByRun.has(member.runId))) counter.unpricedRuns += 1;
      }

      return {
        tasks: data.tasks.map((task): ScheduledTaskRunStats => ({
          id: ScheduledTaskId.make(task.task_id),
          title: task.title,
          group: task.label,
          ...counters.get(task.task_id)!,
        })),
      };
    },
  );

  return ScheduledTaskStats.of({ stats });
});

export const layer = Layer.effect(ScheduledTaskStats, make);
