import {
  CommandId,
  type EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  repositoryKeysOf,
  repositoryMatchRank,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Tool from "effect/ai/Tool";
import { withExecutedModelNote } from "@t3tools/provider-core/server/subagentProjection";

import { withLegacyUltracodeEffort } from "@t3tools/shared/model";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import {
  advertisedSlug,
  overrideOptions,
  requireOfferedOptions,
  resolveInteractionMode,
  resolveRuntimeMode,
  taskPrompt,
} from "../mcp/delegatedTaskModes.ts";
import { followUpOwnerRun } from "../orchestration-v2/CommandPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** How long one follow of a remote task waits on its thread there before checking again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** About 20 minutes of retrying a settle at the follow back-off, after which the thread there stays active. */
const SETTLE_RETRIES = 10;
/** A follower that hits this many defects in a row fails its task instead of retrying. */
const FOLLOW_MAX_DEFECTS = 3;
/** How a follower retries; tests step it by hand. */
export const FollowRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/RemoteDelegation/FollowRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/**
 * `delegate_task` to a linked environment. The task's child is an ordinary
 * thread there, launched through the link; the parent here records the task
 * like a local one, without a child thread, and a follower completes it when
 * the thread there ends, so the parent wakes as it would for a local child.
 */
export class RemoteDelegation extends Context.Service<
  RemoteDelegation,
  {
    readonly delegate: (
      scope: ThreadScope,
      parent: {
        readonly thread: OrchestrationV2ThreadProjection["thread"];
        readonly runId: RunId;
        readonly nodeId: NodeId;
      },
      input: OrchestratorMcpDelegateTaskInput & {
        readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
          readonly environmentId: EnvironmentId;
        };
      },
      request: { readonly key: string; readonly commandId: CommandId },
    ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
    /**
     * A `t3_thread_send` there that started or queued a run on the thread of
     * one of this thread's tasks that has its result: like a follow-up to a
     * finished child here, that run is a new task, whose id the send returns.
     * Any other send is returned as it came.
     */
    readonly followUp: (
      scope: McpInvocationContext.McpInvocationScope,
      environmentId: EnvironmentId,
      request: Pick<OrchestratorMcpThreadSendInput, "message" | "clientRequestId">,
      sent: OrchestratorMcpThreadSendResult,
    ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
    /**
     * Stops the task's thread there, then completes it here as cancelled. A
     * task that already has its result keeps it; its thread there is still
     * stopped, as cancelling a local task stops follow-up work on its child.
     */
    readonly cancel: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
      input: {
        readonly reason?: string | undefined;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    /**
     * The status of the task's run there, or null when it cannot be read: an
     * unreachable machine reads as no news rather than failing the read here.
     */
    readonly runStatus: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
    ) => Effect.Effect<OrchestratorMcpThreadRun["status"] | null>;
    /**
     * Follows every open remote task until it ends, including after a
     * restart, and a finished one again when a Stop here owes it a stop there.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteDelegation") {}

const encodeKeyPair = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

/** The other side refused because the thread there runs above this caller's modes. */
const isModeRefusal = (error: OrchestratorMcpFailure) =>
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

/**
 * Refusals that following again cannot change: the link was revoked, expired
 * or forgotten, or the thread or run there is gone. Anything else (the other
 * machine asleep, a dropped route) is worth retrying.
 */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

const make = Effect.gen(function* () {
  const followRetry = yield* FollowRetrySchedule;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  // One follower runs per open task and holds what it read across a wait of
  // up to FOLLOW_WAIT_MS, so it reads its own task, never the parent's whole
  // task list: a parent with thousands of tasks made every restart decode
  // that list once per open task at the same time and ran out of heap.
  const readTask = (parentThreadId: ThreadId, taskId: NodeId) =>
    threads
      .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] })
      .pipe(Effect.map(({ thread, subagents }) => ({ thread, task: subagents[0] })));

  /**
   * Where the task runs there: the project the caller named, the peer's own No project for a
   * thread in No project (it has no repository to match), else the peer's project with this
   * thread's repository, by its origin before its upstream.
   */
  const resolveRemoteProject = Effect.fn("RemoteDelegation.resolveRemoteProject")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    parentProjectId: ProjectId,
    requested: ProjectId | undefined,
  ) {
    if (requested !== undefined) return { projectId: requested } as const;
    if (yield* managedFolders.isScratchProject(parentProjectId)) return { scratch: true } as const;
    const here = yield* projects.getById(parentProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    // The project's own identity is a one-minute cache that reads blank when
    // cold, so resolve it here, as the other side's t3_project_list does.
    const identity =
      here === undefined ? null : yield* repositoryIdentities.resolve(here.workspaceRoot);
    if (identity === null) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass target.projectId: this thread's project has no repository to match there.",
      });
    }
    const keys = repositoryKeysOf(identity);
    let matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    let bestRank = Number.POSITIVE_INFINITY;
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          cursor,
          limit: 100,
        });
      for (const project of listed.projects) {
        const rank = repositoryMatchRank(identity, project.repositoryIdentity);
        if (rank === -1 || rank > bestRank) continue;
        if (rank < bestRank) matches = [];
        bestRank = rank;
        matches.push(project);
      }
      cursor = listed.nextCursor;
    }
    if (matches.length === 1) return { projectId: matches[0]!.id } as const;
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        matches.length === 0
          ? `No project there has this repository (${keys.join(" or ")}). Pass target.projectId; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`
          : `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass target.projectId.`,
    });
  });

  /** The instance there of the driver the caller named, preferring the one this thread runs on, as a task here does. */
  const resolveRemoteInstance = Effect.fn("RemoteDelegation.resolveRemoteInstance")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    requested: {
      readonly driverKind: ProviderDriverKind;
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly inheritedInstanceId: ProviderInstanceId;
    },
  ) {
    const { providers } = yield* forwarding.readCapabilities(scope, environmentId);
    if (requested.providerInstanceId !== undefined) {
      const named = providers.find(
        (provider) => provider.providerInstanceId === requested.providerInstanceId,
      );
      if (named !== undefined && named.driverKind !== requested.driverKind) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Provider instance ${named.providerInstanceId} there uses driver ${named.driverKind}, not ${requested.driverKind}.`,
        });
      }
      return requested.providerInstanceId;
    }
    const candidates = providers.filter(
      (provider) => provider.driverKind === requested.driverKind && provider.canRunChildTask,
    );
    const chosen =
      candidates.find(
        (provider) => provider.providerInstanceId === requested.inheritedInstanceId,
      ) ??
      candidates.find(
        (provider) => provider.usageLimited !== true && provider.constraints.length === 0,
      ) ??
      candidates[0];
    if (chosen === undefined) {
      const available = providers
        .filter((provider) => provider.canRunChildTask)
        .map((provider) => `${provider.providerInstanceId} (${provider.driverKind})`)
        .join(", ");
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `No instance of driver ${requested.driverKind} there can run a child task. Its instances that can: ${available || "none"}. Pass target.providerInstanceId; orchestrator_capabilities with this environmentId lists their models.`,
      });
    }
    return chosen.providerInstanceId;
  });

  /**
   * A new worktree there, from the commit this thread's checkout is on. The other machine can
   * only fetch a commit that is pushed, so an unpushed one is refused by name.
   */
  const parentCommitWorktree = Effect.fn("RemoteDelegation.parentCommitWorktree")(
    function* (parent: { readonly projectId: ProjectId; readonly worktreePath: string | null }) {
      const project = yield* projects.getById(parent.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const cwd = parent.worktreePath ?? project?.workspaceRoot;
      const unresolved = new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          'Isolation "worktree" in a linked environment branches from this thread\'s checkout commit, which could not be read. Omit isolation, or pass target.projectId and use t3_thread_launch with environmentId and a worktree workspaceStrategy.',
      });
      if (cwd === undefined) return yield* unresolved;
      const head = yield* git
        .resolveCommit({ cwd, revision: "HEAD" })
        .pipe(Effect.mapError(() => unresolved));
      const pushedTo = yield* git
        .execute({
          operation: "RemoteDelegation.parentCommitWorktree",
          cwd,
          args: [
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "--contains",
            head.commitSha,
            "refs/remotes",
          ],
        })
        .pipe(Effect.mapError(() => unresolved));
      if (pushedTo.stdout.trim() === "") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Commit ${head.commitSha} is not pushed, so the other environment cannot fetch it. Push it, or omit isolation to run in that project's checkout.`,
        });
      }
      return { type: "worktree", baseRef: head.commitSha, startFromOrigin: true } as const;
    },
  );

  /**
   * A key built from several parts, fixed in length: the caller's own key may already be at the
   * 256-character limit the forwarded tool's schema checks before the forwarder shortens it.
   * Equal parts give the same key, so a retry still finds its first result.
   */
  const composedKey = (...parts: ReadonlyArray<string>) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(JSON.stringify(parts))).pipe(
      Effect.map((hash) => Hex.encode(hash)),
      Effect.orDie,
    );

  const delegate: RemoteDelegation["Service"]["delegate"] = Effect.fn("RemoteDelegation.delegate")(
    function* (scope, parent, input, { key, commandId }) {
      const taskId = derive.delegatedTaskNode({ commandId });
      const { target } = input;
      const workspaceStrategy =
        input.isolation === "worktree" ? yield* parentCommitWorktree(parent.thread) : undefined;
      // The provider and model inherit as they do for a task here. Another
      // provider there has no model to inherit, so the caller names one.
      const inherited = parent.thread.modelSelection;
      const instanceId =
        target.driverKind === undefined
          ? (target.providerInstanceId ?? inherited.instanceId)
          : yield* resolveRemoteInstance(scope, target.environmentId, {
              driverKind: target.driverKind,
              providerInstanceId: target.providerInstanceId,
              inheritedInstanceId: inherited.instanceId,
            });
      // An alias can name another model on the other machine, so the parent's model goes there
      // by its slug here, and only that name carries the parent's options.
      const parentProvider = (yield* providerRegistry.getProviders).find(
        (provider) => provider.instanceId === inherited.instanceId,
      );
      const parentModel = advertisedSlug(parentProvider, inherited.model);
      const model = target.model ?? (instanceId === inherited.instanceId ? parentModel : undefined);
      if (model === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: `Pass target.model from orchestrator_capabilities with this environmentId (instance ${instanceId} there).`,
        });
      }
      // The merge would keep one of two values given for an option; the call names it instead.
      yield* requireOfferedOptions({ instanceId, model, options: target.options }, undefined);
      const inherits = instanceId === inherited.instanceId && model === parentModel;
      // Both sides are read as the parent's model runs them before the merge, as for a task here,
      // so a given effort keeps the Ultracode that an inherited legacy effort carries.
      const descriptors = inherits
        ? (parentProvider?.models.find((candidate) => candidate.slug === parentModel)?.capabilities
            ?.optionDescriptors ?? [])
        : [];
      const given = withLegacyUltracodeEffort(descriptors, target.options) ?? undefined;
      const options = overrideOptions(
        inherits
          ? (withLegacyUltracodeEffort(descriptors, inherited.options) ?? undefined)
          : undefined,
        given,
      );
      // The other side checks the options against its own catalog: those the agent named must be
      // offered there, and inherited ones it does not offer are dropped, as for a task here.
      const inheritedOptionIds = (options ?? [])
        .map((option) => option.id)
        .filter((id) => given?.some((option) => option.id === id) !== true);
      // Modes asked for are checked against this thread. Omitted ones are left
      // to the other side, which inherits this thread's modes capped by the
      // link's access, so a narrower link still takes the task.
      const runtimeMode =
        input.runtimeMode === undefined || input.runtimeMode === "inherit"
          ? undefined
          : yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
      const interactionMode =
        input.interactionMode === undefined || input.interactionMode === "inherit"
          ? undefined
          : yield* resolveInteractionMode(parent.thread.interactionMode, input.interactionMode);
      const where = yield* resolveRemoteProject(
        scope,
        target.environmentId,
        parent.thread.projectId,
        target.projectId,
      );
      // One key for the launch there and the record here, so a retry finds both.
      // Both are scoped to the provider session, as every key a caller passes is:
      // the forwarder scopes the launch's, and the record's names it.
      const task = taskPrompt(input);
      const title = input.title ?? parent.thread.title;
      // The thread there is named here, from the same scope and key, so the task is recorded
      // before the launch: a crash or lost reply after the launch leaves a task whose follower
      // finds its thread, and one before it a task whose thread is gone, which the follower fails.
      // A JSON pair keeps the namespace apart from the key.
      const keyBytes = yield* encodeKeyPair([scope.requestNamespace, key]).pipe(
        Effect.map((encoded) => new TextEncoder().encode(encoded)),
        Effect.orDie,
      );
      const keyDigest = yield* digest.digest(Digest.sha256, keyBytes).pipe(Effect.orDie);
      const remoteThreadId = ThreadId.make(`remote-delegate:${Hex.encode(keyDigest)}`);
      const link = yield* links.get(target.environmentId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const requestedChild: OrchestrationV2RemoteTaskChild = {
        environmentId: target.environmentId,
        threadId: remoteThreadId,
        label: link?.label ?? target.environmentId,
        title,
      };
      const modelSelection = { instanceId, model, ...(options === undefined ? {} : { options }) };
      const record = threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parent.runId,
          parentNodeId: parent.nodeId,
          task,
          ...(input.title === undefined ? {} : { title: input.title }),
          // The driver runs there; this side only labels the task with it.
          driver: ProviderDriverKind.make("remote"),
          modelSelection,
          remoteChild: requestedChild,
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          // The cause goes to the log; the caller learns only that recording failed.
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.record-failed", {
              parentThreadId: scope.thread.threadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Unable to record the delegated task.",
              }),
          ),
        );
      // The first committed command alone sends the launch. Overlapping calls can both finish preflight.
      return yield* Effect.acquireUseRelease(
        record,
        (recorded) =>
          Effect.gen(function* () {
            if (recorded.replayed) return { taskId };
            const stored = recorded.storedEvents.find(
              ({ event }) => event.type === "subagent.updated" && event.payload.id === taskId,
            );
            const accepted =
              stored?.event.type === "subagent.updated" ? stored.event.payload : undefined;
            const remoteChild = accepted?.remoteChild;
            if (
              accepted === undefined ||
              remoteChild === undefined ||
              remoteChild.threadId !== remoteThreadId ||
              remoteChild.environmentId !== target.environmentId
            ) {
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "The delegated task was not recorded.",
              });
            }
            const launched = yield* forwarding
              .call(
                scope,
                ProjectToolkit.tools.t3_thread_launch,
                remoteChild.environmentId,
                {
                  ...where,
                  title,
                  modelSelection,
                  inheritedOptionIds,
                  ...(runtimeMode === undefined ? {} : { runtimeMode }),
                  ...(interactionMode === undefined ? {} : { interactionMode }),
                  ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
                  message: task,
                  clientRequestId: yield* composedKey("delegate", scope.thread.threadId, key),
                  launchId: remoteThreadId,
                  // The thread there shows it is this thread's subagent, with a way back.
                  delegatedFrom: {
                    environmentId: hereId,
                    threadId: parent.thread.id,
                    title: parent.thread.title,
                  },
                },
                // A peer that predates it checks no option, so it runs them all as before.
                ["inheritedOptionIds"],
              )
              .pipe(
                Effect.filterOrElse(
                  (result) => result.threadId === remoteThreadId,
                  // A peer that predates the chosen id launched a thread nothing here follows.
                  (result) => {
                    const orphan = { ...remoteChild, threadId: result.threadId };
                    return stopThere(followScope(scope.thread, orphan), orphan, "stop").pipe(
                      Effect.ignoreCause({ log: true }),
                      Effect.andThen(
                        Effect.fail(
                          new OrchestratorMcpFailure({
                            code: "orchestration_error",
                            message:
                              "The linked environment is too old to launch a delegated task. Update it.",
                          }),
                        ),
                      ),
                    );
                  },
                ),
                Effect.tapError((error) =>
                  // The task stays on record so a launch whose reply was lost is followed. It is
                  // failed here only once nothing is left to stop there.
                  stopThere(followScope(scope.thread, remoteChild), remoteChild, "stop").pipe(
                    Effect.as(true),
                    Effect.catch((stopError) =>
                      Effect.succeed(stopError.code === "thread_not_found"),
                    ),
                    Effect.flatMap((nothingThere) =>
                      nothingThere
                        ? complete(
                            scope.thread.threadId,
                            taskId,
                            "failed",
                            `The task could not be started in ${remoteChild.label}: ${error.message}`,
                            "stopped",
                          )
                        : Effect.void,
                    ),
                    Effect.ignoreCause({ log: true }),
                  ),
                ),
              );
            // The follower waits on this run once it knows it; a failure here leaves it on the
            // thread's latest run, which is the run it launched.
            if (launched.runId !== null) {
              yield* threads
                .dispatch({
                  type: "delegated_task.remote.attach-run",
                  commandId: CommandId.make(`${commandId}:attach-run`),
                  parentThreadId: scope.thread.threadId,
                  taskId,
                  runId: launched.runId,
                })
                .pipe(
                  Effect.tapError((cause) =>
                    Effect.logWarning("remote-delegation.attach-run-failed", { taskId, cause }),
                  ),
                  Effect.ignore,
                );
            }
            return { taskId };
          }),
        (recorded) =>
          recorded.replayed
            ? Effect.void
            : // A disconnect can interrupt the first sender after acceptance. Its recorded task still needs its follower.
              followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers)),
      );
    },
  );

  const followUp: RemoteDelegation["Service"]["followUp"] = Effect.fn("RemoteDelegation.followUp")(
    function* (scope, environmentId, request, sent) {
      // A steer joins a run that is already some task's, or no one's.
      if (scope.thread === undefined || (sent.delivery !== "started" && sent.delivery !== "queued"))
        return sent;
      const parentThreadId = scope.thread.threadId;
      const parent = yield* threads
        .getThreadRecords(parentThreadId, ["runs", "subagents"])
        .pipe(Effect.orElseSucceed(() => undefined));
      const isThere = (task: OrchestrationV2Subagent) =>
        task.remoteChild?.environmentId === environmentId &&
        task.remoteChild.threadId === sent.threadId;
      const finished = parent?.subagents.find((task) => isThere(task) && task.result !== null);
      // Bound as a follow-up here is: a background caller's foreground run may have ended.
      const parentRun = parent === undefined ? null : followUpOwnerRun(parent.runs);
      if (
        finished?.remoteChild === undefined ||
        finished.model === null ||
        parentRun === null ||
        parentRun.rootNodeId === null
      )
        return sent;
      // The message id there is the send's, so a retry that reached the same send records once.
      const commandId = CommandId.make(
        `command:remote-followup:${encodeURIComponent(parentThreadId)}:${encodeURIComponent(environmentId)}:${encodeURIComponent(sent.messageId)}`,
      );
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: request.message,
          ...(finished.title === null ? {} : { title: finished.title }),
          driver: finished.driver,
          modelSelection: { instanceId: finished.providerInstanceId, model: finished.model },
          remoteChild: {
            environmentId,
            threadId: sent.threadId,
            label: finished.remoteChild.label,
            runId: sent.runId,
          },
          completionWake: "always",
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.followup-record-failed", {
              parentThreadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  request.clientRequestId === undefined
                    ? "The message was sent, but its task was not recorded; read the thread for its answer instead of sending it again."
                    : "The message was sent, but its task was not recorded; send it again with the same clientRequestId to record it.",
              }),
          ),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated"
          ? taskEvent.event.payload.id
          : // A replayed request recorded the task the first time.
            yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
              Effect.map(
                ({ subagents }) =>
                  subagents.find((task) => isThere(task) && task.remoteChild?.runId === sent.runId)
                    ?.id,
              ),
              Effect.orElseSucceed(() => undefined),
            );
      if (taskId === undefined) return sent;
      yield* followOne(parentThreadId, taskId).pipe(Effect.forkIn(followers));
      return { ...sent, taskId };
    },
  );

  /**
   * Completes `task` here with its thread there's final state. Each attempt is its own
   * command, so a failed one never blocks the next; a report refused because the task already
   * has its result (a cancel, a Stop or an earlier report) is done. `stoppedThere` records that
   * nothing is left to stop there, even on a task that already has its result.
   */
  const complete = Effect.fn("RemoteDelegation.complete")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string,
    stoppedThere: "ran-out" | "stopped" | undefined,
    stopCount?: number,
  ) {
    const attempt = yield* random.uuidV4();
    yield* threads
      .dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make(`command:remote-task-complete:${taskId}:${attempt}`),
        parentThreadId,
        taskId,
        status,
        result,
        ...(stoppedThere === undefined ? {} : { stoppedThere }),
        ...(stopCount === undefined ? {} : { stopCount }),
      })
      .pipe(
        Effect.catch((error) =>
          readTask(parentThreadId, taskId).pipe(
            Effect.flatMap(({ task }) => (task?.result != null ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
  });

  /**
   * How this environment reaches a task's thread there: as the parent
   * thread, under one namespace per parent, so a stop sent again after a
   * restart or a dropped route is recorded there once.
   */
  const followScope = (
    parent: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
    remote: OrchestrationV2RemoteTaskChild,
  ): ThreadScope => ({
    environmentId: hereId,
    requestNamespace: `remote-task:${parent.threadId}`,
    thread: {
      threadId: parent.threadId,
      providerSessionId: `remote-task:${remote.threadId}`,
      providerInstanceId: parent.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /**
   * Stops the task's own thread there as its Stop button does: its running turn, queued
   * messages, pull request watches and delegated tasks. `key` names the stop (the follower
   * sends one, each cancel its own), and each is recorded there once however often it is sent.
   */
  const stopThere = Effect.fn("RemoteDelegation.stopThere")(function* (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    key: string,
    reason?: string,
  ) {
    yield* forwarding.interruptThread(scope, remote.environmentId, {
      threadId: remote.threadId,
      stop: true,
      ...(reason === undefined ? {} : { reason }),
      clientRequestId: yield* composedKey("stop", key, remote.threadId),
    });
  });

  /**
   * The last reply `runId` gave on the task's thread there, which is its
   * result, read whole however long it is. A failed run prefers its error
   * from the activity view over an earlier reply, without taking another run's.
   * Led by a note when its provider reported running another model than it asked for.
   */
  const lastReply = Effect.fn("RemoteDelegation.lastReply")(function* (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    runId: RunId | null,
    failed = false,
    probeSuccess = true,
  ) {
    let reply: OrchestratorMcpThreadTimelineItem | undefined;
    let error: OrchestratorMcpThreadTimelineItem | undefined;
    let afterPosition: number | undefined;
    let remainingItems = 0;
    let wholePageItems = 0;
    let tailProbed = false;
    let run: OrchestratorMcpThreadRun | undefined;
    while (true) {
      // Keep the first and expected final activity pages whole; a result on a middle page then
      // needs an extra text read. A whole page ends at the result budget, so the last one read
      // whole is the measure of whether the rest fits in one.
      const truncated = failed && remainingItems > wholePageItems;
      const read = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        view: failed ? "activity" : "messages",
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: truncated ? 1 : 20_000,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      if (!truncated) wholePageItems = read.items.length;
      run ??= read.recentRuns?.find((candidate) => candidate.runId === runId);
      reply =
        read.items.findLast(
          (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
        ) ?? reply;
      if (failed) {
        error =
          read.items.findLast(
            (item) => item.type === "error" && (runId === null || item.runId === runId),
          ) ?? error;
      }
      if (!read.hasMore || read.nextPosition === null) break;
      if (!failed && probeSuccess && !tailProbed) {
        tailProbed = true;
        let tailPosition: number | null = Math.floor((read.thread.itemCount - 1) / 100) * 100 - 1;
        if (tailPosition > read.nextPosition) {
          // Read on to the end: the result budget can end a tail read early.
          let tailReply: OrchestratorMcpThreadTimelineItem | undefined;
          while (tailPosition !== null) {
            const tail: OrchestratorMcpThreadReadResult = yield* forwarding.readThread(
              scope,
              remote.environmentId,
              {
                threadId: remote.threadId,
                view: "messages",
                limit: 100,
                maxCharsPerItem: 20_000,
                afterPosition: tailPosition,
              },
            );
            tailReply =
              tail.items.findLast(
                (item) =>
                  item.type === "assistant_message" && (runId === null || item.runId === runId),
              ) ?? tailReply;
            tailPosition = tail.hasMore ? tail.nextPosition : null;
          }
          if (tailReply !== undefined) {
            reply = tailReply;
            break;
          }
        }
      }
      afterPosition = read.nextPosition;
      remainingItems = read.thread.itemCount - afterPosition - 1;
    }
    reply = error ?? reply;
    if (reply === undefined) return undefined;
    let text = reply.text ?? "";
    let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
    while (textOffset !== null) {
      const rest = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        itemId: reply.itemId,
        textOffset,
        maxCharsPerItem: 20_000,
      });
      const part = rest.items[0];
      if (part === undefined) break;
      text += part.text ?? "";
      textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    return run === undefined ? text : withExecutedModelNote(text, run.model, run.executedModel);
  });

  /**
   * Why following a task can never succeed, if that is what `error` means.
   * The far side's message already says what was refused and what to do; a
   * link forgotten here only reads as a bad request, so it is named.
   */
  const finalReason = Effect.fn("RemoteDelegation.finalReason")(
    function* (parentThreadId: ThreadId, taskId: NodeId, error: OrchestratorMcpFailure) {
      if (isFinal(error)) return error.message;
      if (error.code !== "invalid_request") return undefined;
      const { task } = yield* readTask(parentThreadId, taskId);
      const environmentId = task?.remoteChild?.environmentId;
      if (environmentId === undefined) return error.message;
      const link = yield* links.get(environmentId);
      return Option.isSome(link) ? undefined : error.message;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** Each task's settle there in progress, given up by `giveUpSettle`. */
  const settling = new Map<NodeId, Deferred.Deferred<void>>();

  /**
   * Ends the task's settle there once its attempt in flight has decided, for a Stop or cancel
   * here, so neither waits on the back-off and the settle never follows them there.
   */
  const giveUpSettle = (taskId: NodeId) =>
    Effect.suspend(() => {
      const givenUp = settling.get(taskId);
      return givenUp === undefined ? Effect.void : Deferred.succeed(givenUp, undefined);
    });

  /**
   * Settles a task's thread there once the task here holds its run's result, so a finished
   * helper leaves that machine's active list. Each attempt settles only while the thread still
   * rests on `runId`, so a settle whose answer was lost, or a message there since, ends the
   * retries; so does a cancel or Stop here, which then owns the thread there instead.
   */
  const settleThere = Effect.fn("RemoteDelegation.settleThere")(function* (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    parentThreadId: ThreadId,
    taskId: NodeId,
    runId: RunId,
  ) {
    const { task } = yield* readTask(parentThreadId, taskId);
    if (task?.status !== "completed" || task.remoteChild?.stoppedThere !== true) return;
    const givenUp = yield* Deferred.make<void>();
    const inFlight = yield* Semaphore.make(1);
    settling.set(taskId, givenUp);
    yield* forwarding
      .readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        limit: 1,
        runLimit: 1,
        maxCharsPerItem: 1,
      })
      .pipe(
        Effect.flatMap(({ thread }) =>
          restsOn(thread, runId)
            ? forwarding.settleThread(scope, remote.environmentId, remote.threadId)
            : Effect.void,
        ),
        inFlight.withPermits(1),
        Effect.retry({
          schedule: followRetry,
          times: SETTLE_RETRIES,
          while: (error) =>
            isModeRefusal(error)
              ? false
              : finalReason(parentThreadId, taskId, error).pipe(
                  Effect.map((reason) => reason === undefined),
                ),
        }),
        Effect.catch((error) =>
          Effect.logWarning("A linked environment kept a finished delegated task's thread active", {
            taskId,
            reason: error.message,
          }),
        ),
        // Waits out the attempt in flight, so only a back-off is cut short.
        Effect.raceFirst(
          Deferred.await(givenUp).pipe(Effect.andThen(inFlight.withPermits(1)(Effect.void))),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (settling.get(taskId) === givenUp) settling.delete(taskId);
          }),
        ),
      );
  });

  /** A task's thread there that ended without a reply. */
  const noReply = "(The thread in the linked environment ended without a reply.)";

  /**
   * Waits for the task's run there to end, completes the task here, and stops it there if it
   * ended here first. A revoked, expired or forgotten link, or a thread or run gone there,
   * fails the task with nothing left to stop; repeated defects here fail it too. Anything else
   * (the other machine asleep, a dropped route) is retried with back-off, and so is completing.
   */
  const follow = (parentThreadId: ThreadId, taskId: NodeId): Effect.Effect<void> =>
    Effect.suspend(() => {
      let defects = 0;
      const noDefect = Effect.sync(() => {
        defects = 0;
      });
      return followOnce(parentThreadId, taskId).pipe(
        Effect.tap(noDefect),
        // `false` means it is still running there: follow again straight away.
        Effect.repeat({ while: (done) => !done }),
        Effect.catchTags({
          OrchestratorMcpFailure: Effect.fn("RemoteDelegation.followFailed")(function* (error) {
            const reason = yield* finalReason(parentThreadId, taskId, error);
            if (reason === undefined) return yield* error;
            // Gone there, or no link to reach it by: nothing left to stop there.
            const { task } = yield* readTask(parentThreadId, taskId);
            const stopCount = task?.remoteChild?.stopCount;
            yield* complete(parentThreadId, taskId, "failed", reason, "stopped", stopCount);
          }),
        }),
        Effect.tapError(() => noDefect),
        Effect.tapDefect(() =>
          Effect.sync(() => {
            defects += 1;
          }),
        ),
        failOnDefect,
        Effect.retry({ schedule: followRetry, while: () => defects < FOLLOW_MAX_DEFECTS }),
        Effect.catch(
          Effect.fn("RemoteDelegation.followGaveUp")(
            function* () {
              const { task } = yield* readTask(parentThreadId, taskId);
              const remote = task?.remoteChild;
              // A task with its result keeps it; completing it again would owe another stop there.
              if (remote === undefined || task?.result !== null) return;
              const result = `Following the thread ${remote.threadId} in ${remote.label} failed repeatedly, so it may still run there (task_cancel stops it).`;
              yield* complete(parentThreadId, taskId, "failed", result, undefined);
            },
            failOnDefect,
            Effect.retry(followRetry),
          ),
        ),
        Effect.ignoreCause({ log: true }),
      );
    });

  /**
   * One wait on the task's thread there; true once the task here is done.
   * A task completed here first (cancelled, or its parent stopped) is
   * stopped there, and done once that stop is recorded here.
   */
  const followOnce = Effect.fn("RemoteDelegation.followOnce")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    const sequence = yield* threads.getThreadEventSequence(parentThreadId);
    const { thread, task } = yield* readTask(parentThreadId, taskId);
    if (task?.remoteChild === undefined) return true;
    const remote = task.remoteChild;
    const scope = followScope(
      { threadId: parentThreadId, providerInstanceId: thread.providerInstanceId },
      remote,
    );
    // Ended here, maybe while this follower backed off from an unreachable
    // machine or before a restart: it still has to be stopped there. So
    // does one its parent here was stopped after, for what followed there.
    if (task.result !== null) {
      if (
        remote.stoppedThere === false ||
        ((task.status === "cancelled" || task.status === "interrupted") &&
          remote.stoppedThere !== true)
      ) {
        const count = remote.stopCount === undefined ? "stop" : `stop-${remote.stopCount}`;
        // Named for its run too: a follow-up task shares the thread there and counts its own stops.
        const key = remote.runId === undefined ? count : `${count}:${remote.runId}`;
        yield* stopThere(scope, remote, key).pipe(
          // Its thread there now runs above what this side may touch, say
          // because the parent here was lowered since; no retry changes that.
          Effect.catchIf(isModeRefusal, (error) =>
            Effect.logWarning("A linked environment refused to stop a delegated task", {
              taskId,
              reason: error.message,
            }),
          ),
        );
        yield* complete(
          parentThreadId,
          taskId,
          terminalStatus(task.status),
          task.result,
          "stopped",
          remote.stopCount,
        );
        return yield* settled(parentThreadId, taskId);
      }
      return true;
    }
    const endedHere = threads
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: sequence,
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
        Effect.flatMap((ended) =>
          Option.isSome(ended) ? Effect.succeed({ endedHere: true } as const) : Effect.never,
        ),
      );
    const waited = yield* forwarding
      .waitForThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        ...(remote.runId === undefined ? {} : { runId: remote.runId }),
        timeoutMs: FOLLOW_WAIT_MS,
        // A thread there whose run ended may still be waiting on its own
        // tasks to wake it for the answer, which a task here waits for too.
        // An older peer ignores this and reports the run alone.
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.raceFirst(endedHere));
    // The next look reads the result and stops it there.
    if ("endedHere" in waited) return false;
    if (waited.timedOut) return false;
    // A task recorded without its run waits on the thread's latest; a
    // thread there with none has nothing left to wait for.
    if (waited.runId === null) {
      const reply = yield* lastReply(scope, remote, null);
      yield* complete(
        parentThreadId,
        taskId,
        reply === undefined ? "failed" : "completed",
        reply ?? "The thread in the linked environment has no run to follow.",
        "ran-out",
      );
      return yield* settled(parentThreadId, taskId);
    }
    if (!isTerminal(waited.status)) return false;
    // A later run's answer there may be another open follow-up's, or its restart, which no run id
    // here names; concurrent sends may record here out of their order there. Then this task's
    // answer is its own run's latest restart, the one waited on.
    const sharedThread =
      waited.resultRun !== undefined &&
      waited.resultRun.runId !== waited.runId &&
      (yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
        Effect.map(({ subagents }) => {
          const recordedAt = subagents.find((task) => task.id === taskId)?.startedAt ?? null;
          return subagents.some(
            (other) =>
              other.id !== taskId &&
              other.remoteChild?.environmentId === remote.environmentId &&
              other.remoteChild.threadId === remote.threadId &&
              // One that settled before this was recorded ran before it there.
              (recordedAt === null ||
                other.completedAt === null ||
                DateTime.isGreaterThan(other.completedAt, recordedAt)),
          );
        }),
      ));
    const resultRun =
      waited.resultRun !== undefined && !sharedThread
        ? waited.resultRun
        : { runId: waited.runId, status: waited.status };
    const result = yield* lastReply(
      scope,
      remote,
      resultRun.runId,
      resultRun.status === "failed",
      resultRun.status === "completed",
    );
    yield* complete(
      parentThreadId,
      taskId,
      terminalStatus(resultRun.status),
      result ?? noReply,
      "ran-out",
    );
    if (resultRun.status === "completed") {
      yield* settleThere(scope, remote, parentThreadId, taskId, resultRun.runId);
    }
    return yield* settled(parentThreadId, taskId);
  });

  /**
   * Whether the task is done here after the follower reported its run ran
   * out there. A cancel or Stop that landed while the reply was read keeps
   * its result, and still owes a stop there for what may follow the run;
   * the next look sends it.
   */
  const settled = (parentThreadId: ThreadId, taskId: NodeId) =>
    readTask(parentThreadId, taskId).pipe(
      Effect.map(({ task }) => task?.remoteChild?.stoppedThere === true),
    );

  const following = new Map<NodeId, { again: boolean }>();

  /**
   * `follow`, at most once per task. Asked again while it runs, say by a
   * Stop here on a task that already has its result, it looks once more
   * before it ends, so that stop is not missed.
   */
  const followOne = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.suspend(() => {
      const running = following.get(taskId);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const state = { again: false };
      following.set(taskId, state);
      return follow(parentThreadId, taskId).pipe(
        // Checked and released in one step, so a request between them is never lost.
        Effect.repeat({
          while: () => {
            if (state.again) {
              state.again = false;
              return true;
            }
            following.delete(taskId);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (following.get(taskId) === state) following.delete(taskId);
          }),
        ),
      );
    });

  const cancel: RemoteDelegation["Service"]["cancel"] = Effect.fn("RemoteDelegation.cancel")(
    function* (scope, task, input) {
      const remote = task.remoteChild;
      if (remote === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: `Delegated task ${task.id} is not remote.`,
        });
      }
      const { reason } = input;
      const there = followScope(scope.thread, remote);
      // A later cancel stops what started there since; a retry of this one, nothing new.
      const key = `cancel:${encodeURIComponent(scope.requestNamespace)}:${
        input.clientRequestId ?? (yield* random.uuidV4())
      }`;
      if (task.result !== null) {
        yield* giveUpSettle(task.id);
        // Best effort: the result stands whether or not the stop gets there.
        yield* stopThere(there, remote, key, reason).pipe(
          Effect.andThen(
            complete(
              task.threadId,
              task.id,
              terminalStatus(task.status),
              task.result,
              "stopped",
              remote.stopCount,
            ),
          ),
          Effect.ignoreCause({ log: true }),
        );
        return {
          taskId: task.id,
          status:
            task.status === "completed" || task.status === "failed" || task.status === "interrupted"
              ? task.status
              : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      // A link that is gone or a machine that is down still cancels the task
      // here; its follower keeps trying to stop it there, across restarts.
      const unstopped = yield* stopThere(there, remote, key, reason).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      const cancelled = reason === undefined ? "Cancelled." : `Cancelled: ${reason}`;
      yield* complete(
        task.threadId,
        task.id,
        "cancelled",
        unstopped === undefined
          ? cancelled
          : `${cancelled} It could not be stopped in ${remote.label} and may still run there: ${unstopped}`,
        unstopped === undefined ? "stopped" : undefined,
        remote.stopCount,
      ).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.cancel-record-failed", { taskId: task.id, cause }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the cancellation.",
            }),
        ),
      );
      return {
        taskId: task.id,
        status: "cancel_requested",
      } satisfies OrchestratorMcpTaskCancelResult;
    },
  );

  const runStatus = Effect.fn("RemoteDelegation.runStatus")(
    function* (scope: ThreadScope, task: OrchestrationV2Subagent) {
      const remote = task.remoteChild;
      if (remote?.runId === undefined) return null;
      const read = yield* forwarding.readThread(
        followScope(scope.thread, remote),
        remote.environmentId,
        { threadId: remote.threadId, limit: 1, runLimit: 50 },
      );
      return read.recentRuns?.find((run) => run.runId === remote.runId)?.status ?? null;
    },
    Effect.orElseSucceed(() => null),
  );

  const start: RemoteDelegation["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // A finished task's follower has ended, so a Stop here that owes its
        // thread there a stop starts it again, or ends the settle it still waits on.
        // Started before the scan below; a Stop that slips between the two stays
        // owed for the next start.
        yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "subagent.updated" && event.payload.remoteChild?.stoppedThere === false
            ? giveUpSettle(event.payload.id).pipe(
                Effect.andThen(followOne(event.threadId, event.payload.id)),
                Effect.forkIn(followers),
              )
            : Effect.void,
        ).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(followers, { startImmediately: true }),
        );
        const open = yield* projections.getOpenRemoteDelegatedTasks;
        yield* Effect.forEach(
          open,
          ({ parentThreadId, taskId }) => followOne(parentThreadId, taskId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return RemoteDelegation.of({ delegate, followUp, cancel, runStatus, start });
});

/** A defect, logged, as a failure, so a retry covers it. */
const failOnDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchDefect(effect, (defect) =>
    Effect.logWarning("A remote task's follower hit a defect", Cause.die(defect)).pipe(
      Effect.andThen(Effect.fail(new Cause.UnknownError(defect, "A follower hit a defect."))),
    ),
  );

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

/**
 * Whether a task's thread there still rests on the run that gave its result: no later run,
 * queued message or unanswered question, which settling would hide or cancel.
 */
const restsOn = (thread: OrchestratorMcpThreadDetail, runId: RunId | null) =>
  thread.latestRunId === runId &&
  thread.activeRunId === null &&
  thread.pendingRequestCount === 0 &&
  !thread.settled &&
  !thread.archived;

const terminalStatus = (status: string): "completed" | "failed" | "cancelled" | "interrupted" =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";

export const layer = Layer.effect(RemoteDelegation, make);
