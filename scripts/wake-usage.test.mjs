import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vitest";
import { decision, wakeReport } from "./wake-usage.mjs";

function createProjectionTables(db) {
  db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(run_id,thread_id,payload_json);
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id);
      CREATE TABLE orchestration_v2_projection_provider_turns(thread_id,run_attempt_id,started_at,payload_json);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id,thread_id,updated_at,payload_json);
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
      db.exec(`
        INSERT INTO orchestration_v2_projection_runs VALUES ('wake','chat','{"userMessageId":"msg"}');
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
          ? { state: "acknowledged", observedByRunId: "wake" }
          : { at: observedAt, runId: "wake" };
      db.prepare(
        "INSERT INTO orchestration_v2_projection_subagents VALUES ('task','chat',?,?)",
      ).run(
        observedAt,
        JSON.stringify({ completedAt, status: "completed", [source]: observation }),
      );
      expect(wakeReport(db, day).all).toMatchObject({ wakes: 1, repeated: 0, unknown: 1 });
    } finally {
      db.close();
    }
  },
);

it("uses turn items to isolate idle overlapping turns and detect post-completion logPath reads", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(run_id,thread_id,payload_json);
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id);
      CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,run_attempt_id,started_at,payload_json);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id,thread_id,updated_at,payload_json);
      CREATE TABLE orchestration_v2_projection_turn_items(thread_id,run_id,provider_turn_id,type,status,updated_at,payload_json);
    `);
    const day = "2026-11-26";
    const t = (sec) => `${day}T00:00:${String(sec).padStart(2, "0")}.000Z`;
    const logA = "/tmp/logs/a/output.log";
    const logB = "/tmp/logs/b/output.log";
    const logC = "/tmp/logs/c/output.log";
    const logD = "/tmp/logs/d/output.log";
    const logE = "/tmp/logs/e/output.log";
    const addRun = (runId, thread, startSec, endSec, tasks, extraTurn = {}) => {
      db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?)").run(
        runId,
        thread,
        JSON.stringify({ userMessageId: runId }),
      );
      db.prepare("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?,?,?)").run(
        runId,
        thread,
        runId,
      );
      db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?)").run(
        `turn-${runId}`,
        thread,
        runId,
        t(startSec),
        JSON.stringify({
          completedAt: t(endSec),
          turnTokenUsage: { inputTokens: 10, outputTokens: 5, usageStatus: "complete" },
          ...extraTurn,
        }),
      );
      db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?)").run(
        runId,
        runId,
        thread,
        "user",
        t(startSec),
        JSON.stringify(
          tasks
            ? { createdBy: "agent", delegatedCompletion: { taskIds: tasks } }
            : { createdBy: "user" },
        ),
      );
    };
    const addItem = (thread, runId, type, status, sec, payload) =>
      db
        .prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)")
        .run(thread, runId, `turn-${runId}`, type, status, t(sec), JSON.stringify(payload));

    // Chat 1: prior turn started before completion and only wrote assistant text, launched another delegate, and updated async app_owned subagent card -> fresh.
    addRun("p1", "c1", 1, 10, null);
    addItem("c1", "p1", "assistant_message", "completed", 9, {
      startedAt: t(8),
      completedAt: t(9),
    });
    addItem("c1", "p1", "dynamic_tool", "completed", 8, {
      toolName: "t3-code.delegate_task",
      startedAt: t(7),
      completedAt: t(8),
    });
    addItem("c1", "p1", "subagent", "completed", 9, {
      origin: "app_owned",
      startedAt: t(2),
      completedAt: t(5),
    });
    db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
      "t1",
      "c1",
      t(5),
      JSON.stringify({ status: "completed", completedAt: t(5) }),
    );
    addRun("w1", "c1", 11, 15, ["t1"]);

    // Chat 2: prior turn reads logA via tail -n 15 and logD via cat with stderr redirect after completion -> repeated.
    addRun("p2", "c2", 1, 20, null);
    addItem("c2", "p2", "command_execution", "completed", 12, {
      startedAt: t(11),
      completedAt: t(12),
      exitCode: 0,
      input: `tail -n 15 ${logA}`,
    });
    addItem("c2", "p2", "command_execution", "completed", 14, {
      startedAt: t(13),
      completedAt: t(14),
      exitCode: 0,
      input: `cat ${logD} 2>/dev/null || true`,
    });
    db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
      "t2a",
      "c2",
      t(10),
      JSON.stringify({ status: "completed", completedAt: t(10), command: { logPath: logA } }),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
      "t2d",
      "c2",
      t(10),
      JSON.stringify({ status: "completed", completedAt: t(10), command: { logPath: logD } }),
    );
    addRun("w2a", "c2", 21, 23, ["t2a"]);
    addRun("w2d", "c2", 24, 26, ["t2d"]);

    // Chat 3: non-EOF, redirected, scripted, or partial reads stay unknown.
    addRun("p3", "c3", 1, 20, null);
    for (const [sec, exitCode, input] of [
      [12, 0, `echo "landed (${logB})"`],
      [13, 0, `head -n 5 ${logB}`],
      [14, 0, `grep -c PASS ${logB}`],
      [15, 0, `tail -f ${logB}`],
      [16, 0, `cat ${logB} | head -n 5`],
      [16, 0, `cat ${logB} > /dev/null`],
      [16, 0, `cat ${logB} 1>/dev/null`],
      [17, 0, `python3 -c 'open("${logB}", "w")'`],
      [17, 0, `node -e 'require("fs").readFileSync("${logB}", "utf8")'`],
      [18, 1, `cat ${logC}`],
      [19, 0, `cat ${logC}.bak`],
    ]) {
      addItem("c3", "p3", "command_execution", "completed", sec, {
        startedAt: t(sec - 1),
        completedAt: t(sec),
        exitCode,
        input,
      });
    }
    addItem("c3", "p3", "dynamic_tool", "completed", 19, {
      toolName: "Read",
      startedAt: t(18),
      completedAt: t(19),
      input: { file_path: logE },
    });
    for (const [taskId, logPath] of [
      ["t3b", logB],
      ["t3c", logC],
      ["t3e", logE],
    ]) {
      db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
        taskId,
        "c3",
        t(10),
        JSON.stringify({ status: "completed", completedAt: t(10), command: { logPath } }),
      );
    }
    addRun("w3b", "c3", 21, 22, ["t3b"]);
    addRun("w3c", "c3", 23, 24, ["t3c"]);
    addRun("w3e", "c3", 25, 26, ["t3e"]);

    // Chat 4: duplicate wake started AFTER completion (with only assistant text) must NOT be skipped as fresh -> second wake stays unknown.
    db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
      "t4",
      "c4",
      t(10),
      JSON.stringify({ status: "completed", completedAt: t(10) }),
    );
    addRun("w4-first", "c4", 11, 15, ["t4"]);
    addItem("c4", "w4-first", "assistant_message", "completed", 14, {
      startedAt: t(12),
      completedAt: t(14),
    });
    addRun("w4-dup", "c4", 20, 25, ["t4"]);

    // Chat 5: overlapping provider_native subagent -> unknown.
    addRun("p5", "c5", 1, 20, null);
    addItem("c5", "p5", "subagent", "completed", 12, {
      origin: "provider_native",
      startedAt: t(2),
      completedAt: t(12),
    });
    db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?,?,?,?)").run(
      "t5",
      "c5",
      t(10),
      JSON.stringify({ status: "completed", completedAt: t(10) }),
    );
    addRun("w5", "c5", 21, 25, ["t5"]);

    const report = wakeReport(db, day);
    expect(report.chats.c1).toMatchObject({ wakes: 1, fresh: 1, repeated: 0, unknown: 0 });
    expect(report.chats.c2).toMatchObject({ wakes: 2, fresh: 0, repeated: 2, unknown: 0 });
    expect(report.chats.c3).toMatchObject({ wakes: 3, fresh: 0, repeated: 0, unknown: 3 });
    expect(report.chats.c4).toMatchObject({ wakes: 2, fresh: 1, repeated: 0, unknown: 1 });
    expect(report.chats.c5).toMatchObject({ wakes: 1, fresh: 0, repeated: 0, unknown: 1 });
  } finally {
    db.close();
  }
});

it("handles usage-limit failed turns in start evidence and top-five ranking", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(run_id,thread_id,payload_json);
      CREATE TABLE orchestration_v2_projection_messages(message_id,run_id,thread_id,role,created_at,payload_json);
      CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id);
      CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,run_attempt_id,started_at,payload_json);
      CREATE TABLE orchestration_v2_projection_subagents(subagent_id,thread_id,updated_at,payload_json);
      CREATE TABLE orchestration_v2_projection_turn_items(thread_id,run_id,provider_turn_id,type,status,updated_at,payload_json);
    `);
    const day = "2026-11-26";
    const ts = `${day}T01:00:00.000Z`;
    const addTurn = (id, thread, turnPayload, msgPayload = { createdBy: "user" }) => {
      db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?)").run(
        id,
        thread,
        JSON.stringify({ userMessageId: id }),
      );
      db.prepare("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?,?,?)").run(
        id,
        thread,
        id,
      );
      db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?)").run(
        `turn-${id}`,
        thread,
        id,
        ts,
        JSON.stringify(turnPayload),
      );
      db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?)").run(
        id,
        id,
        thread,
        "user",
        ts,
        JSON.stringify(msgPayload),
      );
    };
    const addItem = (thread, runId, type, payload, providerTurnId = `turn-${runId}`) =>
      db
        .prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)")
        .run(thread, runId, providerTurnId, type, "completed", ts, JSON.stringify(payload));
    const addErr = (thread, runId, providerTurnId = `turn-${runId}`) =>
      addItem(thread, runId, "error", { title: "Usage limit reached" }, providerTurnId);

    // 5 chats with high tokens (c3 is a partial quota-stopped turn with hasSubagents: true, still inside top 5).
    for (const [id, tokens] of [
      ["c1", 500],
      ["c2", 400],
      ["c4", 200],
      ["c5", 100],
    ]) {
      addTurn(id, id, {
        status: "completed",
        turnTokenUsage: { inputTokens: tokens, outputTokens: 1, usageStatus: "complete" },
      });
    }
    addTurn("c3", "c3", {
      status: "failed",
      turnTokenUsage: {
        inputTokens: 300,
        outputTokens: 10,
        usageStatus: "partial",
        hasSubagents: true,
      },
    });
    addErr("c3", "c3");

    // Chat 6 outside top 5: partial quota-stopped turn with hasSubagents: false -> measured, does not break top 5.
    addTurn("c6", "c6", {
      status: "failed",
      turnTokenUsage: {
        inputTokens: 50,
        outputTokens: 5,
        usageStatus: "partial",
        hasSubagents: false,
      },
    });
    addErr("c6", "c6");

    // Chat 7 outside top 5: zero-work unavailable quota-rejected wake with provider limit notice -> 0 uncertainStarts and 0 measured tokens.
    addTurn(
      "c7",
      "c7",
      {
        status: "failed",
        turnTokenUsage: { usageStatus: "unavailable" },
      },
      { createdBy: "agent", delegatedCompletion: { taskIds: ["x"] } },
    );
    addItem("c7", "c7", "assistant_message", {
      text: "You've hit your usage limit · resets 5pm UTC",
    });
    addErr("c7", "c7");

    const report = wakeReport(db, day);
    expect(report.chats.c7).toMatchObject({ wakes: 0, uncertainStarts: 0 });
    expect(report.topFive.reason).toBeUndefined();
    expect(report.topFiveByRecordedTurnTokens.map((r) => r.thread)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);

    // A quota-failed wake that streamed non-limit assistant prose with unavailable usage stays an uncertainStart.
    addTurn(
      "c7b",
      "c7b",
      {
        status: "failed",
        turnTokenUsage: { usageStatus: "unavailable" },
      },
      { createdBy: "agent", delegatedCompletion: { taskIds: ["y"] } },
    );
    addItem("c7b", "c7b", "assistant_message", { text: "Inspecting the failing test output now." });
    addErr("c7b", "c7b");
    expect(wakeReport(db, day).chats.c7b).toMatchObject({ wakes: 0, uncertainStarts: 1 });
    expect(wakeReport(db, day).topFive.decision).toBe("indeterminate");

    // Remove c7b so we can verify steered quota-partial and multi-attempt quota isolation independently.
    for (const tbl of ["turn_items", "messages", "provider_turns", "run_attempts", "runs"]) {
      db.prepare(`DELETE FROM orchestration_v2_projection_${tbl} WHERE thread_id='c7b'`).run();
    }
    expect(wakeReport(db, day).topFive.reason).toBeUndefined();

    // A quota-partial turn on a steered run outside top 5 stays unmeasured -> topFive indeterminate.
    db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?)").run(
      "c6-steer",
      "c6",
      "c6",
      "user",
      ts,
      JSON.stringify({ createdBy: "user" }),
    );
    expect(wakeReport(db, day).topFive.decision).toBe("indeterminate");
    db.prepare(
      "DELETE FROM orchestration_v2_projection_messages WHERE message_id='c6-steer'",
    ).run();
    expect(wakeReport(db, day).topFive.reason).toBeUndefined();

    // A non-quota failed attempt on another chat outside top 5 stays unmeasured even if a retry in the same run hits quota.
    addTurn("c8", "c8", {
      status: "failed",
      turnTokenUsage: { inputTokens: 10, outputTokens: 2, usageStatus: "partial" },
    });
    db.prepare("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?,?,?)").run(
      "c8-retry",
      "c8",
      "c8",
    );
    db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?,?,?,?,?)").run(
      "turn-c8-retry",
      "c8",
      "c8-retry",
      ts,
      JSON.stringify({ status: "failed", turnTokenUsage: { usageStatus: "unavailable" } }),
    );
    addErr("c8", "c8", "turn-c8-retry");
    expect(wakeReport(db, day).topFive.decision).toBe("indeterminate");
  } finally {
    db.close();
  }
});
