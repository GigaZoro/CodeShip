import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestratorMcpThreadReadInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ProviderThreadId,
  type Project,
  type ServerProvider,
  type RepositoryIdentity,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as SharedSettings from "../sharedSettings/SharedSettings.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as CommandRunner from "../commandRunner/CommandRunner.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as PeerLinkBack from "./PeerLinkBack.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";

// The laptop's agent delegates a task to the box through a link. The box is
// its real /mcp behind real OAuth, with one thread the test finishes; the
// laptop is its real orchestrator and toolkits. The parent here wakes as it
// would for a local child.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

/** The thread the box launches for the task, which the test finishes. */
interface TimelineEntry {
  readonly id: TurnItemId;
  readonly runId: RunId;
  readonly text: string;
  readonly type: "assistant_message" | "error";
}

interface BoxThread {
  readonly timeline: Ref.Ref<ReadonlyArray<TimelineEntry> | null>;
  readonly pageSize: Ref.Ref<number>;
  readonly holdRefill: Ref.Ref<boolean>;
  readonly beforeTail: Ref.Ref<Effect.Effect<void>>;
  readonly launchCalls: Ref.Ref<number>;
  readonly launched: Ref.Ref<ThreadLaunch.ThreadLaunchInput | null>;
  readonly status: Ref.Ref<OrchestrationV2Run["status"]>;
  readonly reply: Ref.Ref<string | null>;
  readonly error: Ref.Ref<string | null>;
  readonly laterError: Ref.Ref<string | null>;
  /** A later run's reply, after the task's own, as a follow-up message would leave. */
  readonly laterReply: Ref.Ref<string | null>;
  /** The reply of a run queued there behind the later one; once set, the thread settles on it. */
  readonly queuedReply: Ref.Ref<string | null>;
  /** A run there restarted, which its continuation finished with this reply. */
  readonly restart: Ref.Ref<{ readonly of: RunId; readonly reply: string } | null>;
  /** The model the provider there reported running the task's run. */
  readonly executedModel: Ref.Ref<string | null>;
  /** The run each wait asked for, in order. */
  readonly waitedFor: Ref.Ref<ReadonlyArray<RunId | undefined>>;
  /** The thread's run ends with a task of its own still running, whose result wakes it again. */
  readonly nested: Ref.Ref<boolean>;
  /** Completed once a wait there blocks on that task. */
  readonly nestedWaiting: Deferred.Deferred<void>;
  /** That task settled and the run it woke answered, with `laterReply`. */
  readonly nestedSettled: Deferred.Deferred<void>;
  /** Waiting there fails with this, as a thread deleted there does. */
  readonly gone: Ref.Ref<boolean>;
  readonly interrupted: Ref.Ref<number>;
  /** What each interrupt or stop there did, once per command id. */
  readonly stops: Ref.Ref<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>;
  /** The launch starts no run, as one recorded before its run was kept. */
  readonly runless: Ref.Ref<boolean>;
  /** Completed on the first interrupt there. */
  readonly interruptedOnce: Deferred.Deferred<void>;
  readonly finished: Deferred.Deferred<void>;
  /** Ends the later run a message sent there started, for a wait pinned to it. */
  readonly laterFinished: Deferred.Deferred<void>;
  /** While set, reading the thread there waits: completed once a read starts, released by `releaseRead`. */
  readonly holdRead: Ref.Ref<boolean>;
  readonly readStarted: Deferred.Deferred<void>;
  readonly releaseRead: Deferred.Deferred<void>;
  readonly holdFirstStop: Ref.Ref<boolean>;
  readonly stopStarted: Deferred.Deferred<void>;
  readonly releaseStop: Deferred.Deferred<void>;
  /** Messages sent to the thread there after its launch, each starting a later run. */
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  /** Runs as the launch there is answered, before the laptop hears back. */
  readonly afterLaunch: Ref.Ref<Effect.Effect<void>>;
  /** The threads settled there, in order. */
  readonly settles: Ref.Ref<ReadonlyArray<ThreadId>>;
  /** Completed on the first settle recorded there. */
  readonly settledOnce: Deferred.Deferred<void>;
  /** Settles there fail this many times first, as on a machine too busy to record them. */
  readonly dropSettles: Ref.Ref<number>;
  /** The thread there waits on a question its run asked. */
  readonly question: Ref.Ref<boolean>;
  /** A run after the task's own on the thread there, with this status. */
  readonly laterRun: Ref.Ref<OrchestrationV2Run["status"] | null>;
}

const makeBoxThread = Effect.gen(function* () {
  return {
    timeline: yield* Ref.make<ReadonlyArray<TimelineEntry> | null>(null),
    pageSize: yield* Ref.make(1),
    holdRefill: yield* Ref.make(false),
    beforeTail: yield* Ref.make<Effect.Effect<void>>(Effect.void),
    launchCalls: yield* Ref.make(0),
    launched: yield* Ref.make<ThreadLaunch.ThreadLaunchInput | null>(null),
    status: yield* Ref.make<OrchestrationV2Run["status"]>("running"),
    reply: yield* Ref.make<string | null>("Working…"),
    error: yield* Ref.make<string | null>(null),
    laterError: yield* Ref.make<string | null>(null),
    laterReply: yield* Ref.make<string | null>(null),
    queuedReply: yield* Ref.make<string | null>(null),
    restart: yield* Ref.make<{ readonly of: RunId; readonly reply: string } | null>(null),
    executedModel: yield* Ref.make<string | null>(null),
    waitedFor: yield* Ref.make<ReadonlyArray<RunId | undefined>>([]),
    nested: yield* Ref.make(false),
    nestedWaiting: yield* Deferred.make<void>(),
    nestedSettled: yield* Deferred.make<void>(),
    gone: yield* Ref.make(false),
    interrupted: yield* Ref.make(0),
    stops: yield* Ref.make<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>([]),
    runless: yield* Ref.make(false),
    interruptedOnce: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<void>(),
    laterFinished: yield* Deferred.make<void>(),
    holdRead: yield* Ref.make(false),
    readStarted: yield* Deferred.make<void>(),
    releaseRead: yield* Deferred.make<void>(),
    holdFirstStop: yield* Ref.make(false),
    stopStarted: yield* Deferred.make<void>(),
    releaseStop: yield* Deferred.make<void>(),
    sent: yield* Ref.make<ReadonlyArray<string>>([]),
    afterLaunch: yield* Ref.make<Effect.Effect<void>>(Effect.void),
    settles: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
    settledOnce: yield* Deferred.make<void>(),
    dropSettles: yield* Ref.make(0),
    question: yield* Ref.make(false),
    laterRun: yield* Ref.make<OrchestrationV2Run["status"] | null>(null),
  } satisfies BoxThread;
});

const boxScratchProject = ProjectId.make("project:box-scratch");

/** The box's projects: its No project, more than a page of others, and this repository's last. */
const boxProjects: ReadonlyArray<Project> = [
  {
    id: boxScratchProject,
    title: "No project",
    workspaceRoot: "/srv/scratch",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  },
  ...Array.from({ length: 120 }, (_, index) => ({
    id: ProjectId.make(`project:box-other-${index}`),
    title: `other ${index}`,
    workspaceRoot: `/srv/other-${index}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  })),
  {
    id: boxProject,
    title: "app",
    workspaceRoot: "/srv/app",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/app.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  },
];

/** The box's own accounts: its codex instance is not named like the laptop's. */
const boxCodex = ProviderInstanceId.make("codex_box");
const boxClaude = ProviderInstanceId.make("claudeAgent_box");
const readyProvider = {
  enabled: true,
  installed: true,
  availability: "available",
  status: "ready",
  auth: { status: "authenticated" },
  models: [],
};
const boxProviders = [
  { ...readyProvider, instanceId: boxCodex, driver },
  { ...readyProvider, instanceId: boxClaude, driver: ProviderDriverKind.make("claudeAgent") },
] as unknown as ReadonlyArray<ServerProvider>;
/** The laptop's own account, which names its model by an alias and has Ultracode as an option. */
const laptopProviders = [
  {
    ...readyProvider,
    instanceId,
    driver,
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        aliases: ["gpt"],
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra high" },
              ],
            },
            { id: "ultracode", label: "Ultracode", type: "boolean" },
          ],
        },
      },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

interface BoxLaunch {
  input: ThreadLaunch.ThreadLaunchInput;
  state: BoxThread;
  runId: RunId;
  laterRunId: RunId;
}

const serveBox = (
  thread: BoxThread,
  projects = boxProjects,
  providers?: ReadonlyArray<ServerProvider>,
  projectRegistration?: typeof McpHttpServer.layerProjectRegistration,
) => {
  const launches = new Map<ThreadId, BoxLaunch>();
  return servePeer(
    box,
    boxToolkitLayer(thread, projects, launches, providers, projectRegistration),
  ).pipe(Effect.map((peer) => ({ ...peer, launches })));
};

/** The model a delegated task was launched with on the box. */
const launchedSelection = (
  b: { readonly launches: Map<ThreadId, BoxLaunch> },
  result: { readonly structuredContent?: unknown },
) => {
  const { remoteChild } = result.structuredContent as { remoteChild: { threadId: ThreadId } };
  return b.launches.get(remoteChild.threadId)?.input.modelSelection;
};

/** A box from before `inheritedOptionIds`: its launch takes no such argument. */
const { inheritedOptionIds: _inheritedOptionIds, ...olderLaunchFields } =
  ProjectToolkit.tools.t3_thread_launch.parametersSchema.fields;
const layerOlderProjectRegistration = McpHttpServer.toolkitRegistration(
  Toolkit.make(
    ...Object.values({
      ...ProjectToolkit.tools,
      t3_thread_launch: ProjectToolkit.tools.t3_thread_launch.setParameters(
        Schema.Struct(olderLaunchFields),
      ),
    }),
  ) as unknown as typeof ProjectToolkit,
  ProjectHandlers.layer,
);

const boxRunId = RunId.make("run:box");
const boxLaterRunId = RunId.make("run:box-later");
const boxQueuedRunId = RunId.make("run:box-queued");
const continuationOf = (runId: RunId) => RunId.make(`${runId}:restarted`);

const boxToolkitLayer = (
  thread: BoxThread,
  projects: ReadonlyArray<Project>,
  launches: Map<ThreadId, BoxLaunch>,
  providers: ReadonlyArray<ServerProvider> = boxProviders,
  projectRegistration: typeof McpHttpServer.layerProjectRegistration = McpHttpServer.layerProjectRegistration,
) => {
  const interrupts = new Set<string>();
  const shellOf = (threadId: ThreadId) => {
    const input = launches.get(threadId)?.input;
    return Effect.succeed(
      input
        ? {
            ...liveThreadShell(threadId, input),
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            providerInstanceId: input.modelSelection.instanceId,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            ...(input.linkOrigin && { linkOrigin: input.linkOrigin }),
          }
        : null,
    );
  };
  const runOf = (threadId: ThreadId, status: OrchestrationV2Run["status"]) =>
    ({
      id: launches.get(threadId)!.runId,
      threadId,
      ordinal: 1,
      status,
      modelSelection,
      activeAttemptId: "attempt:box",
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: DateTime.makeUnsafe(0),
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const projectionOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      const launch = launches.get(threadId);
      if (!launch || !shell) return null as never;
      const { state, input, runId, laterRunId } = launch;
      const status = yield* Ref.get(state.status);
      const runless = yield* Ref.get(state.runless);
      const laterRun = yield* Ref.get(state.laterRun);
      const question = yield* Ref.get(state.question);
      const model = yield* Ref.get(state.executedModel);
      return {
        ...idleThreadProjection(shell),
        runs:
          runless || !input.initialMessage?.messageId
            ? []
            : [
                {
                  ...runOf(threadId, status),
                  userMessageId: input.initialMessage.messageId,
                },
                ...(laterRun === null
                  ? []
                  : [{ ...runOf(threadId, laterRun), id: laterRunId, ordinal: 2 }]),
              ],
        runtimeRequests: question
          ? [
              {
                id: "request:box-question",
                runId,
                kind: "user_input",
                status: "pending",
              } as never,
            ]
          : [],
        providerTurns: (model === null
          ? []
          : [{ runAttemptId: "attempt:box", ordinal: 1, model }]) as never,
      };
    });
  // One record per command id, as its receipt replays a repeat.
  const recordStop = (
    threadId: ThreadId,
    commandId: string,
    kind: "interrupt" | "thread.stop" | "delegated-tasks",
  ) =>
    Effect.gen(function* () {
      const thread = launches.get(threadId)!.state;
      if (interrupts.has(`${kind}:${commandId}`)) return;
      interrupts.add(`${kind}:${commandId}`);
      yield* Ref.update(thread.stops, (seen) => [...seen, kind]);
      if (kind !== "delegated-tasks") {
        yield* Ref.update(thread.interrupted, (count) => count + 1);
        yield* Deferred.succeed(thread.interruptedOnce, undefined);
      }
    });
  const layerBoxThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    waitForThread: (input) =>
      Effect.gen(function* () {
        const { state: thread, runId, laterRunId } = launches.get(input.threadId)!;
        yield* Ref.update(thread.waitedFor, (seen) => [...seen, input.runId]);
        // A thread with no run has nothing to wait for.
        if (yield* Ref.get(thread.runless)) {
          return { threadId: input.threadId, run: null, timedOut: false };
        }
        if (yield* Ref.get(thread.gone)) {
          return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
            projectId: boxProject,
            threadId: input.threadId,
          });
        }
        // The queued run's own task stays open while the follow-up ahead of it settles.
        if (input.runId === boxQueuedRunId) return yield* Effect.never;
        if (input.runId === laterRunId) {
          const laterDone = yield* Deferred.await(thread.laterFinished).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          // Settled, the thread's answer is the run queued behind it, once there is one.
          const queued =
            Option.isSome(laterDone) &&
            input.untilDelegatedWorkSettled === true &&
            (yield* Ref.get(thread.queuedReply)) !== null;
          // A restarted run is reported as its continuation, as the box follows the chain.
          const restarted = (yield* Ref.get(thread.restart))?.of;
          const latest = (runId: RunId) => (runId === restarted ? continuationOf(runId) : runId);
          return {
            threadId: input.threadId,
            run: {
              id: latest(laterRunId),
              status: Option.isSome(laterDone) ? "completed" : "running",
            } as OrchestrationV2Run,
            timedOut: Option.isNone(laterDone),
            ...(queued
              ? {
                  resultRun: {
                    id: latest(boxQueuedRunId),
                    status: "completed",
                  } as OrchestrationV2Run,
                }
              : {}),
          };
        }
        const done = yield* Deferred.await(thread.finished).pipe(
          Effect.timeoutOption(input.timeoutMs),
        );
        // Only a waiter that asks waits past the run for the thread's own task.
        if (
          Option.isSome(done) &&
          input.untilDelegatedWorkSettled === true &&
          (yield* Ref.get(thread.nested))
        ) {
          yield* Deferred.succeed(thread.nestedWaiting, undefined);
          const settled = yield* Deferred.await(thread.nestedSettled).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          return {
            threadId: input.threadId,
            run: { id: runId, status: yield* Ref.get(thread.status) } as OrchestrationV2Run,
            timedOut: Option.isNone(settled),
            ...(Option.isSome(settled)
              ? { resultRun: { id: laterRunId, status: "completed" } as OrchestrationV2Run }
              : {}),
          };
        }
        // Unpinned, a wait reports the latest run: a later one once there is one.
        const later = input.runId === undefined && (yield* Ref.get(thread.laterReply)) !== null;
        return {
          threadId: input.threadId,
          run: {
            id: later ? laterRunId : runId,
            status: later ? "completed" : yield* Ref.get(thread.status),
          } as OrchestrationV2Run,
          timedOut: Option.isNone(done),
        };
      }),
    getTimelinePage: (threadId, options) =>
      Effect.gen(function* () {
        const { state: thread, runId, laterRunId } = launches.get(threadId)!;
        if (options.afterPosition === 299 && options.itemId === undefined) {
          yield* Ref.getAndSet(thread.beforeTail, Effect.void).pipe(Effect.flatten);
        }
        if (
          (yield* Ref.get(thread.holdRead)) ||
          (options.itemId !== undefined && (yield* Ref.get(thread.holdRefill)))
        ) {
          yield* Deferred.succeed(thread.readStarted, undefined);
          yield* Deferred.await(thread.releaseRead);
        }
        const reply = yield* Ref.get(thread.reply);
        const later = yield* Ref.get(thread.laterReply);
        const queued = yield* Ref.get(thread.queuedReply);
        const error = yield* Ref.get(thread.error);
        const laterError = yield* Ref.get(thread.laterError);
        const restart = yield* Ref.get(thread.restart);
        // One item per page, with errors available only in the activity view.
        const replies = (
          (yield* Ref.get(thread.timeline)) ?? [
            ...(reply === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:reply"),
                    runId,
                    text: reply,
                    type: "assistant_message",
                  },
                  ...(queued === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:queued-reply"),
                          runId: boxQueuedRunId,
                          text: queued,
                          type: "assistant_message",
                        },
                      ]),
                  ...(restart === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:restarted-reply"),
                          runId: continuationOf(restart.of),
                          text: restart.reply,
                          type: "assistant_message",
                        },
                      ]),
                ]),
            ...(error === null
              ? []
              : [{ id: TurnItemId.make("item:error"), runId, text: error, type: "error" }]),
            ...(later === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:later-reply"),
                    runId: laterRunId,
                    text: later,
                    type: "assistant_message",
                  },
                  ...(queued === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:queued-reply"),
                          runId: boxQueuedRunId,
                          text: queued,
                          type: "assistant_message",
                        },
                      ]),
                  ...(restart === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:restarted-reply"),
                          runId: continuationOf(restart.of),
                          text: restart.reply,
                          type: "assistant_message",
                        },
                      ]),
                ]),
            ...(laterError === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:later-error"),
                    runId: laterRunId,
                    text: laterError,
                    type: "error",
                  },
                  ...(queued === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:queued-reply"),
                          runId: boxQueuedRunId,
                          text: queued,
                          type: "assistant_message",
                        },
                      ]),
                  ...(restart === null
                    ? []
                    : [
                        {
                          id: TurnItemId.make("item:restarted-reply"),
                          runId: continuationOf(restart.of),
                          text: restart.reply,
                          type: "assistant_message",
                        },
                      ]),
                ]),
            ...(queued === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:queued-reply"),
                    runId: boxQueuedRunId,
                    text: queued,
                    type: "assistant_message",
                  },
                ]),
            ...(restart === null
              ? []
              : [
                  {
                    id: TurnItemId.make("item:restarted-reply"),
                    runId: continuationOf(restart.of),
                    text: restart.reply,
                    type: "assistant_message",
                  },
                ]),
          ]
        ).map((entry, position) => ({ ...entry, position }));
        const visible =
          options.itemId === undefined
            ? replies.filter(
                (entry) => options.view === "activity" || entry.type === "assistant_message",
              )
            : replies.filter((entry) => entry.id === options.itemId);
        const matching = visible
          .filter((entry) => entry.position > (options.afterPosition ?? -1))
          .slice(0, yield* Ref.get(thread.pageSize));
        return {
          items: matching.map(({ id, runId: itemRunId, text, position, type }) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: threadId,
            sourceItemId: id,
            item: {
              id,
              threadId,
              runId: itemRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed" as const,
              title: null,
              startedAt: DateTime.makeUnsafe(0),
              completedAt: DateTime.makeUnsafe(0),
              updatedAt: DateTime.makeUnsafe(0),
              ...(type === "error"
                ? { type, failure: { message: text } }
                : {
                    type: "assistant_message" as const,
                    messageId: MessageId.make(`message:${id}`),
                    text,
                    streaming: false,
                  }),
            } as never,
          })),
          totalItems: replies.length,
          hasMore:
            options.itemId === undefined &&
            matching.length > 0 &&
            visible.some((entry) => entry.position > matching.at(-1)!.position),
          hasEarlier: false,
        };
      }),
    interruptThread: (input) =>
      recordStop(input.threadId, input.commandId, "interrupt").pipe(
        Effect.as({ type: "interrupt_requested", run: runOf(input.threadId, "running") } as never),
      ),
    dispatch: (command) =>
      command.type === "thread.stop"
        ? recordStop(command.threadId, command.commandId, "thread.stop").pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const thread = launches.get(command.threadId)!.state;
                if (!(yield* Ref.getAndSet(thread.holdFirstStop, false))) return;
                yield* Deferred.succeed(thread.stopStarted, undefined);
                yield* Deferred.await(thread.releaseStop);
              }),
            ),
            Effect.as({ sequence: 0, storedEvents: [] } as never),
          )
        : Effect.die(`The box does not expect ${command.type}`),
    stopDelegatedTasks: (input) => recordStop(input.threadId, input.commandId, "delegated-tasks"),
    organizeThread: (input) => {
      const thread = launches.get(input.threadId)!.state;
      return input.action === "settle"
        ? Ref.modify(thread.dropSettles, (left) => [left, Math.max(0, left - 1)]).pipe(
            Effect.flatMap((left) =>
              left > 0
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: input.commandId,
                      commandType: "thread.settle",
                    }),
                  )
                : Ref.update(thread.settles, (seen) => [...seen, input.threadId]).pipe(
                    Effect.andThen(Deferred.succeed(thread.settledOnce, undefined)),
                    Effect.as({ sequence: 0 }),
                  ),
            ),
          )
        : Effect.die(`The box does not expect ${input.action}`);
    },
    sendToThread: (input) => {
      const { state: thread, laterRunId } = launches.get(input.threadId)!;
      return Ref.update(thread.sent, (seen) => [...seen, input.text]).pipe(
        Effect.as(
          (input.mode === "queue"
            ? { run: { id: boxQueuedRunId, status: "queued" }, delivery: "queued" }
            : { run: { id: laterRunId, status: "running" }, delivery: "started" }) as never,
        ),
      );
    },
  });
  const layerBoxLaunches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    checkWorktreeBase: () => Effect.void,
    launch: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(thread.launchCalls, (count) => count + 1);
        const threadId = input.threadId!;
        const accepted = launches.get(threadId);
        if (accepted) {
          if (accepted.input.commandId !== input.commandId)
            return yield* Effect.die("A different command already launched this box thread");
          return { threadId, projection: yield* projectionOf(threadId), resumed: true };
        }
        const state = launches.size === 0 ? thread : yield* makeBoxThread;
        launches.set(threadId, {
          state,
          input,
          runId: state === thread ? boxRunId : RunId.make(`run:${threadId}`),
          laterRunId: state === thread ? boxLaterRunId : RunId.make(`later:${threadId}`),
        });
        yield* Ref.set(state.launched, input);
        yield* Effect.flatten(Ref.get(thread.afterLaunch));
        return { threadId, projection: yield* projectionOf(threadId), resumed: false };
      }),
  });
  return Layer.mergeAll(
    McpHttpServer.layerOrchestratorToolkit,
    projectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(layerBoxThreads),
    Layer.provide(layerBoxLaunches),
    Layer.provide(
      Layer.merge(
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(CommandRunner.CommandRunner)({}),
      ),
    ),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
        Layer.mock(PeerLinkBack.PeerLinkBack)({}),
        Layer.mock(SharedSettings.SharedSettings)({}),
        Layer.mock(ThreadSearch.ThreadSearch)({}),
      ),
    ),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/p",
        ensureScratchProject: Effect.succeed({ projectId: boxScratchProject }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-delegation-box-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed(providers.map((provider) => provider.instanceId)),
      }),
    ),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(Option.fromNullishOr(boxProjects.find((project) => project.id === id))),
        // More than a page, so finding the project with this repository pages.
        listPage: ({ cursor, limit }) =>
          Effect.succeed({
            projects: projects.slice(cursor, cursor + limit),
            nextCursor: cursor + limit < projects.length ? cursor + limit : null,
          }),
      }),
    ),
    Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(Layer.merge(ServerSettings.layerTest(), MemoryAdmission.layerTest())),
    Layer.provide(NodeServices.layer),
  );
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "remote-delegation", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "remote-delegation", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/**
 * The laptop: a real orchestrator (in-memory SQLite) whose parent thread has
 * a live run, the real orchestrator toolkit, and RemoteDelegation. Built in
 * its own scope so a test can tear it down and build it again on the same
 * database, as a restart does.
 */
const makeLaptop = (
  database: Context.Context<SqlClient.SqlClient>,
  offers: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
  >,
  /** The laptop's links from before a restart, which keep their sessions there. */
  kept?: Context.Context<Layer.Success<ReturnType<typeof layerLinkingEnvironment>>>,
  {
    /** Runs as each follow attempt here starts, on its follower's fiber. */
    beforeFollow = Effect.void,
    identity = { canonicalKey: "github.com/acme/app" } as RepositoryIdentity,
    /** Whether the parent checkout's commit is on a remote. */
    pushed = true,
  }: {
    readonly beforeFollow?: Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    readonly identity?: RepositoryIdentity;
    readonly pushed?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const linking = kept ?? (yield* layerLinkingEnvironment(laptop).pipe(Layer.build));
    const layerDatabase = Layer.succeedContext(database);
    const adapterRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "remote-delegation-laptop" },
        adapterRegistry,
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => SubscriptionRef.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(
        Layer.mergeAll(layerOrchestrator, ServerSettings.layerTest(), MemoryAdmission.layerTest()),
      ),
    );
    const layerHere = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(Layer.mock(CommandRunner.CommandRunner)({})),
      Layer.provideMerge(
        RemoteDelegation.layer.pipe(
          Layer.provide(
            Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.gen(function* () {
                const threads = yield* ThreadManagement.ThreadManagementService;
                return {
                  ...threads,
                  // Read at each call, so a test's spy on the service's dispatch sees these too.
                  dispatch: (...args: Parameters<typeof threads.dispatch>) =>
                    threads.dispatch(...args),
                  getThreadEventSequence: (threadId: ThreadId) =>
                    beforeFollow.pipe(Effect.andThen(threads.getThreadEventSequence(threadId))),
                };
              }),
            ),
          ),
          Layer.provideMerge(PeerForwarding.layer),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              // A cold enrichment cache: the project itself reports no identity yet.
              getById: () =>
                Effect.succeedSome({
                  workspaceRoot: "/home/me/app",
                  repositoryIdentity: null,
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/p",
              isScratchProject: (projectId) => Effect.succeed(projectId === laptopScratchProject),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) => Effect.succeed(cwd === "/home/me/app" ? identity : null),
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(PeerLinkBack.PeerLinkBack)({}),
          Layer.mock(SharedSettings.SharedSettings)({}),
        ),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(laptopProviders),
        }),
      ),
      Layer.provide(adapterRegistry),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: () => Effect.succeed({ commitSha: parentCommit } as never),
          execute: () =>
            Effect.succeed({
              stdout: pushed ? "refs/remotes/origin/main\n" : "",
            } as never),
        }),
      ),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      settings: Context.get(linking, ServerSettings.ServerSettingsService),
      orchestrator: Context.get(here, Orchestrator.OrchestratorV2),
      remote: Context.get(here, RemoteDelegation.RemoteDelegation),
      threads: Context.get(here, ThreadManagement.ThreadManagementService),
      projections: Context.get(here, ProjectionStore.ProjectionStoreV2),
      sink: Context.get(here, EventSink.EventSinkV2),
      call: (name: string, args: Record<string, unknown>, scope = parentScope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          ),
    };
  });

const laptopScratchProject = ProjectId.make("project:laptop-scratch");
const parentThreadId = ThreadId.make("thread:laptop-parent");
const parentRunId = RunId.make("run:laptop-parent");
const parentRootNode = NodeId.make("node:laptop-parent:root");
const parentScope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:laptop-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:laptop-parent",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The laptop's parent thread, mid-turn when its agent delegates. */
const seedParent = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  projectId = ProjectId.make("project:laptop"),
  parentModelSelection: ModelSelection = modelSelection,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:laptop-parent");
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-parent"),
      threadId: parentThreadId,
      projectId,
      title: "Laptop parent",
      modelSelection: parentModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* laptopEnv.sink.write({
      commandId: CommandId.make("command:seed:laptop-parent"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread:laptop-parent"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: parentThreadId,
            ownerNodeId: parentRootNode,
            nativeThreadRef: { driver, nativeId: "native:laptop-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-node:laptop-parent"),
          type: "node.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRootNode,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId: null,
            rootNodeId: parentRootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run:laptop-parent"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRunId,
            threadId: parentThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: parentModelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user:laptop-parent"),
            rootNodeId: parentRootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const delegateToBox = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  laptopEnv
    .call("delegate_task", {
      task: "Run the full suite on the box.",
      target: {
        environmentId: box.environmentId,
        providerInstanceId: instanceId,
        model: "gpt-5.4",
      },
      mode: "async",
      clientRequestId: "suite-on-box",
    })
    .pipe(
      Effect.map((result) => {
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        return result.structuredContent as {
          taskId: NodeId;
          status: string;
          childThreadId: null;
          remoteChild: { environmentId: string; threadId: ThreadId; label: string };
          link?: string;
        };
      }),
    );

/** Waits until the task here has the result its thread there ended with. */
const taskResult = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>, taskId: NodeId) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.result !== null,
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

it.effect("the box replays a keyed launch with its original run's current status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const linking = yield* Layer.build(layerLinkingEnvironment(laptop));
      yield* linkTo(Context.get(linking, PeerLinks.PeerLinks), b, "full-access");
      const client = Context.get(linking, PeerMcpClient.PeerMcpClient);
      const hooks = yield* Ref.make(0);
      yield* Ref.set(
        thread.afterLaunch,
        Ref.update(hooks, (count) => count + 1),
      );
      const launch = (clientRequestId: string, message: string) =>
        client.call({
          environmentId: box.environmentId,
          tool: "t3_thread_launch",
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          arguments: {
            projectId: boxProject,
            modelSelection: { instanceId: boxCodex, model: "gpt-5.4" },
            title: "Remote suite",
            clientRequestId,
            message,
          },
          success: ProjectToolkit.tools.t3_thread_launch.successSchema,
        });
      const first = yield* launch("suite-a", "Original suite");
      expect(first).toMatchObject({ runId: boxRunId, status: "running" });
      yield* Ref.set(thread.status, "completed");
      const second = yield* launch("suite-b", "Another suite");
      expect(second.status).toBe("running");
      expect(yield* launch("suite-a", "Changed suite")).toEqual({ ...first, status: "completed" });
      expect(yield* Ref.get(hooks)).toBe(2);
      expect(second.runId).not.toBe(first.runId);
      expect((yield* Ref.get(thread.launched))?.initialMessage?.text).toBe("Original suite");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task delegated to the box wakes the laptop's parent when it ends there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      expect(delegated).toMatchObject({
        status: "running",
        childThreadId: null,
        remoteChild: { environmentId: box.environmentId, label: "Box" },
      });
      // The box launched it in the project with the same repository.
      expect((yield* Ref.get(thread.launched))?.threadId).toBe(delegated.remoteChild.threadId);
      // Its link opens the thread there, so the parent can mention it like any other.
      expect(delegated.link).toBe(
        `[Laptop parent](t3-thread://v2/${box.environmentId}/${delegated.remoteChild.threadId})`,
      );
      // ...naming the parent here, so the thread there links back to it.
      expect((yield* Ref.get(thread.launched))?.delegatedFrom).toEqual({
        environmentId: laptop.environmentId,
        threadId: parentThreadId,
        title: "Laptop parent",
      });
      // A retry with the same key launches nothing new and records nothing new.
      const retried = yield* delegateToBox(a);
      expect(retried.taskId).toBe(delegated.taskId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(1);

      // Its provider there has not started the turn yet.
      yield* Ref.set(thread.status, "starting");
      const starting = yield* a.call("task_status", { taskId: delegated.taskId });
      expect(starting.structuredContent).toMatchObject({
        status: "starting",
        workState: "working",
      });
      yield* Ref.set(thread.status, "running");

      const historyReads: Array<string> = [];
      const historyTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              /\bSELECT\s+payload_json\s+FROM orchestration_v2_projection_(?:runs|context_transfers)\b/i.test(
                query,
              )
            ) {
              historyReads.push(query);
            }
          };
          return span;
        },
      });
      const running = yield* a
        .call("task_status", { taskId: delegated.taskId })
        .pipe(Effect.withTracer(historyTracer));
      expect(running.structuredContent).toMatchObject({
        taskId: delegated.taskId,
        childThreadId: null,
        remoteChild: delegated.remoteChild,
        status: "running",
        workState: "working",
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      });
      // A running task there needs its local row, not the parent's run or transfer history.
      expect(historyReads).toEqual([]);

      yield* Ref.set(thread.reply, "All 412 tests pass on the box.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "All 412 tests pass on the box." });
      // The parent's live run claims the result, as for a child here.
      const parentRun = (yield* a.orchestrator.getThreadProjection(parentThreadId)).runs.find(
        (run) => run.id === parentRunId,
      );
      expect(parentRun?.delegatedCompletion?.delivery?.taskIds).toEqual([delegated.taskId]);
      // The wake is offered after the result commits, so the result can be seen first.
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);

      const messageReads: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              /SELECT[\s\S]*FROM orchestration_v2_projection_messages/i.test(query)
            ) {
              messageReads.push(query);
            }
          };
          return span;
        },
      });
      const status = yield* a
        .call("task_status", { taskId: delegated.taskId })
        .pipe(Effect.withTracer(tracer));
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        summary: "All 412 tests pass on the box.",
      });
      // Delivery validation still reads messages; choosing the observer does not need another read.
      expect(messageReads).toHaveLength(2);
      expect(messageReads.filter((query) => !/\bmessage_id\s+IN\b/i.test(query))).toHaveLength(1);
      const acknowledged = yield* a.projections.getThreadRecords(parentThreadId, ["subagents"], {
        subagentIds: [delegated.taskId],
      });
      expect(acknowledged.subagents[0]?.completionDelivery).toEqual({
        state: "acknowledged",
        observedByRunId: parentRunId,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["no active parent run", "a newer run owned by another provider"] as const)(
  "preserves remote observation guards with %s",
  (observer) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);

        yield* Ref.set(thread.reply, "Remote result remains available.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);
        yield* SubscriptionRef.changes(offers).pipe(
          Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
          Stream.runHead,
        );

        const parent = yield* a.projections.getThreadRecords(
          parentThreadId,
          ["runs", "subagents"],
          {
            subagentIds: [delegated.taskId],
          },
        );
        expect(parent.subagents[0]?.completionDelivery?.state).not.toBe("acknowledged");
        const parentRun = parent.runs.find((run) => run.id === parentRunId);
        if (parentRun === undefined) return yield* Effect.die("The parent run was not seeded.");
        const now = yield* DateTime.now;
        const otherInstanceId = ProviderInstanceId.make("codex-other");
        const observingRun: OrchestrationV2Run =
          observer === "no active parent run"
            ? { ...parentRun, status: "completed", completedAt: now }
            : {
                id: RunId.make("run:laptop-other-provider"),
                threadId: parentThreadId,
                ordinal: parentRun.ordinal + 1,
                providerInstanceId: otherInstanceId,
                modelSelection: { instanceId: otherInstanceId, model: "gpt-5.4" },
                providerThreadId: null,
                userMessageId: MessageId.make("message:laptop-other-provider"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "preparing",
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              };
        yield* a.sink.write({
          commandId: CommandId.make("command:change-remote-result-observer"),
          events: [
            {
              id: EventId.make("event:change-remote-result-observer"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: observingRun.id,
              providerInstanceId: observingRun.providerInstanceId,
              occurredAt: now,
              payload: observingRun,
            },
          ],
        });

        const status = yield* a.call("task_status", { taskId: delegated.taskId });
        if (observer === "no active parent run") {
          expect(status.isError).toBe(true);
          expect(status.content).toEqual([
            {
              type: "text",
              text: JSON.stringify({
                _tag: "OrchestratorMcpFailure",
                code: "parent_not_active",
                message: "The calling provider no longer owns an active thread run.",
              }),
            },
          ]);
          const unacknowledged = yield* a.projections.getThreadRecords(
            parentThreadId,
            ["subagents"],
            { subagentIds: [delegated.taskId] },
          );
          expect(unacknowledged.subagents[0]?.result).toBe("Remote result remains available.");
          expect(unacknowledged.subagents[0]?.completionDelivery?.state).not.toBe("acknowledged");
          return;
        }
        expect(status.isError, JSON.stringify(status.content)).not.toBe(true);
        expect(status.structuredContent).toMatchObject({
          status: "completed",
          summary: "Remote result remains available.",
        });
        const acknowledged = yield* a.projections.getThreadRecords(parentThreadId, ["subagents"], {
          subagentIds: [delegated.taskId],
        });
        expect(acknowledged.subagents[0]?.completionDelivery).toEqual({
          state: "acknowledged",
          observedByRunId: parentRunId,
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "with the beta off here, a task already running there still ends, and no new one starts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);

        yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const refused = yield* a.call("delegate_task", {
          task: "Run the linter on the box.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          mode: "async",
          clientRequestId: "lint-on-box",
        });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain(
          PeerForwarding.linkedEnvironmentsOff.message,
        );
        expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
          1,
        );

        yield* Ref.set(thread.reply, "All 412 tests pass on the box.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "completed",
          result: "All 412 tests pass on the box.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task named only by environment inherits the parent's model, within the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      // The parent runs with full access; the link allows less.
      yield* linkTo(a.links, b, "auto-accept-edits");
      const effort = { id: "reasoningEffort", value: "high" };
      const tier = { id: "serviceTier", value: "priority" };
      // An explicit Standard must survive, or a Daybreak default there would replace it.
      const standard = { id: "cyberAccessProgram", value: "standard" };
      // The parent names its model by the laptop's alias, which the box may map elsewhere.
      yield* seedParent(a, undefined, {
        ...modelSelection,
        model: "gpt",
        options: [effort, tier, standard],
      });

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId, options: { reasoningEffort: "max" } },
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      // The parent's model by its slug and options, the given option over its own, and the
      // link's modes rather than the parent's.
      expect(yield* Ref.get(thread.launched)).toMatchObject({
        modelSelection: {
          ...modelSelection,
          options: [{ ...effort, value: "max" }, tier, standard],
        },
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
      });

      // An alias is the box's to resolve, so it takes only the given options.
      for (const [name, inheritedOptions] of [
        ["gpt", []],
        ["gpt-5.4", [tier, standard]],
      ] as const) {
        const named = yield* a.call("delegate_task", {
          task: "Run the suite on the box.",
          target: {
            environmentId: box.environmentId,
            model: name,
            options: { reasoningEffort: "max" },
          },
          clientRequestId: `named:${name}`,
        });
        expect(named.isError, JSON.stringify(named.content)).toBe(false);
        expect(launchedSelection(b, named)).toEqual({
          ...modelSelection,
          model: name,
          options: [{ ...effort, value: "max" }, ...inheritedOptions],
        });
      }

      // An option given twice is refused, not settled by the merge.
      const repeated = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: {
          environmentId: box.environmentId,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "reasoningEffort", value: "max" },
          ],
        },
        clientRequestId: "repeated",
      });
      expect(repeated.isError).toBe(true);
      expect(JSON.stringify(repeated.content)).toContain(
        "Option reasoningEffort was specified more than once.",
      );

      // Asking for more than the link allows is still refused there.
      const broader = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        runtimeMode: "full-access",
        clientRequestId: "broader",
      });
      expect(broader.isError).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a task there is refused an option the box's model lacks, and drops an inherited one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        // The box's account offers reasoning effort for the parent's model but no service tier.
        const b = yield* serveBox(thread, boxProjects, [
          {
            ...readyProvider,
            instanceId,
            driver,
            models: [
              {
                slug: "gpt-5.4",
                name: "gpt-5.4",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [
                        { id: "low", label: "Low" },
                        { id: "high", label: "High", isDefault: true },
                      ],
                    },
                    {
                      id: "effort",
                      label: "Effort",
                      type: "select",
                      options: [
                        { id: "high", label: "High" },
                        { id: "xhigh", label: "Extra high" },
                      ],
                    },
                    { id: "ultracode", label: "Ultracode", type: "boolean" },
                  ],
                },
              },
            ],
          } as unknown as ServerProvider,
        ]);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a, ProjectId.make("project:laptop"), {
          ...modelSelection,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
            // A legacy effort: xhigh with Ultracode on.
            { id: "effort", value: "ultracode" },
          ],
        });

        // Given options are the box's to refuse, also when they replace every inherited one.
        for (const [key, options] of [
          ["given", [{ id: "serviceTier", value: "fast" }]],
          [
            "given-all",
            [
              { id: "reasoningEffort", value: "low" },
              { id: "serviceTier", value: "fast" },
              { id: "effort", value: "high" },
              { id: "ultracode", value: false },
            ],
          ],
        ] as const) {
          const given = yield* a.call("delegate_task", {
            task: "Run the suite on the box.",
            target: { environmentId: box.environmentId, options },
            clientRequestId: key,
          });
          expect(given.isError, key).toBe(true);
          expect(JSON.stringify(given.content)).toContain(
            "rejected options: Unknown option serviceTier; supported options: reasoningEffort, effort, ultracode.",
          );
        }
        expect(yield* Ref.get(thread.launched)).toBeNull();

        const inherited = yield* a.call("delegate_task", {
          task: "Run the suite on the box.",
          target: { environmentId: box.environmentId },
          clientRequestId: "inherited",
        });
        expect(inherited.isError, JSON.stringify(inherited.content)).toBe(false);
        expect(launchedSelection(b, inherited)).toEqual({
          ...modelSelection,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "effort", value: "xhigh" },
            { id: "ultracode", value: true },
          ],
        });

        // A given effort replaces the legacy one's level and keeps its Ultracode, as here.
        const effort = yield* a.call("delegate_task", {
          task: "Run the suite on the box.",
          target: { environmentId: box.environmentId, options: [{ id: "effort", value: "high" }] },
          clientRequestId: "effort",
        });
        expect(effort.isError, JSON.stringify(effort.content)).toBe(false);
        expect(launchedSelection(b, effort)).toEqual({
          ...modelSelection,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "effort", value: "high" },
            { id: "ultracode", value: true },
          ],
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a box from before inherited options are marked still takes the task, with them all",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread, boxProjects, boxProviders, layerOlderProjectRegistration);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        const parentModel = { ...modelSelection, options: [{ id: "serviceTier", value: "fast" }] };
        yield* seedParent(a, ProjectId.make("project:laptop"), parentModel);

        const result = yield* a.call("delegate_task", {
          task: "Run the suite on the box.",
          target: {
            environmentId: box.environmentId,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        expect(launchedSelection(b, result)).toEqual({
          ...modelSelection,
          options: [
            { id: "serviceTier", value: "fast" },
            { id: "reasoningEffort", value: "high" },
          ],
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task from a No-project chat runs in the box's No project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a, laptopScratchProject);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect((yield* Ref.get(thread.launched))?.projectId).toBe(boxScratchProject);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A fork checkout: its primary key is the upstream remote's, its grouping key origin's. */
const forkIdentity = {
  canonicalKey: "github.com/upstream/app",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "git@github.com:upstream/app.git",
  },
  origin: { canonicalKey: "github.com/acme/app" },
} satisfies RepositoryIdentity;

const upstreamClone: Project = {
  ...boxProjects.at(-1)!,
  id: ProjectId.make("project:box-upstream"),
  title: "upstream app",
  workspaceRoot: "/srv/upstream-app",
  repositoryIdentity: {
    canonicalKey: "github.com/upstream/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:upstream/app.git",
    },
  },
};

/** A fork of acme/app checked out with acme/app as its upstream remote. */
const forkOfFork: Project = {
  ...upstreamClone,
  id: ProjectId.make("project:box-fork-of-fork"),
  title: "my app",
  workspaceRoot: "/srv/my-app",
  repositoryIdentity: {
    ...forkIdentity,
    canonicalKey: "github.com/acme/app",
    origin: { canonicalKey: "github.com/me/app" },
  },
};

it.effect.each([
  {
    side: "here",
    laptopIdentity: forkIdentity,
    // Neither a clone of the upstream there nor a fork of the fork may win over its own copy.
    projects: [...boxProjects, upstreamClone, forkOfFork],
  },
  {
    side: "there",
    laptopIdentity: { canonicalKey: "github.com/acme/app" } as RepositoryIdentity,
    projects: boxProjects.map((project) =>
      project.id === boxProject ? { ...project, repositoryIdentity: forkIdentity } : project,
    ),
  },
])(
  "a fork with an upstream remote $side finds its copy by origin on the other machine",
  ({ laptopIdentity, projects }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread, projects);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers, undefined, { identity: laptopIdentity });
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);

        const result = yield* a.call("delegate_task", {
          task: "Run the suite on the box.",
          target: { environmentId: box.environmentId },
        });
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        expect((yield* Ref.get(thread.launched))?.projectId).toBe(boxProject);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a launch whose reply is lost with the box unreachable is followed once the box is back",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const retries = yield* steppedRetries;
        const a = yield* makeLaptop(database, offers).pipe(
          Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
        );
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        // The thread is there, then the box goes away before the reply arrives.
        yield* Ref.set(
          thread.afterLaunch,
          Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere")).pipe(
            Effect.andThen(Effect.die("reply lost")),
          ),
        );
        const result = yield* a.call("delegate_task", {
          task: "Run the full suite on the box.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          mode: "async",
          clientRequestId: "lost-reply",
        });
        expect(result.isError).toBe(true);
        // The task was on record before the launch, so it is followed, not forgotten.
        expect(yield* a.projections.getOpenRemoteDelegatedTasks).toHaveLength(1);
        yield* Ref.set(b.descriptor, box);
        yield* Ref.set(thread.reply, "Done on the box.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* Queue.offer(retries.retry, undefined);
        const [open] = yield* a.projections.getOpenRemoteDelegatedTasks;
        expect(yield* taskResult(a, open!.taskId)).toMatchObject({ result: "Done on the box." });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task named only by driver runs on the box's own instance of it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId, driverKind: driver, model: "gpt-5.4" },
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect((yield* Ref.get(thread.launched))?.modelSelection).toEqual({
        instanceId: boxCodex,
        model: "gpt-5.4",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a driver the box has no instance of is refused with the box's instances", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId, driverKind: "cursor", model: "auto" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("codex_box (codex), claudeAgent_box");
      expect(yield* Ref.get(thread.launched)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const parentCommit = "0123456789abcdef0123456789abcdef01234567";

it.effect("starts a task there in a new worktree from the parent's pushed commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "auto");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        isolation: "worktree",
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect((yield* Ref.get(thread.launched))?.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: parentCommit,
        startFromOrigin: true,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses worktree isolation for a commit that is not pushed, naming it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers, undefined, { pushed: false });
      yield* linkTo(a.links, b, "auto");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        isolation: "worktree",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(parentCommit);
      expect(yield* Ref.get(thread.launched)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("follows an open task again after the laptop restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // The laptop before the restart delegates, then goes away.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          return yield* delegateToBox(before);
        }),
      );
      // The task finishes on the box while the laptop is down.
      yield* Ref.set(thread.reply, "Finished while you were away.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);

      const after = yield* makeLaptop(database, offers);
      // The link lives in the laptop's own store, so it needs linking again here.
      yield* linkTo(after.links, b, "full-access");
      yield* after.remote.start();
      const task = yield* taskResult(after, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "Finished while you were away." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when the box revokes the link, and cancel interrupts it there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const cancelled = yield* delegateToBox(a);
      const cancel = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        reason: "Not needed",
      });
      expect(cancel.structuredContent).toEqual({
        taskId: cancelled.taskId,
        status: "cancel_requested",
      });
      // Cancelling stops the thread there as Stop does: its queue and its own tasks too.
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      expect(yield* taskResult(a, cancelled.taskId)).toMatchObject({ status: "cancelled" });

      // Cancelling again, once the result is in, still stops what came after it there.
      const again = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        clientRequestId: "cancel-again",
      });
      expect(again.structuredContent).toEqual({ taskId: cancelled.taskId, status: "cancelled" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);
      // ...and a retry of that cancel stops nothing new.
      yield* a.call("task_cancel", { taskId: cancelled.taskId, clientRequestId: "cancel-again" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);

      // A second task, then the box revokes the link before it ends.
      const revoked = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          clientRequestId: "second",
        })
        .pipe(Effect.map((result) => result.structuredContent as { taskId: NodeId }));
      const [session] = yield* b.linkedSessions;
      yield* b.auth.revokeSession(session!.sessionId);
      yield* Deferred.succeed(thread.finished, undefined);
      const failed = yield* taskResult(a, revoked.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toBe(
        "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a delegate and its cancel work with a caller key at the 256-character limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const longKey = "k".repeat(256);

      const launched = yield* a.call("delegate_task", {
        task: "Run the full suite on the box.",
        target: {
          environmentId: box.environmentId,
          providerInstanceId: instanceId,
          model: "gpt-5.4",
        },
        mode: "async",
        clientRequestId: longKey,
      });
      expect(launched.isError, JSON.stringify(launched.content)).toBe(false);
      const { taskId } = launched.structuredContent as { taskId: NodeId };

      const cancel = yield* a.call("task_cancel", { taskId, clientRequestId: longKey });
      expect(cancel.isError, JSON.stringify(cancel.content)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task's result is its own run's whole last reply, not a later run's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Review the diff.",
        role: "review",
        target: { environmentId: box.environmentId },
        clientRequestId: "review-on-box",
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const { taskId } = result.structuredContent as { taskId: NodeId };
      // The role reaches the thread there, as it does a child here.
      expect((yield* Ref.get(thread.launched))?.initialMessage?.text).toBe(
        "Act as the review sub-agent for this task.\n\nReview the diff.",
      );

      // A reply longer than one read, then a later run's reply on the same thread.
      const long = "x".repeat(45_000);
      yield* Ref.set(thread.reply, long);
      yield* Ref.set(thread.laterReply, "Someone else asked a follow-up.");
      yield* Ref.set(thread.executedModel, "gpt-5.4-mini");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, taskId);
      expect(task?.status).toBe("completed");
      expect(task?.result).toBe(
        `Requested model gpt-5.4; the provider reported running gpt-5.4-mini.\n\n${long}`,
      );
      // Every wait was for the run the launch started.
      const waits = yield* Ref.get(thread.waitedFor);
      expect(waits.length).toBeGreaterThan(0);
      expect(waits.every((runId) => runId === boxRunId)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task whose thread there waits on its own task ends with the answer after it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The task's run there ends after delegating a review of its own.
      yield* Ref.set(thread.nested, true);
      yield* Ref.set(thread.reply, "Started a review; I will answer when it reports.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const first = yield* Effect.raceFirst(
        Deferred.await(thread.nestedWaiting).pipe(Effect.as("waiting there" as const)),
        taskResult(a, delegated.taskId).pipe(Effect.as("completed here" as const)),
      );
      expect(first).toBe("waiting there");

      // The review reports and wakes the thread there, whose next run answers.
      yield* Ref.set(thread.laterReply, "The review found two issues; both are fixed.");
      yield* Deferred.succeed(thread.nestedSettled, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "The review found two issues; both are fixed.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["local", "remote"] as const)(
  "replays the first %s delegation when the same request key changes destination",
  (first) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const peer = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, peer, "full-access");
        yield* seedParent(a);

        const local = a.call("delegate_task", {
          task: "Run the suite locally.",
          clientRequestId: "suite-on-box",
        });
        const remote = a.call("delegate_task", {
          task: "Run the suite on the box.",
          clientRequestId: "suite-on-box",
          target: { environmentId: box.environmentId, projectId: boxProject },
        });
        const original = yield* first === "local" ? local : remote;
        expect(original.isError, JSON.stringify(original.content)).toBe(false);

        const replay = yield* first === "local" ? remote : local;
        expect(replay.isError, JSON.stringify(replay.content)).toBe(false);
        expect(replay.structuredContent).toEqual(original.structuredContent);
        expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
          1,
        );
        if (first === "local") expect(yield* Ref.get(thread.launched)).toBeNull();
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("simultaneous local and remote requests with the same key accept one task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const peer = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, peer, "full-access");
      yield* seedParent(a);

      const remoteArrived = yield* Deferred.make<void>();
      const allowRemote = yield* Deferred.make<void>();
      const dispatch = a.threads.dispatch;
      using _dispatch = vi
        .spyOn(a.threads, "dispatch")
        .mockImplementation((command) =>
          command.type === "delegated_task.remote.request"
            ? Deferred.succeed(remoteArrived, undefined).pipe(
                Effect.andThen(Deferred.await(allowRemote)),
                Effect.andThen(dispatch(command)),
              )
            : dispatch(command),
        );
      const pending = yield* delegateToBox(a).pipe(Effect.forkChild);
      yield* Deferred.await(remoteArrived);
      const local = yield* a.call("delegate_task", {
        task: "Run the suite locally.",
        clientRequestId: "suite-on-box",
      });
      expect(local.isError, JSON.stringify(local.content)).toBe(false);

      yield* Deferred.succeed(allowRemote, undefined);
      expect(yield* Fiber.join(pending)).toEqual(local.structuredContent);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(1);
      expect(yield* Ref.get(thread.launched)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const recordedCompletionWake = Effect.fn("test.recordedCompletionWake")(function* (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  taskId: NodeId,
) {
  const commandId = CommandId.make(
    `command:mcp:${encodeURIComponent(parentScope.requestNamespace)}:delegated-task-completion-wake:${encodeURIComponent(taskId)}`,
  );
  const sequence = yield* laptopEnv.threads.acceptedCommandSequence(commandId);
  expect(sequence).toBeDefined();
  const events = yield* laptopEnv.orchestrator.readCommandEvents({
    commandId,
    type: "delegated_task.wake-policy",
  });
  const updates = events.flatMap(({ event }) =>
    event.type === "subagent.updated" ? [event.payload] : [],
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ id: taskId, completionWake: "always" });
  const parent = yield* laptopEnv.threads.getThreadRecords(parentThreadId, ["subagents"], {
    subagentIds: [taskId],
  });
  expect(parent.subagents).toEqual([
    expect.objectContaining({ id: taskId, completionWake: "always" }),
  ]);
  return sequence;
});

it.effect("local and linked waits each record one completion wake for the actual task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox(yield* makeBoxThread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const waiting = yield* Queue.unbounded<void>();
      const readSequence = a.threads.getThreadEventSequence;
      using _sequence = vi
        .spyOn(a.threads, "getThreadEventSequence")
        .mockImplementation((threadId) =>
          readSequence(threadId).pipe(Effect.tap(() => Queue.offer(waiting, undefined))),
        );
      const sequences = [];
      const taskIds = [];
      for (const [key, target] of [
        ["local-review", undefined],
        ["linked-verification", { environmentId: box.environmentId }],
      ] as const) {
        const args = {
          task: "Run the checks.",
          clientRequestId: key,
          mode: "wait",
          timeoutMs: 10,
          ...(target === undefined ? {} : { target }),
        };
        const wait = Effect.gen(function* () {
          const caller = yield* a.call("delegate_task", args).pipe(Effect.forkChild);
          yield* Effect.race(Queue.take(waiting), Fiber.join(caller));
          yield* TestClock.adjust(args.timeoutMs);
          return yield* Fiber.join(caller);
        });
        const initial = yield* wait;
        expect(initial.isError, JSON.stringify(initial.content)).toBe(false);
        const { taskId, waitTimedOut } = initial.structuredContent as {
          taskId: NodeId;
          waitTimedOut: boolean;
        };
        expect(waitTimedOut).toBe(true);
        taskIds.push(taskId);
        const sequence = yield* recordedCompletionWake(a, taskId);
        sequences.push(sequence);
        const retry = yield* wait;
        expect(retry.isError, JSON.stringify(retry.content)).toBe(false);
        expect(retry.structuredContent).toMatchObject({ taskId, waitTimedOut: true });
        expect(yield* recordedCompletionWake(a, taskId)).toBe(sequence);
      }
      expect(new Set(taskIds).size).toBe(2);
      expect(new Set(sequences).size).toBe(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["user_input", "command"] as const)(
  "waiting on a retained local task with a pending %s upgrades its completion wake",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* seedParent(a);
        const commandId = CommandId.make(
          "command:mcp:provider-session%3Alaptop-parent:delegate-task:retained-wait",
        );
        const accepted = yield* a.threads.dispatch({
          type: "delegated_task.request",
          parentThreadId,
          parentRunId,
          parentNodeId: parentRootNode,
          commandId,
          modelSelection,
          createdBy: "agent",
          creationSource: "mcp",
          runtimeMode: "full-access",
          interactionMode: "default",
          task: "Review locally.",
          completionWake: "settled_only",
        });
        const event = accepted.storedEvents.find(
          ({ event }) => event.type === "subagent.updated",
        )?.event;
        if (event?.type !== "subagent.updated" || !event.payload.childThreadId)
          return yield* Effect.die("Missing local task");
        const task = event.payload;
        const threadId = event.payload.childThreadId;
        const [run] = (yield* a.threads.getThreadProjection(threadId)).runs;
        if (!run?.rootNodeId) return yield* Effect.die("Missing child run root");
        const nodeId = run.rootNodeId;
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make("request:retained-child");
        yield* a.sink.write({
          events: [
            {
              id: EventId.make("event:retained-request"),
              type: "runtime-request.updated",
              threadId,
              runId: run.id,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind,
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("session:retained-child"),
                  supportsFeedback: false,
                },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });
        const sql = Context.get(database, SqlClient.SqlClient);
        yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
        const args = {
          task: "Retry",
          clientRequestId: "retained-wait",
          target: { environmentId: box.environmentId },
        };
        const getTask = a.threads
          .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [task.id] })
          .pipe(Effect.map((rows) => rows.subagents[0]));
        expect((yield* a.call("delegate_task", args)).isError).toBe(false);
        expect((yield* getTask)?.completionWake).toBe("settled_only");
        const waited = yield* a.call("delegate_task", { ...args, mode: "wait", timeoutMs: 1000 });
        expect(waited.isError, JSON.stringify(waited.content)).toBe(false);
        expect(waited.structuredContent).toMatchObject({
          taskId: task.id,
          childThreadId: threadId,
          waitTimedOut: false,
          ...(kind === "user_input"
            ? { hasPendingQuestion: true }
            : { pendingApproval: { requestId } }),
        });
        yield* recordedCompletionWake(a, task.id);
        expect(yield* a.threads.acceptedCommandSequence(commandId)).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["remote only", "remote first", "local first", "missing receipt"] as const)(
  "replays the first delegation accepted with the historical remote command id (%s)",
  (order) =>
    Effect.scoped(
      Effect.gen(function* () {
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* seedParent(a);
        const remoteChild = {
          environmentId: box.environmentId,
          threadId: ThreadId.make("thread:legacy-delegation"),
          label: "Box",
        };
        const common = {
          parentThreadId,
          parentRunId,
          parentNodeId: parentRootNode,
          modelSelection,
        };
        const remoteId = CommandId.make(
          "command:mcp:provider-session%3Alaptop-parent:remote-delegate:suite-on-box",
        );
        const remote = a.threads.dispatch({
          ...common,
          type: "delegated_task.remote.request",
          commandId: remoteId,
          task: "Original remote task.",
          driver: ProviderDriverKind.make("remote"),
          remoteChild,
        });
        const local = a.threads.dispatch({
          ...common,
          type: "delegated_task.request",
          commandId: CommandId.make(
            "command:mcp:provider-session%3Alaptop-parent:delegate-task:suite-on-box",
          ),
          task: "Original local task.",
          createdBy: "agent",
          creationSource: "mcp",
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const first = yield* order === "local first" ? local : remote;
        if (order !== "remote only") yield* order === "local first" ? remote : local;
        const event = first.storedEvents.find(
          ({ event }) => event.type === "subagent.updated",
        )?.event;
        if (event?.type !== "subagent.updated") return yield* Effect.die("Missing accepted task");
        if (order === "missing receipt") {
          const sql = Context.get(database, SqlClient.SqlClient);
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${remoteId}`;
        }

        const replay = yield* a.call("delegate_task", {
          task: "Retry with the same key.",
          clientRequestId: "suite-on-box",
          ...(order === "local first" ? { target: { environmentId: box.environmentId } } : {}),
        });
        if (order === "missing receipt") {
          expect(replay.isError).toBe(true);
          expect(JSON.stringify(replay.content)).toContain("acceptance order is unknown");
        } else {
          expect(replay.isError, JSON.stringify(replay.content)).toBe(false);
          expect(replay.structuredContent).toMatchObject({ taskId: event.payload.id });
        }
        expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
          order === "remote only" ? 1 : 2,
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("overlapping delegations with one key launch only the recorded destination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const second = descriptorOf("environment-second-box", "Second box");
      const firstThread = yield* makeBoxThread;
      const secondThread = yield* makeBoxThread;
      const firstBox = yield* serveBox(firstThread);
      const secondBox = yield* servePeer(
        second,
        boxToolkitLayer(secondThread, boxProjects, new Map()),
      );
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, firstBox, "full-access");
      yield* linkTo(a.links, secondBox, "full-access");
      yield* seedParent(a);

      // Both requests have finished preflight when the first recording commits.
      const atRecord = yield* Ref.make(0);
      const both = yield* Deferred.make<void>();
      const dispatch = a.threads.dispatch;
      const record = vi.spyOn(a.threads, "dispatch").mockImplementation((command) =>
        command.type !== "delegated_task.remote.request"
          ? dispatch(command)
          : Effect.gen(function* () {
              if ((yield* Ref.updateAndGet(atRecord, (count) => count + 1)) === 2)
                yield* Deferred.succeed(both, undefined);
              yield* Deferred.await(both);
              return yield* dispatch(command);
            }),
      );
      const submit = (environmentId: typeof box.environmentId) =>
        a.call("delegate_task", {
          target: { environmentId, projectId: boxProject },
          task: "Run the suite.",
          clientRequestId: "concurrent-suite",
          mode: "async",
        });
      const results = yield* Effect.all([submit(box.environmentId), submit(second.environmentId)], {
        concurrency: 2,
      }).pipe(Effect.ensuring(Effect.sync(() => record.mockRestore())));
      for (const result of results)
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const [accepted] = (yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents;
      expect(accepted?.remoteChild).toBeDefined();
      const onFirst = accepted!.remoteChild!.environmentId === box.environmentId;
      for (const result of results)
        expect(result.structuredContent).toMatchObject({
          taskId: accepted!.id,
          remoteChild: { environmentId: accepted!.remoteChild!.environmentId },
        });
      expect((yield* Ref.get(firstThread.launched))?.threadId ?? null).toBe(
        onFirst ? accepted!.remoteChild!.threadId : null,
      );
      expect((yield* Ref.get(secondThread.launched))?.threadId ?? null).toBe(
        onFirst ? null : accepted!.remoteChild!.threadId,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the same key from another provider session is another task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const first = yield* delegateToBox(a);
      const later = yield* a.call(
        "delegate_task",
        {
          task: "Run the full suite on the box.",
          target: { environmentId: box.environmentId },
          clientRequestId: "suite-on-box",
        },
        { ...parentScope, requestNamespace: "provider-session:laptop-parent-2" },
      );
      expect(later.isError, JSON.stringify(later.content)).toBe(false);
      const second = later.structuredContent as {
        taskId: NodeId;
        remoteChild: { threadId: ThreadId };
      };
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.remoteChild.threadId).not.toBe(first.remoteChild.threadId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([null, "Working before the provider failed."])(
  "reports the failed remote run's error instead of its earlier reply (%s)",
  (reply) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, reply);
        const error = "Provider failed: authentication expired on the destination.";
        yield* Ref.set(thread.error, error);
        yield* Ref.set(thread.status, "failed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "failed",
          result: error,
        });
        const status = yield* a.call("task_status", { taskId: delegated.taskId });
        expect(status.structuredContent).toMatchObject({
          status: "failed",
          summary: error,
          latestTerminalSummary: error,
        });
        const offered = yield* SubscriptionRef.changes(offers).pipe(
          Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
          Stream.runHead,
        );
        expect(Option.isSome(offered)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([false, true])(
  "ignores later-run errors and reads the failed run's full error (ownError=%s)",
  (ownError) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, null);
        const error = `Provider failed: ${"detail ".repeat(10_000)}end of error.`;
        if (ownError) yield* Ref.set(thread.error, error);
        yield* Ref.set(thread.laterReply, "A later user run answered.");
        yield* Ref.set(thread.laterError, "Another run's provider error.");
        yield* Ref.set(thread.status, "failed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "failed",
          result: ownError
            ? error
            : "(The thread in the linked environment ended without a reply.)",
        });
        expect(yield* Ref.get(thread.waitedFor)).toEqual([boxRunId]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["tail-error", "middle-error", "reply-fallback", "cancel-refill"] as const)(
  "reads a failed task through full activity pages (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const reads: Array<OrchestratorMcpThreadReadInput> = [];
      const nativeFetch = yield* FetchHttpClient.Fetch;
      const fetch: typeof globalThis.fetch = (input, init) => {
        const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
        if (body?.startsWith("{")) {
          const rpc: {
            method?: string;
            params?: { name?: string; arguments?: OrchestratorMcpThreadReadInput };
          } = JSON.parse(body);
          if (
            rpc.method === "tools/call" &&
            rpc.params?.name === "t3_thread_read" &&
            rpc.params.arguments !== undefined
          ) {
            reads.push(rpc.params.arguments);
          }
        }
        return nativeFetch(input, init);
      };
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const thread = yield* makeBoxThread;
          const b = yield* serveBox(thread);
          const offers = yield* SubscriptionRef.make<
            ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
          >([]);
          const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
          const a = yield* makeLaptop(database, offers);
          yield* linkTo(a.links, b, "full-access");
          yield* seedParent(a);
          const delegated = yield* delegateToBox(a);
          const result = `Provider details: ${"detail ".repeat(8_000)}end.`;
          const middle = scenario !== "tail-error";
          const ownType = scenario === "reply-fallback" ? "assistant_message" : "error";
          const history = (count: number, runId: RunId, prefix: string): Array<TimelineEntry> =>
            Array.from({ length: count }, (_, index) => ({
              id: TurnItemId.make(`${prefix}:${index}`),
              runId,
              text: "discarded history ".repeat(120),
              type: "assistant_message",
            }));
          yield* Ref.set(thread.timeline, [
            ...history(middle ? 150 : 297, boxRunId, "before"),
            { id: TurnItemId.make("selected"), runId: boxRunId, text: result, type: ownType },
            ...(middle ? history(200, boxLaterRunId, "later") : []),
            {
              id: TurnItemId.make("other-error"),
              runId: boxLaterRunId,
              text: "Wrong run",
              type: "error",
            },
          ]);
          yield* Ref.set(thread.pageSize, 100);
          yield* Ref.set(thread.status, "failed");
          if (scenario === "cancel-refill") yield* Ref.set(thread.holdRefill, true);
          yield* Deferred.succeed(thread.finished, undefined);
          if (scenario === "cancel-refill") {
            yield* Deferred.await(thread.readStarted);
            yield* a.threads.stopDelegatedTasks({
              threadId: parentThreadId,
              commandId: CommandId.make("command:stop:mid-refill"),
            });
            yield* Deferred.succeed(thread.releaseRead, undefined);
            expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });
            yield* Deferred.await(thread.interruptedOnce);
            expect(yield* Ref.get(thread.stops)).toContain("thread.stop");
          } else {
            expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
              status: "failed",
              result,
            });
          }
          // Scan pages name their view; the status read delegate_task makes does not.
          const pages = reads.filter((read) => read.view !== undefined);
          // The result budget ends a whole page at 11 history items and a truncated one near 71,
          // so the last 3 items after the truncated pages fit one whole page and the last 56 do not.
          expect(pages.map((read) => read.afterPosition)).toEqual([
            undefined,
            10,
            82,
            153,
            224,
            295,
          ]);
          expect(pages.map((read) => read.maxCharsPerItem)).toEqual([
            20_000,
            1,
            1,
            1,
            1,
            middle ? 1 : 20_000,
          ]);
          const refills = reads.filter((read) => read.itemId !== undefined);
          expect(refills[0]).toMatchObject({ itemId: "selected", textOffset: middle ? 1 : 20_000 });
          if (scenario !== "cancel-refill") expect(refills).toHaveLength(middle ? 3 : 2);
        }),
      ).pipe(
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    }),
);

it.effect.each([
  "terminal",
  "long",
  "later-run",
  "sparse",
  "growing",
  "shrinking",
  "cancel",
  "no-run",
  "cancelled",
  "interrupted",
] as const)("reads a successful task with an aligned tail probe (%s)", (scenario) =>
  Effect.gen(function* () {
    const reads: Array<OrchestratorMcpThreadReadInput> = [];
    const nativeFetch = yield* FetchHttpClient.Fetch;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
      if (body?.startsWith("{")) {
        const rpc: {
          method?: string;
          params?: { name?: string; arguments?: OrchestratorMcpThreadReadInput };
        } = JSON.parse(body);
        if (
          rpc.method === "tools/call" &&
          rpc.params?.name === "t3_thread_read" &&
          rpc.params.arguments !== undefined
        ) {
          reads.push(rpc.params.arguments);
        }
      }
      return nativeFetch(input, init);
    };
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const result =
          scenario === "long"
            ? `Complete ${"detail ".repeat(12_000)}end.`
            : "Authoritative result.";
        const middle = scenario === "later-run" || scenario === "shrinking";
        const history = (count: number, runId: RunId, prefix: string): Array<TimelineEntry> =>
          Array.from({ length: count }, (_, index) => ({
            id: TurnItemId.make(`${prefix}:${index}`),
            runId,
            text: "History",
            type: scenario === "sparse" && index % 2 === 0 ? "error" : "assistant_message",
          }));
        const timeline: Array<TimelineEntry> = [
          ...history(middle ? 150 : 300, boxRunId, "before"),
          {
            id: TurnItemId.make("selected"),
            runId: scenario === "no-run" ? boxLaterRunId : boxRunId,
            text: result,
            type: "assistant_message",
          },
          ...(middle ? history(200, boxLaterRunId, "later") : []),
        ];
        yield* Ref.set(thread.timeline, timeline);
        yield* Ref.set(thread.pageSize, 100);
        if (scenario === "growing") {
          yield* Ref.set(
            thread.beforeTail,
            Ref.set(thread.timeline, [...timeline, ...history(101, boxLaterRunId, "growth")]),
          );
        }
        if (scenario === "shrinking") {
          yield* Ref.set(thread.beforeTail, Ref.set(thread.timeline, timeline.slice(0, 151)));
        }
        if (scenario === "cancel") {
          yield* Ref.set(
            thread.beforeTail,
            Effect.gen(function* () {
              yield* Deferred.succeed(thread.readStarted, undefined);
              yield* Deferred.await(thread.releaseRead);
            }),
          );
        }
        if (scenario === "no-run") yield* Ref.set(thread.runless, true);
        const delegated = yield* delegateToBox(a);
        const status =
          scenario === "cancelled" || scenario === "interrupted" ? scenario : "completed";
        yield* Ref.set(thread.status, status);
        yield* Deferred.succeed(thread.finished, undefined);
        if (scenario === "cancel") {
          yield* Deferred.await(thread.readStarted);
          yield* a.threads.stopDelegatedTasks({
            threadId: parentThreadId,
            commandId: CommandId.make("command:stop:tail-probe"),
          });
          yield* Deferred.succeed(thread.releaseRead, undefined);
          expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });
          yield* Deferred.await(thread.interruptedOnce);
          expect(yield* Ref.get(thread.stops)).toContain("thread.stop");
        } else {
          expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
            status,
            result,
          });
        }
        // Scan pages name their view; the status read delegate_task makes does not.
        const pages = reads.filter((read) => read.view !== undefined);
        // The result budget ends a page of history at about 70 items, and the tail read in
        // "growing" after 69 of the 102 items past position 299.
        const positions =
          scenario === "cancelled" || scenario === "interrupted"
            ? [undefined, 69, 139, 208, 277]
            : scenario === "later-run"
              ? [undefined, 299, 69, 139, 208, 277, 346]
              : scenario === "shrinking"
                ? [undefined, 299, 69, 139]
                : scenario === "growing"
                  ? [undefined, 299, 368]
                  : [undefined, 299];
        expect(pages.map((read) => read.afterPosition)).toEqual(positions);
        expect(
          pages.every(
            (read) =>
              read.view === "messages" && read.limit === 100 && read.maxCharsPerItem === 20_000,
          ),
        ).toBe(true);
        const refills = reads.filter((read) => read.itemId !== undefined);
        expect(refills.map((read) => read.textOffset)).toEqual(
          scenario === "long" ? [20_000, 40_000, 60_000, 80_000] : [],
        );
      }),
    ).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  }),
);

it.effect("keeps a successful remote reply despite an error item in the run's activity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "Recovered and completed the task.");
      yield* Ref.set(thread.error, "A recoverable tool error.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Recovered and completed the task.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when its thread there is gone, or the link here is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      yield* Ref.set(thread.gone, true);
      const gone = yield* delegateToBox(a);
      const failed = yield* taskResult(a, gone.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toContain("was not found");
      expect(yield* Ref.get(thread.launchCalls)).toBe(1);
      const replay = yield* delegateToBox(a);
      expect(replay).toMatchObject({ taskId: gone.taskId, status: "failed" });
      expect(yield* Ref.get(thread.launchCalls)).toBe(1);

      // The link is forgotten here while the task runs there.
      yield* Ref.set(thread.gone, false);
      const forgotten = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: { environmentId: box.environmentId },
          clientRequestId: "forgotten",
        })
        .pipe(
          Effect.map(
            (result) =>
              result.structuredContent as { taskId: NodeId; remoteChild: { threadId: ThreadId } },
          ),
        );
      yield* a.links.unlink(box.environmentId);
      const second = b.launches.get(forgotten.remoteChild.threadId)!.state;
      yield* Ref.set(second.status, "completed");
      yield* Deferred.succeed(second.finished, undefined);
      const unlinked = yield* taskResult(a, forgotten.taskId);
      expect(unlinked?.status).toBe("failed");
      expect(unlinked?.result).toContain("not linked to");
      const offlineReplay = yield* a.call("delegate_task", {
        task: "Replayed after the link was forgotten.",
        target: { environmentId: box.environmentId },
        clientRequestId: "forgotten",
      });
      expect(offlineReplay.isError, JSON.stringify(offlineReplay.content)).toBe(false);
      expect(offlineReplay.structuredContent).toMatchObject({
        taskId: forgotten.taskId,
        status: "failed",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("cancel ends the task here even when the link is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      yield* a.links.unlink(box.environmentId);
      const cancel = yield* a.call("task_cancel", { taskId: delegated.taskId });
      expect(cancel.structuredContent).toEqual({
        taskId: delegated.taskId,
        status: "cancel_requested",
      });
      const task = yield* taskResult(a, delegated.taskId);
      expect(task?.status).toBe("cancelled");
      expect(task?.result).toContain("could not be stopped in Box");
      expect(yield* Ref.get(thread.interrupted)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the task's result is read still stops its thread there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The task's run ends there, and while the follower reads its reply,
      // the parent here is stopped: more work may follow that run there.
      yield* Ref.set(thread.holdRead, true);
      yield* Ref.set(thread.reply, "Done there.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* Deferred.await(thread.readStarted);
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-mid-read"),
      });
      yield* Deferred.succeed(thread.releaseRead, undefined);

      // The Stop's result stands, and the thread there is still stopped.
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.stops)).toContain("thread.stop");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a stop the box refuses because the parent was lowered ends instead of retrying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The parent is lowered below the full-access thread there, then stopped.
      yield* a.orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:lower:laptop-parent"),
        threadId: parentThreadId,
        runtimeMode: "approval-required",
      });
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-lowered"),
      });

      // The box refuses that stop; the follower records it as settled and
      // stops, so nothing retries it, now or after a restart.
      const settled = yield* a.orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.taskId &&
              stored.event.payload.remoteChild?.stoppedThere === true,
          ),
          Stream.runHead,
        );
      expect(Option.isSome(settled)).toBe(true);
      expect(yield* Ref.get(thread.stops)).toEqual([]);
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("stopping the parent stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      // What the delegated-tasks.stop effect runs once the parent's Stop commits.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent"),
        reason: "User stopped",
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "interrupted",
        result: "Stopped with its parent: User stopped",
      });
      // The follower sees it ended here and stops it there.
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/**
 * A follower retry schedule the test steps: each failed attempt is offered, then waits for
 * `retry`. `cut` completes once such a wait is interrupted.
 */
const steppedRetries = Effect.gen(function* () {
  const failed = yield* Queue.unbounded<void>();
  const retry = yield* Queue.unbounded<void>();
  const cut = yield* Deferred.make<void>();
  const schedule = Schedule.forever.pipe(
    Schedule.tap(() =>
      Queue.offer(failed, undefined).pipe(
        Effect.andThen(Queue.take(retry)),
        Effect.onInterrupt(() => Deferred.succeed(cut, undefined).pipe(Effect.asVoid)),
      ),
    ),
  );
  return { failed, retry, cut, schedule };
});

it.effect("a follower that keeps hitting defects fails the task and wakes the parent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      const attempts = yield* Ref.make(0);
      // The defect carries internal detail that the task's result must not.
      const beforeFollow = Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(Effect.die(new Error("A follow attempt hit a bug: defect-detail-4f1c9e"))),
      );
      const a = yield* makeLaptop(database, offers, undefined, { beforeFollow }).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      yield* Queue.take(retries.failed).pipe(
        Effect.andThen(Queue.offer(retries.retry, undefined)),
        Effect.forever,
        Effect.forkScoped,
      );

      const delegated = yield* delegateToBox(a);
      const task = yield* taskResult(a, delegated.taskId);
      expect(yield* Ref.get(attempts)).toBe(3);
      expect(task?.status).toBe("failed");
      expect(task?.result).toContain(delegated.remoteChild.threadId);
      expect(task?.result).not.toContain("defect-detail-4f1c9e");
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["a still-running wait", "a failed attempt"] as const)(
  "defects separated by %s do not add up to giving up",
  (between) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const retries = yield* steppedRetries;
        const attempts = yield* Ref.make(0);
        const defect = Effect.die(new Error("A follow attempt hit a bug."));
        const script = [
          defect,
          between === "a still-running wait"
            ? Effect.void
            : Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId: parentThreadId }),
              ),
          defect,
          between === "a still-running wait"
            ? Effect.void
            : Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId: parentThreadId }),
              ),
          defect,
        ];
        // Past the script, the run there has ended, so the next attempt completes the task.
        const beforeFollow = Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
          Effect.flatMap(
            (count) =>
              script[count] ??
              Ref.set(thread.reply, "All green.").pipe(
                Effect.andThen(Ref.set(thread.status, "completed")),
              ),
          ),
        );
        // Each wait there answers at once that its run is still running.
        yield* Deferred.succeed(thread.finished, undefined);
        const a = yield* makeLaptop(database, offers, undefined, { beforeFollow }).pipe(
          Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
        );
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        yield* Queue.take(retries.failed).pipe(
          Effect.andThen(Queue.offer(retries.retry, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );

        const delegated = yield* delegateToBox(a);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "completed",
          result: "All green.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** Waits until the task here records that the `stopCount`th Stop after its result reached there. */
const stoppedThere = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  taskId: NodeId,
  // `null` for a cancel's stop, which carries no count.
  stopCount: number | null = 1,
) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.remoteChild?.stoppedThere === true &&
          stored.event.payload.remoteChild.stopCount === (stopCount ?? undefined),
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

it.effect("a follower that keeps hitting defects leaves a stop it owes owed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      // Follow attempts hit a defect only once the task has its result.
      const broken = yield* Ref.make(false);
      const follower = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const beforeFollow = Ref.get(broken).pipe(
        Effect.flatMap((isBroken) =>
          isBroken
            ? Effect.withFiber((fiber) => Deferred.succeed(follower, fiber)).pipe(
                Effect.andThen(Effect.die(new Error("A follow attempt hit a bug."))),
              )
            : Effect.void,
        ),
      );
      const a = yield* makeLaptop(database, offers, undefined, { beforeFollow }).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);
      yield* Ref.set(broken, true);
      yield* Queue.take(retries.failed).pipe(
        Effect.andThen(Queue.offer(retries.retry, undefined)),
        Effect.forever,
        Effect.forkScoped,
      );

      // The Stop owes one stop there, which every attempt to send fails on.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-defective-follower"),
      });
      const owedAgain = a.orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.taskId &&
              (stored.event.payload.remoteChild?.stopCount ?? 0) > 1,
          ),
          Stream.runHead,
          Effect.flatMap((owed) =>
            Option.isSome(owed) ? Effect.succeed("owed another stop" as const) : Effect.never,
          ),
        );
      const ended = yield* Deferred.await(follower).pipe(
        Effect.flatMap(Fiber.await),
        Effect.as("follower ended" as const),
        Effect.raceFirst(owedAgain),
      );
      expect(ended).toBe("follower ended");
      const { subagents } = yield* a.threads.getThreadRecords(parentThreadId, ["subagents"], {
        subagentIds: [delegated.taskId],
      });
      expect(subagents[0]).toMatchObject({
        status: "completed",
        result: "All green.",
        remoteChild: { stoppedThere: false, stopCount: 1 },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("stopping the parent stops follow-up work on a task there that has its result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "All green.",
      });

      // The parent sends the thread there a follow-up, which starts a run there as a new task.
      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Now run the slow suite too.",
      });
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false);
      const followUpId = (sent.structuredContent as { taskId: NodeId }).taskId;
      expect(yield* Ref.get(thread.sent)).toEqual(["Now run the slow suite too."]);
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-after-result"),
      });
      // The thread there is stopped as Stop does, for each task, and the first keeps its result.
      const task = yield* stoppedThere(a, delegated.taskId);
      expect(yield* stoppedThere(a, followUpId, null)).toMatchObject({ status: "interrupted" });
      expect((yield* Ref.get(thread.stops)).toSorted()).toEqual([
        "delegated-tasks",
        "delegated-tasks",
        "thread.stop",
        "thread.stop",
      ]);
      expect(task).toMatchObject({ status: "completed", result: "All green." });
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);

      // A second Stop owes a second stop there, not a replay of the first.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-again"),
      });
      expect(yield* stoppedThere(a, delegated.taskId, 2)).toMatchObject({ status: "completed" });
      expect(yield* stoppedThere(a, followUpId, 1)).toMatchObject({ status: "interrupted" });
      expect(yield* Ref.get(thread.interrupted)).toBe(4);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  { order: "sent", queuedFirst: false },
  // Concurrent sends may be recorded here in the opposite order they run there.
  { order: "recorded out of order", queuedFirst: true },
])(
  "a follow-up there ends with its own reply, not one queued behind it ($order)",
  ({ queuedFirst }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* a.remote.start();
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, "All green.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);

        const sendFollowUp = a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Now run the slow suite too.",
        });
        const sendQueued = a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Then the flaky suite.",
          mode: "queue",
        });
        const [first, second] = queuedFirst
          ? [sendQueued, sendFollowUp]
          : [sendFollowUp, sendQueued];
        const firstSent = yield* first;
        yield* TestClock.adjust("1 second");
        const secondSent = yield* second;
        const [followUp, queued] = queuedFirst ? [secondSent, firstSent] : [firstSent, secondSent];
        const followUpId = (followUp.structuredContent as { taskId: NodeId }).taskId;
        expect((queued.structuredContent as { taskId?: NodeId }).taskId).toBeDefined();

        // The thread there settles on the queued run, after the follow-up's own run ended.
        yield* Ref.set(thread.laterReply, "The slow suite passes too.");
        yield* Ref.set(thread.queuedReply, "The flaky suite passes.");
        yield* Deferred.succeed(thread.laterFinished, undefined);
        expect(yield* taskResult(a, followUpId)).toMatchObject({
          status: "completed",
          result: "The slow suite passes too.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  {
    restarted: "follow-up",
    of: boxLaterRunId,
    laterReply: "Running the slow suite…",
    restartReply: "The slow suite passes too.",
    queuedReply: "The flaky suite passes.",
  },
  {
    restarted: "queued",
    of: boxQueuedRunId,
    laterReply: "The slow suite passes too.",
    restartReply: "The flaky suite passes.",
    queuedReply: "Running the flaky suite…",
  },
])(
  "a follow-up there ends with its own reply when the $restarted run is restarted",
  ({ of, laterReply, restartReply, queuedReply }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* a.remote.start();
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, "All green.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);

        const followUp = yield* a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Now run the slow suite too.",
        });
        yield* a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Then the flaky suite.",
          mode: "queue",
        });
        const followUpId = (followUp.structuredContent as { taskId: NodeId }).taskId;

        // The thread there settles on the queued run, after one of the two was restarted.
        yield* Ref.set(thread.laterReply, laterReply);
        yield* Ref.set(thread.queuedReply, queuedReply);
        yield* Ref.set(thread.restart, { of, reply: restartReply });
        yield* Deferred.succeed(thread.laterFinished, undefined);
        expect(yield* taskResult(a, followUpId)).toMatchObject({
          status: "completed",
          result: "The slow suite passes too.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a follow-up sent after the parent's own run ended is still a task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);

      // The parent's turn ends, while a background agent of its own still holds its credential.
      const now = yield* DateTime.now;
      const projection = yield* a.orchestrator.getThreadProjection(parentThreadId);
      const run = projection.runs.find((candidate) => candidate.id === parentRunId)!;
      yield* a.sink.write({
        commandId: CommandId.make("command:seed:laptop-parent-ended"),
        events: [
          {
            id: EventId.make("event:seed-background-agent:laptop-parent"),
            type: "provider-thread.updated",
            threadId: parentThreadId,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              ...projection.providerThreads[0]!,
              pendingBackgroundTasks: [{ taskId: "native-agent", kind: "subagent" }],
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:seed-run-ended:laptop-parent"),
            type: "run.updated",
            threadId: parentThreadId,
            runId: parentRunId,
            nodeId: parentRootNode,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });

      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Now run the slow suite too.",
      });
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false);
      const followUp = sent.structuredContent as { taskId?: NodeId };
      expect(followUp.taskId, JSON.stringify(followUp)).toBeDefined();
      const tasks = (yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents;
      expect(tasks.find((task) => task.id === followUp.taskId)).toMatchObject({
        runId: parentRunId,
        status: "running",
      });

      // Its run there ends with its own reply, and the parent wakes for it.
      const wakes = (
        seen: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>,
      ) => seen.filter((offer) => offer.threadId === parentThreadId).length;
      const wokenBefore = wakes(yield* SubscriptionRef.get(offers));
      yield* Ref.set(thread.laterReply, "The slow suite passes too.");
      yield* Deferred.succeed(thread.laterFinished, undefined);
      expect(yield* taskResult(a, followUp.taskId!)).toMatchObject({
        status: "completed",
        result: "The slow suite passes too.",
      });
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => wakes(seen) > wokenBefore),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  { case: "its run completed", status: "completed", settled: true },
  { case: "its run failed", status: "failed", settled: false },
  { case: "a question waits there", status: "completed", question: true, settled: false },
  { case: "a message is queued there", status: "completed", laterRun: "queued", settled: false },
  { case: "a later run ended there", status: "completed", laterRun: "completed", settled: false },
  { case: "the box dropped the first settle", status: "completed", dropped: true, settled: true },
  {
    case: "a message was queued there after a dropped settle",
    status: "completed",
    dropped: true,
    laterRunAfterDrop: "queued",
    settled: false,
  },
  {
    case: "a Stop came while a dropped settle backed off",
    status: "completed",
    dropped: true,
    stopWhileBackingOff: true,
    settled: false,
  },
  {
    case: "a cancel came while a dropped settle backed off",
    status: "completed",
    dropped: true,
    cancelWhileBackingOff: true,
    settled: false,
  },
] as const)(
  "settles the task's thread there once the parent has its result, only when $case",
  ({
    status,
    question = false,
    laterRun = null,
    dropped = false,
    laterRunAfterDrop,
    stopWhileBackingOff = false,
    cancelWhileBackingOff = false,
    settled,
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const retries = yield* steppedRetries;
        const a = yield* makeLaptop(database, offers).pipe(
          Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
        );
        yield* a.remote.start();
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, "All green.");
        yield* Ref.set(thread.question, question);
        yield* Ref.set(thread.laterRun, laterRun);
        yield* Ref.set(thread.dropSettles, dropped ? 1 : 0);
        yield* Ref.set(thread.status, status);
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status });
        if (dropped) {
          yield* Queue.take(retries.failed);
          if (laterRunAfterDrop !== undefined) {
            yield* Ref.set(thread.laterRun, laterRunAfterDrop);
            yield* Ref.set(thread.holdRead, true);
            yield* Queue.offer(retries.retry, undefined);
            // The retry reads the thread there again before it decides.
            yield* Deferred.await(thread.readStarted);
            yield* Deferred.succeed(thread.releaseRead, undefined);
          } else if (cancelWhileBackingOff) {
            const cancelled = yield* a.call("task_cancel", { taskId: delegated.taskId });
            expect(cancelled.isError, JSON.stringify(cancelled.content)).toBe(false);
            // The cancel stops it there itself, so only the ended back-off shows no settle follows.
            yield* Deferred.await(retries.cut);
          } else if (!stopWhileBackingOff) {
            yield* Queue.offer(retries.retry, undefined);
          }
        }
        if (settled) yield* Deferred.await(thread.settledOnce);

        // A Stop ends a settle that backs off once its attempt in flight has decided, and is
        // otherwise followed after the follow that recorded the result, so once its stop is
        // recorded, no settle there is left to come.
        yield* a.threads.stopDelegatedTasks({
          threadId: parentThreadId,
          commandId: CommandId.make("command:stop:laptop-parent-after-settle"),
        });
        yield* stoppedThere(a, delegated.taskId);
        expect(yield* Ref.get(thread.settles)).toEqual(
          settled ? [delegated.remoteChild.threadId] : [],
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a delayed Stop acknowledgement leaves a newer Stop owed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);

      yield* Ref.set(thread.holdFirstStop, true);
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:delayed-first"),
      });
      yield* Deferred.await(thread.stopStarted);
      // Work starts after the first Stop landed there, but before its acknowledgement returns.
      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Run another check.",
      });
      const followUpId = (sent.structuredContent as { taskId: NodeId }).taskId;
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:delayed-second"),
      });
      const pending = yield* a.threads.getThreadRecords(parentThreadId, ["subagents"]);
      expect(
        pending.subagents.find((task) => task.id === delegated.taskId)?.remoteChild,
      ).toMatchObject({ stoppedThere: false, stopCount: 2 });
      yield* Deferred.succeed(thread.releaseStop, undefined);
      expect(yield* stoppedThere(a, delegated.taskId, 2)).toMatchObject({
        status: "completed",
        result: "All green.",
      });
      // The follow-up the work became is stopped there too, as its own task.
      expect(yield* stoppedThere(a, followUpId, null)).toMatchObject({ status: "interrupted" });
      expect(yield* Ref.get(thread.interrupted)).toBe(3);
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a Stop on a task that has its result reaches there after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The laptop records the Stop, then goes away before its follower sends it.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          const task = yield* delegateToBox(before);
          yield* Ref.set(thread.status, "completed");
          yield* Deferred.succeed(thread.finished, undefined);
          yield* taskResult(before, task.taskId);
          yield* before.threads.stopDelegatedTasks({
            threadId: parentThreadId,
            commandId: CommandId.make("command:stop:laptop-parent-before-restart"),
          });
          return task;
        }),
      );
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      const after = yield* makeLaptop(database, offers, linking);
      expect(yield* after.projections.getOpenRemoteDelegatedTasks).toEqual([
        { parentThreadId, taskId: delegated.taskId },
      ]);
      yield* after.remote.start();
      expect(yield* stoppedThere(after, delegated.taskId)).toMatchObject({ status: "completed" });
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the box is unreachable still stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      const a = yield* makeLaptop(database, offers).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // The box sleeps as soon as the task is there, so its follower's first attempt fails.
      yield* Ref.set(
        thread.afterLaunch,
        Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere")),
      );
      const delegated = yield* delegateToBox(a);
      yield* Queue.take(retries.failed);
      // The parent is stopped meanwhile.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-offline"),
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });

      // Once the box is back, the follower's next attempt stops the task there.
      yield* Ref.set(b.descriptor, box);
      yield* Queue.offer(retries.retry, undefined);
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task cancelled while the box is unreachable is stopped there after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // Its links outlive the restart, so the box knows it as the same link session.
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The laptop cancels while the box sleeps, then restarts before it wakes.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          const task = yield* delegateToBox(before);
          yield* Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
          yield* before.call("task_cancel", { taskId: task.taskId });
          expect(yield* taskResult(before, task.taskId)).toMatchObject({ status: "cancelled" });
          return task;
        }),
      );
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      yield* Ref.set(b.descriptor, box);
      const after = yield* makeLaptop(database, offers, linking);
      yield* after.remote.start();
      yield* Deferred.await(thread.interruptedOnce);
      // Once the stop is recorded, nothing is owed there any more.
      yield* stoppedThere(after, delegated.taskId, null);
      expect(yield* after.projections.getOpenRemoteDelegatedTasks).toEqual([]);
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      // The result here is still the cancel's.
      expect(yield* taskResult(after, delegated.taskId)).toMatchObject({ status: "cancelled" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task whose thread there has no run ends with its last reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // As a task recorded before its run was kept, whose thread there is idle.
      yield* Ref.set(thread.runless, true);
      yield* Ref.set(thread.reply, "Done before it was followed.");

      const delegated = yield* delegateToBox(a);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Done before it was followed.",
      });
      // One look, not a loop.
      expect(yield* Ref.get(thread.waitedFor)).toEqual([undefined]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a local task runs in this thread's project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run it here.",
        target: { projectId: "project:elsewhere" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("invalid_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task naming another driver there never runs its model on the parent's instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: {
          environmentId: box.environmentId,
          driverKind: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
      });
      expect(result.isError).toBe(false);
      expect((yield* Ref.get(thread.launched))?.modelSelection.instanceId).toBe(boxClaude);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
