import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HostResourcesSnapshot,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineCapacity,
  type OrchestratorMcpProviderCapability,
  type PeerLinkSummary,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  type ActiveTurnWorkspace,
  type ProjectionOpenCommandTask,
  ProjectionStoreThreadNotFoundError,
} from "../orchestration-v2/ProjectionStore.ts";
import * as MachinePlacement from "./MachinePlacement.ts";

const GIB = 1024 ** 3;
const LOCAL_ENV_ID = EnvironmentId.make("env:local");
const PEER_A_ID = EnvironmentId.make("env:peer-a");
const PEER_B_ID = EnvironmentId.make("env:peer-b");
const PEER_C_ID = EnvironmentId.make("env:peer-c");
const PARENT_PROJECT_ID = ProjectId.make("project:codeship");

const REPO_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/pingdotgg/t3code",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://github.com/pingdotgg/t3code.git",
  },
  origin: {
    canonicalKey: "github.com/gigazoro/codeship",
    displayName: "GigaZoro/CodeShip",
  },
};

const OTHER_REPO_IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/gigazoro/other-repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/gigazoro/other-repo.git",
  },
};

function makeCapacity(
  overrides: Partial<OrchestratorMcpMachineCapacity> = {},
): OrchestratorMcpMachineCapacity {
  return {
    loadAverage1m: 1,
    cpuCores: 8,
    loadPerCore: 0.125,
    activeThreads: 1,
    activeLandingCommands: 0,
    checkSlots: 4,
    freeCheckSlots: 4,
    availableMemoryBytes: 24 * GIB,
    totalMemoryBytes: 32 * GIB,
    memoryShort: false,
    activeImplementationThreadsByRepo: {},
    ...overrides,
  };
}

function makeProvider(
  overrides: Partial<OrchestratorMcpProviderCapability> = {},
): OrchestratorMcpProviderCapability {
  return {
    providerInstanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    models: [{ id: "gpt-5.4" }],
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    constraints: [],
    ...overrides,
  };
}

function makeCapabilities(
  input: {
    readonly capacity?: OrchestratorMcpMachineCapacity;
    readonly providers?: ReadonlyArray<OrchestratorMcpProviderCapability>;
  } = {},
): OrchestratorMcpCapabilitiesResult {
  return {
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    inheritedOptions: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    providers: [...(input.providers ?? [makeProvider()])],
    ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
    features: {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: true,
      threadManagement: true,
      incrementalThreadRead: true,
      scheduledTasks: true,
      maxBatchThreads: 20,
    },
  };
}

function makeLink(
  environmentId: EnvironmentId,
  overrides: Partial<PeerLinkSummary> = {},
): PeerLinkSummary {
  return {
    environmentId,
    label: environmentId,
    urls: ["https://peer.example.test"],
    access: "full-access",
    status: "reachable",
    lastReachedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
    lastError: null,
    linkedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
    expiresAt: DateTime.makeUnsafe("2027-11-28T00:00:00Z"),
    ...overrides,
  };
}

function makeScope(overrides: Partial<McpInvocationScope> = {}): McpInvocationScope {
  return {
    environmentId: LOCAL_ENV_ID,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "test-ns",
    thread: {
      threadId: ThreadId.make("thread:parent"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    ...overrides,
  };
}

function makeDelegateInput(
  overrides: Partial<OrchestratorMcpDelegateTaskInput> = {},
): OrchestratorMcpDelegateTaskInput {
  return {
    task: "Implement feature",
    role: "implementation",
    isolation: "worktree",
    ...overrides,
  };
}

function makeProject(id: ProjectId, repositoryIdentity: RepositoryIdentity | null): Project {
  return {
    id,
    title: id,
    workspaceRoot: `/workspace/${id}`,
    repositoryIdentity,
    faviconPath: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-28T00:00:00Z",
    updatedAt: "2026-11-28T00:00:00Z",
    deletedAt: null,
  };
}

describe("MachinePlacement.selectLeastLoadedMachine", () => {
  it("prefers healthy memory over memoryShort regardless of CPU load or slots", () => {
    const picked = MachinePlacement.selectLeastLoadedMachine([
      {
        environmentId: "local",
        capacity: makeCapacity({
          memoryShort: true,
          loadPerCore: 0,
          activeThreads: 0,
          freeCheckSlots: 4,
        }),
      },
      {
        environmentId: PEER_A_ID,
        capacity: makeCapacity({
          memoryShort: false,
          loadPerCore: 2.5,
          activeThreads: 8,
          freeCheckSlots: 0,
        }),
      },
    ]);
    assert.equal(picked?.environmentId, PEER_A_ID);
  });

  it("prefers candidates with freeCheckSlots > 0 before saturated ones", () => {
    const picked = MachinePlacement.selectLeastLoadedMachine([
      {
        environmentId: "local",
        capacity: makeCapacity({
          freeCheckSlots: 0,
          activeLandingCommands: 4,
          checkSlots: 4,
          loadPerCore: 0.1,
        }),
      },
      {
        environmentId: PEER_A_ID,
        capacity: makeCapacity({
          freeCheckSlots: 1,
          activeLandingCommands: 1,
          checkSlots: 2,
          loadPerCore: 1.5,
        }),
      },
    ]);
    assert.equal(picked?.environmentId, PEER_A_ID);
  });

  it("ranks by lower effective load pressure including Windows loadPerCore=0", () => {
    const picked = MachinePlacement.selectLeastLoadedMachine([
      {
        environmentId: "local",
        capacity: makeCapacity({
          loadAverage1m: 0,
          loadPerCore: 0,
          activeThreads: 4,
          activeLandingCommands: 1,
          checkSlots: 2,
          freeCheckSlots: 1,
        }),
      },
      {
        environmentId: PEER_A_ID,
        capacity: makeCapacity({
          loadAverage1m: 0,
          loadPerCore: 0,
          activeThreads: 1,
          activeLandingCommands: 0,
          checkSlots: 2,
          freeCheckSlots: 2,
        }),
      },
    ]);
    assert.equal(picked?.environmentId, PEER_A_ID);

    const byCpuLoad = MachinePlacement.selectLeastLoadedMachine([
      {
        environmentId: "local",
        capacity: makeCapacity({ activeThreads: 1, checkSlots: 4, loadPerCore: 0.9 }),
      },
      {
        environmentId: PEER_B_ID,
        capacity: makeCapacity({ activeThreads: 1, checkSlots: 4, loadPerCore: 0.2 }),
      },
    ]);
    assert.equal(byCpuLoad?.environmentId, PEER_B_ID);
  });

  it("breaks ties deterministically: local wins over remote, then lexicographical environmentId", () => {
    const shared = makeCapacity({ activeThreads: 2, checkSlots: 4, loadPerCore: 0.25 });
    // Even though "env:aaa" sorts before "local", local wins equal-score ties.
    const localTie = MachinePlacement.selectLeastLoadedMachine([
      { environmentId: EnvironmentId.make("env:aaa"), capacity: shared },
      { environmentId: "local", capacity: shared },
    ]);
    assert.equal(localTie?.environmentId, "local");

    const remoteTie = MachinePlacement.selectLeastLoadedMachine([
      { environmentId: PEER_B_ID, capacity: shared },
      { environmentId: PEER_A_ID, capacity: shared },
    ]);
    assert.equal(remoteTie?.environmentId, PEER_A_ID);
  });
});

const DEFAULT_INHERITED_INSTANCE = ProviderInstanceId.make("codex");
const DEFAULT_INHERITED_MODEL = "gpt-5.4";

function makeGit(
  execute: MachinePlacement.ResolveAutomaticPlacementInput["git"]["execute"] = () =>
    Effect.succeed({
      exitCode: 0 as never,
      stdout: "  origin/main\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
): MachinePlacement.ResolveAutomaticPlacementInput["git"] {
  return { execute };
}

describe("MachinePlacement.readLocalCapacity", () => {
  it.effect(
    "deduplicates active+landing threads, excludes archived/deleted threads from activeThreads and repo map, excludes plan/review/research from repo map, and handles Windows null loadAverage",
    () =>
      Effect.gen(function* () {
        const implBoth = ThreadId.make("thread:impl-both");
        const implLandingOnly = ThreadId.make("thread:impl-landing-only");
        const planThread = ThreadId.make("thread:plan");
        const reviewThread = ThreadId.make("thread:review");
        const researchThread = ThreadId.make("thread:research");
        const archivedActiveThread = ThreadId.make("thread:archived-active");
        const deletedActiveThread = ThreadId.make("thread:deleted-active");
        const archivedCommandThread = ThreadId.make("thread:archived-cmd");

        const activeWorkspaces: ReadonlyArray<ActiveTurnWorkspace> = [
          { threadId: implBoth, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/1" },
          { threadId: planThread, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/2" },
          { threadId: reviewThread, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/3" },
          { threadId: researchThread, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/4" },
          { threadId: archivedActiveThread, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/5" },
          { threadId: deletedActiveThread, projectId: PARENT_PROJECT_ID, worktreePath: "/wt/6" },
        ];
        const openCommands: ReadonlyArray<ProjectionOpenCommandTask> = [
          {
            parentThreadId: implBoth,
            taskId: NodeId.make("cmd:1"),
            threadTitle: "Impl 1",
            threadClosed: null,
            label: "land",
            command: "node .github/scripts/landing-turn.cjs land",
          },
          {
            parentThreadId: implLandingOnly,
            taskId: NodeId.make("cmd:2"),
            threadTitle: "Impl 2",
            threadClosed: null,
            label: "check",
            command: "vp run check:changed origin/main",
          },
          {
            parentThreadId: implBoth,
            taskId: NodeId.make("cmd:3"),
            threadTitle: "Impl 1",
            threadClosed: null,
            label: "unit",
            command: "vp test run foo.test.ts",
          },
          {
            parentThreadId: archivedCommandThread,
            taskId: NodeId.make("cmd:4"),
            threadTitle: "Archived",
            threadClosed: "archived",
            label: "land",
            command: "node .github/scripts/landing-turn.cjs land",
          },
        ];
        const threads = new Map<ThreadId, OrchestrationV2AppThread>([
          [
            implBoth,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            implLandingOnly,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            planThread,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "plan",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            reviewThread,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "default",
              reviewAssignment: { handle: "review-1" },
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            researchThread,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "default",
              tags: ["Research"],
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            archivedActiveThread,
            {
              projectId: PARENT_PROJECT_ID,
              interactionMode: "default",
              archivedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
            } as unknown as OrchestrationV2AppThread,
          ],
        ]);
        const hostSnapshot: HostResourcesSnapshot = {
          sampledAt: 1_000,
          cpuUtilization: 0.4,
          cpuCount: 16,
          availableMemoryBytes: 24 * GIB,
          totalMemoryBytes: 64 * GIB,
          loadAverage: null,
        };

        const capacity = yield* MachinePlacement.readLocalCapacity({
          hostResources: Option.some({ read: Effect.succeed(hostSnapshot) }),
          memoryAdmission: { shortage: Effect.succeed(null) },
          projections: Option.some({
            getActiveTurnWorkspaces: () => Effect.succeed(activeWorkspaces),
            getOpenCommandTasks: Effect.succeed(openCommands),
            getThread: (threadId) => {
              const found = threads.get(threadId);
              return found === undefined
                ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }))
                : Effect.succeed(found);
            },
          }),
          projects: {
            getWithRepositoryIdentity: (projectId) =>
              Effect.succeed(
                projectId === PARENT_PROJECT_ID
                  ? Option.some(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY))
                  : Option.none(),
              ),
          },
        });

        assert.equal(capacity.loadAverage1m, 0);
        assert.equal(capacity.cpuCores, 16);
        assert.equal(capacity.loadPerCore, 0);
        // 4 live active turn threads + 1 landing-only thread (archived + deleted excluded)
        assert.equal(capacity.activeThreads, 5);
        assert.equal(capacity.activeLandingCommands, 2);
        // min(floor(16/2)=8, floor(24GiB/6GiB)=4) = 4
        assert.equal(capacity.checkSlots, 4);
        assert.equal(capacity.freeCheckSlots, 2);
        assert.equal(capacity.availableMemoryBytes, 24 * GIB);
        assert.equal(capacity.totalMemoryBytes, 64 * GIB);
        assert.equal(capacity.memoryShort, false);
        // Only live implBoth + implLandingOnly count (archived, deleted, plan, review, research excluded).
        assert.deepEqual(capacity.activeImplementationThreadsByRepo, {
          "github.com/gigazoro/codeship": 2,
          "github.com/pingdotgg/t3code": 2,
        });
      }),
  );

  it.effect(
    "guards non-finite cpuCount and falls back to OS metrics when HostResources and ProjectionStoreV2 are absent",
    () =>
      Effect.gen(function* () {
        const nonFiniteCapacity = yield* MachinePlacement.readLocalCapacity({
          hostResources: Option.some({
            read: Effect.succeed({
              sampledAt: 1_000,
              cpuUtilization: 0,
              cpuCount: Number.NaN,
              availableMemoryBytes: 16 * GIB,
              totalMemoryBytes: 32 * GIB,
              loadAverage: [Number.NaN, 0, 0] as const,
            }),
          }),
          memoryAdmission: { shortage: Effect.succeed(null) },
          projections: Option.none(),
          projects: {
            getWithRepositoryIdentity: () => Effect.die("unused"),
          },
        });
        assert.equal(nonFiniteCapacity.cpuCores, 0);
        assert.equal(nonFiniteCapacity.loadAverage1m, 0);
        assert.equal(nonFiniteCapacity.checkSlots, 1);

        const capacity = yield* MachinePlacement.readLocalCapacity({
          hostResources: Option.none(),
          memoryAdmission: {
            shortage: Effect.succeed({
              kind: "available",
              totalBytes: 16 * GIB,
              availableBytes: 1 * GIB,
              reserveBytes: 4 * GIB,
            }),
          },
          projections: Option.none(),
          projects: {
            getWithRepositoryIdentity: () =>
              Effect.die("should not be called when no active threads"),
          },
        });
        assert.isTrue(capacity.cpuCores >= 0);
        assert.isTrue(capacity.checkSlots >= 1);
        assert.equal(capacity.activeThreads, 0);
        assert.equal(capacity.activeLandingCommands, 0);
        assert.equal(capacity.memoryShort, true);
        assert.deepEqual(capacity.activeImplementationThreadsByRepo, {});
      }),
  );
});

describe("MachinePlacement.resolveAutomaticPlacement", () => {
  it.effect("routes unpinned implementation worktree delegate to least-loaded eligible peer", () =>
    Effect.gen(function* () {
      const gitCwds: Array<string> = [];
      const selected = yield* MachinePlacement.resolveAutomaticPlacement({
        scope: makeScope(),
        parentProjectId: PARENT_PROJECT_ID,
        parentWorktreePath: "/wt/parent-feature",
        inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
        inheritedParentModel: DEFAULT_INHERITED_MODEL,
        input: makeDelegateInput(),
        localCapacity: makeCapacity({ activeThreads: 4, checkSlots: 2, loadPerCore: 1.0 }),
        peerLinks: {
          list: Effect.succeed([makeLink(PEER_A_ID), makeLink(PEER_B_ID)]),
        },
        peerForwarding: {
          readCapabilities: (_scope, envId) =>
            Effect.succeed(
              envId === PEER_A_ID
                ? makeCapabilities({
                    capacity: makeCapacity({ activeThreads: 2, checkSlots: 4, loadPerCore: 0.4 }),
                  })
                : makeCapabilities({
                    capacity: makeCapacity({ activeThreads: 0, checkSlots: 4, loadPerCore: 0.1 }),
                  }),
            ),
          call: (_scope, _tool, envId) =>
            Effect.succeed({
              projects: [makeProject(ProjectId.make(`proj:${envId}`), REPO_IDENTITY)],
              nextCursor: null,
              total: 1,
            }) as never,
        },
        projects: {
          getWithRepositoryIdentity: () =>
            Effect.succeedSome(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY)),
        },
        git: makeGit((input) => {
          gitCwds.push(input.cwd);
          assert.deepEqual(input.args, ["branch", "-r", "--contains", "HEAD"]);
          return Effect.succeed({
            exitCode: 0 as never,
            stdout: "  origin/main\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }),
      });
      assert.equal(selected, PEER_B_ID);
      assert.deepEqual(gitCwds, ["/wt/parent-feature"]);
    }),
  );

  it.effect(
    "stays local without probing peers when local HEAD is unpushed or cannot be verified",
    () =>
      Effect.gen(function* () {
        const peerForwarding = {
          readCapabilities: () => Effect.die("must not probe peers for unpushed HEAD"),
          call: () => Effect.die("must not call peers for unpushed HEAD"),
        };
        const base = {
          scope: makeScope(),
          parentProjectId: PARENT_PROJECT_ID,
          inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
          inheritedParentModel: DEFAULT_INHERITED_MODEL,
          input: makeDelegateInput(),
          localCapacity: makeCapacity({ activeThreads: 8, loadPerCore: 3 }),
          peerLinks: { list: Effect.succeed([makeLink(PEER_A_ID)]) },
          peerForwarding,
          projects: {
            getWithRepositoryIdentity: () =>
              Effect.succeedSome(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY)),
          },
        };

        const unpushed = yield* MachinePlacement.resolveAutomaticPlacement({
          ...base,
          git: makeGit(() =>
            Effect.succeed({
              exitCode: 0 as never,
              stdout: "   \n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          ),
        });
        assert.isUndefined(unpushed);

        const gitFailed = yield* MachinePlacement.resolveAutomaticPlacement({
          ...base,
          git: makeGit(() => Effect.fail(new Error("not a git repo") as never)),
        });
        assert.isUndefined(gitFailed);
      }),
  );

  it.effect(
    "preserves explicit pinning, local isolation, non-implementation roles, linkOrigin, Auto/routing/options/roleSelection, and un-modelled cross-provider targets",
    () =>
      Effect.gen(function* () {
        let peerLinksReadCount = 0;
        const peerLinks = {
          list: Effect.sync(() => {
            peerLinksReadCount += 1;
            return [makeLink(PEER_A_ID)];
          }),
        };
        const peerForwarding = {
          readCapabilities: () => Effect.die("must not probe peers"),
          call: () => Effect.die("must not call peers"),
        };
        const projects = {
          getWithRepositoryIdentity: () => Effect.die("must not read parent project"),
        };
        const git = makeGit(() => Effect.die("must not run git"));

        const cases: ReadonlyArray<{
          readonly label: string;
          readonly scope?: McpInvocationScope;
          readonly parentLinkOrigin?: {
            readonly sessionId: string;
            readonly label: string;
            readonly access: "full-access";
          };
          readonly inheritedAutoAccount?: boolean;
          readonly hasRoleSelection?: boolean;
          readonly input: OrchestratorMcpDelegateTaskInput;
        }> = [
          {
            label: "explicit remote environmentId",
            input: makeDelegateInput({ target: { environmentId: PEER_A_ID } }),
          },
          {
            label: "explicit local environmentId",
            input: makeDelegateInput({ target: { environmentId: LOCAL_ENV_ID } }),
          },
          {
            label: "explicit projectId",
            input: makeDelegateInput({ target: { projectId: PARENT_PROJECT_ID } }),
          },
          {
            label: "shared isolation",
            input: makeDelegateInput({ isolation: "shared" }),
          },
          {
            label: "omitted isolation",
            input: makeDelegateInput({ isolation: undefined }),
          },
          {
            label: "omitted role",
            input: makeDelegateInput({ role: undefined }),
          },
          {
            label: "general role",
            input: makeDelegateInput({ role: "general" }),
          },
          {
            label: "review role",
            input: makeDelegateInput({ role: "review" }),
          },
          {
            label: "research role",
            input: makeDelegateInput({ role: "research" }),
          },
          {
            label: "linkedEnvironments disabled on scope",
            scope: makeScope({ linkedEnvironments: false }),
            input: makeDelegateInput(),
          },
          {
            label: "parent thread originated from peer link",
            parentLinkOrigin: { sessionId: "sess-1", label: "Peer", access: "full-access" },
            input: makeDelegateInput(),
          },
          {
            label: "direct linked client scope",
            scope: makeScope({
              client: {
                sessionId: "sess-2",
                label: "Peer",
                access: "full-access",
                linked: true,
              },
            }),
            input: makeDelegateInput(),
          },
          {
            label: "local roleSelection overrides model",
            hasRoleSelection: true,
            input: makeDelegateInput(),
          },
          {
            label: "target.options specified",
            input: makeDelegateInput({
              target: {
                driverKind: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
                options: [{ id: "effort", value: "high" }],
              },
            }),
          },
          {
            label: "explicit auto:true",
            input: makeDelegateInput({ auto: true }),
          },
          {
            label: "inherited Auto parent with omitted target",
            inheritedAutoAccount: true,
            input: makeDelegateInput(),
          },
          {
            label: "inherited Auto parent with empty target",
            inheritedAutoAccount: true,
            input: makeDelegateInput({ target: {} }),
          },
          {
            label: "routing constraints present",
            input: makeDelegateInput({ routing: { capabilityTier: "deep" } }),
          },
          {
            label: "driverKind without model",
            input: makeDelegateInput({
              target: { driverKind: ProviderDriverKind.make("codex") },
            }),
          },
          {
            label: "different providerInstanceId without model",
            input: makeDelegateInput({
              target: { providerInstanceId: ProviderInstanceId.make("codex-other") },
            }),
          },
        ];

        for (const testCase of cases) {
          const result = yield* MachinePlacement.resolveAutomaticPlacement({
            scope: testCase.scope ?? makeScope(),
            parentProjectId: PARENT_PROJECT_ID,
            parentLinkOrigin: testCase.parentLinkOrigin,
            inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
            inheritedParentModel: DEFAULT_INHERITED_MODEL,
            inheritedAutoAccount: testCase.inheritedAutoAccount,
            hasRoleSelection: testCase.hasRoleSelection,
            input: testCase.input,
            localCapacity: makeCapacity({ activeThreads: 8, loadPerCore: 3 }),
            peerLinks,
            peerForwarding,
            projects,
            git,
          });
          assert.isUndefined(result, testCase.label);
        }
        assert.equal(peerLinksReadCount, 0);
      }),
  );

  it.effect("aligns peerSatisfiesTarget strictly with RemoteDelegation target resolution", () =>
    Effect.gen(function* () {
      const codexDriver = ProviderDriverKind.make("codex");
      const codexAlt = ProviderInstanceId.make("codex-alt");
      const codexSecondary = ProviderInstanceId.make("codex-secondary");

      const probeWithPeerProviders = (
        providers: ReadonlyArray<OrchestratorMcpProviderCapability>,
        input: OrchestratorMcpDelegateTaskInput,
        overrides: {
          readonly inheritedInstanceId?: ProviderInstanceId;
          readonly inheritedParentModel?: string;
          readonly inheritedAutoAccount?: boolean;
        } = {},
      ) =>
        MachinePlacement.resolveAutomaticPlacement({
          scope: makeScope(),
          parentProjectId: PARENT_PROJECT_ID,
          inheritedInstanceId: overrides.inheritedInstanceId ?? DEFAULT_INHERITED_INSTANCE,
          inheritedParentModel: overrides.inheritedParentModel ?? DEFAULT_INHERITED_MODEL,
          inheritedAutoAccount: overrides.inheritedAutoAccount,
          input,
          localCapacity: makeCapacity({ activeThreads: 6, checkSlots: 2, loadPerCore: 2.0 }),
          peerLinks: { list: Effect.succeed([makeLink(PEER_A_ID)]) },
          peerForwarding: {
            readCapabilities: () =>
              Effect.succeed(
                makeCapabilities({
                  capacity: makeCapacity({ activeThreads: 0, checkSlots: 4, loadPerCore: 0.1 }),
                  providers,
                }),
              ),
            call: () =>
              Effect.succeed({
                projects: [makeProject(ProjectId.make("proj:peer-a"), REPO_IDENTITY)],
                nextCursor: null,
                total: 1,
              }) as never,
          },
          projects: {
            getWithRepositoryIdentity: () =>
              Effect.succeedSome(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY)),
          },
          git: makeGit(),
        });

      // Omitted target requires peer to have inheritedInstanceId AND explicit inheritedParentModel.
      assert.isUndefined(
        yield* probeWithPeerProviders(
          [makeProvider({ providerInstanceId: codexAlt, models: [{ id: "gpt-5.4" }] })],
          makeDelegateInput(),
        ),
        "omitted target must not match when peer lacks inheritedInstanceId",
      );
      assert.isUndefined(
        yield* probeWithPeerProviders(
          [makeProvider({ models: [{ id: "gpt-5.3" }], omittedModels: 10 })],
          makeDelegateInput(),
        ),
        "omitted target must not treat omittedModels > 0 as matching an unlisted model",
      );
      assert.isUndefined(
        yield* probeWithPeerProviders(
          [makeProvider({ models: [{ id: "gpt-5.4" }], constraints: ["Disabled for project"] })],
          makeDelegateInput(),
        ),
        "provider with constraints is not runnable",
      );

      // target.model only inherits inheritedInstanceId, so another instance offering the model must NOT match.
      assert.isUndefined(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: DEFAULT_INHERITED_INSTANCE,
              models: [{ id: "gpt-5.3" }],
            }),
            makeProvider({ providerInstanceId: codexAlt, models: [{ id: "gpt-5.5" }] }),
          ],
          makeDelegateInput({ target: { model: "gpt-5.5" } }),
        ),
        "target.model only requires inheritedInstanceId to offer the model",
      );
      assert.equal(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: DEFAULT_INHERITED_INSTANCE,
              models: [{ id: "gpt-5.5" }],
            }),
          ],
          makeDelegateInput({ target: { model: "gpt-5.5" } }),
        ),
        PEER_A_ID,
      );

      // target.providerInstanceId === inheritedInstanceId without model uses inheritedParentModel.
      assert.equal(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: DEFAULT_INHERITED_INSTANCE,
              models: [{ id: "gpt-5.4" }],
            }),
          ],
          makeDelegateInput({ target: { providerInstanceId: DEFAULT_INHERITED_INSTANCE } }),
        ),
        PEER_A_ID,
      );

      // driverKind + model must inspect the exact instance RemoteDelegation.resolveRemoteInstance picks.
      assert.isUndefined(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: codexAlt,
              driverKind: codexDriver,
              models: [{ id: "gpt-5.3" }],
            }),
            makeProvider({
              providerInstanceId: codexSecondary,
              driverKind: codexDriver,
              models: [{ id: "gpt-5.4" }],
            }),
          ],
          makeDelegateInput({ target: { driverKind: codexDriver, model: "gpt-5.4" } }),
        ),
        "must stay local when the first runnable instance of driverKind lacks target.model",
      );
      assert.equal(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: codexAlt,
              driverKind: codexDriver,
              models: [{ id: "gpt-5.3" }],
              usageLimited: true,
            }),
            makeProvider({
              providerInstanceId: codexSecondary,
              driverKind: codexDriver,
              models: [{ id: "gpt-5.4" }],
            }),
          ],
          makeDelegateInput({ target: { driverKind: codexDriver, model: "gpt-5.4" } }),
        ),
        PEER_A_ID,
      );

      // Inherited Auto parent with explicit auto:false or explicit driverKind+model can still offload.
      assert.equal(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: DEFAULT_INHERITED_INSTANCE,
              models: [{ id: "gpt-5.4" }],
            }),
          ],
          makeDelegateInput({ auto: false }),
          { inheritedAutoAccount: true },
        ),
        PEER_A_ID,
      );
      assert.equal(
        yield* probeWithPeerProviders(
          [
            makeProvider({
              providerInstanceId: codexAlt,
              driverKind: codexDriver,
              models: [{ id: "gpt-5.4" }],
            }),
          ],
          makeDelegateInput({ target: { driverKind: codexDriver, model: "gpt-5.4" } }),
          { inheritedAutoAccount: true },
        ),
        PEER_A_ID,
      );
    }),
  );

  it.effect(
    "skips offline, non-full-access, timed-out, older (no capacity), memoryShort, repo-missing, ambiguous-repo, and provider-mismatched peers",
    () =>
      Effect.gen(function* () {
        const envTimedOut = EnvironmentId.make("env:timed-out");
        const envOldPeer = EnvironmentId.make("env:old");
        const envMemShort = EnvironmentId.make("env:mem-short");
        const envNoRepo = EnvironmentId.make("env:no-repo");
        const envAmbiguous = EnvironmentId.make("env:ambiguous");
        const envWrongProvider = EnvironmentId.make("env:wrong-provider");
        const envOffline = EnvironmentId.make("env:offline");
        const envNarrowAccess = EnvironmentId.make("env:narrow");
        const envHealthy = PEER_C_ID;
        const stalled = yield* Deferred.make<never>();

        const fiber = yield* MachinePlacement.resolveAutomaticPlacement({
          scope: makeScope(),
          parentProjectId: PARENT_PROJECT_ID,
          inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
          inheritedParentModel: DEFAULT_INHERITED_MODEL,
          input: makeDelegateInput({
            target: {
              driverKind: ProviderDriverKind.make("claudeAgent"),
              model: "claude-opus-5-5",
            },
          }),
          localCapacity: makeCapacity({ activeThreads: 6, checkSlots: 2, loadPerCore: 2.0 }),
          peerLinks: {
            list: Effect.succeed([
              makeLink(envOffline, { status: "unreachable" }),
              makeLink(envNarrowAccess, { access: "auto" }),
              makeLink(envTimedOut),
              makeLink(envOldPeer),
              makeLink(envMemShort),
              makeLink(envNoRepo),
              makeLink(envAmbiguous),
              makeLink(envWrongProvider),
              makeLink(envHealthy),
            ]),
          },
          peerForwarding: {
            readCapabilities: (_scope, envId) => {
              if (envId === envTimedOut) return Deferred.await(stalled);
              if (envId === envOldPeer) return Effect.succeed(makeCapabilities());
              if (envId === envMemShort) {
                return Effect.succeed(
                  makeCapabilities({
                    capacity: makeCapacity({ memoryShort: true, activeThreads: 0, loadPerCore: 0 }),
                    providers: [
                      makeProvider({
                        providerInstanceId: ProviderInstanceId.make("claude"),
                        driverKind: ProviderDriverKind.make("claudeAgent"),
                        models: [{ id: "claude-opus-5-5" }],
                      }),
                    ],
                  }),
                );
              }
              if (envId === envWrongProvider) {
                return Effect.succeed(
                  makeCapabilities({
                    capacity: makeCapacity({ activeThreads: 0, loadPerCore: 0 }),
                    providers: [
                      makeProvider({
                        providerInstanceId: ProviderInstanceId.make("claude"),
                        driverKind: ProviderDriverKind.make("claudeAgent"),
                        models: [{ id: "claude-opus-5-5" }],
                        usageLimited: true,
                      }),
                    ],
                  }),
                );
              }
              return Effect.succeed(
                makeCapabilities({
                  capacity: makeCapacity({ activeThreads: 0, loadPerCore: 0.1 }),
                  providers: [
                    makeProvider({
                      providerInstanceId: ProviderInstanceId.make("claude"),
                      driverKind: ProviderDriverKind.make("claudeAgent"),
                      models: [{ id: "claude-opus-5-5" }],
                    }),
                  ],
                }),
              );
            },
            call: (_scope, _tool, envId) => {
              if (envId === envNoRepo) {
                return Effect.succeed({
                  projects: [makeProject(ProjectId.make("proj:other"), OTHER_REPO_IDENTITY)],
                  nextCursor: null,
                  total: 1,
                }) as never;
              }
              if (envId === envAmbiguous) {
                return Effect.succeed({
                  projects: [
                    makeProject(ProjectId.make("proj:dup-1"), REPO_IDENTITY),
                    makeProject(ProjectId.make("proj:dup-2"), REPO_IDENTITY),
                  ],
                  nextCursor: null,
                  total: 2,
                }) as never;
              }
              return Effect.succeed({
                projects: [makeProject(ProjectId.make(`proj:${envId}`), REPO_IDENTITY)],
                nextCursor: null,
                total: 1,
              }) as never;
            },
          },
          projects: {
            getWithRepositoryIdentity: () =>
              Effect.succeedSome(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY)),
          },
          git: makeGit(),
        }).pipe(Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(6));
        const selected = yield* Fiber.join(fiber);
        assert.equal(selected, envHealthy);
      }),
  );

  it.effect("stays local when parent project has no repositoryIdentity or peer probe fails", () =>
    Effect.gen(function* () {
      const noRepoResult = yield* MachinePlacement.resolveAutomaticPlacement({
        scope: makeScope(),
        parentProjectId: PARENT_PROJECT_ID,
        inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
        inheritedParentModel: DEFAULT_INHERITED_MODEL,
        input: makeDelegateInput(),
        localCapacity: makeCapacity({ activeThreads: 5, loadPerCore: 2 }),
        peerLinks: { list: Effect.succeed([makeLink(PEER_A_ID)]) },
        peerForwarding: {
          readCapabilities: () => Effect.die("must not probe when parent has no repo identity"),
          call: () => Effect.die("must not call peer"),
        },
        projects: {
          getWithRepositoryIdentity: () => Effect.succeedSome(makeProject(PARENT_PROJECT_ID, null)),
        },
        git: makeGit(() => Effect.die("must not run git when parent has no repo identity")),
      });
      assert.isUndefined(noRepoResult);

      const failedProbeResult = yield* MachinePlacement.resolveAutomaticPlacement({
        scope: makeScope(),
        parentProjectId: PARENT_PROJECT_ID,
        inheritedInstanceId: DEFAULT_INHERITED_INSTANCE,
        inheritedParentModel: DEFAULT_INHERITED_MODEL,
        input: makeDelegateInput(),
        localCapacity: makeCapacity({ activeThreads: 5, loadPerCore: 2 }),
        peerLinks: { list: Effect.succeed([makeLink(PEER_A_ID)]) },
        peerForwarding: {
          readCapabilities: () =>
            Effect.fail(new OrchestratorMcpFailure({ code: "unreachable", message: "offline" })),
          call: () => Effect.die("should not call project list after capabilities failed"),
        },
        projects: {
          getWithRepositoryIdentity: () =>
            Effect.succeedSome(makeProject(PARENT_PROJECT_ID, REPO_IDENTITY)),
        },
        git: makeGit(),
      });
      assert.isUndefined(failedProbeResult);
    }),
  );
});
