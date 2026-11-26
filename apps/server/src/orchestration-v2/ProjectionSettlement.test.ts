import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  isAutoSettlementCandidate,
  isSnoozed,
  resolveAutoSettlementAt,
} from "./ThreadSettlementService.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (
  threadId: ThreadId,
  runId: RunId,
  status: "idle" | "running" | "completed",
  persistent = false,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:item:${runId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload: {
      id: TurnItemId.make(`item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status,
      title: null,
      startedAt: old,
      completedAt: status === "completed" ? old : null,
      updatedAt: old,
      toolName: "background",
      input: persistent ? { persistent: true } : null,
      output: null,
    },
  });
});

it.effect.each([["sql", layerSql]] as const)(
  "%s: pending approvals wake a snoozed question even with older creation times",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("snoozed-question-approval", {
        snoozedAt: now,
        snoozedUntil: DateTime.add(now, { days: 1 }),
      });
      const question: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("node:question"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.subtract(now, { hours: 1 }),
        resolvedAt: null,
      };
      const approval: OrchestrationV2RuntimeRequest = {
        ...question,
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: old,
      };
      const newerApproval = {
        ...approval,
        id: RuntimeRequestId.make("newer-approval"),
        createdAt: DateTime.add(old, { hours: 1 }),
      };
      const setRequest = (request: OrchestrationV2RuntimeRequest) =>
        store.apply({
          id: EventId.make(`event:${request.id}:${request.status}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: request,
        });
      const assertPending = (expected: RuntimeRequestId, snoozed: boolean) =>
        Effect.gen(function* () {
          const snapshot = yield* store.getShellSnapshot();
          const shell = snapshot.threads.find((thread) => thread.id === threadId)!;
          const projection = yield* store.getThreadProjection(threadId);
          for (const candidate of [shell, ProjectionStore.threadShellFromProjection(projection)]) {
            assert.equal(candidate.pendingRuntimeRequest?.id, expected);
            assert.equal(isSnoozed(candidate, DateTime.toEpochMillis(now)), snoozed);
          }
        });
      yield* setRequest({
        ...question,
        id: RuntimeRequestId.make("older-question"),
        createdAt: old,
      });
      yield* setRequest(question);
      yield* assertPending(question.id, true);

      // A request becoming pending can retain a creation time older than the snooze.
      yield* setRequest(approval);
      yield* assertPending(approval.id, false);
      yield* setRequest(newerApproval);
      yield* assertPending(newerApproval.id, false);
      yield* setRequest({ ...newerApproval, status: "resolved", resolvedAt: now });
      yield* assertPending(approval.id, false);
      yield* setRequest({ ...approval, status: "resolved", resolvedAt: now });
      yield* assertPending(question.id, true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "sql: discovers settlement work with the same activity and background semantics as the shell",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const idle = yield* createThread("idle");
      const completed = yield* createThread("completed");
      yield* createRun(completed);
      for (const [name, overrides] of [
        ["archived", { archivedAt: old }],
        ["deleted", { deletedAt: old }],
        ["settled", { settledOverride: "settled" }],
        ["unsettled", { settledOverride: "active" }],
        ["pinned", { pinnedAt: old }],
        ["auto-settle-disabled", { autoSettleDisabledAt: old }],
      ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2AppThread>]>) {
        yield* createRun(yield* createThread(name, overrides));
      }
      for (const status of ["preparing", "starting", "running", "waiting"] as const) {
        yield* createRun(yield* createThread(status), status);
      }
      const queued = yield* createThread("queued");
      yield* createRun(queued, "queued");
      const blocked = yield* createThread("blocked");
      yield* store.apply({
        id: EventId.make("event:settlement:request"),
        type: "runtime-request.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          id: RuntimeRequestId.make("request:settlement"),
          nodeId: NodeId.make("node:settlement"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Process stopped" },
          createdAt: old,
          resolvedAt: null,
        },
      });
      const recent = yield* createThread("recent-message");
      yield* createRun(recent);
      yield* store.apply({
        id: EventId.make("event:settlement:message"),
        type: "message.updated",
        threadId: recent,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:settlement:recent"),
          threadId: recent,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Next turn",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* createRun(
        yield* createThread("snoozed", {
          snoozedUntil: DateTime.add(now, { days: 1 }),
          snoozedAt: now,
        }),
      );
      const woke = yield* createThread("woke", {
        snoozedUntil: DateTime.add(now, { days: 1 }),
        snoozedAt: DateTime.subtract(old, { days: 1 }),
      });
      yield* createRun(woke, "failed");
      const background = yield* createThread("idle-background");
      yield* createItem(background, yield* createRun(background), "idle");
      const persistent = yield* createThread("persistent-monitor");
      yield* createItem(persistent, yield* createRun(persistent), "running", true);
      const rolledBack = yield* createThread("rolled-back-background");
      yield* createItem(rolledBack, yield* createRun(rolledBack, "rolled_back"), "running");
      yield* createRun(rolledBack, "completed", 2);
      const roster = yield* createThread("provider-roster");
      yield* createRun(roster);
      yield* store.apply({
        id: EventId.make("event:settlement:roster"),
        type: "provider-thread.updated",
        threadId: roster,
        occurredAt: old,
        payload: {
          id: ProviderThreadId.make("provider-thread:settlement"),
          appThreadId: roster,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: old,
          updatedAt: old,
          pendingBackgroundTasks: [{ taskId: "running-task", kind: "subagent" }],
        },
      });
      const candidates = yield* store.getSettlementCandidates();
      const shell = yield* store.getShellSnapshot({ location: "active" });
      const eligible = candidates.filter((thread) =>
        isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set([idle, completed, queued, woke, background, persistent, rolledBack]),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set(
          shell.threads
            .filter((thread) => isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)))
            .map((thread) => thread.id),
        ),
      );
      for (const candidate of candidates) {
        const expected = shell.threads.find((thread) => thread.id === candidate.id)!;
        assert.deepEqual(candidate.pendingBackgroundTasks, expected.pendingBackgroundTasks);
        const settings = {
          pullRequest: null,
          nowMs: DateTime.toEpochMillis(now),
          autoSettleAfterDays: 7,
          autoSettleOnMerge: false,
        };
        assert.deepEqual(
          resolveAutoSettlementAt({ ...settings, thread: candidate }),
          resolveAutoSettlementAt({
            ...settings,
            thread: {
              ...expected,
              latestResumingMessageAt: candidate.latestResumingMessageAt,
            },
          }),
        );
      }
      assert.equal(
        DateTime.formatIso((yield* store.getThread(completed)).createdAt),
        DateTime.formatIso(old),
      );
      assert.equal(
        (yield* store.getThread(ThreadId.make("missing")).pipe(Effect.flip))._tag,
        "ProjectionStoreThreadNotFoundError",
      );
    }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: the resuming message time counts MCP sends and ignores agent notifications", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "mcp" | "provider",
      at: DateTime.Utc,
    ) =>
      store.apply({
        id: EventId.make(`event:settlement:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy,
          creationSource,
          id: MessageId.make(`message:settlement:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    const written = DateTime.subtract(now, { hours: 2 });
    const sent = DateTime.subtract(now, { hours: 1 });
    yield* message("written", "user", "web", written);
    yield* message("sent", "agent", "mcp", sent);
    yield* message("notification", "agent", "provider", now);

    const [candidate] = yield* store.getSettlementCandidates(threadId);
    assert.isDefined(candidate);
    assert.equal(DateTime.formatIso(candidate.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(DateTime.formatIso(candidate.latestResumingMessageAt!), DateTime.formatIso(sent));
    const shellThread = (yield* store.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.equal(
      DateTime.formatIso(shellThread!.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: only a message the user wrote counts as written in the thread", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("scheduled-run");
    const message = (
      id: string,
      origin: Pick<
        OrchestrationV2ConversationMessage,
        "createdBy" | "creationSource" | "scheduledTaskId"
      >,
    ) =>
      store.apply({
        id: EventId.make(`event:written:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...origin,
          id: MessageId.make(`message:written:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    // A scheduled run's prompt carries the creator and source of its task.
    yield* message("prompt", {
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("task"),
    });
    yield* message("agent", { createdBy: "agent", creationSource: "mcp" });
    // Recovering after a network or usage-limit stop sends "continue" as the user.
    yield* message("recovery", { createdBy: "user", creationSource: "server" });
    assert.isFalse(yield* store.hasUserWrittenMessage(threadId));

    yield* message("typed", { createdBy: "user", creationSource: "mobile" });
    assert.isTrue(yield* store.hasUserWrittenMessage(threadId));
  }).pipe(Effect.provide(layerSql)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect("sql: lists only active threads with pull request links, oldest first", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("no-links");
    yield* createThread("empty-links", { pullRequests: [] });
    const archived = yield* createThread("archived-link", {
      archivedAt: old,
      pullRequests: [pullRequestLink(1)],
    });
    const settled = yield* createThread("settled-link", {
      settledOverride: "settled",
      settledAt: old,
      updatedAt: DateTime.subtract(now, { days: 12 }),
      pullRequests: [pullRequestLink(2)],
    });
    const open = yield* createThread("open-link", {
      pullRequests: [pullRequestLink(3), pullRequestLink(4)],
    });

    const threads = yield* store.getThreadsWithPullRequests();
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.settledOverride, thread.pullRequests?.length]),
      [
        [settled, "settled", 1],
        [open, null, 2],
      ],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
      [open],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(undefined, { includeArchived: true })).map(
        (thread) => thread.id,
      ),
      [settled, archived, open],
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: an unsettled-only shell read skips settled threads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const open = yield* createThread("unsettled-open");
    const reopened = yield* createThread("unsettled-reopened", { settledOverride: "active" });
    yield* createThread("unsettled-manual", { settledOverride: "settled", settledAt: old });
    yield* createThread("unsettled-auto", { settledAt: old });
    yield* createThread("unsettled-archived", { archivedAt: old });

    const shell = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    assert.deepEqual(new Set(shell.threads.map((thread) => thread.id)), new Set([open, reopened]));
    assert.equal(shell.archivedThreads.length, 0);
    const all = yield* store.getShellSnapshot({ location: "active" });
    assert.equal(all.threads.length, 4);
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: a subagent thread becomes a candidate once its parent is done", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* createThread("subagent-parent");
    const child = yield* createThread("subagent-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    const ids = () =>
      store.getSettlementCandidates().pipe(Effect.map((rows) => rows.map((row) => row.id)));
    assert.deepEqual(yield* ids(), [parent]);

    const parentThread = yield* store.getThread(parent);
    for (const [type, overrides] of [
      ["thread.settled", { settledOverride: "settled", settledAt: now }],
      ["thread.archived", { archivedAt: now }],
      ["thread.deleted", { deletedAt: now }],
    ] satisfies ReadonlyArray<
      readonly [
        "thread.settled" | "thread.archived" | "thread.deleted",
        Partial<OrchestrationV2AppThread>,
      ]
    >) {
      yield* store.apply({
        id: EventId.make(`event:settlement:subagent-parent:${type}`),
        type,
        threadId: parent,
        occurredAt: now,
        payload: { ...parentThread, ...overrides, updatedAt: now },
      });
      assert.deepEqual(yield* ids(), [child]);
    }
    const orphan = yield* createThread("orphan", {
      lineage: {
        parentThreadId: ThreadId.make("missing-parent"),
        relationshipToParent: "subagent",
        rootThreadId: parent,
      },
    });
    assert.deepEqual(new Set(yield* ids()), new Set([child, orphan]));
  }).pipe(Effect.provide(layerSql)),
);
const recordTask = Effect.fn(function* (
  parentId: ThreadId,
  childThreadId: ThreadId,
  name: string,
  task: {
    readonly origin?: "provider_native";
    readonly status: "running" | "completed" | "failed";
    readonly result: string | null;
    readonly startedAt: DateTime.Utc;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  },
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const driver = ProviderDriverKind.make("codex");
  const id = NodeId.make(`node:task:${name}`);
  yield* store.apply({
    id: EventId.make(`event:task:${name}`),
    type: "subagent.updated",
    threadId: parentId,
    nodeId: id,
    driver,
    providerInstanceId,
    occurredAt: task.updatedAt,
    payload: {
      id,
      threadId: parentId,
      runId: null,
      parentNodeId: NodeId.make("node:task-parent"),
      origin: "app_owned",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Do the work",
      title: name,
      model: null,
      ...task,
    },
  });
});
it.effect(
  "sql: a delegated child reads its parent, its latest task and its own background work",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* createThread("delegating-parent", {
        worktreePath: "/worktrees/parent",
      });
      const childOf = (name: string) =>
        createThread(name, {
          createdBy: "agent",
          creationSource: "mcp",
          worktreePath: "/worktrees/parent",
          lineage: {
            parentThreadId: parent,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        });
      const at = (hours: number) => DateTime.add(old, { hours });
      const delivered = yield* childOf("delivered-child");
      // Acknowledging the older task's delivery later must not make it the latest task.
      yield* recordTask(parent, delivered, "delivered-first", {
        status: "completed",
        result: "First",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(5),
      });
      yield* recordTask(parent, delivered, "delivered-again", {
        status: "completed",
        result: "Second",
        startedAt: at(2),
        completedAt: at(3),
        updatedAt: at(3),
      });
      const failed = yield* childOf("failed-child");
      yield* recordTask(parent, failed, "failed", {
        status: "failed",
        result: "Partial",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(1),
      });
      const rerun = yield* childOf("rerun-child");
      yield* recordTask(parent, rerun, "rerun-first", {
        status: "completed",
        result: "First",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(1),
      });
      yield* recordTask(parent, rerun, "rerun-again", {
        status: "running",
        result: null,
        startedAt: at(2),
        completedAt: null,
        updatedAt: at(2),
      });
      // Only the thread the child belongs to holds its result.
      const stranger = yield* createThread("unrelated-parent");
      const misattributed = yield* childOf("misattributed-child");
      yield* recordTask(stranger, misattributed, "misattributed", {
        status: "completed",
        result: "Done",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(1),
      });
      // A provider-native subagent ran on its parent's run, so it has no run of its own.
      const native = yield* childOf("native-child");
      yield* recordTask(parent, native, "native", {
        origin: "provider_native",
        status: "completed",
        result: "Done",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(1),
      });
      yield* createItem(native, yield* createRun(parent), "running");
      // Only its task shows a resumed one working, so no settle rule may take it.
      const resumed = yield* childOf("resumed-native-child");
      yield* recordTask(parent, resumed, "resumed-first", {
        origin: "provider_native",
        status: "completed",
        result: "First",
        startedAt: at(0),
        completedAt: at(1),
        updatedAt: at(1),
      });
      yield* recordTask(parent, resumed, "resumed-again", {
        origin: "provider_native",
        status: "running",
        result: null,
        startedAt: at(2),
        completedAt: null,
        updatedAt: at(2),
      });

      const candidates = new Map(
        (yield* store.getSettlementCandidates()).map((thread) => [
          thread.id,
          [
            thread.parentWorktreePath,
            thread.parentResultAt === null ? null : DateTime.formatIso(thread.parentResultAt),
            thread.pendingBackgroundTasks?.length ?? 0,
            thread.parentDone,
          ],
        ]),
      );
      // While the parent works, only a child whose result it holds is a candidate.
      assert.deepEqual(
        [delivered, native, resumed, failed, rerun, misattributed, parent].map((id) =>
          candidates.get(id),
        ),
        [
          ["/worktrees/parent", DateTime.formatIso(at(3)), 0, false],
          ["/worktrees/parent", DateTime.formatIso(at(1)), 1, false],
          undefined,
          undefined,
          undefined,
          undefined,
          [null, null, 0, true],
        ],
      );

      const parentThread = yield* store.getThread(parent);
      yield* store.apply({
        id: EventId.make("event:settlement:delegating-parent:settled"),
        type: "thread.settled",
        threadId: parent,
        occurredAt: now,
        payload: { ...parentThread, settledOverride: "settled", settledAt: now, updatedAt: now },
      });
      const afterParentSettled = new Map(
        (yield* store.getSettlementCandidates()).map((thread) => [thread.id, thread.parentDone]),
      );
      assert.deepEqual(
        [delivered, native, resumed, failed, rerun, misattributed].map((id) =>
          afterParentSettled.get(id),
        ),
        [true, true, undefined, true, true, true],
      );
    }).pipe(Effect.provide(layerSql)),
);
it.effect("sql: a finished subagent waits for its active parent to hold the result", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* createThread("result-parent");
    const child = yield* createThread("result-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    const ids = () =>
      store.getSettlementCandidates().pipe(Effect.map((rows) => rows.map((row) => row.id)));
    assert.deepEqual(yield* ids(), [parent]);

    const taskId = NodeId.make("node:result-task");
    for (const state of ["pending", "delivered"] as const) {
      yield* store.apply({
        id: EventId.make(`event:settlement:result-task:${state}`),
        type: "subagent.updated",
        threadId: parent,
        nodeId: taskId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: taskId,
          threadId: parent,
          runId: null,
          parentNodeId: NodeId.make("node:result-parent"),
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerThreadId: null,
          childThreadId: child,
          nativeTaskRef: null,
          prompt: "Reply PONG",
          title: null,
          model: null,
          completionDelivery: { state, observedByRunId: null },
          status: "completed",
          result: "PONG",
          startedAt: old,
          completedAt: old,
          updatedAt: now,
        },
      });
      if (state === "pending") {
        yield* createRun(child, "completed");
        assert.deepEqual(yield* ids(), [parent]);
      }
    }
    assert.deepEqual(new Set(yield* ids()), new Set([parent, child]));
  }).pipe(Effect.provide(layerSql)),
);
it.effect("sql: a provider-native subagent with no run settles once its task ends", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* createThread("native-parent");
    const child = yield* createThread("native-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    const ids = () =>
      store.getSettlementCandidates().pipe(Effect.map((rows) => rows.map((row) => row.id)));
    const taskId = NodeId.make("node:native-task");
    for (const status of ["running", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`event:settlement:native-task:${status}`),
        type: "subagent.updated",
        threadId: parent,
        nodeId: taskId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: taskId,
          threadId: parent,
          runId: null,
          parentNodeId: NodeId.make("node:native-parent"),
          origin: "provider_native",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerThreadId: null,
          childThreadId: child,
          nativeTaskRef: null,
          prompt: "Explore",
          title: null,
          model: null,
          status,
          result: status === "completed" ? "Done" : null,
          startedAt: old,
          completedAt: status === "completed" ? old : null,
          updatedAt: now,
        },
      });
      if (status === "running") assert.deepEqual(yield* ids(), [parent]);
    }
    assert.deepEqual(new Set(yield* ids()), new Set([parent, child]));
  }).pipe(Effect.provide(layerSql)),
);
