import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ScheduledTaskStats from "./ScheduledTaskStats.ts";

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-02-01T00:00:00.000Z";
const AT = Date.parse("2026-01-10T00:00:00.000Z");

// One dollar per million uncached input tokens; only "priced-model" has a price.
const layerUsage = Layer.mock(UsageService.UsageService)({
  priceTokens: (items) =>
    Effect.succeed(
      items.map((item) =>
        item.model === "priced-model" ? item.totals.uncachedInputTokens / 1_000_000 : null,
      ),
    ),
});
const layer = ScheduledTaskStats.layer.pipe(
  Layer.provide(layerUsage),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface OrchestrationRunSeed {
  readonly id: string;
  readonly status: string;
  readonly payload?: Record<string, unknown>;
  readonly items?: ReadonlyArray<{ readonly type: string; readonly payload?: unknown }>;
  readonly turns?: ReadonlyArray<unknown>;
}

interface Scenario {
  readonly name: string;
  readonly group?: string;
  readonly scheduledRuns: ReadonlyArray<{
    readonly at?: number;
    readonly outcome: string;
    readonly dispatched: boolean;
  }>;
  readonly runs: ReadonlyArray<OrchestrationRunSeed>;
  readonly expected: {
    readonly runs: number;
    readonly failed?: number;
    readonly usageLimited?: number;
    readonly costUsd?: number;
    readonly unpricedRuns?: number;
  };
}

const usage = (extra: Record<string, unknown>) => ({
  usageScope: "main_agent",
  hasSubagents: false,
  usageStatus: "complete",
  outputTokens: 0,
  ...extra,
});

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "could-not-start",
    scheduledRuns: [{ outcome: "failed", dispatched: false }],
    runs: [],
    expected: { runs: 1, failed: 1 },
  },
  {
    name: "completed-and-priced",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      {
        id: "completed-and-priced-1",
        status: "completed",
        payload: { modelSelection: { model: "priced-model" } },
        turns: [
          // 1M input of which 400k were cache reads and 100k cache writes: 500k uncached.
          usage({
            inputTokens: 1_000_000,
            cachedInputTokens: 400_000,
            cacheCreationTokens: 100_000,
            models: ["priced-model"],
          }),
          // No reported model: the run's selected model prices it.
          usage({ inputTokens: 1_000_000 }),
        ],
      },
    ],
    expected: { runs: 1, costUsd: 1.5 },
  },
  {
    name: "thread-failed",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [{ id: "thread-failed-1", status: "failed" }],
    expected: { runs: 1, failed: 1 },
  },
  {
    name: "still-running",
    scheduledRuns: [{ outcome: "running", dispatched: true }],
    runs: [{ id: "still-running-1", status: "running" }],
    expected: { runs: 1 },
  },
  {
    name: "limit-then-resumed",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      {
        id: "limit-then-resumed-1",
        status: "failed",
        items: [{ type: "error", payload: { failure: { class: "usage_limit" } } }],
      },
      {
        id: "limit-then-resumed-2",
        status: "completed",
        payload: { userMessageId: "limit-resume:abc" },
      },
    ],
    expected: { runs: 1, usageLimited: 1 },
  },
  {
    name: "stopped-on-purpose",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      {
        id: "stopped-on-purpose-1",
        status: "interrupted",
        items: [{ type: "run_interrupt_request" }],
      },
    ],
    expected: { runs: 1 },
  },
  {
    name: "restart-continued",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      { id: "restart-continued-1", status: "interrupted" },
      {
        id: "restart-continued-2",
        status: "completed",
        payload: { restartContinuationOfRunId: "restart-continued-1" },
      },
    ],
    expected: { runs: 1 },
  },
  {
    name: "continued-past-a-queued-message",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      { id: "continued-past-a-queued-message-1", status: "interrupted" },
      // A message the user queued meanwhile sits between the run and its continuation.
      { id: "continued-past-a-queued-message-2", status: "queued" },
      {
        id: "continued-past-a-queued-message-3",
        status: "completed",
        payload: {
          restartContinuationOfRunId: "continued-past-a-queued-message-1",
          modelSelection: { model: "priced-model" },
        },
        turns: [usage({ inputTokens: 3_000_000 })],
      },
    ],
    expected: { runs: 1, costUsd: 3 },
  },
  {
    name: "skipped-and-out-of-window",
    scheduledRuns: [
      { outcome: "skipped", dispatched: false },
      { at: Date.parse(SINCE) - 1, outcome: "failed", dispatched: false },
      { at: Date.parse(UNTIL), outcome: "failed", dispatched: false },
    ],
    runs: [],
    expected: { runs: 0 },
  },
  {
    name: "no-runs",
    scheduledRuns: [],
    runs: [],
    expected: { runs: 0 },
  },
  {
    name: "partly-unpriced",
    group: "Ops",
    scheduledRuns: [{ outcome: "succeeded", dispatched: true }],
    runs: [
      {
        id: "partly-unpriced-1",
        status: "completed",
        payload: { modelSelection: { model: "priced-model" } },
        turns: [
          usage({ inputTokens: 2_000_000 }),
          { usageScope: "main_agent", hasSubagents: false, usageStatus: "unavailable" },
          usage({ inputTokens: 9_000_000, models: ["unknown-model"] }),
          usage({ inputTokens: 9_000_000, localCommand: true }),
        ],
      },
    ],
    expected: { runs: 1, costUsd: 2, unpricedRuns: 1 },
  },
];

const taskId = (scenario: Scenario) => `scheduled-task:${scenario.name}`;
const threadId = (scenario: Scenario) => `thread-${scenario.name}`;

const seed = Effect.fn("ScheduledTaskStats.test.seed")(function* (
  scenario: Scenario,
  firstIndex: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = taskId(scenario);
  yield* sql`
    INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
      workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
      created_by, creation_source, created_at, updated_at, last_run_status, run_count
    ) VALUES (${id}, ${`Title ${scenario.name}`}, 'p', 1, '{}', 'project', NULL, '{}', '{}',
      'full-access', 'default', 'test', 'user', ${SINCE}, ${SINCE}, 'idle', 0)
  `;
  if (scenario.group !== undefined) {
    yield* sql`
      INSERT INTO scheduled_task_group (task_id, label, paused_with_group)
      VALUES (${id}, ${scenario.group}, 0)
    `;
  }
  for (const [index, run] of scenario.scheduledRuns.entries()) {
    const startedMs = run.at ?? AT + (firstIndex + index) * 60_000;
    const runId = `${id}:${startedMs}:scheduled`;
    yield* sql`
      INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, thread_id)
      VALUES (${runId}, ${id}, 'scheduled', ${iso(startedMs)}, ${run.outcome},
        ${run.dispatched ? threadId(scenario) : null})
    `;
    if (!run.dispatched || run.at !== undefined) continue;
    for (const [ordinal, orchestrationRun] of scenario.runs.entries()) {
      const payload = {
        userMessageId:
          ordinal === 0 ? `scheduled-task-message:${runId}` : `message:${orchestrationRun.id}`,
        ...orchestrationRun.payload,
      };
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${orchestrationRun.id}, ${threadId(scenario)}, ${ordinal}, 'codex',
          ${orchestrationRun.status}, ${iso(startedMs + 1_000 + ordinal)},
          ${JSON.stringify(payload)})
      `;
      for (const [itemIndex, item] of (orchestrationRun.items ?? []).entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${`${orchestrationRun.id}-item-${itemIndex}`}, ${threadId(scenario)},
            ${orchestrationRun.id}, ${itemIndex}, ${item.type}, 'completed', ${SINCE},
            ${JSON.stringify(item.payload ?? {})})
        `;
      }
      for (const [turnIndex, turn] of (orchestrationRun.turns ?? []).entries()) {
        const attemptId = `${orchestrationRun.id}-attempt-${turnIndex}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts
            (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
             provider_thread_id, status, payload_json)
          VALUES (${attemptId}, ${threadId(scenario)}, ${orchestrationRun.id}, ${turnIndex},
            'node', 'codex', 'provider-thread', 'completed', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
             status, payload_json)
          VALUES (${`${attemptId}-turn`}, ${threadId(scenario)}, ${`provider-${attemptId}`}, 'node',
            ${attemptId}, 0, 'completed', ${JSON.stringify({ turnTokenUsage: turn })})
        `;
      }
    }
  }
});

// ScheduledTaskService creates this side table at startup; it is not a migration.
const createGroupTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_group (
      task_id TEXT PRIMARY KEY, label TEXT NOT NULL, paused_with_group INTEGER NOT NULL
    )
  `;
});

it.effect("counts runs, failures, usage limits and cost per task", () =>
  Effect.gen(function* () {
    yield* createGroupTable;
    for (const [index, scenario] of scenarios.entries()) yield* seed(scenario, index * 10);

    const { tasks } = yield* (yield* ScheduledTaskStats.ScheduledTaskStats).stats({
      since: SINCE,
      until: UNTIL,
    });

    expect(tasks.map((task) => task.id)).toHaveLength(scenarios.length);
    for (const scenario of scenarios) {
      const task = tasks.find((candidate) => candidate.id === taskId(scenario));
      expect(task, scenario.name).toEqual({
        id: taskId(scenario),
        title: `Title ${scenario.name}`,
        group: scenario.group ?? null,
        failed: 0,
        usageLimited: 0,
        costUsd: 0,
        unpricedRuns: 0,
        ...scenario.expected,
      });
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("gives each of two close webhook runs in one thread its own thread run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createGroupTable;
    const id = "scheduled-task:hooks";
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count
      ) VALUES (${id}, 'Hooks', 'p', 1, '{}', 'project', 'thread-hooks', '{}', '{}',
        'full-access', 'default', 'test', 'user', ${SINCE}, ${SINCE}, 'idle', 0)
    `;
    for (const [index, delivery] of [
      { status: "completed", turns: [usage({ inputTokens: 1_000_000, models: ["priced-model"] })] },
      { status: "failed", turns: [] },
    ].entries()) {
      const startedMs = AT + index * 1_000;
      yield* sql`
        INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, thread_id)
        VALUES (${`${id}:${startedMs}:webhook`}, ${id}, 'webhook', ${iso(startedMs)}, 'succeeded',
          'thread-hooks')
      `;
      const runId = `hooks-run-${index}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, 'thread-hooks', ${index}, 'codex', ${delivery.status},
          ${iso(startedMs + 500)},
          ${JSON.stringify({ userMessageId: `scheduled-task-message:${id}:webhook:delivery-${index}` })})
      `;
      for (const turn of delivery.turns) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts
            (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
             provider_thread_id, status, payload_json)
          VALUES (${`${runId}-attempt`}, 'thread-hooks', ${runId}, 0, 'node', 'codex',
            'provider-thread', 'completed', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
             status, payload_json)
          VALUES (${`${runId}-turn`}, 'thread-hooks', 'provider-thread', 'node',
            ${`${runId}-attempt`}, ${index}, 'completed', ${JSON.stringify({ turnTokenUsage: turn })})
        `;
      }
    }

    const { tasks } = yield* (yield* ScheduledTaskStats.ScheduledTaskStats).stats({
      since: SINCE,
      until: UNTIL,
    });

    expect(tasks.find((task) => task.id === id)).toMatchObject({ runs: 2, failed: 1, costUsd: 1 });
  }).pipe(Effect.provide(layer)),
);
