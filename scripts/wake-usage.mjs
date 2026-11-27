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

const NON_OBSERVING_TOOLS = [
  "t3_command_run",
  "delegate_task",
  "task_cancel",
  "orchestrator_capabilities",
  "list_scheduled_tasks",
  "schedule_task",
  "t3_environment_links",
  "t3_thread_send",
].flatMap((name) => [`t3-code.${name}`, `mcp__t3-code__${name}`]);

const SHELL_EOF_READ_CMD = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:cat|tail)\b/;
const TAIL_FOLLOW_FLAG = /\s(?:--follow(?:=\S*)?|-[A-Za-z]*f[A-Za-z]*)\b/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPathToken(segment, logPath) {
  const pathToken = new RegExp(`(?:^|[\\s"'\`=:(])${escapeRegex(logPath)}(?:$|[\\s"'\`):;&|<>])`);
  return pathToken.test(segment);
}

function redirectsStdout(segment) {
  return segment.replace(/(?:^|\s)2>>?(?:&\d+|\s*\S+)/g, "").includes(">");
}

function readsLogPath(type, payloadJson, logPath) {
  if (type !== "command_execution" || !logPath || !payloadJson.includes(logPath)) return false;
  const payload = JSON.parse(payloadJson);
  if (payload.exitCode !== 0 || typeof payload.input !== "string") return false;
  for (const segment of payload.input.split(/\r?\n|&&|\|\||;/)) {
    if (segment.includes("|") || redirectsStdout(segment)) continue;
    if (
      SHELL_EOF_READ_CMD.test(segment) &&
      !TAIL_FOLLOW_FLAG.test(segment) &&
      containsPathToken(segment, logPath)
    ) {
      return true;
    }
  }
  return false;
}

export function wakeReport(db, day) {
  const start = day + "T00:00:00.000Z";
  const since = Date.parse(start);
  if (!Number.isFinite(since) || new Date(since).toISOString() !== start) {
    throw new Error("Expected a UTC date in YYYY-MM-DD format");
  }
  const end = new Date(since + 86_400_000).toISOString();
  const turnItemColumns = new Set(
    db
      .prepare("PRAGMA table_info(orchestration_v2_projection_turn_items)")
      .all()
      .map((c) => c.name),
  );
  const providerTurnColumns = new Set(
    db
      .prepare("PRAGMA table_info(orchestration_v2_projection_provider_turns)")
      .all()
      .map((c) => c.name),
  );
  const hasTurnItems = turnItemColumns.size > 0;
  const hasProviderTurnId =
    turnItemColumns.has("provider_turn_id") && providerTurnColumns.has("provider_turn_id");
  const nonObservingToolSql = NON_OBSERVING_TOOLS.map((name) => `'${name}'`).join(",");
  const sameTurnFilter = (turnAlias) =>
    hasProviderTurnId ? `AND ti.provider_turn_id=${turnAlias}.provider_turn_id` : "";
  const sameOrUnscopedTurnFilter = (turnAlias) =>
    hasProviderTurnId
      ? `AND (ti.provider_turn_id=${turnAlias}.provider_turn_id OR ti.provider_turn_id IS NULL)`
      : "";
  const isQuotaError = (turnAlias, attemptAlias) =>
    `${attemptAlias}.run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM orchestration_v2_projection_turn_items ti
      WHERE ti.thread_id=${turnAlias}.thread_id AND ti.run_id=${attemptAlias}.run_id
        ${sameTurnFilter(turnAlias)}
        AND ti.type='error'
        AND (json_extract(ti.payload_json,'$.title')='Usage limit reached'
          OR json_extract(ti.payload_json,'$.failure.class')='usage_limit')
    )`;
  const isQuotaLimitNoticeText = `length(coalesce(json_extract(ti.payload_json,'$.text'),'')) <= 200
    AND instr(lower(coalesce(json_extract(ti.payload_json,'$.text'),'')),'limit') > 0
    AND (instr(lower(coalesce(json_extract(ti.payload_json,'$.text'),'')),'reset') > 0
      OR instr(lower(coalesce(json_extract(ti.payload_json,'$.text'),'')),'try again') > 0
      OR instr(lower(coalesce(json_extract(ti.payload_json,'$.text'),'')),'unavailable') > 0
      OR instr(lower(coalesce(json_extract(ti.payload_json,'$.text'),'')),'quota') > 0)`;
  const hasRunWorkItems = (turnAlias, attemptAlias) =>
    `EXISTS (
      SELECT 1 FROM orchestration_v2_projection_turn_items ti
      WHERE ti.thread_id=${turnAlias}.thread_id AND ti.run_id=${attemptAlias}.run_id
        ${sameOrUnscopedTurnFilter(turnAlias)}
        AND (ti.type NOT IN ('user_message','assistant_message','error','notification','system_notice','checkpoint','compaction')
          OR (ti.type='compaction' AND ti.status != 'failed')
          OR (ti.type='assistant_message'
            AND length(trim(coalesce(json_extract(ti.payload_json,'$.text'),''))) > 0
            AND NOT (${isQuotaLimitNoticeText})))
    )`;
  const isZeroWorkQuotaFailure = (turnAlias, attemptAlias) =>
    `json_extract(${turnAlias}.payload_json,'$.status')='failed'
      AND coalesce(json_extract(${turnAlias}.payload_json,'$.nativeWakeStarted'),0) != 1
      AND coalesce(json_extract(${turnAlias}.payload_json,'$.turnTokenUsage.inputTokens'),0)=0
      AND coalesce(json_extract(${turnAlias}.payload_json,'$.turnTokenUsage.outputTokens'),0)=0
      AND ${isQuotaError(turnAlias, attemptAlias)}
      AND NOT ${hasRunWorkItems(turnAlias, attemptAlias)}`;
  const isQuotaPartial = (turnAlias, attemptAlias) =>
    `json_extract(${turnAlias}.payload_json,'$.status')='failed'
      AND json_extract(${turnAlias}.payload_json,'$.turnTokenUsage.usageStatus')='partial'
      AND json_type(${turnAlias}.payload_json,'$.turnTokenUsage.inputTokens')='integer'
      AND json_type(${turnAlias}.payload_json,'$.turnTokenUsage.outputTokens')='integer'
      AND ${isQuotaError(turnAlias, attemptAlias)}`;

  const chats = new Map();
  const ranking = db
    .prepare(`
    SELECT thread_id, count(*) AS turns, sum(measured) AS measuredTurns, sum(tokens) AS tokens FROM (
      SELECT p.thread_id,
        CASE
          WHEN json_extract(p.payload_json,'$.turnTokenUsage.localCommand')=1 THEN 0
          WHEN json_type(p.payload_json,'$.turnTokenUsage.inputTokens')='integer'
            AND json_type(p.payload_json,'$.turnTokenUsage.outputTokens')='integer'
            AND coalesce(json_extract(p.payload_json,'$.turnTokenUsage.usageStatus'),'complete')='complete'
          THEN json_extract(p.payload_json,'$.turnTokenUsage.inputTokens') +
               json_extract(p.payload_json,'$.turnTokenUsage.outputTokens')
          ${
            hasTurnItems
              ? `WHEN ${isZeroWorkQuotaFailure("p", "a")} THEN 0
          WHEN ${isQuotaPartial("p", "a")}
          THEN json_extract(p.payload_json,'$.turnTokenUsage.inputTokens') +
               json_extract(p.payload_json,'$.turnTokenUsage.outputTokens')`
              : ""
          }
        END AS tokens,
        CASE
          WHEN json_extract(p.payload_json,'$.turnTokenUsage.localCommand')=1 THEN 1
          WHEN json_type(p.payload_json,'$.turnTokenUsage.inputTokens')='integer'
            AND json_type(p.payload_json,'$.turnTokenUsage.outputTokens')='integer'
            AND coalesce(json_extract(p.payload_json,'$.turnTokenUsage.usageStatus'),'complete')='complete'
          THEN 1
          ${
            hasTurnItems
              ? `WHEN ${isZeroWorkQuotaFailure("p", "a")} THEN 1
          WHEN ${isQuotaPartial("p", "a")}
            AND coalesce(json_extract(p.payload_json,'$.turnTokenUsage.hasSubagents'),0)=0
            AND json_type(p.payload_json,'$.turnTokenUsage.otherUsage') IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items ti
              WHERE ti.thread_id=p.thread_id AND ti.run_id=a.run_id
                ${sameOrUnscopedTurnFilter("p")}
                AND ti.type='compaction' AND ti.status != 'failed'
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_messages msg
              JOIN orchestration_v2_projection_runs pr ON pr.run_id=msg.run_id AND pr.thread_id=msg.thread_id
              WHERE msg.thread_id=p.thread_id AND msg.run_id=a.run_id
                AND msg.role='user' AND msg.message_id != json_extract(pr.payload_json,'$.userMessageId')
            )
          THEN 1`
              : ""
          }
          ELSE 0
        END AS measured
      FROM orchestration_v2_projection_provider_turns p
      LEFT JOIN orchestration_v2_projection_run_attempts a
        ON a.attempt_id=p.run_attempt_id AND a.thread_id=p.thread_id
      WHERE p.started_at >= ? AND p.started_at < ?
    ) GROUP BY thread_id ORDER BY tokens DESC, thread_id
  `)
    .all(start, end);
  for (const row of ranking) chats.set(row.thread_id, counts());
  const startEvidence = (alias, attemptAlias) => `CASE
    WHEN json_extract(${alias}.payload_json,'$.turnTokenUsage.localCommand')=1 THEN 0
    WHEN json_extract(${alias}.payload_json,'$.nativeWakeStarted')=1
      OR json_extract(${alias}.payload_json,'$.turnTokenUsage.outputTokens')>0 THEN 2
    WHEN json_extract(${alias}.payload_json,'$.nativeWakeStarted')=0 THEN 0
    ${hasTurnItems && attemptAlias ? `WHEN ${isZeroWorkQuotaFailure(alias, attemptAlias)} THEN 0` : ""}
    ELSE 1 END`;
  const wakes = db.prepare(`
    SELECT r.run_id, p.thread_id, p.started_at, p.rowid AS turnRow,
      ${startEvidence("p", "a")} AS evidence, json_extract(m.payload_json,'$.delegatedCompletion.taskIds') AS tasks, json_extract(m.payload_json,'$.notification.wakeEventIds') AS identities, json_extract(m.payload_json,'$.notification.previouslyHandledWakeEventIds') AS handledIds
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
        ORDER BY ${startEvidence("t", "b")} DESC,t.started_at,t.rowid LIMIT 1)
  `);
  const observed = db.prepare(`
    SELECT 1 FROM orchestration_v2_projection_subagents s JOIN orchestration_v2_projection_runs r
      ON r.thread_id=s.thread_id AND r.run_id=coalesce(json_extract(s.payload_json,'$.terminalResultObservation.runId'),json_extract(s.payload_json,'$.completionDelivery.observedByRunId'))
    WHERE s.subagent_id=? AND s.thread_id=? AND r.run_id != ? AND coalesce(json_extract(s.payload_json,'$.terminalResultObservation.at'),s.updated_at) < ?
      AND (json_type(s.payload_json,'$.terminalResultObservation.at')='text' OR json_extract(s.payload_json,'$.completionDelivery.state')='acknowledged')
  `);
  const subagentLog = db.prepare(`
    SELECT json_extract(payload_json,'$.completedAt') AS completedAt,
      json_extract(payload_json,'$.command.logPath') AS logPath
    FROM orchestration_v2_projection_subagents
    WHERE subagent_id=? AND thread_id=?
      AND json_extract(payload_json,'$.status') IN ('completed','failed','cancelled','interrupted')
      AND json_type(payload_json,'$.completedAt')='text'
      AND json_type(payload_json,'$.command.logPath')='text'
  `);
  const logReadCandidates = hasTurnItems
    ? db.prepare(`
      SELECT ti.type, ti.payload_json
      FROM orchestration_v2_projection_turn_items ti
      WHERE ti.thread_id=? AND ti.run_id != ? AND ti.status='completed'
        AND ti.type='command_execution'
        AND instr(ti.payload_json, ?) > 0
        AND json_extract(ti.payload_json,'$.startedAt') >= ?
        AND coalesce(json_extract(ti.payload_json,'$.completedAt'), ti.updated_at) < ?
    `)
    : null;
  // A terminal result arriving while no other active turn could observe it could not have been handled by that chat.
  const priorMayObserve = hasTurnItems
    ? `AND NOT (
        prior.started_at < json_extract(s.payload_json,'$.completedAt')
        AND json_type(prior.payload_json,'$.completedAt')='text'
        AND priorAttempt.run_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items ti
          WHERE ti.thread_id=s.thread_id AND ti.run_id=priorAttempt.run_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages msg
          JOIN orchestration_v2_projection_runs pr ON pr.run_id=msg.run_id AND pr.thread_id=msg.thread_id
          WHERE msg.thread_id=s.thread_id AND msg.run_id=priorAttempt.run_id
            AND msg.role='user' AND msg.created_at >= json_extract(s.payload_json,'$.completedAt')
            AND msg.message_id != json_extract(pr.payload_json,'$.userMessageId')
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items ti
          WHERE ti.thread_id=s.thread_id AND ti.run_id=priorAttempt.run_id
            AND coalesce(
              json_extract(ti.payload_json,'$.completedAt'),
              CASE WHEN ti.status IN ('completed','failed','cancelled','interrupted')
                THEN ti.updated_at ELSE json_extract(prior.payload_json,'$.completedAt') END
            ) >= json_extract(s.payload_json,'$.completedAt')
            AND ti.type NOT IN ('assistant_message','reasoning','checkpoint','proposed_plan')
            AND NOT (ti.type='subagent' AND json_extract(ti.payload_json,'$.origin')='app_owned')
            AND NOT (ti.type IN ('notification','user_message') AND coalesce(json_extract(ti.payload_json,'$.startedAt'), ti.updated_at) <= prior.started_at)
            AND NOT (
              ti.type='dynamic_tool'
              AND json_extract(ti.payload_json,'$.toolName') IN (${nonObservingToolSql})
              AND instr(ti.payload_json, s.subagent_id)=0
              AND instr(ti.payload_json, replace(s.subagent_id,'node:delegated-task:',''))=0
            )
        )
      )`
    : "";
  const fresh = db.prepare(`
    SELECT 1 FROM orchestration_v2_projection_subagents s
    WHERE s.subagent_id=? AND s.thread_id=? AND json_extract(s.payload_json,'$.completedAt') < ?
      AND json_extract(s.payload_json,'$.status') IN ('completed','failed','cancelled','interrupted')
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_turns prior
        LEFT JOIN orchestration_v2_projection_run_attempts priorAttempt
          ON priorAttempt.attempt_id=prior.run_attempt_id AND priorAttempt.thread_id=prior.thread_id
        WHERE prior.thread_id=s.thread_id AND prior.rowid != ? AND prior.started_at <= ?
          AND ${startEvidence("prior", "priorAttempt")} > 0
          AND (json_extract(prior.payload_json,'$.completedAt') IS NULL
            OR json_extract(prior.payload_json,'$.completedAt') >= json_extract(s.payload_json,'$.completedAt'))
          ${priorMayObserve}
      )
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
        if (logReadCandidates) {
          const logMeta = subagentLog.get(id, row.thread_id);
          if (logMeta && logMeta.completedAt < row.started_at) {
            for (const candidate of logReadCandidates.iterate(
              row.thread_id,
              row.run_id,
              logMeta.logPath,
              logMeta.completedAt,
              row.started_at,
            )) {
              if (readsLogPath(candidate.type, candidate.payload_json, logMeta.logPath)) {
                return "repeated";
              }
            }
          }
        }
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
