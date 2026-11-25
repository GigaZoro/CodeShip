import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

function counts() {
  return { wakes: 0, repeated: 0, unknown: 0, fresh: 0, uncertainStarts: 0 };
}

export function decision(count) {
  const { wakes, repeated, unknown } = count;
  const possible = wakes + (count.uncertainStarts ?? 0);
  const lower = repeated / possible;
  const upper = (repeated + unknown + (count.uncertainStarts ?? 0)) / possible;
  return {
    ...count,
    shareBounds: possible ? [lower, upper] : null,
    decisionThreshold: 0.1,
    decision: lower >= 0.1 ? "met" : upper < 0.1 ? "below" : "indeterminate",
  };
}

function combined(rows) {
  const sum = counts();
  for (const row of rows) {
    for (const key of Object.keys(sum)) sum[key] += row[key];
  }
  return decision(sum);
}

export function wakeReport(db, day) {
  const start = day + "T00:00:00.000Z";
  const since = Date.parse(start);
  if (!Number.isFinite(since) || new Date(since).toISOString() !== start) {
    throw new Error("Expected a UTC date in YYYY-MM-DD format");
  }
  const end = new Date(since + 86_400_000).toISOString();
  const chats = new Map();
  const ranking = db
    .prepare(`
    SELECT thread_id, count(*) AS turns, count(tokens) AS measuredTurns, sum(tokens) AS tokens FROM (
      SELECT thread_id, CASE WHEN json_extract(payload_json,'$.turnTokenUsage.localCommand')=1 THEN 0
        WHEN json_type(payload_json,'$.turnTokenUsage.inputTokens')='integer'
        AND json_type(payload_json,'$.turnTokenUsage.outputTokens')='integer'
        AND coalesce(json_extract(payload_json,'$.turnTokenUsage.usageStatus'),'complete')='complete'
        THEN json_extract(payload_json,'$.turnTokenUsage.inputTokens') +
             json_extract(payload_json,'$.turnTokenUsage.outputTokens') END AS tokens
      FROM orchestration_v2_projection_provider_turns WHERE started_at >= ? AND started_at < ?
    ) GROUP BY thread_id ORDER BY tokens DESC, thread_id
  `)
    .all(start, end);
  for (const row of ranking) chats.set(row.thread_id, counts());
  const startEvidence = (alias) => `CASE
    WHEN json_extract(${alias}.payload_json,'$.turnTokenUsage.localCommand')=1 THEN 0
    WHEN json_extract(${alias}.payload_json,'$.nativeWakeStarted')=1
      OR json_extract(${alias}.payload_json,'$.turnTokenUsage.outputTokens')>0 THEN 2
    WHEN json_extract(${alias}.payload_json,'$.nativeWakeStarted')=0 THEN 0 ELSE 1 END`;
  const wakes = db.prepare(`
    SELECT r.run_id, p.thread_id, p.started_at, p.rowid AS turnRow,
      ${startEvidence("p")} AS evidence, json_extract(m.payload_json,'$.delegatedCompletion.taskIds') AS tasks, json_extract(m.payload_json,'$.notification.wakeEventIds') AS identities, json_extract(m.payload_json,'$.notification.previouslyHandledWakeEventIds') AS handledIds
    FROM orchestration_v2_projection_provider_turns p
    JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=p.run_attempt_id AND a.thread_id=p.thread_id
    JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id AND r.thread_id=p.thread_id
    JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId')
      AND m.thread_id=r.thread_id AND m.run_id=r.run_id
    WHERE p.started_at >= ? AND p.started_at < ? AND m.role='user'
      AND json_extract(m.payload_json,'$.createdBy')='agent'
      AND (json_type(m.payload_json,'$.notification')='object' OR json_type(m.payload_json,'$.delegatedCompletion')='object')
      AND p.rowid=(SELECT t.rowid FROM orchestration_v2_projection_run_attempts b
        JOIN orchestration_v2_projection_provider_turns t ON t.run_attempt_id=b.attempt_id AND t.thread_id=b.thread_id
        WHERE b.run_id=r.run_id AND b.thread_id=r.thread_id AND t.started_at IS NOT NULL
        ORDER BY ${startEvidence("t")} DESC,t.started_at,t.rowid LIMIT 1)
  `);
  const observed = db.prepare(`
    SELECT 1 FROM orchestration_v2_projection_subagents s JOIN orchestration_v2_projection_runs r
      ON r.thread_id=s.thread_id AND r.run_id=coalesce(json_extract(s.payload_json,'$.terminalResultObservation.runId'),json_extract(s.payload_json,'$.completionDelivery.observedByRunId'))
    WHERE s.subagent_id=? AND s.thread_id=? AND r.run_id != ? AND coalesce(json_extract(s.payload_json,'$.terminalResultObservation.at'),s.updated_at) < ?
      AND (json_type(s.payload_json,'$.terminalResultObservation.at')='text' OR json_extract(s.payload_json,'$.completionDelivery.state')='acknowledged')
  `);
  // A terminal result arriving while the chat had no other active provider turn could not have been handled by that chat.
  const fresh = db.prepare(`
    SELECT 1 FROM orchestration_v2_projection_subagents s
    WHERE s.subagent_id=? AND s.thread_id=? AND json_extract(s.payload_json,'$.completedAt') < ?
      AND json_extract(s.payload_json,'$.status') IN ('completed','failed','cancelled','interrupted')
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_turns prior
        WHERE prior.thread_id=s.thread_id AND prior.rowid != ? AND prior.started_at <= ? AND ${startEvidence("prior")} > 0
        AND (json_extract(prior.payload_json,'$.completedAt') IS NULL
          OR json_extract(prior.payload_json,'$.completedAt') >= json_extract(s.payload_json,'$.completedAt')))
  `);
  let wakesWithEventIdentity = 0;
  for (const row of wakes.iterate(start, end)) {
    const chat = chats.get(row.thread_id);
    if (row.evidence === 0) continue;
    if (row.evidence === 1) {
      chat.uncertainStarts++;
      continue;
    }
    chat.wakes++;
    const tasks = JSON.parse(row.tasks);
    const eventIds = JSON.parse(row.identities) ?? [];
    const handledIds = new Set(JSON.parse(row.handledIds));
    if (tasks?.length || eventIds.length) wakesWithEventIdentity++;
    if (tasks?.length) {
      const members = tasks.map((id) => {
        if (observed.get(id, row.thread_id, row.run_id, row.started_at)) return "repeated";
        if (fresh.get(id, row.thread_id, row.started_at, row.turnRow, row.started_at))
          return "fresh";
        return "unknown";
      });
      if (members.every((status) => status === "repeated")) chat.repeated++;
      else if (members.includes("fresh")) chat.fresh++;
      else chat.unknown++;
    } else if (eventIds.length && eventIds.every((id) => handledIds.has(id))) chat.repeated++;
    else chat.unknown++;
  }
  const { inRunDeliveries } = db
    .prepare(`
    SELECT count(*) AS inRunDeliveries FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_runs r ON r.run_id=m.run_id AND r.thread_id=m.thread_id
    WHERE m.created_at >= ? AND m.created_at < ? AND m.role='user' AND json_extract(m.payload_json,'$.createdBy')='agent'
      AND m.message_id != json_extract(r.payload_json,'$.userMessageId')
      AND (json_type(m.payload_json,'$.notification')='object' OR json_type(m.payload_json,'$.delegatedCompletion')='object')
  `)
    .get(start, end);
  const topFiveByRecordedTurnTokens = ranking
    .filter((row) => ranking.length <= 5 || row.tokens !== null)
    .slice(0, 5)
    .map((row) => ({
      thread: row.thread_id,
      tokens: row.tokens,
      ...decision(chats.get(row.thread_id)),
    }));
  const topIds = new Set(topFiveByRecordedTurnTokens.map((row) => row.thread));
  const uncertainRanking = ranking.some(
    (row) => row.measuredTurns < row.turns && !topIds.has(row.thread_id),
  );
  const recordedTopFive = combined(topFiveByRecordedTurnTokens);
  return {
    day,
    basis:
      "First confirmed model start per notification-started run. Unobserved handling is unknown.",
    all: combined(chats.values()),
    topFive: uncertainRanking
      ? {
          decision: "indeterminate",
          decisionThreshold: 0.1,
          shareBounds: null,
          reason: "missing usage could change membership",
        }
      : recordedTopFive,
    recordedTopFive,
    topFiveByRecordedTurnTokens,
    rankingCoverage: {
      totalTurns: ranking.reduce((n, r) => n + r.turns, 0),
      turnsWithTokens: ranking.reduce((n, r) => n + r.measuredTurns, 0),
    },
    wakesWithEventIdentity,
    inRunDeliveries,
    chats: Object.fromEntries(Array.from(chats, ([id, c]) => [id, decision(c)])),
  };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const [file, day] = args;
  if (args.length !== 2 || !file || !day)
    throw new Error("Usage: node scripts/wake-usage.mjs <statev2.sqlite> <YYYY-MM-DD UTC>");
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    console.log(JSON.stringify(wakeReport(db, day)));
  } finally {
    db.close();
  }
}
