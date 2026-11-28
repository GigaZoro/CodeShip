import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts/baseSchemas";
import { IDLE_COMPACTION_TEXT, type OrchestrationV2Run } from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { claudeProviderCapabilitiesForHost } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import {
  GUEST_FAILURE,
  READ_ONLY_SHARE_RUN_ACTIVE,
  READ_ONLY_SHARE_UNSUPPORTED,
} from "./GuestShareDecider.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const guestAdapter = (platform: NodeJS.Platform) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(claudeProviderCapabilitiesForHost(platform)),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for guest shares"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerForHost = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "guest-share" },
      ProviderAdapterRegistry.layerFromAdapters([guestAdapter(platform)]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
const layerTest = layerForHost("darwin");

const threadId = ThreadId.make("thread:guest-share");
const shareId = GuestShareId.make("share:one");
const guestMessageId = GuestMessageId.make("guest-message:one");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-guest-share"),
    threadId,
    projectId: ProjectId.make("project:guest-share"),
    title: "Review me",
    modelSelection: { instanceId, model: "claude-sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.guest-share.open",
    commandId: CommandId.make("open-guest-share"),
    threadId,
    shareId,
    host: "env.t3.test",
    access: "approve",
    expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 })),
  });
  return orchestrator;
});

const sendGuestMessage = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    guestMessageId,
    text: "ignored: the server sends the guest's own text",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });

const readOnlyShareId = GuestShareId.make("share:read-only");
const openReadOnly = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  Effect.flatMap(DateTime.now, (now) =>
    orchestrator.dispatch({
      type: "thread.guest-share.open",
      commandId: CommandId.make(id),
      threadId,
      shareId: readOnlyShareId,
      host: "env.t3.test",
      access: "read-only",
      expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 24 })),
    }),
  );

it.effect("redeems a guest link once and sends each guest message once, with its turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const redeem = (id: string) =>
      orchestrator.dispatch({
        type: "thread.guest-share.redeem",
        commandId: CommandId.make(id),
        threadId,
        shareId,
        guestName: "Sam",
      });
    yield* redeem("redeem-1");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(redeem("redeem-2"))));

    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-1"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why not keep the old cache?",
    });
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 1);

    yield* sendGuestMessage(orchestrator, "send-1");
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(
      projection.thread.guestShare?.messages.map((message) => message.status),
      ["sent"],
    );
    const sent = projection.messages.find((message) => message.id === MessageId.make("send-1"));
    assert.equal(
      sent?.text,
      "Message from guest Sam, sent by the owner:\n\nWhy not keep the old cache?",
    );
    assert.deepEqual(sent?.context?.guest, {
      guestMessageId,
      name: "Sam",
      text: "Why not keep the old cache?",
      shareId,
    });
    assert.lengthOf(projection.runs, 1);
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 0);

    // A second owner device clicking Send must not start another turn.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-2"))));
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects guest messages until the link is redeemed and after archive", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const submit = orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-early"),
      threadId,
      shareId,
      guestMessageId,
      text: "Hello",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(submit)));

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-guest-share"),
      threadId,
    });
    assert.isNull((yield* projections.getThread(threadId)).guestShare ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("drops guest attribution that a client sends on its own message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message"),
      threadId,
      messageId: MessageId.make("owner-message"),
      text: "Mine",
      context: { version: 1, records: [], guest: { guestMessageId, name: "Sam", text: "Mine" } },
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* projections.getThreadProjection(threadId);
    const sent = projection.messages.find(
      (message) => message.id === MessageId.make("owner-message"),
    );
    assert.isUndefined(sent?.context?.guest);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a queued guest message unchanged when the owner tries to edit it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-first"),
      threadId,
      messageId: MessageId.make("owner-first"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-queued"),
      threadId,
      messageId: MessageId.make("send-queued"),
      guestMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);

    const edit = orchestrator.dispatch({
      type: "queued-run.edit",
      commandId: CommandId.make("edit"),
      threadId,
      runId: queued.id,
      text: "My own words",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(edit)));
    const message = (yield* projections.getThreadProjection(threadId)).messages.find(
      (candidate) => candidate.id === MessageId.make("send-queued"),
    );
    assert.equal(message?.context?.guest?.text, "Why?");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shows a guest message as dismissed when the owner cancels its queued send", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-first"),
      threadId,
      messageId: MessageId.make("owner-first"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-queued"),
      threadId,
      messageId: MessageId.make("send-queued"),
      guestMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel"),
      threadId,
      runId: queued.id,
    });
    const { thread } = yield* projections.getThreadProjection(threadId);
    assert.equal(
      thread.guestShare?.messages.find((message) => message.id === guestMessageId)?.status,
      "dismissed",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("brings a settled thread back when its guest sends a request", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle"),
      threadId,
    });
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).thread.settledOverride,
      "settled",
    );
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    const { thread } = yield* projections.getThreadProjection(threadId);
    assert.isNull(thread.settledOverride);
    assert.isNull(thread.settledAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("restarts the thread's provider session when a read-only link opens", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const providerSessionId = ProviderSessionId.make("session:before-read-only");
    yield* (yield* EventSink.EventSinkV2).write({
      commandId: CommandId.make("attach-session"),
      events: [
        {
          id: EventId.make("attach-session"),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: "claude-sonnet",
            capabilities: claudeProviderCapabilitiesForHost("darwin"),
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
      ],
    });
    // A watched pull request is the server's work, which a session restart leaves running.
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("watch-pull-request"),
      threadId,
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 1,
      watching: true,
      link: { url: "https://github.com/pingdotgg/t3code/pull/1", source: "agent" },
    });

    yield* openReadOnly(orchestrator, "open-read-only");
    assert.deepEqual(
      (yield* outbox.listByCommandId(CommandId.make("open-read-only"))).map(
        (effect) => effect.request,
      ),
      [
        {
          type: "provider-session.detach",
          providerSessionId,
          detail: "Read-only guest link opened.",
        },
      ],
    );
    assert.equal((yield* projections.getThread(threadId)).guestShare?.access, "read-only");
    assert.isTrue((yield* projections.getThreadShell(threadId))?.readOnlyGuestShare);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps the owner-reviewed link on hosts that only support ordinary file restrictions",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const refused = yield* Effect.flip(openReadOnly(orchestrator, "open-unsupported"));
      assert.equal(
        refused._tag === "OrchestratorDispatchError" ? refused.cause : refused._tag,
        READ_ONLY_SHARE_UNSUPPORTED,
      );
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.equal((yield* projections.getThread(threadId)).guestShare?.access, "approve");
    }).pipe(Effect.provide(layerForHost("linux"))),
);

it.effect("refuses a read-only link while a run is active", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-run"),
      threadId,
      messageId: MessageId.make("owner-run"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const refused = yield* Effect.flip(openReadOnly(orchestrator, "open-while-running"));
    assert.equal(
      refused._tag === "OrchestratorDispatchError" ? refused.cause : refused._tag,
      READ_ONLY_SHARE_RUN_ACTIVE,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("takes one read-only guest message at a time", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    yield* openReadOnly(orchestrator, "open-read-only");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId: readOnlyShareId,
      guestName: "Sam",
    });
    const submit = (id: string) =>
      orchestrator.dispatch({
        type: "thread.guest-message.submit",
        commandId: CommandId.make(id),
        threadId,
        shareId: readOnlyShareId,
        guestMessageId: id === "submit" ? guestMessageId : GuestMessageId.make(id),
        text: "Where is the cache?",
      });
    const refusal = (error: Orchestrator.OrchestratorV2Error) =>
      error._tag === "OrchestratorDispatchError" ? error.cause : error._tag;

    yield* submit("submit");
    const whilePending = yield* Effect.flip(submit("submit-while-pending"));
    yield* sendGuestMessage(orchestrator, "send");
    const whileRunning = yield* Effect.flip(submit("submit-while-running"));

    assert.deepEqual(
      [refusal(whilePending), refusal(whileRunning)],
      [GUEST_FAILURE.running, GUEST_FAILURE.running],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "tells the agent a guest message came through a read-only link, and keeps its run read-only",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const readOnlyShell = Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(
          shell?.readOnlyGuestShare,
          ProjectionStore.threadShellFromProjection(projection).readOnlyGuestShare,
        );
        return shell?.readOnlyGuestShare;
      });
      yield* openReadOnly(orchestrator, "open-read-only");
      yield* orchestrator.dispatch({
        type: "thread.guest-share.redeem",
        commandId: CommandId.make("redeem"),
        threadId,
        shareId: readOnlyShareId,
        guestName: "Sam",
      });
      yield* orchestrator.dispatch({
        type: "thread.guest-message.submit",
        commandId: CommandId.make("submit"),
        threadId,
        shareId: readOnlyShareId,
        guestMessageId,
        text: "Where is the cache?",
      });
      yield* sendGuestMessage(orchestrator, "send");
      const sent = (yield* projections.getThreadProjection(threadId)).messages.find(
        (message) => message.id === MessageId.make("send"),
      );
      assert.equal(
        sent?.text,
        "Message from guest Sam, through a read-only guest link:\n\nWhere is the cache?",
      );

      // The link closing must not let the run, or a continuation of its work, write.
      yield* orchestrator.dispatch({
        type: "thread.guest-share.close",
        commandId: CommandId.make("close"),
        threadId,
      });
      const guestRun = (yield* projections.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === MessageId.make("send"),
      );
      assert.isTrue(guestRun?.readOnlyGuestShare);
      assert.isTrue(yield* readOnlyShell);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue"),
        threadId,
        messageId: MessageId.make("continue"),
        text: "Continue",
        attachments: [],
        automaticContinuationOfRunId: guestRun!.id,
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "server",
      });
      const runs = (yield* projections.getThreadProjection(threadId)).runs;
      assert.deepEqual(
        runs.map((run) => [run.userMessageId, run.readOnlyGuestShare]),
        [
          [MessageId.make("send"), true],
          [MessageId.make("continue"), true],
        ],
      );
      const finishRuns = (batch: ReadonlyArray<OrchestrationV2Run>) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* (yield* EventSink.EventSinkV2).write({
            commandId: CommandId.make(`finish-batch-${batch[0]!.id}`),
            events: batch.map((run) => ({
              id: EventId.make(`finish-${run.id}`),
              type: "run.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...run, status: "completed" as const, startedAt: now, completedAt: now },
            })),
          });
        });
      yield* finishRuns(runs);
      assert.isTrue(yield* readOnlyShell);
      for (const idleCompaction of ["beforeCacheExpires", "onReturn"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(idleCompaction),
          threadId,
          messageId: MessageId.make(idleCompaction),
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          idleCompaction,
          createdBy: idleCompaction === "onReturn" ? "user" : "agent",
          creationSource: idleCompaction === "onReturn" ? "web" : "server",
        });
      }
      assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, runs.length);
      assert.isTrue(yield* readOnlyShell);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("owner-work"),
        threadId,
        messageId: MessageId.make("owner-work"),
        text: "Start my own work",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.isUndefined(yield* readOnlyShell);
    }).pipe(Effect.provide(layerTest)),
);
