import {
  CommandId,
  type EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  repositoryKeysOf,
  repositoryMatchRank,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import type * as Tool from "effect/ai/Tool";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { type LaunchWorkspaceStrategy, ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import {
  resolveInteractionMode,
  resolveRuntimeMode,
  taskPrompt,
} from "../mcp/delegatedTaskModes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { remoteFailureText } from "../vcs/GitVcsDriverCore.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** How long one follow of a remote task waits on its thread there before checking again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** About 20 minutes of retrying a settle at the follow back-off, after which the thread there stays active. */
const SETTLE_RETRIES = 10;
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
type ProjectThere = Tool.Success<typeof ProjectToolkit.tools.t3_project_list>["projects"][number];

/**
 * The `repositoryMatchRank` of a project there with this checkout's origin: that machine fetches a
 * pinned base from the remote its project is matched by, so only such a project can start from this commit.
 */
const SAME_ORIGIN = 0;

/**
 * Whether each `delegate_task` isolation gives the task its own worktree there, so a new
 * isolation in the contract needs a decision for linked environments before it compiles.
 */
const ownWorktreeThere = {
  shared: false,
  worktree: true,
} as const satisfies Record<NonNullable<OrchestratorMcpDelegateTaskInput["isolation"]>, boolean>;

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
      input: OrchestratorMcpDelegateTaskInput & {
        readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
          readonly environmentId: EnvironmentId;
        };
      },
    ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
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
     * Follows every open remote task until it ends, including after a
     * restart, and a finished one again when a Stop here owes it a stop there.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteDelegation") {}

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
  const git = yield* GitVcsDriver.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  // One delegate_task call per key at a time, so a retry reads what the call before it left.
  const delegations = yield* RcMap.make({ lookup: (_commandId: CommandId) => Semaphore.make(1) });
  // A recorded task's launch there runs with the followers, so a call interrupted after
  // recording still launches and follows its task, and a retry answers what that launch did.
  const launching = new Map<
    NodeId,
    Fiber.Fiber<{ readonly taskId: NodeId }, OrchestratorMcpFailure>
  >();

  /**
   * Waits for the task's launch there to end, if one runs. Until then its thread there may not
   * exist yet, so a follower, a stop or a retry would find nothing there.
   */
  const awaitLaunch = Effect.fn("RemoteDelegation.awaitLaunch")(function* (taskId: NodeId) {
    const launch = launching.get(taskId);
    if (launch !== undefined) yield* Fiber.await(launch);
  });

  // One follower runs per open task and holds what it read across a wait of
  // up to FOLLOW_WAIT_MS, so it reads its own task, never the parent's whole
  // task list: a parent with thousands of tasks made every restart decode
  // that list once per open task at the same time and ran out of heap.
  const readTask = (parentThreadId: ThreadId, taskId: NodeId) =>
    threads
      .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] })
      .pipe(Effect.map(({ thread, subagents }) => ({ thread, task: subagents[0] })));

  const readProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * Every project there, read a page at a time. `fresh` reads each one's remotes as they are now,
   * which a peer too old to take it refuses: its cached identities could decide the match.
   */
  const projectsThere = Effect.fn("RemoteDelegation.projectsThere")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    fresh: boolean,
  ) {
    const listed: Array<ProjectThere> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> = yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          cursor,
          limit: 100,
          ...(fresh ? { refreshRepositoryIdentity: true } : {}),
        })
        .pipe(
          Effect.mapError((error) =>
            fresh && error.code === "invalid_request"
              ? new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} Isolation "worktree" matches this repository by the remotes each project there has now; omit isolation to work in the project's checkout there.`,
                })
              : error,
          ),
        );
      listed.push(...page.projects);
      cursor = page.nextCursor;
    }
    return listed;
  });

  /**
   * The named project there, the peer's No project for a No-project thread, else its project of
   * this repository, origin before upstream. `rank` (worktree only) starts this commit, or at -1
   * that project's default branch. `remoteName` is the remote of `checkout` the match compared.
   * A worktree's match reads both sides' remotes as they are now, never a cache.
   */
  const resolveRemoteProject = Effect.fn("RemoteDelegation.resolveRemoteProject")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    parentProjectId: ProjectId,
    requested: ProjectId | undefined,
    worktree: boolean,
  ) {
    if (requested !== undefined && !worktree)
      return { where: { projectId: requested }, rank: -1 } as const;
    const namedIn = (listed: ReadonlyArray<ProjectThere>, projectId: ProjectId) => {
      const named = listed.find((project) => project.id === projectId);
      return named === undefined
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `No project ${projectId} there. t3_project_list with this environmentId lists them.`,
            }),
          )
        : Effect.succeed(named);
    };
    if (yield* managedFolders.isScratchProject(parentProjectId)) {
      if (requested === undefined) return { where: { scratch: true }, rank: -1 } as const;
      const named = yield* namedIn(yield* projectsThere(scope, environmentId, true), requested);
      if (named.repositoryIdentity == null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Isolation "worktree" needs a project with a remote there, and project "${named.title}" has none. Omit isolation to work in its folder there.`,
        });
      return { where: { projectId: requested }, rank: -1 } as const;
    }
    const checkout = (yield* readProject(parentProjectId))?.workspaceRoot;
    // The project's own identity is a cache that reads blank when cold and
    // misses a changed remote, so read the checkout's remotes as they are now.
    const identity =
      checkout === undefined
        ? null
        : yield* repositoryIdentities.resolve(checkout, { refresh: true });
    const unidentified = (project: string, omit: string) =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Isolation "worktree" there starts from this checkout's commit in a clone of this repository and from the default branch in another, but ${project} has no remote to tell which. ${omit} to work in that project's checkout there.`,
      });
    if (checkout === undefined || identity === null) {
      if (!worktree)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass target.projectId: this thread's project has no repository to match there.",
        });
      return yield* unidentified(
        "this thread's project",
        requested === undefined ? "Omit isolation and pass target.projectId" : "Omit isolation",
      );
    }
    const remoteName = RepositoryIdentityResolver.groupingRemoteNameOf(identity);
    const listed = yield* projectsThere(scope, environmentId, worktree);
    if (requested !== undefined) {
      const named = yield* namedIn(listed, requested);
      if (named.repositoryIdentity == null)
        return yield* unidentified(`project "${named.title}"`, "Omit isolation");
      const rank = repositoryMatchRank(identity, named.repositoryIdentity);
      return { where: { projectId: requested }, rank, remoteName, checkout } as const;
    }
    const ranked = listed.flatMap((project) => {
      const rank = repositoryMatchRank(identity, project.repositoryIdentity);
      return rank === -1 ? [] : [{ project, rank }];
    });
    const bestRank = Math.min(...ranked.map(({ rank }) => rank));
    const matches = ranked.flatMap(({ project, rank }) => (rank === bestRank ? [project] : []));
    // Forks that tie are all refused for a worktree, so picking one would not help.
    if (matches.length === 1 || (worktree && matches.length > 1 && bestRank > SAME_ORIGIN))
      return {
        where: { projectId: matches[0]!.id },
        rank: bestRank,
        remoteName,
        checkout,
      } as const;
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        matches.length > 1
          ? `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass target.projectId.`
          : `No project there has this repository (${repositoryKeysOf(identity).join(" or ")}). Pass target.projectId; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`,
    });
  });

  /**
   * A worktree there starts from this thread's commit, fetched from that project's remote, so the
   * commit must be a branch tip on `remoteName`, the remote of `checkout` it was matched by; an
   * unpushed one is refused by name. The commit travels with the branch, so a moved branch or a
   * stale fetch cannot start it elsewhere.
   */
  const pushedWorktree = Effect.fn("RemoteDelegation.pushedWorktree")(function* (
    worktreePath: string | null,
    checkout: string,
    remoteName: string,
  ) {
    const unresolved = () =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Isolation "worktree" there starts from this checkout's commit, but HEAD of ${worktreePath ?? checkout} could not be read. Restore that checkout and repeat this call, or omit isolation to work in the project's checkout there.`,
      });
    const { commitSha } = yield* git
      .resolveCommit({ cwd: worktreePath ?? checkout, revision: "HEAD" })
      .pipe(Effect.mapError(unresolved));
    const notPushed = (why: string) =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Isolation "worktree" there starts from this checkout's commit ${commitSha}, but ${why}. Push it to a branch (git push <remote> HEAD:refs/heads/<branch>) and repeat this call with the same clientRequestId, which also finds a task an earlier attempt started there; or omit isolation to work in the project's checkout there.`,
      });
    const [branch] = yield* git.listRemoteBranchesAt({ cwd: checkout, remoteName, commitSha }).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Isolation "worktree" there starts from this checkout's commit ${commitSha} on a branch of ${remoteName}, but ${remoteName} did not list its branches. Repeat this call with the same clientRequestId once it answers, or omit isolation to work in the project's checkout there. ${remoteFailureText(error)}`,
          }),
      ),
    );
    if (branch === undefined) return yield* notPushed(`no branch on ${remoteName} ends at it`);
    return {
      type: "worktree",
      baseRef: branch,
      startFromOrigin: true,
      baseCommit: commitSha,
    } as const;
  });

  /**
   * The peer's own provider instance for a target that names only a driver: instance ids belong
   * to one environment, so this thread's would not exist there. An instance that is not usage
   * limited and has no constraints comes first.
   */
  const resolveRemoteInstance = Effect.fn("RemoteDelegation.resolveRemoteInstance")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    driverKind: ProviderDriverKind,
  ) {
    const there = yield* forwarding.readCapabilities(scope, environmentId);
    const ofDriver = there.providers.filter((provider) => provider.driverKind === driverKind);
    const usable =
      ofDriver.find(
        (provider) => provider.usageLimited !== true && provider.constraints.length === 0,
      ) ?? ofDriver[0];
    if (usable === undefined) {
      const available = there.providers
        .map((provider) => `${provider.providerInstanceId} (${provider.driverKind})`)
        .join(", ");
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `No provider instance of driver ${driverKind} there. Its instances: ${available || "none"}. Pass target.providerInstanceId.`,
      });
    }
    return usable.providerInstanceId;
  });

  const delegate: RemoteDelegation["Service"]["delegate"] = Effect.fn("RemoteDelegation.delegate")(
    function* (scope, input) {
      // One key for the launch there and the record here, so a retry finds both.
      // Both are scoped to the provider session, as every key a caller passes is:
      // the forwarder scopes the launch's, and the record's names it.
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const commandId = CommandId.make(
        `command:mcp:${encodeURIComponent(scope.requestNamespace)}:remote-delegate:${encodeURIComponent(key)}`,
      );
      // A retry while the first call still launches would start a follower that finds no thread
      // there yet and fails the task, so it waits for that call, and then for its launch.
      const lock = yield* RcMap.get(delegations, commandId);
      return yield* lock.withPermits(1)(delegateOnce(scope, input, key, commandId));
    },
    Effect.scoped,
  );

  const delegateOnce = Effect.fn("RemoteDelegation.delegateOnce")(function* (
    scope: ThreadScope,
    input: Parameters<RemoteDelegation["Service"]["delegate"]>[1],
    key: string,
    commandId: CommandId,
  ) {
    // The task's id derives from its command, so a retry finds the one recorded the first time.
    const taskId = derive.delegatedTaskNode({ commandId });
    // A call cut while it launched left its launch running; its record decides this answer.
    yield* awaitLaunch(taskId);
    // An accepted retry answers with its task before checking what changed since, such as this
    // checkout's commit or the run that called. Its launch has ended, so the task's thread is
    // there or never will be, and its follower finds which. A refused record launched nothing.
    const recorded = yield* threads
      .receiptStatus(commandId)
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
    if (recorded === "accepted") {
      yield* followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers));
      return { taskId };
    }
    const parent = yield* threads.getThreadRecords(scope.thread.threadId, ["runs"]).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "The calling thread was not found.",
          }),
      ),
    );
    const parentRun = parent.runs
      .filter(ThreadManagement.isActiveRun)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (
      parentRun === undefined ||
      parentRun.rootNodeId === null ||
      parentRun.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "Delegated tasks require an active run owned by this MCP provider session.",
      });
    }
    const parentNodeId = parentRun.rootNodeId;
    const { target } = input;
    // The provider and model inherit as they do for a task here. Another
    // provider there has no model to inherit, so the caller names one.
    const inherited = parent.thread.modelSelection;
    const instanceId =
      target.providerInstanceId ??
      (target.driverKind === undefined
        ? inherited.instanceId
        : yield* resolveRemoteInstance(scope, target.environmentId, target.driverKind));
    const model =
      target.model ?? (instanceId === inherited.instanceId ? inherited.model : undefined);
    if (model === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: `Pass target.model from orchestrator_capabilities with this environmentId (instance ${instanceId} there).`,
      });
    }
    const options =
      target.options ??
      (instanceId === inherited.instanceId && model === inherited.model
        ? inherited.options
        : undefined);
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
    const worktree = ownWorktreeThere[input.isolation ?? "shared"];
    const there = yield* resolveRemoteProject(
      scope,
      target.environmentId,
      parent.thread.projectId,
      target.projectId,
      worktree,
    );
    const { where } = there;
    if (worktree && "scratch" in where) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message:
          'Isolation "worktree" needs a project with a repository there, and this thread is in No project. Pass target.projectId (t3_project_list with this environmentId lists them), or omit isolation.',
      });
    }
    if (worktree && there.rank > SAME_ORIGIN) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          'Isolation "worktree" there starts from this checkout\'s commit, but the project it would run in there clones a fork or the upstream of this repository, not its origin, so it cannot fetch the commit. Pass target.projectId of a clone of this origin there, or omit isolation.',
      });
    }
    // A project there with another repository starts from its own default branch, as a
    // worktree of another local project does.
    const workspaceStrategy: LaunchWorkspaceStrategy | undefined = !worktree
      ? undefined
      : there.rank === SAME_ORIGIN
        ? yield* pushedWorktree(parent.thread.worktreePath, there.checkout, there.remoteName)
        : { type: "worktree" };
    const task = taskPrompt(input);
    // The thread there is named here, from the same scope and key, so the task is recorded
    // before the launch: a crash or lost reply after the launch leaves a task whose follower
    // finds its thread, and one before it a task whose thread is gone, which the follower fails.
    // @effect-diagnostics-next-line preferSchemaOverJson:off - a JSON pair keeps the namespace apart from the key.
    const keyBytes = new TextEncoder().encode(JSON.stringify([scope.requestNamespace, key]));
    const digest = yield* crypto.digest("SHA-256", keyBytes).pipe(Effect.orDie);
    const remoteThreadId = ThreadId.make(`remote-delegate:${Hex.encode(digest)}`);
    const link = yield* links.get(target.environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const remoteChild: OrchestrationV2RemoteTaskChild = {
      environmentId: target.environmentId,
      threadId: remoteThreadId,
      label: link?.label ?? target.environmentId,
    };
    const modelSelection = { instanceId, model, ...(options === undefined ? {} : { options }) };
    const launchThere = Effect.gen(function* () {
      yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId,
          task,
          ...(input.title === undefined ? {} : { title: input.title }),
          // The driver runs there; this side only labels the task with it.
          driver: ProviderDriverKind.make("remote"),
          modelSelection,
          remoteChild,
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
      const launched = yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_thread_launch, target.environmentId, {
          ...where,
          title: input.title ?? parent.thread.title,
          modelSelection,
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(interactionMode === undefined ? {} : { interactionMode }),
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          message: task,
          clientRequestId: `delegate:${scope.thread.threadId}:${key}`,
          launchId: remoteThreadId,
          // The thread there shows it is this thread's subagent, with a way back.
          delegatedFrom: {
            environmentId: hereId,
            threadId: parent.thread.id,
            title: parent.thread.title,
          },
        })
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
              Effect.catch((stopError) => Effect.succeed(stopError.code === "thread_not_found")),
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
    });
    // From the record on, the launch runs with the followers, so interrupting this call
    // cannot leave a recorded task that nothing launches or follows.
    const launch = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fiber = yield* launchThere.pipe(Effect.forkIn(followers));
        launching.set(taskId, fiber);
        // Also runs for a launch the closing scope interrupts before it starts.
        fiber.addObserver(() => {
          if (launching.get(taskId) === fiber) launching.delete(taskId);
        });
        // It waits for the launch, so it also ends a task whose launch failed to record that.
        yield* followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers));
        return fiber;
      }),
    );
    return yield* Fiber.join(launch);
  });

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
    const attempt = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
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
  const stopThere = (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    key: string,
    reason?: string,
  ) =>
    forwarding
      .interruptThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        stop: true,
        ...(reason === undefined ? {} : { reason }),
        clientRequestId: `${key}:${remote.threadId}`,
      })
      .pipe(Effect.asVoid);

  /**
   * The last reply `runId` gave on the task's thread there, which is its
   * result, read whole however long it is. A failed run prefers its error
   * from the activity view over an earlier reply, without taking another run's.
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
    let tailProbed = false;
    while (true) {
      const read = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        view: failed ? "activity" : "messages",
        limit: 100,
        // Keep the first and expected final activity pages whole. A result on a
        // middle page then needs an extra text read after the scan.
        ...(failed && remainingItems > 100 ? { maxCharsPerItem: 1 } : {}),
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
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
        const tailPosition = Math.floor((read.thread.itemCount - 1) / 100) * 100 - 1;
        if (tailPosition > read.nextPosition) {
          const tail = yield* forwarding.readThread(scope, remote.environmentId, {
            threadId: remote.threadId,
            view: "messages",
            limit: 100,
            afterPosition: tailPosition,
          });
          const tailReply = tail.items.findLast(
            (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
          );
          if (!tail.hasMore && tailReply !== undefined) {
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
        maxCharsPerItem: 50_000,
      });
      const part = rest.items[0];
      if (part === undefined) break;
      text += part.text ?? "";
      textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    return text;
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
   * fails the task with nothing left to stop; anything else (the other machine asleep, a
   * dropped route) is retried with back-off, and so is completing.
   */
  const follow = (parentThreadId: ThreadId, taskId: NodeId): Effect.Effect<void> =>
    followOnce(parentThreadId, taskId).pipe(
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
      Effect.retry(followRetry),
      Effect.ignoreCause({ log: true }),
    );

  /**
   * One wait on the task's thread there; true once the task here is done.
   * A task completed here first (cancelled, or its parent stopped) is
   * stopped there, and done once that stop is recorded here.
   */
  const followOnce = Effect.fn("RemoteDelegation.followOnce")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    yield* awaitLaunch(taskId);
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
        const key = remote.stopCount === undefined ? "stop" : `stop-${remote.stopCount}`;
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
    const resultRun = waited.resultRun ?? {
      runId: remote.runId ?? waited.runId,
      status: waited.status,
    };
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
    function* (scope, given, input) {
      const read = readTask(given.threadId, given.id).pipe(
        Effect.map(({ task }) => task),
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      // A launch still running may end the task, and its thread there may not exist yet. One
      // that ended after the caller read the task may have ended it, so it is read again.
      yield* awaitLaunch(given.id);
      const task = yield* read;
      if (task === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: `Delegated task ${given.id} no longer exists.`,
        });
      }
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
        input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie))
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
          status: terminalStatus(task.status),
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
      // Its follower may have seen it end there during the stop; that result stands.
      const stored = yield* read;
      const ended = stored?.result == null ? "cancelled" : terminalStatus(stored.status);
      return {
        taskId: task.id,
        status: ended === "cancelled" ? "cancel_requested" : ended,
      } satisfies OrchestratorMcpTaskCancelResult;
    },
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

  return RemoteDelegation.of({ delegate, cancel, start });
});

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
