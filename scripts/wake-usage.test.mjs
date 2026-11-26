import {
  nativeResultCopiesAgreeSql,
  provenTaskResultReadsSql,
  resultFingerprint,
} from "../apps/server/src/orchestration-v2/taskResultReadEvidence.ts";
import { compactLegacyIdsInJson } from "../packages/provider-core/src/server/compactId.ts";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vitest";
import { decision, wakeReport } from "./wake-usage.mjs";

function createProjectionTables(db) {
  db.exec(`
      CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json);
      CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT,payload_json,
        ordinal AS (json_extract(payload_json,'$.ordinal')),
        status AS (json_extract(payload_json,'$.status')), requested_at AS (json_extract(payload_json,'$.requestedAt')),
        completed_at AS (json_extract(payload_json,'$.completedAt')));
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id TEXT PRIMARY KEY,thread_id,run_id,provider_thread_id,payload_json);
      CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,thread_id,run_attempt_id,
        provider_thread_id,started_at,completed_at,payload_json);
      CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id,run_id,
        ordinal,type,status,provider_thread_id,provider_turn_id,payload_json);
      CREATE INDEX orchestration_v2_projection_turn_items_run_ordinal_idx ON orchestration_v2_projection_turn_items(run_id,ordinal);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT PRIMARY KEY,thread_id TEXT,updated_at,payload_json,
        status AS (json_extract(payload_json,'$.status')), completed_at AS (json_extract(payload_json,'$.completedAt')),
        run_id AS (json_extract(payload_json,'$.runId')), child_thread_id AS (json_extract(payload_json,'$.childThreadId')),
        origin AS (json_extract(payload_json,'$.origin')),
        completion_delivery_state AS (json_extract(payload_json,'$.completionDelivery.state')));
      CREATE TABLE orchestration_v2_projection_context_transfers(context_transfer_id TEXT PRIMARY KEY,source_thread_id,
        target_thread_id,target_run_id,type,status,payload_json);
      CREATE INDEX orchestration_v2_projection_context_transfers_target_run_idx ON orchestration_v2_projection_context_transfers(target_run_id);
      CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, command_id, aggregate_kind, stream_id, application_event_version, event_type, occurred_at, payload_json);
      CREATE TABLE orchestration_command_receipts(command_id PRIMARY KEY, aggregate_kind, aggregate_id, command_type, status);
      CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind, stream_id, sequence);
      CREATE INDEX idx_orch_events_command_id ON orchestration_events(command_id);
      CREATE INDEX idx_orchestration_events_agent_stream_sequence ON orchestration_events(stream_id, sequence)
        WHERE application_event_version = 2 AND aggregate_kind = 'thread';
      CREATE INDEX idx_orch_command_receipts_aggregate ON orchestration_command_receipts(aggregate_kind, aggregate_id);
    `);
}

it("accepts only migrated ID spellings in the retained native response", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  const compare = db.prepare(`
    WITH call AS (SELECT json_extract(?1,'$.content') AS content_copy,
      json_extract(?1,'$.structuredContent') AS response, 1 AS has_copy)
    SELECT (${nativeResultCopiesAgreeSql}) AS agrees FROM call
  `);
  const taskId = "node:delegated-task:command%253Aread!'()";
  const response = {
    taskId,
    childNodeId: taskId,
    childRunId: "run:thread%25253achild:ordinal:1",
    childThreadId: "thread:child%3Aone",
    resultContextTransferId: "context-transfer:child%3Aone",
    latestTerminalRunId: "run:thread%253Achild:ordinal:2",
    latestTerminalResultContextTransferId: "context-transfer:child%3Atwo",
    latestTerminalStatus: "completed",
    latestTerminalSummary: null,
    status: "completed",
    workState: "result_available",
    summary: "Complete 😀\r\nResult %3A\u0000exact",
  };
  const original = { structuredContent: response, content: JSON.stringify(response) };
  const migrated = JSON.parse(compactLegacyIdsInJson(JSON.stringify(original)));
  const agrees = (envelope) => compare.get({ 1: JSON.stringify(envelope) }).agrees;
  expect(migrated.structuredContent.taskId).toBe("node:delegated-task:command:read!'()");
  expect(migrated.structuredContent.childRunId).toBe("run:thread:child:ordinal:1");
  expect(migrated.structuredContent.latestTerminalRunId).toBe("run:thread:child:ordinal:2");
  expect(JSON.parse(migrated.content)).toEqual(response);
  expect(agrees(original)).toBe(1);
  expect(agrees(migrated)).toBe(1);
  for (const [field, value] of [
    ["summary", response.summary.replace("%3A", ":")],
    ["summary", response.summary.replace("exact", "other")],
    ["childRunId", "run:thread%253achild:ordinal:1"],
    ["childRunId", "run:thread:child:ordinal:2"],
    ["taskId", "node:delegated-task:command:other"],
    ["childThreadId", "thread:child:one"],
    ["resultContextTransferId", "context-transfer:child:one"],
    ["latestTerminalRunId", "run:thread:child:ordinal:3"],
    ["latestTerminalResultContextTransferId", "context-transfer:child:two"],
    ["latestTerminalStatus", "failed"],
    ["latestTerminalSummary", "Different result"],
  ]) {
    expect(
      agrees({ ...migrated, structuredContent: { ...migrated.structuredContent, [field]: value } }),
      field,
    ).toBe(0);
  }
});

it("probes historical events by receipt command ID when the stream index also exists", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  createProjectionTables(db);
  const plan = db
    .prepare(`
      EXPLAIN QUERY PLAN
      SELECT 1 FROM orchestration_v2_projection_subagents t
      WHERE t.subagent_id=? AND t.thread_id=?
        AND EXISTS (SELECT 1 FROM (${provenTaskResultReadsSql}) WHERE reader_status='completed')
      LIMIT 1
    `)
    .all("task", "thread");
  expect(plan.map(({ detail }) => detail)).toContain(
    "SEARCH e USING INDEX idx_orch_events_command_id (command_id=?)",
  );
});

it("credits only exact historically returned native local delegate results", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  createProjectionTables(db);
  const day = "2026-11-22";
  const at = (hour) => `${day}T${hour}:00:00.000Z`;
  const requestedAt = at("06");
  const startedAt = at("07");
  const completedAt = at("08");
  const acknowledgedAt = at("09");
  const returnedAt = at("10");
  const settledAt = at("11");
  const wakeAt = at("12");
  const result = "Complete result 😀\r\nSecond line.";
  const task = {
    id: "task",
    origin: "app_owned",
    threadId: "chat",
    runId: "reader",
    childThreadId: "child",
    status: "completed",
    completedAt,
    updatedAt: acknowledgedAt,
    result,
    completionDelivery: { state: "acknowledged", observedByRunId: "reader" },
  };
  const reader = { requestedAt, startedAt, completedAt: settledAt, status: "completed" };
  const insertRun = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?)");
  insertRun.run("reader", "chat", JSON.stringify(reader));
  insertRun.run("wake", "chat", '{"userMessageId":"msg"}');
  const childRun = {
    ordinal: 1,
    status: "completed",
    requestedAt: startedAt,
    startedAt,
    completedAt,
  };
  insertRun.run("child-run", "child", JSON.stringify(childRun));
  insertRun.run("other-child-run", "child", JSON.stringify({ ...childRun, ordinal: 2 }));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id,thread_id,run_id,provider_thread_id,payload_json) VALUES ('reader-attempt','chat','reader','provider',?)
  `).run(JSON.stringify(reader));
  db.exec(`
    INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id) VALUES ('wake-attempt','chat','wake');
    INSERT INTO orchestration_v2_projection_threads VALUES ('child','{"forkedFrom":{"type":"node","nodeId":"task"}}');
    INSERT INTO orchestration_command_receipts VALUES
      ('old-ack','thread','chat','delegated_task.completion-delivery.acknowledge','accepted');
  `);
  const publication = {
    sourcePoint: { threadId: "child", runId: "child-run" },
    createdAt: completedAt,
    consumedAt: completedAt,
  };
  const insertPublication = db.prepare(`
    INSERT INTO orchestration_v2_projection_context_transfers VALUES (?,'child','chat','reader',
      'subagent_result','consumed',?)
  `);
  insertPublication.run("transfer", JSON.stringify(publication));
  db.prepare(`
    INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id,thread_id,run_attempt_id,provider_thread_id,started_at,completed_at,payload_json)
      VALUES ('provider-turn','chat','reader-attempt','provider',?,?,'{}')
  `).run(startedAt, settledAt);
  db.prepare(`
    INSERT INTO orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json)
      VALUES ('chat','wake-attempt',?,'{"nativeWakeStarted":true}')
  `).run(wakeAt);
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages VALUES ('msg','wake','chat','user',?,?)",
  ).run(wakeAt, '{"createdBy":"agent","delegatedCompletion":{"taskIds":["task"]}}');
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('task','chat',?,?)").run(
    acknowledgedAt,
    JSON.stringify(task),
  );
  db.prepare(
    "INSERT INTO orchestration_events VALUES (1,'old-ack','thread','chat',2,'subagent.updated',?,?)",
  ).run(acknowledgedAt, JSON.stringify(task));
  const response = {
    taskId: "task",
    childNodeId: "task",
    childThreadId: "child",
    childRunId: "child-run",
    status: "completed",
    workState: "result_available",
    summary: result,
  };
  const retainedOutput = (value) => ({ structuredContent: value, content: JSON.stringify(value) });
  const tool = {
    toolName: "mcp__t3-code__delegate_task",
    nativeItemRef: { driver: "claudeAgent", nativeId: "toolu_delegate", strength: "strong" },
    startedAt,
    completedAt: returnedAt,
    input: { task: "Produce two lines", mode: "wait" },
    output: retainedOutput(response),
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_turn_items
      VALUES ('tool','chat','reader',1,'dynamic_tool','completed','provider','provider-turn',?)
  `).run(JSON.stringify(tool));
  const repetitions = () => wakeReport(db, day).all.repeated;
  expect(repetitions()).toBe(1);

  const changePublication = db.prepare(
    "UPDATE orchestration_v2_projection_context_transfers SET payload_json=? WHERE context_transfer_id='transfer'",
  );
  for (const [label, fields] of [
    ["transfer created after the call", { createdAt: settledAt }],
    ["transfer consumed after the acknowledgement", { consumedAt: returnedAt }],
    ["earlier publication with identical bytes", { createdAt: startedAt, consumedAt: startedAt }],
  ]) {
    changePublication.run(JSON.stringify({ ...publication, ...fields }));
    expect(repetitions(), label).toBe(0);
  }
  changePublication.run(JSON.stringify(publication));
  insertPublication.run(
    "ambiguous",
    JSON.stringify({
      ...publication,
      sourcePoint: { threadId: "child", runId: "other-child-run" },
    }),
  );
  expect(repetitions(), "two source runs at the same publication time").toBe(0);
  const updateTask = db.prepare("UPDATE orchestration_v2_projection_subagents SET payload_json=?");
  updateTask.run(
    JSON.stringify({
      ...task,
      terminalResultObservation: {
        runId: "reader",
        at: returnedAt,
        sourceChildRunId: "child-run",
        resultFingerprint: resultFingerprint(result),
      },
    }),
  );
  expect(repetitions(), "promotion cannot disambiguate two publications").toBe(0);
  db.exec(
    "DELETE FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='ambiguous'",
  );
  expect(repetitions(), "unambiguous publication").toBe(1);
  updateTask.run(JSON.stringify(task));

  const updateTool = db.prepare("UPDATE orchestration_v2_projection_turn_items SET payload_json=?");
  db.exec("UPDATE orchestration_v2_projection_context_transfers SET status='pending'");
  expect(repetitions(), "omitted transfer ID still requires a consumed transfer").toBe(0);
  db.exec("UPDATE orchestration_v2_projection_context_transfers SET status='consumed'");
  updateTool.run(
    JSON.stringify({
      ...tool,
      output: retainedOutput({ ...response, resultContextTransferId: "transfer" }),
    }),
  );
  expect(repetitions(), "matching transfer ID").toBe(1);
  for (const [label, fields] of [
    ["different result", { summary: "Different result" }],
    ["wrong task", { taskId: "other-task" }],
    ["wrong child", { childThreadId: "other-child" }],
    ["same summary from another child run", { childRunId: "other-child-run" }],
    ["wrong transfer", { resultContextTransferId: "other-transfer" }],
  ]) {
    updateTool.run(JSON.stringify({ ...tool, output: retainedOutput({ ...response, ...fields }) }));
    expect(repetitions(), label).toBe(0);
  }
  for (const [label, projected] of [
    ["truncated output", { ...tool, outputOmitted: true }],
    ["truncated text copy", { ...tool, output: { ...tool.output, content: '{"taskId":' } }],
    [
      "different text copy",
      {
        ...tool,
        output: { ...tool.output, content: JSON.stringify({ ...response, summary: "Other" }) },
      },
    ],
    ["tool returned an error", { ...tool, output: { ...tool.output, isError: true } }],
    [
      "weak provider observation",
      { ...tool, nativeItemRef: { ...tool.nativeItemRef, strength: "weak" } },
    ],
    ["different native tool", { ...tool, toolName: "delegate_task" }],
    ["acknowledged before this call", { ...tool, startedAt: returnedAt }],
    ["returned before publication", { ...tool, completedAt: startedAt }],
    ["returned after the provider turn", { ...tool, completedAt: wakeAt }],
  ]) {
    updateTool.run(JSON.stringify(projected));
    expect(repetitions(), label).toBe(0);
  }
  updateTool.run(JSON.stringify(tool));
  const updateChildRun = db.prepare(
    "UPDATE orchestration_v2_projection_runs SET payload_json=? WHERE run_id='child-run'",
  );
  updateChildRun.run(JSON.stringify({ ...childRun, completedAt: settledAt }));
  expect(repetitions(), "child completed after the return").toBe(0);
  updateChildRun.run(JSON.stringify(childRun));
  const updateEvent = db.prepare("UPDATE orchestration_events SET payload_json=? WHERE sequence=1");
  updateEvent.run(JSON.stringify({ ...task, childThreadId: "other-child" }));
  expect(repetitions(), "acknowledgement belongs to a different child").toBe(0);
  updateEvent.run(JSON.stringify(task));
  db.exec("UPDATE orchestration_v2_projection_context_transfers SET status='pending'");
  expect(repetitions(), "unconsumed transfer").toBe(0);
  db.exec("UPDATE orchestration_v2_projection_context_transfers SET status='consumed'");
  db.exec("DELETE FROM orchestration_command_receipts");
  expect(repetitions(), "missing receipt").toBe(0);
});

it("measures provider starts and uses only prior same-chat observations of every member", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    createProjectionTables(db);
    const before = "2026-11-21T23:59:59.000Z";
    const start = "2026-11-22T00:00:00.000Z";
    const end = "2026-11-23T00:00:00.000Z";
    const columns = {
      run_attempts: "(attempt_id,thread_id,run_id)",
      provider_turns: "(thread_id,run_attempt_id,started_at,payload_json)",
    };
    const insert = (table, ...values) =>
      db
        .prepare(
          `INSERT INTO orchestration_v2_projection_${table}${columns[table] ?? ""} VALUES (${values.map(() => "?")})`,
        )
        .run(...values);
    insert(
      "runs",
      "observer",
      "a",
      JSON.stringify({
        status: "failed",
        requestedAt: before,
        startedAt: before,
        completedAt: before,
      }),
    );
    insert(
      "subagents",
      "seen",
      "a",
      before,
      JSON.stringify({
        completedAt: before,
        status: "completed",
        result: "done",
        terminalResultObservation: { runId: "observer", at: before },
        completionDelivery: {
          state: "acknowledged",
          observedByRunId: "observer",
          observedAt: before,
          resultFingerprint: resultFingerprint("done"),
        },
      }),
    );
    for (const [id, thread, ts, tasks] of [
      ["1", "a", start, ["seen"]],
      ["2", "a", start, ["seen", "unknown"]],
      ["3", "b", start, ["seen"]],
      ["4", "b", end, ["seen"]],
      ["5", "c", start, null],
    ]) {
      insert("runs", id, thread, JSON.stringify({ userMessageId: id }));
      insert("run_attempts", id, thread, id);
      insert(
        "provider_turns",
        thread,
        id,
        ts,
        JSON.stringify({ turnTokenUsage: { inputTokens: 5, outputTokens: 3 } }),
      );
      insert(
        "messages",
        id,
        id,
        thread,
        "user",
        ts,
        JSON.stringify(
          tasks
            ? { createdBy: "agent", delegatedCompletion: { taskIds: tasks } }
            : { createdBy: "user" },
        ),
      );
    }
    insert(
      "messages",
      "steer",
      "1",
      "a",
      "user",
      start,
      JSON.stringify({ createdBy: "agent", notification: {} }),
    );
    insert("run_attempts", "retry", "a", "1");
    insert("provider_turns", "a", "retry", start, JSON.stringify({ nativeWakeStarted: true }));
    insert("run_attempts", "non-start", "b", "3");
    insert(
      "provider_turns",
      "b",
      "non-start",
      before,
      JSON.stringify({ nativeWakeStarted: false }),
    );
    const report = wakeReport(db, "2026-11-22");
    expect(report.all).toMatchObject({ wakes: 3, repeated: 1, unknown: 2, decision: "met" });
    for (const field of ["wakes", "repeated", "fresh", "unknown", "uncertainStarts"]) {
      expect(Object.values(report.chats).reduce((sum, chat) => sum + chat[field], 0)).toBe(
        report.all[field],
      );
    }
    expect(report.topFive).toEqual(report.all);
    expect(report.chats.c.wakes).toBe(0);
    expect(report.inRunDeliveries).toBe(1);
    expect(report.chats.b.decision).toBe("indeterminate");
    db.prepare(
      "UPDATE orchestration_v2_projection_messages SET payload_json=? WHERE message_id='3'",
    ).run(JSON.stringify({ createdBy: "agent", notification: {}, creationSource: "provider" }));
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE run_attempt_id='3'",
    ).run(JSON.stringify({ nativeWakeStarted: false }));
    expect(wakeReport(db, "2026-11-22").chats.b.wakes).toBe(0);
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json='{}' WHERE run_attempt_id='3'",
    ).run();
    expect(wakeReport(db, "2026-11-22").chats.b.uncertainStarts).toBe(1);
    insert(
      "subagents",
      "fresh",
      "b",
      before,
      JSON.stringify({ status: "completed", completedAt: before }),
    );
    db.prepare(
      "UPDATE orchestration_v2_projection_messages SET payload_json=? WHERE message_id='3'",
    ).run(JSON.stringify({ createdBy: "agent", delegatedCompletion: { taskIds: ["fresh"] } }));
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE run_attempt_id='3'",
    ).run(JSON.stringify({ turnTokenUsage: { inputTokens: 1, outputTokens: 1 } }));
    expect(wakeReport(db, "2026-11-22").chats.b.decision).toBe("below");
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json='{}' WHERE run_attempt_id='5'",
    ).run();
    expect(wakeReport(db, "2026-11-22").topFive).toEqual(wakeReport(db, "2026-11-22").all);
    db.prepare(
      "UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE run_attempt_id='5'",
    ).run(
      JSON.stringify({ turnTokenUsage: { localCommand: true, inputTokens: 50, outputTokens: 5 } }),
    );
    expect(
      wakeReport(db, "2026-11-22").topFiveByRecordedTurnTokens.find((row) => row.thread === "c")
        .tokens,
    ).toBe(0);
    const observer = db.prepare(
      "UPDATE orchestration_v2_projection_runs SET payload_json=? WHERE run_id='observer'",
    );
    observer.run(
      JSON.stringify({
        requestedAt: before,
        startedAt: before,
        completedAt: "2026-11-21T18:00:00.000Z",
        status: "completed",
      }),
    );
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(0);
    observer.run(
      JSON.stringify({
        requestedAt: before,
        startedAt: before,
        completedAt: before,
        status: "completed",
      }),
    );
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(1);
    const legacy = {
      id: "seen",
      status: "completed",
      result: "done",
      completedAt: before,
      updatedAt: before,
      terminalResultObservation: { runId: "observer", at: before, verified: true },
      completionDelivery: { state: "disposed", observedByRunId: "observer" },
    };
    db.prepare(
      "UPDATE orchestration_v2_projection_subagents SET payload_json=? WHERE subagent_id='seen'",
    ).run(JSON.stringify(legacy));
    db.prepare(
      "INSERT INTO orchestration_events VALUES (1,'read','thread','a',2,'subagent.updated',?,?)",
    ).run(
      before,
      JSON.stringify({
        ...legacy,
        completionDelivery: { ...legacy.completionDelivery, state: "acknowledged" },
      }),
    );
    db.exec(
      "INSERT INTO orchestration_command_receipts VALUES ('read','thread','a','delegated_task.completion-delivery.acknowledge','accepted')",
    );
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(0);
    db.exec(
      "UPDATE orchestration_command_receipts SET command_type='delegated_task.completion-delivery.observe-disposed'",
    );
    db.prepare("UPDATE orchestration_events SET payload_json=?").run(
      JSON.stringify({ ...legacy, result: "different" }),
    );
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(0);
    db.prepare("UPDATE orchestration_events SET payload_json=?").run(JSON.stringify(legacy));
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(1);
    const unpaired = "result\ud800\u0000";
    const textRead = {
      ...legacy,
      result: unpaired,
      completionDelivery: {
        ...legacy.completionDelivery,
        observedAt: before,
        resultFingerprint: resultFingerprint(unpaired),
      },
    };
    const setTask = db.prepare(
      "UPDATE orchestration_v2_projection_subagents SET payload_json=? WHERE subagent_id='seen'",
    );
    setTask.run(JSON.stringify(textRead));
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(1);
    setTask.run(JSON.stringify({ ...textRead, result: "result\ud801\u0000" }));
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(0);
    for (const id of ["d", "e", "f"])
      insert(
        "provider_turns",
        id,
        id,
        start,
        id === "f" ? "{}" : JSON.stringify({ turnTokenUsage: { inputTokens: 1, outputTokens: 1 } }),
      );
    expect(wakeReport(db, "2026-11-22").topFive.decision).toBe("indeterminate");
  } finally {
    db.close();
  }
});

it.each([
  [0, 0, 0, "indeterminate"],
  [10, 0, 0, "below"],
  [10, 1, 0, "met"],
  [10, 2, 0, "met"],
  [10, 0, 1, "indeterminate"],
])(
  "evaluates the 10 percent threshold for %i wakes, %i repeats, %i unknown",
  (wakes, repeated, unknown, expected) =>
    expect(decision({ wakes, repeated, unknown }).decision).toBe(expected),
);

it.each(["completionDelivery", "terminalResultObservation"])(
  "excludes the wake run's own %s observation before a confirmed retry",
  (source) => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    try {
      createProjectionTables(db);
      const day = "2026-11-22";
      const completedAt = day + "T00:00:00.000Z";
      const first = day + "T01:00:00.000Z";
      const observedAt = day + "T01:10:00.000Z";
      const retry = day + "T02:00:00.000Z";
      db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('wake','chat',?)").run(
        JSON.stringify({
          userMessageId: "msg",
          requestedAt: first,
          startedAt: first,
          completedAt: retry,
          status: "completed",
        }),
      );
      db.exec(`
        INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id) VALUES ('first','chat','wake'), ('retry','chat','wake');
      `);
      db.prepare(
        "INSERT INTO orchestration_v2_projection_messages VALUES ('msg','wake','chat','user',?,?)",
      ).run(
        first,
        JSON.stringify({ createdBy: "agent", delegatedCompletion: { taskIds: ["task"] } }),
      );
      const turn = db.prepare(
        "INSERT INTO orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json) VALUES ('chat',?,?,?)",
      );
      turn.run("first", first, JSON.stringify({ completedAt: observedAt }));
      turn.run(
        "retry",
        retry,
        JSON.stringify({ turnTokenUsage: { inputTokens: 9, outputTokens: 4 } }),
      );
      const observation =
        source === "completionDelivery"
          ? {
              state: "acknowledged",
              observedByRunId: "wake",
              observedAt,
              resultFingerprint: resultFingerprint("done"),
            }
          : { at: observedAt, runId: "wake" };
      db.prepare(
        "INSERT INTO orchestration_v2_projection_subagents VALUES ('task','chat',?,?)",
      ).run(
        observedAt,
        JSON.stringify({ completedAt, status: "completed", result: "done", [source]: observation }),
      );
      expect(wakeReport(db, day).all).toMatchObject({ wakes: 1, repeated: 0, unknown: 1 });
      if (source === "terminalResultObservation") {
        db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('later','chat',?)").run(
          JSON.stringify({
            status: "completed",
            requestedAt: observedAt,
            startedAt: observedAt,
            completedAt: retry,
          }),
        );
        db.prepare("UPDATE orchestration_v2_projection_subagents SET payload_json=?").run(
          JSON.stringify({
            status: "completed",
            result: "done",
            completedAt,
            terminalResultObservation: {
              runId: "wake",
              at: observedAt,
              resultFingerprint: resultFingerprint("done"),
            },
            completionDelivery: {
              state: "acknowledged",
              observedByRunId: "later",
              observedAt,
              resultFingerprint: resultFingerprint("done"),
            },
          }),
        );
        expect(wakeReport(db, day).all).toMatchObject({ wakes: 1, repeated: 0, unknown: 1 });
      }
    } finally {
      db.close();
    }
  },
);

it.each([
  "terminalResultObservation",
  "completionDelivery",
  "observe-disposed",
  "unverified acknowledgement",
])("retains only proven %s evidence from an earlier attempt of a restarted reader", (source) => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  createProjectionTables(db);
  const day = "2026-11-22";
  const at = (hour) => `${day}T${hour}:00:00.000Z`;
  const requestedAt = at("06");
  const completedAt = at("07");
  const observedAt = at("08");
  const restartedAt = at("09");
  const settledAt = at("10");
  const wakeAt = at("11");
  const result = "child finished";
  const fingerprint = resultFingerprint(result);
  const task = { id: "task", status: "completed", completedAt, result, updatedAt: observedAt };
  const delivery = { state: "acknowledged", observedByRunId: "reader" };
  if (source === "terminalResultObservation") {
    task.terminalResultObservation = {
      runId: "reader",
      at: observedAt,
      resultFingerprint: fingerprint,
    };
  } else if (source === "completionDelivery") {
    task.completionDelivery = { ...delivery, observedAt, resultFingerprint: fingerprint };
  } else {
    const disposed = source === "observe-disposed";
    task.completionDelivery = { ...delivery, state: disposed ? "disposed" : "acknowledged" };
    db.prepare(
      "INSERT INTO orchestration_command_receipts VALUES ('old-read','thread','chat',?,'accepted')",
    ).run(`delegated_task.completion-delivery.${disposed ? "observe-disposed" : "acknowledge"}`);
    db.prepare(
      "INSERT INTO orchestration_events VALUES (1,'old-read','thread','chat',2,'subagent.updated',?,?)",
    ).run(observedAt, JSON.stringify(task));
  }
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('task','chat',?,?)").run(
    observedAt,
    JSON.stringify(task),
  );
  const reader = {
    requestedAt,
    startedAt: requestedAt,
    activeAttemptId: "first",
    status: "running",
  };
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('reader','chat',?)").run(
    JSON.stringify(reader),
  );
  db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES ('wake','chat','{"userMessageId":"msg"}');
      INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id) VALUES ('first','chat','reader'), ('wake-attempt','chat','wake');`);
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages VALUES ('msg','wake','chat','user',?,?)",
  ).run(wakeAt, JSON.stringify({ createdBy: "agent", delegatedCompletion: { taskIds: ["task"] } }));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json) VALUES ('chat','wake-attempt',?,?)",
  ).run(wakeAt, JSON.stringify({ nativeWakeStarted: true }));
  const repeated = () => wakeReport(db, day).all.repeated;
  const expected = source === "unverified acknowledgement" ? 0 : 1;
  expect(repeated()).toBe(expected);
  const updateReader = db.prepare(
    "UPDATE orchestration_v2_projection_runs SET payload_json=? WHERE run_id='reader'",
  );
  db.exec(
    "INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id) VALUES ('second','chat','reader')",
  );
  const restarted = { ...reader, startedAt: restartedAt, activeAttemptId: "second" };
  updateReader.run(JSON.stringify(restarted));
  expect(repeated()).toBe(expected);
  updateReader.run(JSON.stringify({ ...restarted, status: "completed", completedAt: settledAt }));
  expect(repeated()).toBe(expected);
  // Even proven content cannot be credited before this run existed.
  updateReader.run(JSON.stringify({ ...restarted, requestedAt: restartedAt }));
  expect(repeated()).toBe(0);
});
