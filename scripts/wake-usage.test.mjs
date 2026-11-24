import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vitest";
import { decision, wakeReport } from "./wake-usage.mjs";

it("measures provider starts and uses only prior same-chat observations of every member", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(run_id,thread_id,payload_json);
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id);
      CREATE TABLE orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id,thread_id,updated_at,payload_json);
    `);
    const before = "2026-11-21T23:59:59.000Z";
    const start = "2026-11-22T00:00:00.000Z";
    const end = "2026-11-23T00:00:00.000Z";
    const insert = (table, ...values) =>
      db
        .prepare(
          `INSERT INTO orchestration_v2_projection_${table} VALUES (${values.map(() => "?")})`,
        )
        .run(...values);
    insert("runs", "observer", "a", "{}");
    insert(
      "subagents",
      "seen",
      "a",
      before,
      JSON.stringify({
        completedAt: before,
        status: "completed",
        terminalResultObservation: { runId: "observer", at: before },
        completionDelivery: { state: "acknowledged", observedByRunId: "observer" },
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
