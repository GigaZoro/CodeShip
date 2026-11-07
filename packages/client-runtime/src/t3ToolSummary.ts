import { t, tn } from "@t3tools/shared/i18n";
import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

export interface T3ToolSummaryCall {
  readonly input: unknown;
  readonly output: unknown;
  readonly outcome: "completed" | "failed" | "unfinished";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface ToolResult {
  readonly data?: Record<string, unknown>;
  readonly failed: boolean;
}

function readResult(value: unknown, depth = 0): ToolResult {
  if (depth > 4) return { failed: false };
  if (typeof value === "string") {
    try {
      return readResult(JSON.parse(value), depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    let data: ToolResult["data"];
    let failed = false;
    for (const block of value) {
      const record = asRecord(block);
      const text = record?.text ?? asRecord(record?.content)?.text;
      const result = readResult(asRecord(text)?.text ?? text, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data ? { data } : {}), failed };
  }
  const record = asRecord(value);
  if (!record) return { failed: false };
  const failed =
    record.isError === true ||
    record.is_error === true ||
    (typeof record._tag === "string" && /(?:Error|Failure)$/.test(record._tag)) ||
    record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const result = readResult(content, depth + 1);
    return { ...(result.data ? { data: result.data } : {}), failed: failed || result.failed };
  }
  return { data: record, failed };
}

function readInput(value: unknown): Record<string, unknown> | undefined {
  const input = readResult(value).data;
  // Historical Cursor items retain the MCP args envelope.
  return input && typeof input.toolName === "string" ? asRecord(input.args) : input;
}

/** MCP errors can be returned as data even when the provider completed the tool call. */
export function t3ToolResultIndicatesFailure(output: unknown): boolean {
  return readResult(output).failed;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

/** One PR per single call; a batch counts what its result reports. */
function pullRequestQuantity(
  calls: ReadonlyArray<{
    readonly input: Record<string, unknown> | undefined;
    readonly output: Record<string, unknown> | undefined;
  }>,
  countKey: "linkedCount" | "unlinkedCount",
): string {
  let count = 0;
  for (const call of calls) {
    const reported = call.output?.[countKey];
    if (typeof reported === "number") count += reported;
    else if (call.input?.url !== undefined || call.input?.number !== undefined) count += 1;
    // A batch result too large to compact loses its count, so the label drops the number.
    else return t("pull requests");
  }
  return tn(count, "{count} pull request", "{count} pull requests");
}

export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
): { label: string; failedCount: number } {
  const results = calls.map((call) => {
    const result = readResult(call.output);
    return {
      input: readInput(call.input),
      output: result.data,
      outcome: result.failed ? ("failed" as const) : call.outcome,
    };
  });
  const completed = results.filter((call) => call.outcome === "completed");
  let failedCount = results.filter((call) => call.outcome === "failed").length;
  const selected = completed.length > 0 ? completed : results;
  const times = tn(selected.length, "{count} time", "{count} times");
  const phrase = (past: string, infinitive: string, object: string) =>
    completed.length > 0
      ? t("{past} {object}", { past, object })
      : t("Tried to {infinitive} {object}", { infinitive, object });
  const entityIds = (key: string) =>
    selected.map((call) => id(call.output?.[key]) ?? id(call.input?.[key]));
  const projectIds = selected.map(
    (call) => id(call.output?.id) ?? id(call.output?.projectId) ?? id(call.input?.projectId),
  );
  const threadIds = selected.map(
    (call) =>
      id(call.output?.threadId) ??
      id(asRecord(call.output?.thread)?.threadId) ??
      id(call.input?.threadId),
  );
  let label: string;
  switch (action) {
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const targetsKnown = threadIds.every((value) => value !== undefined);
      const threads = new Set(threadIds).size;
      const object = targetsKnown
        ? messages === threads && messages > 1
          ? t("messages to {threads}", {
              threads: tn(threads, "{count} thread", "{count} threads"),
            })
          : t("{messages} to {threads}", {
              messages: tn(messages, "{count} message", "{count} messages"),
              threads: tn(threads, "{count} thread", "{count} threads"),
            })
        : tn(messages, "{count} message", "{count} messages");
      label = phrase(t("Sent"), t("send"), object);
      break;
    }
    case "thread-create": {
      const createdIds: string[] = [];
      const resultsKnown =
        completed.length > 0 &&
        completed.every((call) => {
          const threads = Array.isArray(call.output?.threads) ? call.output.threads : [call.output];
          return threads.every((thread) => {
            const record = asRecord(thread);
            if (record?.status === "rolled_back") return true;
            const threadId = id(record?.threadId);
            if (!threadId) return false;
            createdIds.push(threadId);
            return true;
          });
        });
      label = resultsKnown
        ? tn(new Set(createdIds).size, "Created {count} thread", "Created {count} threads")
        : t("Requested thread creation {times}", { times });
      break;
    }
    case "delegate":
      label = phrase(
        t("Delegated"),
        t("delegate"),
        tn(countEntities(entityIds("taskId")), "{count} task", "{count} tasks"),
      );
      break;
    case "thread-read":
    case "thread-wait": {
      const targets = threadIds.every((value) => value !== undefined)
        ? tn(new Set(threadIds).size, "{count} thread", "{count} threads")
        : t("threads {times}", { times });
      label =
        action === "thread-read"
          ? phrase(t("Read"), t("read"), targets)
          : phrase(t("Waited on"), t("wait on"), targets);
      break;
    }
    case "thread-list":
      label = phrase(t("Listed"), t("list"), t("threads {times}", { times }));
      break;
    case "thread-interrupt":
      label = phrase(
        t("Requested interrupts for"),
        t("interrupt"),
        tn(countEntities(threadIds), "{count} thread", "{count} threads"),
      );
      break;
    case "workflow-stop":
      label = phrase(
        t("Requested stops for"),
        t("stop"),
        tn(countEntities(entityIds("subagentId")), "{count} workflow", "{count} workflows"),
      );
      break;
    case "task-status":
      label = phrase(t("Checked"), t("check"), t("task status {times}", { times }));
      break;
    case "background-wait":
      label = phrase(t("Updated"), t("update"), t("background waits {times}", { times }));
      break;
    case "task-cancel":
      label = phrase(
        t("Requested cancellation of"),
        t("cancel"),
        tn(countEntities(entityIds("taskId")), "{count} task", "{count} tasks"),
      );
      break;
    case "schedule-create":
      label = phrase(
        t("Scheduled"),
        t("schedule"),
        tn(countEntities(entityIds("scheduledTaskId")), "{count} task", "{count} tasks"),
      );
      break;
    case "schedule-list":
      label = phrase(t("Listed"), t("list"), t("scheduled tasks {times}", { times }));
      break;
    case "schedule-update":
      label = phrase(
        t("Updated"),
        t("update"),
        tn(
          countEntities(entityIds("scheduledTaskId")),
          "{count} scheduled task",
          "{count} scheduled tasks",
        ),
      );
      break;
    case "schedule-delete":
      label = phrase(
        t("Requested deletion of"),
        t("delete"),
        tn(
          countEntities(entityIds("scheduledTaskId")),
          "{count} scheduled task",
          "{count} scheduled tasks",
        ),
      );
      break;
    case "schedule-run":
      label = phrase(
        t("Requested"),
        t("request"),
        tn(selected.length, "{count} scheduled task run", "{count} scheduled task runs"),
      );
      break;
    case "thread-configuration":
      label = phrase(t("Checked"), t("check"), t("thread configuration {times}", { times }));
      break;
    case "thread-configure":
      label = phrase(t("Set"), t("set"), t("thread model {times}", { times }));
      break;
    case "thread-fork":
      label = phrase(
        t("Requested"),
        t("request"),
        tn(selected.length, "{count} thread fork", "{count} thread forks"),
      );
      break;
    case "thread-merge":
      label = phrase(
        t("Requested"),
        t("request"),
        tn(selected.length, "{count} context merge", "{count} context merges"),
      );
      break;
    case "thread-search":
      label = phrase(t("Searched"), t("search"), t("threads {times}", { times }));
      break;
    case "thread-transfers":
      label = phrase(t("Checked"), t("check"), t("thread transfers {times}", { times }));
      break;
    case "thread-organize":
      label = phrase(t("Organized"), t("organize"), t("threads {times}", { times }));
      break;
    case "thread-update":
      label = phrase(
        t("Updated"),
        t("update"),
        tn(countEntities(threadIds), "{count} thread", "{count} threads"),
      );
      break;
    case "queue-list":
      label = phrase(t("Listed"), t("list"), t("queued messages {times}", { times }));
      break;
    case "queue-read":
      label = phrase(
        t("Read"),
        t("read"),
        tn(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
        ),
      );
      break;
    case "queue-edit":
      label = phrase(
        t("Edited"),
        t("edit"),
        tn(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
        ),
      );
      break;
    case "queue-cancel":
      label = phrase(
        t("Requested cancellation of"),
        t("cancel"),
        tn(countEntities(entityIds("queuedRunId")), "{count} queued run", "{count} queued runs"),
      );
      break;
    case "queue-reorder":
      label = phrase(
        t("Reordered"),
        t("reorder"),
        tn(countEntities(entityIds("queuedRunId")), "{count} queued run", "{count} queued runs"),
      );
      break;
    case "queue-steer":
      label = phrase(
        t("Requested steering with"),
        t("steer with"),
        tn(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
        ),
      );
      break;
    case "question-list":
      label = phrase(t("Listed"), t("list"), t("pending questions {times}", { times }));
      break;
    case "question-read":
      label = phrase(
        t("Read"),
        t("read"),
        tn(
          countEntities(entityIds("requestId")),
          "{count} pending question request",
          "{count} pending question requests",
        ),
      );
      break;
    case "question-respond":
      label = phrase(
        t("Answered"),
        t("answer"),
        tn(
          countEntities(entityIds("requestId")),
          "{count} pending question request",
          "{count} pending question requests",
        ),
      );
      break;
    case "question-ask": {
      const questions = selected.reduce((total, call) => {
        const asked = call.input?.questions;
        return total + (Array.isArray(asked) ? asked.length : 1);
      }, 0);
      label = phrase(t("Asked"), t("ask"), tn(questions, "{count} question", "{count} questions"));
      break;
    }
    case "secret-request":
      label = phrase(
        t("Asked for"),
        t("ask for"),
        tn(selected.length, "{count} secret", "{count} secrets"),
      );
      break;
    case "worktree-handoff":
      label = phrase(
        t("Handed off to"),
        t("hand off to"),
        tn(countEntities(entityIds("worktreePath")), "{count} worktree", "{count} worktrees"),
      );
      break;
    case "worktree-list":
      label = phrase(t("Listed"), t("list"), t("workspace branches {times}", { times }));
      break;
    case "worktree-status":
      label = phrase(t("Checked"), t("check"), t("worktree status {times}", { times }));
      break;
    case "project-list":
      label = phrase(t("Listed"), t("list"), t("projects {times}", { times }));
      break;
    case "project-read":
      label = phrase(
        t("Read"),
        t("read"),
        tn(countEntities(projectIds), "{count} project", "{count} projects"),
      );
      break;
    case "project-create":
      label = phrase(
        t("Registered"),
        t("register"),
        tn(countEntities(projectIds), "{count} project", "{count} projects"),
      );
      break;
    case "project-update":
      label = phrase(
        t("Updated"),
        t("update"),
        tn(countEntities(projectIds), "{count} project", "{count} projects"),
      );
      break;
    case "project-delete":
      label = phrase(
        t("Deleted"),
        t("delete"),
        tn(countEntities(projectIds), "{count} project", "{count} projects"),
      );
      break;
    case "project-clone":
      label = phrase(
        t("Cloned"),
        t("clone"),
        tn(countEntities(entityIds("cwd")), "{count} repository", "{count} repositories"),
      );
      break;
    case "environment-read":
      label = phrase(t("Checked"), t("check"), t("environment preferences {times}", { times }));
      break;
    case "environment-update":
      label = phrase(t("Updated"), t("update"), t("environment preferences {times}", { times }));
      break;
    case "environment-links":
      label = phrase(t("Listed"), t("list"), t("linked environments {times}", { times }));
      break;
    case "environment-link":
      label = phrase(
        t("Asked to link"),
        t("ask to link"),
        tn(selected.length, "{count} environment", "{count} environments"),
      );
      break;
    case "environment-unlink":
      label = phrase(
        t("Forgot"),
        t("forget"),
        tn(
          countEntities(entityIds("environmentId")),
          "{count} linked environment",
          "{count} linked environments",
        ),
      );
      break;
    case "attachment-prepare":
      label = phrase(
        t("Prepared"),
        t("prepare"),
        tn(
          countEntities(entityIds("attachmentId")),
          "{count} attachment upload",
          "{count} attachment uploads",
        ),
      );
      break;
    case "attachment-discard":
      label = phrase(
        t("Discarded"),
        t("discard"),
        tn(
          countEntities(entityIds("attachmentId")),
          "{count} pending attachment",
          "{count} pending attachments",
        ),
      );
      break;
    case "attachment-send": {
      const messages = new Map<string, (typeof selected)[number]>();
      selected.forEach((call, index) =>
        messages.set(id(call.output?.messageId) ?? `call-${index}`, call),
      );
      const attachmentCount = [...messages.values()].reduce(
        (count, call) =>
          count + (Array.isArray(call.input?.attachments) ? call.input.attachments.length : 0),
        0,
      );
      const countsKnown = [...messages.values()].every(
        (call) => Array.isArray(call.input?.attachments) && call.input.attachments.length > 0,
      );
      const targets = threadIds.every((value) => value !== undefined)
        ? tn(new Set(threadIds).size, " to {count} thread", " to {count} threads")
        : "";
      label = phrase(
        t("Sent"),
        t("send"),
        countsKnown
          ? t("{attachments}{targets}", {
              attachments: tn(attachmentCount, "{count} attachment", "{count} attachments"),
              targets,
            })
          : t("attachments{targets} {times}", { targets, times }),
      );
      break;
    }
    case "link-pr":
      label = phrase(t("Linked"), t("link"), pullRequestQuantity(selected, "linkedCount"));
      break;
    case "unlink-pr":
      label = phrase(t("Unlinked"), t("unlink"), pullRequestQuantity(selected, "unlinkedCount"));
      break;
    case "watch-pr":
      label = phrase(
        t("Watching"),
        t("watch"),
        tn(selected.length, "{count} pull request", "{count} pull requests"),
      );
      break;
    case "unwatch-pr":
      label = phrase(
        t("Stopped watching"),
        t("stop watching"),
        tn(selected.length, "{count} pull request", "{count} pull requests"),
      );
      break;
    case "list-prs":
      label = phrase(
        t("Checked"),
        t("check"),
        selected.length === 1
          ? t("linked pull requests")
          : t("linked pull requests {times}", { times }),
      );
      break;
    case "write-pr-guides": {
      // One call writes many guides, and reports a refusal per guide rather than failing.
      const outcomes = selected.flatMap((call) =>
        Array.isArray(call.output?.guides)
          ? call.output.guides.map((guide) => asRecord(guide)?.outcome)
          : [],
      );
      const started = outcomes.filter((outcome) => outcome !== "failed").length;
      const failed = outcomes.length - started;
      failedCount += failed;
      if (outcomes.length === 0) {
        label = phrase(
          t("Started writing"),
          t("start writing"),
          selected.length === 1 ? t("review guides") : t("review guides {times}", { times }),
        );
      } else if (started === 0) {
        label = tn(
          failed,
          "Could not start {count} review guide",
          "Could not start {count} review guides",
        );
      } else {
        label = phrase(
          t("Started"),
          t("start"),
          failed > 0
            ? t("{guides}, {failed} failed", {
                guides: tn(started, "{count} review guide", "{count} review guides"),
                failed,
              })
            : tn(started, "{count} review guide", "{count} review guides"),
        );
      }
      break;
    }
    case "read-pr-guide":
      label = phrase(
        t("Read"),
        t("read"),
        tn(selected.length, "{count} review guide", "{count} review guides"),
      );
      break;
    case "browser":
      label = phrase(t("Used"), t("use"), t("browser {times}", { times }));
      break;
    case "device":
      label = phrase(t("Used"), t("use"), t("device controls {times}", { times }));
      break;
    case "terminal":
      label = phrase(t("Read"), t("read"), t("terminal output {times}", { times }));
      break;
    case "terminal-write":
      label = phrase(t("Typed"), t("type"), t("in a terminal {times}", { times }));
      break;
    case "visual-studio":
      label = phrase(t("Used"), t("use"), t("the Visual Studio debugger {times}", { times }));
      break;
    case "html-preview":
      label = phrase(
        t("Previewed"),
        t("preview"),
        tn(selected.length, "{count} HTML page", "{count} HTML pages"),
      );
      break;
    case "html-render":
      label = phrase(
        t("Rendered"),
        t("render"),
        tn(selected.length, "{count} HTML page", "{count} HTML pages"),
      );
      break;
    case "capabilities":
      label = phrase(t("Checked"), t("check"), t("orchestration capabilities {times}", { times }));
      break;
  }
  return { label, failedCount };
}
