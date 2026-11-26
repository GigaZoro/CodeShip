import { msg, t, tn } from "@t3tools/shared/i18n";
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

// A row's static past-tense verb ("Opened a pull request") is wrong when the call reports another outcome.
export function t3ToolOutcomeLabel(
  action: T3McpToolSummaryAction,
  call: T3ToolSummaryCall,
  resolve: typeof t = t,
): string | undefined {
  if (
    action !== "create-pr" &&
    action !== "merge-pr" &&
    action !== "write-pr-guides" &&
    action !== "ci-rerun"
  ) {
    return undefined;
  }
  const output = readResult(call.output).data;
  const contradicted =
    action === "create-pr"
      ? output?.created === false
      : action === "merge-pr"
        ? output?.state === undefined
          ? readInput(call.input)?.auto === true
          : output.state !== "merged"
        : action === "write-pr-guides"
          ? Array.isArray(output?.guides) &&
            output.guides.some((guide) => asRecord(guide)?.outcome === "failed")
          : Array.isArray(output?.checks) &&
            (output.checks.length === 0 ||
              output.checks.some((check) => asRecord(check)?.rerun !== true));
  return contradicted ? summarizeT3ToolCalls(action, [call], resolve).label : undefined;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

/** One PR per single call; a batch counts what its result reports. Null when a count was lost. */
function pullRequestCount(
  calls: ReadonlyArray<{
    readonly input: Record<string, unknown> | undefined;
    readonly output: Record<string, unknown> | undefined;
  }>,
  countKey: "linkedCount" | "unlinkedCount",
): number | null {
  let count = 0;
  for (const call of calls) {
    const reported = call.output?.[countKey];
    if (typeof reported === "number") count += reported;
    else if (call.input?.url !== undefined || call.input?.number !== undefined) count += 1;
    // A batch result too large to compact loses its count, so the label drops the number.
    else return null;
  }
  return count;
}

export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
  resolve: typeof t = t,
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
  const done = completed.length > 0;
  const selected = done ? completed : results;
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
    case "command-run": {
      const count = countEntities(entityIds("taskId"));
      label = done
        ? tn(count, "Started {count} command", "Started {count} commands")
        : tn(count, "Tried to start {count} command", "Tried to start {count} commands");
      break;
    }
    case "queue-resume": {
      const count = countEntities(threadIds);
      label = done
        ? tn(count, "Resumed {count} held queue", "Resumed {count} held queues")
        : tn(count, "Tried to resume {count} held queue", "Tried to resume {count} held queues");
      break;
    }
    case "question-ask": {
      const count = selected.reduce((total, call) => {
        const asked = call.input?.questions;
        return total + (Array.isArray(asked) ? asked.length : 1);
      }, 0);
      label = done
        ? tn(count, "Asked {count} question", "Asked {count} questions")
        : tn(count, "Tried to ask {count} question", "Tried to ask {count} questions");
      break;
    }
    case "terminal": {
      const count = selected.length;
      label = done
        ? tn(count, "Read terminal output {count} time", "Read terminal output {count} times")
        : tn(
            count,
            "Tried to read terminal output {count} time",
            "Tried to read terminal output {count} times",
          );
      break;
    }
    case "terminal-write": {
      const count = selected.length;
      label = done
        ? tn(count, "Typed in a terminal {count} time", "Typed in a terminal {count} times")
        : tn(
            count,
            "Tried to type in a terminal {count} time",
            "Tried to type in a terminal {count} times",
          );
      break;
    }
    case "visual-studio": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Used the Visual Studio debugger {count} time",
            "Used the Visual Studio debugger {count} times",
          )
        : tn(
            count,
            "Tried to use the Visual Studio debugger {count} time",
            "Tried to use the Visual Studio debugger {count} times",
          );
      break;
    }
    case "delegate": {
      const count = countEntities(entityIds("taskId"));
      label = done
        ? tn(count, "Delegated {count} task", "Delegated {count} tasks")
        : tn(count, "Tried to delegate {count} task", "Tried to delegate {count} tasks");
      break;
    }
    case "thread-interrupt": {
      const count = countEntities(threadIds);
      label = done
        ? tn(
            count,
            "Requested interrupts for {count} thread",
            "Requested interrupts for {count} threads",
          )
        : tn(count, "Tried to interrupt {count} thread", "Tried to interrupt {count} threads");
      break;
    }
    case "workflow-stop": {
      const count = countEntities(entityIds("subagentId"));
      label = done
        ? tn(count, "Requested stops for {count} workflow", "Requested stops for {count} workflows")
        : tn(count, "Tried to stop {count} workflow", "Tried to stop {count} workflows");
      break;
    }
    case "task-cancel": {
      const count = countEntities(entityIds("taskId"));
      label = done
        ? tn(
            count,
            "Requested cancellation of {count} task",
            "Requested cancellation of {count} tasks",
          )
        : tn(count, "Tried to cancel {count} task", "Tried to cancel {count} tasks");
      break;
    }
    case "schedule-create": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? tn(count, "Scheduled {count} task", "Scheduled {count} tasks")
        : tn(count, "Tried to schedule {count} task", "Tried to schedule {count} tasks");
      break;
    }
    case "schedule-update": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? tn(count, "Updated {count} scheduled task", "Updated {count} scheduled tasks")
        : tn(
            count,
            "Tried to update {count} scheduled task",
            "Tried to update {count} scheduled tasks",
          );
      break;
    }
    case "schedule-delete": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? tn(
            count,
            "Requested deletion of {count} scheduled task",
            "Requested deletion of {count} scheduled tasks",
          )
        : tn(
            count,
            "Tried to delete {count} scheduled task",
            "Tried to delete {count} scheduled tasks",
          );
      break;
    }
    case "schedule-run": {
      const count = selected.length;
      label = done
        ? tn(count, "Requested {count} scheduled task run", "Requested {count} scheduled task runs")
        : tn(
            count,
            "Tried to request {count} scheduled task run",
            "Tried to request {count} scheduled task runs",
          );
      break;
    }
    case "thread-fork": {
      const count = selected.length;
      label = done
        ? tn(count, "Requested {count} thread fork", "Requested {count} thread forks")
        : tn(
            count,
            "Tried to request {count} thread fork",
            "Tried to request {count} thread forks",
          );
      break;
    }
    case "thread-merge": {
      const count = selected.length;
      label = done
        ? tn(count, "Requested {count} context merge", "Requested {count} context merges")
        : tn(
            count,
            "Tried to request {count} context merge",
            "Tried to request {count} context merges",
          );
      break;
    }
    case "thread-update": {
      const count = countEntities(threadIds);
      label = done
        ? tn(count, "Updated {count} thread", "Updated {count} threads")
        : tn(count, "Tried to update {count} thread", "Tried to update {count} threads");
      break;
    }
    case "queue-read": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? tn(count, "Read {count} queued message", "Read {count} queued messages")
        : tn(
            count,
            "Tried to read {count} queued message",
            "Tried to read {count} queued messages",
          );
      break;
    }
    case "queue-edit": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? tn(count, "Edited {count} queued message", "Edited {count} queued messages")
        : tn(
            count,
            "Tried to edit {count} queued message",
            "Tried to edit {count} queued messages",
          );
      break;
    }
    case "queue-cancel": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? tn(
            count,
            "Requested cancellation of {count} queued run",
            "Requested cancellation of {count} queued runs",
          )
        : tn(count, "Tried to cancel {count} queued run", "Tried to cancel {count} queued runs");
      break;
    }
    case "queue-reorder": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? tn(count, "Reordered {count} queued run", "Reordered {count} queued runs")
        : tn(count, "Tried to reorder {count} queued run", "Tried to reorder {count} queued runs");
      break;
    }
    case "queue-steer": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? tn(
            count,
            "Requested steering with {count} queued message",
            "Requested steering with {count} queued messages",
          )
        : tn(
            count,
            "Tried to steer with {count} queued message",
            "Tried to steer with {count} queued messages",
          );
      break;
    }
    case "question-read": {
      const count = countEntities(entityIds("requestId"));
      label = done
        ? tn(
            count,
            "Read {count} pending question request",
            "Read {count} pending question requests",
          )
        : tn(
            count,
            "Tried to read {count} pending question request",
            "Tried to read {count} pending question requests",
          );
      break;
    }
    case "question-respond": {
      const count = countEntities(entityIds("requestId"));
      label = done
        ? tn(
            count,
            "Answered {count} pending question request",
            "Answered {count} pending question requests",
          )
        : tn(
            count,
            "Tried to answer {count} pending question request",
            "Tried to answer {count} pending question requests",
          );
      break;
    }
    case "secret-request": {
      const count = selected.length;
      label = done
        ? tn(count, "Asked for {count} secret", "Asked for {count} secrets")
        : tn(count, "Tried to ask for {count} secret", "Tried to ask for {count} secrets");
      break;
    }
    case "worktree-handoff": {
      const count = countEntities(entityIds("worktreePath"));
      label = done
        ? tn(count, "Handed off to {count} worktree", "Handed off to {count} worktrees")
        : tn(
            count,
            "Tried to hand off to {count} worktree",
            "Tried to hand off to {count} worktrees",
          );
      break;
    }
    case "project-read": {
      const count = countEntities(projectIds);
      label = done
        ? tn(count, "Read {count} project", "Read {count} projects")
        : tn(count, "Tried to read {count} project", "Tried to read {count} projects");
      break;
    }
    case "project-create": {
      const count = countEntities(projectIds);
      label = done
        ? tn(count, "Registered {count} project", "Registered {count} projects")
        : tn(count, "Tried to register {count} project", "Tried to register {count} projects");
      break;
    }
    case "project-update": {
      const count = countEntities(projectIds);
      label = done
        ? tn(count, "Updated {count} project", "Updated {count} projects")
        : tn(count, "Tried to update {count} project", "Tried to update {count} projects");
      break;
    }
    case "project-delete": {
      const count = countEntities(projectIds);
      label = done
        ? tn(count, "Deleted {count} project", "Deleted {count} projects")
        : tn(count, "Tried to delete {count} project", "Tried to delete {count} projects");
      break;
    }
    case "project-clone": {
      const count = countEntities(entityIds("cwd"));
      label = done
        ? tn(count, "Cloned {count} repository", "Cloned {count} repositories")
        : tn(count, "Tried to clone {count} repository", "Tried to clone {count} repositories");
      break;
    }
    case "environment-link": {
      const count = selected.length;
      label = done
        ? tn(count, "Asked to link {count} environment", "Asked to link {count} environments")
        : tn(
            count,
            "Tried to ask to link {count} environment",
            "Tried to ask to link {count} environments",
          );
      break;
    }
    case "environment-unlink": {
      const count = countEntities(entityIds("environmentId"));
      label = done
        ? tn(count, "Forgot {count} linked environment", "Forgot {count} linked environments")
        : tn(
            count,
            "Tried to forget {count} linked environment",
            "Tried to forget {count} linked environments",
          );
      break;
    }
    case "attachment-prepare": {
      const count = countEntities(entityIds("attachmentId"));
      label = done
        ? tn(count, "Prepared {count} attachment upload", "Prepared {count} attachment uploads")
        : tn(
            count,
            "Tried to prepare {count} attachment upload",
            "Tried to prepare {count} attachment uploads",
          );
      break;
    }
    case "attachment-discard": {
      const count = countEntities(entityIds("attachmentId"));
      label = done
        ? tn(count, "Discarded {count} pending attachment", "Discarded {count} pending attachments")
        : tn(
            count,
            "Tried to discard {count} pending attachment",
            "Tried to discard {count} pending attachments",
          );
      break;
    }
    case "watch-pr": {
      const count = selected.length;
      label = done
        ? tn(count, "Watching {count} pull request", "Watching {count} pull requests")
        : tn(count, "Tried to watch {count} pull request", "Tried to watch {count} pull requests");
      break;
    }
    case "unwatch-pr": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Stopped watching {count} pull request",
            "Stopped watching {count} pull requests",
          )
        : tn(
            count,
            "Tried to stop watching {count} pull request",
            "Tried to stop watching {count} pull requests",
          );
      break;
    }
    case "read-pr-guide": {
      const count = selected.length;
      label = done
        ? tn(count, "Read {count} review guide", "Read {count} review guides")
        : tn(count, "Tried to read {count} review guide", "Tried to read {count} review guides");
      break;
    }
    case "list-issues": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed issues {count} time", "Listed issues {count} times")
        : tn(count, "Tried to list issues {count} time", "Tried to list issues {count} times");
      break;
    }
    case "read-issue": {
      const count = selected.length;
      label = done
        ? tn(count, "Read {count} issue", "Read {count} issues")
        : tn(count, "Tried to read {count} issue", "Tried to read {count} issues");
      break;
    }
    case "create-issue": {
      const count = selected.length;
      label = done
        ? tn(count, "Filed {count} issue", "Filed {count} issues")
        : tn(count, "Tried to file {count} issue", "Tried to file {count} issues");
      break;
    }
    case "comment-issue": {
      const count = selected.length;
      label = done
        ? tn(count, "Commented on {count} issue", "Commented on {count} issues")
        : tn(count, "Tried to comment on {count} issue", "Tried to comment on {count} issues");
      break;
    }
    case "set-issue-state": {
      const count = selected.length;
      label = done
        ? tn(count, "Changed the state of {count} issue", "Changed the state of {count} issues")
        : tn(
            count,
            "Tried to change the state of {count} issue",
            "Tried to change the state of {count} issues",
          );
      break;
    }
    case "link-issue": {
      const count = selected.length;
      label = done
        ? tn(count, "Linked {count} issue", "Linked {count} issues")
        : tn(count, "Tried to link {count} issue", "Tried to link {count} issues");
      break;
    }
    case "unlink-issue": {
      const count = selected.length;
      label = done
        ? tn(count, "Unlinked {count} issue", "Unlinked {count} issues")
        : tn(count, "Tried to unlink {count} issue", "Tried to unlink {count} issues");
      break;
    }
    case "list-thread-issues": {
      const count = selected.length;
      if (count === 1) {
        label = done
          ? resolve(msg("Checked linked issues"))
          : resolve(msg("Tried to check linked issues"));
      } else {
        label = done
          ? tn(count, "Checked linked issues {count} time", "Checked linked issues {count} times")
          : tn(
              count,
              "Tried to check linked issues {count} time",
              "Tried to check linked issues {count} times",
            );
      }
      break;
    }
    case "html-preview": {
      const count = selected.length;
      label = done
        ? tn(count, "Previewed {count} HTML page", "Previewed {count} HTML pages")
        : tn(count, "Tried to preview {count} HTML page", "Tried to preview {count} HTML pages");
      break;
    }
    case "html-render": {
      const count = selected.length;
      label = done
        ? tn(count, "Rendered {count} HTML page", "Rendered {count} HTML pages")
        : tn(count, "Tried to render {count} HTML page", "Tried to render {count} HTML pages");
      break;
    }
    case "send-to-user": {
      const count = selected.length;
      label = done
        ? tn(count, "Sent {count} message", "Sent {count} messages")
        : tn(count, "Tried to send {count} message", "Tried to send {count} messages");
      break;
    }
    case "thread-list": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed threads {count} time", "Listed threads {count} times")
        : tn(count, "Tried to list threads {count} time", "Tried to list threads {count} times");
      break;
    }
    case "task-status": {
      const count = selected.length;
      label = done
        ? tn(count, "Checked task status {count} time", "Checked task status {count} times")
        : tn(
            count,
            "Tried to check task status {count} time",
            "Tried to check task status {count} times",
          );
      break;
    }
    case "background-wait": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Updated background waits {count} time",
            "Updated background waits {count} times",
          )
        : tn(
            count,
            "Tried to update background waits {count} time",
            "Tried to update background waits {count} times",
          );
      break;
    }
    case "schedule-list": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed scheduled tasks {count} time", "Listed scheduled tasks {count} times")
        : tn(
            count,
            "Tried to list scheduled tasks {count} time",
            "Tried to list scheduled tasks {count} times",
          );
      break;
    }
    case "thread-configuration": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Checked thread configuration {count} time",
            "Checked thread configuration {count} times",
          )
        : tn(
            count,
            "Tried to check thread configuration {count} time",
            "Tried to check thread configuration {count} times",
          );
      break;
    }
    case "thread-configure": {
      const count = selected.length;
      label = done
        ? tn(count, "Set thread model {count} time", "Set thread model {count} times")
        : tn(
            count,
            "Tried to set thread model {count} time",
            "Tried to set thread model {count} times",
          );
      break;
    }
    case "thread-search": {
      const count = selected.length;
      label = done
        ? tn(count, "Searched threads {count} time", "Searched threads {count} times")
        : tn(
            count,
            "Tried to search threads {count} time",
            "Tried to search threads {count} times",
          );
      break;
    }
    case "thread-transfers": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Checked thread transfers {count} time",
            "Checked thread transfers {count} times",
          )
        : tn(
            count,
            "Tried to check thread transfers {count} time",
            "Tried to check thread transfers {count} times",
          );
      break;
    }
    case "thread-organize": {
      const count = selected.length;
      label = done
        ? tn(count, "Organized threads {count} time", "Organized threads {count} times")
        : tn(
            count,
            "Tried to organize threads {count} time",
            "Tried to organize threads {count} times",
          );
      break;
    }
    case "queue-list": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed queued messages {count} time", "Listed queued messages {count} times")
        : tn(
            count,
            "Tried to list queued messages {count} time",
            "Tried to list queued messages {count} times",
          );
      break;
    }
    case "question-list": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Listed pending questions {count} time",
            "Listed pending questions {count} times",
          )
        : tn(
            count,
            "Tried to list pending questions {count} time",
            "Tried to list pending questions {count} times",
          );
      break;
    }
    case "worktree-list": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Listed workspace branches {count} time",
            "Listed workspace branches {count} times",
          )
        : tn(
            count,
            "Tried to list workspace branches {count} time",
            "Tried to list workspace branches {count} times",
          );
      break;
    }
    case "worktree-status": {
      const count = selected.length;
      label = done
        ? tn(count, "Checked worktree status {count} time", "Checked worktree status {count} times")
        : tn(
            count,
            "Tried to check worktree status {count} time",
            "Tried to check worktree status {count} times",
          );
      break;
    }
    case "project-list": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed projects {count} time", "Listed projects {count} times")
        : tn(count, "Tried to list projects {count} time", "Tried to list projects {count} times");
      break;
    }
    case "environment-read": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Checked environment preferences {count} time",
            "Checked environment preferences {count} times",
          )
        : tn(
            count,
            "Tried to check environment preferences {count} time",
            "Tried to check environment preferences {count} times",
          );
      break;
    }
    case "environment-update": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Updated environment preferences {count} time",
            "Updated environment preferences {count} times",
          )
        : tn(
            count,
            "Tried to update environment preferences {count} time",
            "Tried to update environment preferences {count} times",
          );
      break;
    }
    case "theme-read": {
      const count = selected.length;
      label = done
        ? tn(count, "Checked themes {count} time", "Checked themes {count} times")
        : tn(count, "Tried to check themes {count} time", "Tried to check themes {count} times");
      break;
    }
    case "theme-set": {
      const count = selected.length;
      label = done
        ? tn(count, "Set the theme {count} time", "Set the theme {count} times")
        : tn(count, "Tried to set the theme {count} time", "Tried to set the theme {count} times");
      break;
    }
    case "environment-links": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Listed linked environments {count} time",
            "Listed linked environments {count} times",
          )
        : tn(
            count,
            "Tried to list linked environments {count} time",
            "Tried to list linked environments {count} times",
          );
      break;
    }
    case "browser": {
      const count = selected.length;
      label = done
        ? tn(count, "Used browser {count} time", "Used browser {count} times")
        : tn(count, "Tried to use browser {count} time", "Tried to use browser {count} times");
      break;
    }
    case "device": {
      const count = selected.length;
      label = done
        ? tn(count, "Used device controls {count} time", "Used device controls {count} times")
        : tn(
            count,
            "Tried to use device controls {count} time",
            "Tried to use device controls {count} times",
          );
      break;
    }
    case "capabilities": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Checked orchestration capabilities {count} time",
            "Checked orchestration capabilities {count} times",
          )
        : tn(
            count,
            "Tried to check orchestration capabilities {count} time",
            "Tried to check orchestration capabilities {count} times",
          );
      break;
    }
    case "thread-read": {
      if (threadIds.every((value) => value !== undefined)) {
        const count = new Set(threadIds).size;
        label = done
          ? tn(count, "Read {count} thread", "Read {count} threads")
          : tn(count, "Tried to read {count} thread", "Tried to read {count} threads");
      } else {
        const count = selected.length;
        label = done
          ? tn(count, "Read threads {count} time", "Read threads {count} times")
          : tn(count, "Tried to read threads {count} time", "Tried to read threads {count} times");
      }
      break;
    }
    case "thread-wait": {
      if (threadIds.every((value) => value !== undefined)) {
        const count = new Set(threadIds).size;
        label = done
          ? tn(count, "Waited on {count} thread", "Waited on {count} threads")
          : tn(count, "Tried to wait on {count} thread", "Tried to wait on {count} threads");
      } else {
        const count = selected.length;
        label = done
          ? tn(count, "Waited on threads {count} time", "Waited on threads {count} times")
          : tn(
              count,
              "Tried to wait on threads {count} time",
              "Tried to wait on threads {count} times",
            );
      }
      break;
    }
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const threads = new Set(threadIds).size;
      if (!threadIds.every((value) => value !== undefined)) {
        const count = messages;
        label = done
          ? tn(count, "Sent {count} message", "Sent {count} messages")
          : tn(count, "Tried to send {count} message", "Tried to send {count} messages");
      } else if (messages === threads && messages > 1) {
        label = done
          ? tn(threads, "Sent messages to {count} thread", "Sent messages to {count} threads")
          : tn(
              threads,
              "Tried to send messages to {count} thread",
              "Tried to send messages to {count} threads",
            );
      } else {
        label = done
          ? tn(messages, "Sent {count} message{targets}", "Sent {count} messages{targets}", {
              targets: tn(threads, " to {count} thread", " to {count} threads"),
            })
          : tn(
              messages,
              "Tried to send {count} message{targets}",
              "Tried to send {count} messages{targets}",
              { targets: tn(threads, " to {count} thread", " to {count} threads") },
            );
      }
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
      if (resultsKnown) {
        const count = new Set(createdIds).size;
        label = tn(count, "Created {count} thread", "Created {count} threads");
      } else {
        const count = selected.length;
        label = tn(
          count,
          "Requested thread creation {count} time",
          "Requested thread creation {count} times",
        );
      }
      break;
    }
    case "attachment-send": {
      const messages = new Map<string, (typeof selected)[number]>();
      selected.forEach((call, index) =>
        messages.set(id(call.output?.messageId) ?? `call-${index}`, call),
      );
      const attachments = [...messages.values()].reduce(
        (count, call) =>
          count + (Array.isArray(call.input?.attachments) ? call.input.attachments.length : 0),
        0,
      );
      const countsKnown = [...messages.values()].every(
        (call) => Array.isArray(call.input?.attachments) && call.input.attachments.length > 0,
      );
      const threads = new Set(threadIds).size;
      const count = selected.length;
      if (threadIds.every((value) => value !== undefined)) {
        label = countsKnown
          ? done
            ? tn(
                attachments,
                "Sent {count} attachment{targets}",
                "Sent {count} attachments{targets}",
                { targets: tn(threads, " to {count} thread", " to {count} threads") },
              )
            : tn(
                attachments,
                "Tried to send {count} attachment{targets}",
                "Tried to send {count} attachments{targets}",
                { targets: tn(threads, " to {count} thread", " to {count} threads") },
              )
          : done
            ? tn(
                count,
                "Sent attachments{targets} {count} time",
                "Sent attachments{targets} {count} times",
                { targets: tn(threads, " to {count} thread", " to {count} threads") },
              )
            : tn(
                count,
                "Tried to send attachments{targets} {count} time",
                "Tried to send attachments{targets} {count} times",
                { targets: tn(threads, " to {count} thread", " to {count} threads") },
              );
      } else {
        label = countsKnown
          ? done
            ? tn(attachments, "Sent {count} attachment", "Sent {count} attachments")
            : tn(
                attachments,
                "Tried to send {count} attachment",
                "Tried to send {count} attachments",
              )
          : done
            ? tn(count, "Sent attachments {count} time", "Sent attachments {count} times")
            : tn(
                count,
                "Tried to send attachments {count} time",
                "Tried to send attachments {count} times",
              );
      }
      break;
    }
    case "link-pr": {
      const count = pullRequestCount(selected, "linkedCount");
      if (count === null) {
        label = done
          ? resolve(msg("Linked pull requests"))
          : resolve(msg("Tried to link pull requests"));
      } else {
        label = done
          ? tn(count, "Linked {count} pull request", "Linked {count} pull requests")
          : tn(count, "Tried to link {count} pull request", "Tried to link {count} pull requests");
      }
      break;
    }
    case "unlink-pr": {
      const count = pullRequestCount(selected, "unlinkedCount");
      if (count === null) {
        label = done
          ? resolve(msg("Unlinked pull requests"))
          : resolve(msg("Tried to unlink pull requests"));
      } else {
        label = done
          ? tn(count, "Unlinked {count} pull request", "Unlinked {count} pull requests")
          : tn(
              count,
              "Tried to unlink {count} pull request",
              "Tried to unlink {count} pull requests",
            );
      }
      break;
    }
    case "list-prs": {
      const count = selected.length;
      if (count === 1) {
        label = done
          ? resolve(msg("Checked linked pull requests"))
          : resolve(msg("Tried to check linked pull requests"));
      } else {
        label = done
          ? tn(
              count,
              "Checked linked pull requests {count} time",
              "Checked linked pull requests {count} times",
            )
          : tn(
              count,
              "Tried to check linked pull requests {count} time",
              "Tried to check linked pull requests {count} times",
            );
      }
      break;
    }
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
        const count = selected.length;
        label =
          count === 1
            ? done
              ? resolve(msg("Started writing review guides"))
              : resolve(msg("Tried to start writing review guides"))
            : done
              ? tn(
                  count,
                  "Started writing review guides {count} time",
                  "Started writing review guides {count} times",
                )
              : tn(
                  count,
                  "Tried to start writing review guides {count} time",
                  "Tried to start writing review guides {count} times",
                );
      } else if (started === 0) {
        label = tn(
          failed,
          "Could not start {count} review guide",
          "Could not start {count} review guides",
        );
      } else if (failed > 0) {
        label = done
          ? tn(
              started,
              "Started {count} review guide, {failed} failed",
              "Started {count} review guides, {failed} failed",
              { failed },
            )
          : tn(
              started,
              "Tried to start {count} review guide, {failed} failed",
              "Tried to start {count} review guides, {failed} failed",
              { failed },
            );
      } else {
        label = done
          ? tn(started, "Started {count} review guide", "Started {count} review guides")
          : tn(
              started,
              "Tried to start {count} review guide",
              "Tried to start {count} review guides",
            );
      }
      break;
    }
    case "read-pr": {
      const count = selected.length;
      label = done
        ? tn(count, "Read {count} pull request", "Read {count} pull requests")
        : tn(count, "Tried to read {count} pull request", "Tried to read {count} pull requests");
      break;
    }
    case "list-repo-prs": {
      const count = selected.length;
      label = done
        ? tn(count, "Listed pull requests {count} time", "Listed pull requests {count} times")
        : tn(
            count,
            "Tried to list pull requests {count} time",
            "Tried to list pull requests {count} times",
          );
      break;
    }
    case "create-pr": {
      // An open PR for the branch is returned rather than duplicated.
      const existing = selected.filter((call) => call.output?.created === false).length;
      const opened = selected.length - existing;
      label = !done
        ? tn(
            selected.length,
            "Tried to open {count} pull request",
            "Tried to open {count} pull requests",
          )
        : opened === 0
          ? tn(existing, "Found {count} open pull request", "Found {count} open pull requests")
          : existing === 0
            ? tn(opened, "Opened {count} pull request", "Opened {count} pull requests")
            : tn(
                opened,
                "Opened {count} pull request, found {existing} open",
                "Opened {count} pull requests, found {existing} open",
                { existing },
              );
      break;
    }
    case "update-pr": {
      const count = selected.length;
      label = done
        ? tn(count, "Updated {count} pull request", "Updated {count} pull requests")
        : tn(
            count,
            "Tried to update {count} pull request",
            "Tried to update {count} pull requests",
          );
      break;
    }
    case "respond-pr": {
      const count = selected.length;
      label = done
        ? tn(
            count,
            "Responded on pull requests {count} time",
            "Responded on pull requests {count} times",
          )
        : tn(
            count,
            "Tried to respond on pull requests {count} time",
            "Tried to respond on pull requests {count} times",
          );
      break;
    }
    case "merge-pr": {
      // Auto-merge and merge queues leave the PR open until it lands.
      const queued = selected.filter((call) =>
        call.output?.state === undefined
          ? call.input?.auto === true
          : call.output.state !== "merged",
      ).length;
      const merged = selected.length - queued;
      label = !done
        ? tn(
            selected.length,
            "Tried to merge {count} pull request",
            "Tried to merge {count} pull requests",
          )
        : merged === 0
          ? tn(
              queued,
              "Queued {count} pull request to merge",
              "Queued {count} pull requests to merge",
            )
          : queued === 0
            ? tn(merged, "Merged {count} pull request", "Merged {count} pull requests")
            : tn(
                merged,
                "Merged {count} pull request, queued {queued}",
                "Merged {count} pull requests, queued {queued}",
                { queued },
              );
      break;
    }
    case "ci-logs": {
      const count = selected.length;
      label = done
        ? tn(count, "Read CI logs {count} time", "Read CI logs {count} times")
        : tn(count, "Tried to read CI logs {count} time", "Tried to read CI logs {count} times");
      break;
    }
    case "ci-rerun": {
      // A host can refuse a check it cannot re-run, such as one outside its CI.
      const outcomes = selected.flatMap((call) =>
        Array.isArray(call.output?.checks)
          ? call.output.checks.map((check) => asRecord(check)?.rerun === true)
          : [],
      );
      const rerun = outcomes.filter(Boolean).length;
      const refused = outcomes.length - rerun;
      failedCount += refused;
      if (!done) {
        label = tn(
          selected.length,
          "Tried to re-run CI {count} time",
          "Tried to re-run CI {count} times",
        );
      } else if (outcomes.length === 0) {
        // An empty list means no check had failed, so nothing was asked of the host.
        label = selected.some((call) => Array.isArray(call.output?.checks))
          ? resolve(msg("Found no failed checks to re-run"))
          : tn(selected.length, "Re-ran CI {count} time", "Re-ran CI {count} times");
      } else if (rerun === 0) {
        label = tn(refused, "Could not re-run {count} check", "Could not re-run {count} checks");
      } else if (refused === 0) {
        label = tn(rerun, "Re-ran {count} check", "Re-ran {count} checks");
      } else {
        label = tn(
          rerun,
          "Re-ran {count} check, {refused} refused",
          "Re-ran {count} checks, {refused} refused",
          { refused },
        );
      }
      break;
    }
    case "review-pr": {
      const count = selected.length;
      label = done
        ? tn(count, "Reviewed {count} pull request", "Reviewed {count} pull requests")
        : tn(
            count,
            "Tried to review {count} pull request",
            "Tried to review {count} pull requests",
          );
      break;
    }
  }
  return { label, failedCount };
}
