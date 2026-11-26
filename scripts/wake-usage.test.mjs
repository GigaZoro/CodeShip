import { resultFingerprint } from "../apps/server/src/orchestration-v2/taskResultReadEvidence.ts";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vitest";
import { decision, wakeReport } from "./wake-usage.mjs";

function createProjectionTables(db) {
  db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(run_id,thread_id,payload_json,
        status AS (json_extract(payload_json,'$.status')), requested_at AS (json_extract(payload_json,'$.requestedAt')),
        completed_at AS (json_extract(payload_json,'$.completedAt')));
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id);
      CREATE TABLE orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id,thread_id,updated_at,payload_json,
        status AS (json_extract(payload_json,'$.status')), completed_at AS (json_extract(payload_json,'$.completedAt')),
        completion_delivery_state AS (json_extract(payload_json,'$.completionDelivery.state')));
      CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, command_id, aggregate_kind, stream_id, application_event_version, event_type, occurred_at, payload_json);
      CREATE TABLE orchestration_command_receipts(command_id PRIMARY KEY, aggregate_kind, aggregate_id, command_type, status);
    `);
}

it("measures provider starts and uses only prior same-chat observations of every member", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    createProjectionTables(db);
    const before = "2026-11-21T23:59:59.000Z";
    const start = "2026-11-22T00:00:00.000Z";
    const end = "2026-11-23T00:00:00.000Z";
    const insert = (table, ...values) =>
      db
        .prepare(
          `INSERT INTO orchestration_v2_projection_${table} VALUES (${values.map(() => "?")})`,
        )
        .run(...values);
    insert(
      "runs",
      "observer",
      "a",
      JSON.stringify({ status: "failed", startedAt: before, completedAt: before }),
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
        startedAt: before,
        completedAt: "2026-11-21T18:00:00.000Z",
        status: "completed",
      }),
    );
    expect(wakeReport(db, "2026-11-22").chats.a.repeated).toBe(0);
    observer.run(JSON.stringify({ startedAt: before, completedAt: before, status: "completed" }));
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
          startedAt: first,
          completedAt: retry,
          status: "completed",
        }),
      );
      db.exec(`
        INSERT INTO orchestration_v2_projection_run_attempts VALUES ('first','chat','wake'), ('retry','chat','wake');
      `);
      db.prepare(
        "INSERT INTO orchestration_v2_projection_messages VALUES ('msg','wake','chat','user',?,?)",
      ).run(
        first,
        JSON.stringify({ createdBy: "agent", delegatedCompletion: { taskIds: ["task"] } }),
      );
      const turn = db.prepare(
        "INSERT INTO orchestration_v2_projection_provider_turns VALUES ('chat',?,?,?)",
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
          JSON.stringify({ status: "completed", startedAt: observedAt, completedAt: retry }),
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
