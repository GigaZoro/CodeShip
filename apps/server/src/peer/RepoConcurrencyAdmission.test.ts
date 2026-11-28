import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, NodeId, ProjectId, ThreadId } from "@t3tools/contracts/baseSchemas";
import type { RepositoryIdentity } from "@t3tools/contracts/environment";
import type { OrchestrationV2AppThread } from "@t3tools/contracts/orchestrationV2";
import { OrchestratorMcpFailure } from "@t3tools/contracts/orchestratorMcp";
import type { PeerLinkSummary } from "@t3tools/contracts/peerLink";
import type { Project } from "@t3tools/contracts/project";
import type { HostResourcesSnapshot } from "@t3tools/contracts/resourceTelemetry";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type ActiveTurnWorkspace,
  type ProjectionOpenCommandTask,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as MachinePlacement from "./MachinePlacement.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as RepoConcurrencyAdmission from "./RepoConcurrencyAdmission.ts";

const GIB = 1024 ** 3;
const LOCAL_ENV_ID = EnvironmentId.make("env:local");
const PEER_A_ID = EnvironmentId.make("env:peer-a");
const PEER_B_ID = EnvironmentId.make("env:peer-b");
const TARGET_PROJECT_ID = ProjectId.make("project:codeship");
const OTHER_PROJECT_ID = ProjectId.make("project:other");
const NONGIT_PROJECT_ID = ProjectId.make("project:scratch");

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

function makeLink(
  environmentId: EnvironmentId,
  overrides: Partial<PeerLinkSummary> = {},
): PeerLinkSummary {
  return {
    environmentId,
    label: overrides.label ?? environmentId,
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

const HOST_SNAPSHOT: HostResourcesSnapshot = {
  sampledAt: 1_000,
  cpuUtilization: 0.2,
  cpuCount: 8,
  availableMemoryBytes: 24 * GIB,
  totalMemoryBytes: 32 * GIB,
  loadAverage: [1, 1, 1],
};

function makeAdmissionDependencies(input: {
  readonly activeWorkspaces?: ReadonlyArray<ActiveTurnWorkspace>;
  readonly openCommands?: ReadonlyArray<ProjectionOpenCommandTask>;
  readonly threads?: ReadonlyMap<ThreadId, OrchestrationV2AppThread>;
  readonly peerLinks?: ReadonlyArray<PeerLinkSummary>;
  readonly peerLinksEnabled?: boolean;
  readonly onPeerCall?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  readonly onPeerCallIfAvailable?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<unknown>, OrchestratorMcpFailure>;
}) {
  const projectsMap = new Map<ProjectId, Project>([
    [TARGET_PROJECT_ID, makeProject(TARGET_PROJECT_ID, REPO_IDENTITY)],
    [OTHER_PROJECT_ID, makeProject(OTHER_PROJECT_ID, OTHER_REPO_IDENTITY)],
    [NONGIT_PROJECT_ID, makeProject(NONGIT_PROJECT_ID, null)],
  ]);
  const threads = input.threads ?? new Map<ThreadId, OrchestrationV2AppThread>();
  return Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, "linux" as NodeJS.Platform),
    MemoryAdmission.layerTest(),
    Layer.succeed(HostResources.HostResources, {
      read: Effect.succeed(HOST_SNAPSHOT),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(LOCAL_ENV_ID),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getWithRepositoryIdentity: (projectId) =>
        Effect.succeed(Option.fromUndefinedOr(projectsMap.get(projectId))),
    }),
    Layer.mock(ProjectionStoreV2)({
      getActiveTurnWorkspaces: () => Effect.succeed(input.activeWorkspaces ?? []),
      getOpenCommandTasks: Effect.succeed(input.openCommands ?? []),
      getThread: (threadId) => {
        const found = threads.get(threadId);
        return found === undefined
          ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }))
          : Effect.succeed(found);
      },
    }),
    Layer.mock(PeerLinks.PeerLinks)({
      enabled: Effect.succeed(input.peerLinksEnabled ?? true),
      list: Effect.succeed(input.peerLinks ?? []),
    }),
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      callIfAvailable: (callInput) =>
        (input.onPeerCallIfAvailable?.(callInput.environmentId) ??
          (input.onPeerCall !== undefined
            ? input.onPeerCall(callInput.environmentId).pipe(Effect.asSome)
            : Effect.succeedSome({
                capacity: { activeImplementationThreadsByRepo: {} },
              }))) as never,
    }),
  );
}

function makeAdmissionLayer(input: {
  readonly activeWorkspaces?: ReadonlyArray<ActiveTurnWorkspace>;
  readonly openCommands?: ReadonlyArray<ProjectionOpenCommandTask>;
  readonly threads?: ReadonlyMap<ThreadId, OrchestrationV2AppThread>;
  readonly peerLinks?: ReadonlyArray<PeerLinkSummary>;
  readonly peerLinksEnabled?: boolean;
  readonly onPeerCall?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  readonly onPeerCallIfAvailable?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<unknown>, OrchestratorMcpFailure>;
  readonly options?: RepoConcurrencyAdmission.RepoConcurrencyAdmissionOptions;
}) {
  return RepoConcurrencyAdmission.layerLive(input.options).pipe(
    Layer.provide(makeAdmissionDependencies(input)),
  );
}

describe("RepoConcurrencyAdmission helpers", () => {
  it("parses positive integer cap overrides and falls back to 4 otherwise", () => {
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap(undefined), 4);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap("2"), 2);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap(" 6 "), 6);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap("0"), 4);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap("-1"), 4);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap("2.5"), 4);
    assert.equal(RepoConcurrencyAdmission.parseRepoImplementationCap("abc"), 4);
  });

  it("takes per-machine max across alias keys without double-counting", () => {
    assert.equal(
      RepoConcurrencyAdmission.maxRepoCountForKeys(
        {
          "github.com/pingdotgg/t3code": 2,
          "github.com/gigazoro/codeship": 2,
          "github.com/gigazoro/other-repo": 9,
        },
        ["github.com/pingdotgg/t3code", "github.com/gigazoro/codeship"],
      ),
      2,
    );
    assert.equal(RepoConcurrencyAdmission.maxRepoCountForKeys(undefined, ["a"]), 0);
    assert.equal(RepoConcurrencyAdmission.maxRepoCountForKeys({ a: Number.NaN }, ["a"]), 0);
  });

  it("classifies review, research, and design as non-implementation roles", () => {
    assert.isTrue(RepoConcurrencyAdmission.isNonImplementationRole("review"));
    assert.isTrue(RepoConcurrencyAdmission.isNonImplementationRole("research"));
    assert.isTrue(RepoConcurrencyAdmission.isNonImplementationRole("design"));
    assert.isFalse(RepoConcurrencyAdmission.isNonImplementationRole("implementation"));
    assert.isFalse(RepoConcurrencyAdmission.isNonImplementationRole(undefined));
  });

  it("formats repo_capacity_full failures with counts, machine breakdown, batch size, and exemption guidance", () => {
    const failure = RepoConcurrencyAdmission.formatRepoConcurrencyFailure({
      allowed: false,
      activeCount: 3,
      requestedCount: 2,
      limit: 4,
      repoKey: "github.com/pingdotgg/t3code",
      breakdown: [
        { environmentId: "local", label: "local", count: 2 },
        { environmentId: PEER_A_ID, label: "Mac", count: 1 },
        { environmentId: PEER_B_ID, label: "Idle", count: 0 },
      ],
    });
    assert.equal(failure.code, "repo_capacity_full");
    assert.include(failure.message, "github.com/pingdotgg/t3code");
    assert.include(failure.message, "3/4");
    assert.include(failure.message, "local: 2, Mac: 1");
    assert.notInclude(failure.message, "Idle");
    assert.include(failure.message, "while requesting 2 more");
    assert.include(failure.message, 'capExemption: "broken_main" or "incident"');
  });
});

describe("RepoConcurrencyAdmission.check", () => {
  it.effect(
    "counts local + peer implementation/landing threads across alias keys without double-counting and ignores read-only, archived, or other-repo threads",
    () =>
      Effect.gen(function* () {
        const implActive1 = ThreadId.make("thread:impl-1");
        const implActive2 = ThreadId.make("thread:impl-2");
        const implLandingOnly = ThreadId.make("thread:impl-landing");
        const planThread = ThreadId.make("thread:plan");
        const reviewAssignedThread = ThreadId.make("thread:review-assigned");
        const reviewTaggedThread = ThreadId.make("thread:review-tag");
        const researchTaggedThread = ThreadId.make("thread:research-tag");
        const designTaggedThread = ThreadId.make("thread:design-tag");
        const archivedThread = ThreadId.make("thread:archived");
        const otherRepoThread = ThreadId.make("thread:other-repo");

        const baseThreads = new Map<ThreadId, OrchestrationV2AppThread>([
          [
            implActive1,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            implActive2,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            implLandingOnly,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            planThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "plan",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            reviewAssignedThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              reviewAssignment: { handle: "rev:1" },
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            reviewTaggedThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              tags: ["review"],
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            researchTaggedThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              tags: ["Research"],
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            designTaggedThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              tags: ["design"],
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            archivedThread,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            otherRepoThread,
            {
              projectId: OTHER_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
        ]);

        const activeWorkspaces: ReadonlyArray<ActiveTurnWorkspace> = [
          { threadId: implActive1, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: implActive2, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: planThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: reviewAssignedThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: reviewTaggedThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: researchTaggedThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: designTaggedThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: archivedThread, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: otherRepoThread, projectId: OTHER_PROJECT_ID, worktreePath: null },
        ];

        // Duplicate command on implActive1 must not double-count implActive1.
        const openCommandsWithDuplicate: ReadonlyArray<ProjectionOpenCommandTask> = [
          {
            parentThreadId: implActive1,
            taskId: NodeId.make("node:check-1"),
            threadTitle: "Impl 1",
            threadClosed: null,
            label: "check",
            command: "vp run check:changed",
          },
        ];

        // 2 local + 1 peer (reporting both alias keys at 1) = 3 active -> allows 4th.
        const underCapLayer = makeAdmissionLayer({
          activeWorkspaces,
          openCommands: openCommandsWithDuplicate,
          threads: baseThreads,
          peerLinks: [makeLink(PEER_A_ID, { label: "Zoro-VPS" })],
          onPeerCall: () =>
            Effect.succeed({
              capacity: {
                activeImplementationThreadsByRepo: {
                  "github.com/pingdotgg/t3code": 1,
                  "github.com/gigazoro/codeship": 1,
                  "github.com/gigazoro/other-repo": 3,
                },
              },
            }),
        });

        const underDecision = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return yield* admission.check({ projectId: TARGET_PROJECT_ID });
        }).pipe(Effect.provide(underCapLayer));

        assert.equal(underDecision.allowed, true);
        assert.equal(underDecision.activeCount, 3);
        assert.equal(underDecision.limit, 4);
        assert.deepEqual(underDecision.breakdown, [
          { environmentId: "local", label: "local", count: 2 },
          { environmentId: PEER_A_ID, label: "Zoro-VPS", count: 1 },
        ]);

        // Adding a landing-only command thread locally brings local to 3 + peer 1 = 4 -> blocks 5th.
        const atCapLayer = makeAdmissionLayer({
          activeWorkspaces,
          openCommands: [
            ...openCommandsWithDuplicate,
            {
              parentThreadId: implLandingOnly,
              taskId: NodeId.make("node:land-1"),
              threadTitle: "Landing",
              threadClosed: null,
              label: "land",
              command: "node .github/scripts/landing-turn.cjs land",
            },
          ],
          threads: baseThreads,
          peerLinks: [makeLink(PEER_A_ID, { label: "Zoro-VPS" })],
          onPeerCall: () =>
            Effect.succeed({
              capacity: {
                activeImplementationThreadsByRepo: {
                  "github.com/pingdotgg/t3code": 1,
                  "github.com/gigazoro/codeship": 1,
                },
              },
            }),
        });

        const atCapDecision = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return yield* admission.check({ projectId: TARGET_PROJECT_ID });
        }).pipe(Effect.provide(atCapLayer));

        assert.equal(atCapDecision.allowed, false);
        assert.equal(atCapDecision.activeCount, 4);
        assert.equal(atCapDecision.limit, 4);

        // Batch check at 2 active: requesting 2 fits (2 + 2 <= 4); requesting 3 is blocked (2 + 3 > 4).
        const batchLayer = makeAdmissionLayer({
          activeWorkspaces: [
            { threadId: implActive1, projectId: TARGET_PROJECT_ID, worktreePath: null },
            { threadId: implActive2, projectId: TARGET_PROJECT_ID, worktreePath: null },
          ],
          threads: baseThreads,
        });
        const [batchFits, batchOver] = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return [
            yield* admission.check({ projectId: TARGET_PROJECT_ID, requestedCount: 2 }),
            yield* admission.check({ projectId: TARGET_PROJECT_ID, requestedCount: 3 }),
          ] as const;
        }).pipe(Effect.provide(batchLayer));

        assert.equal(batchFits.allowed, true);
        assert.equal(batchFits.activeCount, 2);
        assert.equal(batchOver.allowed, false);
        assert.equal(batchOver.requestedCount, 3);
      }),
  );

  it.effect(
    "fails open for unreachable, self, older, missing-tool, failing, and timed-out peers while still counting healthy peers",
    () =>
      Effect.gen(function* () {
        const envOffline = EnvironmentId.make("env:offline");
        const envOld = EnvironmentId.make("env:old");
        const envMissingTool = EnvironmentId.make("env:missing-tool");
        const envFailing = EnvironmentId.make("env:failing");
        const envTimedOut = EnvironmentId.make("env:timed-out");
        const stalled = yield* Deferred.make<never>();
        const probed: Array<EnvironmentId> = [];

        const layer = makeAdmissionLayer({
          peerLinks: [
            makeLink(LOCAL_ENV_ID, { label: "Self" }),
            makeLink(envOffline, { label: "Offline", status: "unreachable" }),
            makeLink(envOld, { label: "Older" }),
            makeLink(envMissingTool, { label: "MissingTool" }),
            makeLink(envFailing, { label: "Failing" }),
            makeLink(envTimedOut, { label: "TimedOut" }),
            makeLink(PEER_B_ID, { label: "HealthyPeer" }),
          ],
          onPeerCallIfAvailable: (environmentId) => {
            probed.push(environmentId);
            if (environmentId === envTimedOut) return Deferred.await(stalled);
            if (environmentId === envMissingTool) return Effect.succeedNone;
            if (environmentId === envOld) return Effect.succeedSome({ providers: [] });
            if (environmentId === envFailing) {
              return Effect.fail(
                new OrchestratorMcpFailure({ code: "unreachable", message: "peer error" }),
              );
            }
            return Effect.succeedSome({
              capacity: {
                activeImplementationThreadsByRepo: {
                  "github.com/gigazoro/codeship": 2,
                },
              },
            });
          },
        });

        const fiber = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return yield* admission.check({ projectId: TARGET_PROJECT_ID });
        }).pipe(Effect.provide(layer), Effect.forkChild);

        yield* TestClock.adjust(Duration.millis(1500));
        const decision = yield* Fiber.join(fiber);

        assert.isFalse(probed.includes(LOCAL_ENV_ID));
        assert.isFalse(probed.includes(envOffline));
        assert.isTrue(probed.includes(envMissingTool));
        assert.equal(decision.allowed, true);
        assert.equal(decision.activeCount, 2);
        assert.equal(
          decision.breakdown.find((entry) => entry.environmentId === PEER_B_ID)?.count,
          2,
        );
        assert.equal(
          decision.breakdown.find((entry) => entry.environmentId === envMissingTool)?.count,
          0,
        );
        assert.equal(
          decision.breakdown.find((entry) => entry.environmentId === envTimedOut)?.count,
          0,
        );
      }),
  );

  it.effect(
    "allows scratch/non-git/missing projects and respects option and env cap overrides",
    () =>
      Effect.gen(function* () {
        const impl1 = ThreadId.make("thread:override-1");
        const impl2 = ThreadId.make("thread:override-2");
        const threads = new Map<ThreadId, OrchestrationV2AppThread>([
          [
            impl1,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
          [
            impl2,
            {
              projectId: TARGET_PROJECT_ID,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
        ]);
        const activeWorkspaces: ReadonlyArray<ActiveTurnWorkspace> = [
          { threadId: impl1, projectId: TARGET_PROJECT_ID, worktreePath: null },
          { threadId: impl2, projectId: TARGET_PROJECT_ID, worktreePath: null },
        ];

        const nonGitDecision = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return [
            yield* admission.check({ projectId: NONGIT_PROJECT_ID }),
            yield* admission.check({ projectId: ProjectId.make("project:missing") }),
          ] as const;
        }).pipe(Effect.provide(makeAdmissionLayer({ activeWorkspaces, threads })));

        assert.equal(nonGitDecision[0].allowed, true);
        assert.equal(nonGitDecision[0].repoKey, null);
        assert.equal(nonGitDecision[1].allowed, true);
        assert.equal(nonGitDecision[1].repoKey, null);

        // Option override limit=2 blocks at 2 active threads.
        const optionBlocked = yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          return yield* admission.check({ projectId: TARGET_PROJECT_ID });
        }).pipe(
          Effect.provide(makeAdmissionLayer({ activeWorkspaces, threads, options: { limit: 2 } })),
        );
        assert.equal(optionBlocked.limit, 2);
        assert.equal(optionBlocked.allowed, false);

        // Env override T3CODE_REPO_IMPLEMENTATION_CAP=2 blocks at 2 active threads.
        vi.stubEnv(RepoConcurrencyAdmission.REPO_IMPLEMENTATION_CAP_ENV, "2");
        try {
          const envBlocked = yield* Effect.gen(function* () {
            const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
            return yield* admission.check({ projectId: TARGET_PROJECT_ID });
          }).pipe(Effect.provide(makeAdmissionLayer({ activeWorkspaces, threads })));
          assert.equal(envBlocked.limit, 2);
          assert.equal(envBlocked.allowed, false);
        } finally {
          vi.unstubAllEnvs();
        }
      }),
  );
});

describe("RepoConcurrencyAdmission.withReservation", () => {
  const makeThreeActiveFixture = () => {
    const t1 = ThreadId.make("thread:res-1");
    const t2 = ThreadId.make("thread:res-2");
    const t3 = ThreadId.make("thread:res-3");
    const threads = new Map<ThreadId, OrchestrationV2AppThread>([
      [
        t1,
        {
          projectId: TARGET_PROJECT_ID,
          interactionMode: "default",
          archivedAt: null,
        } as unknown as OrchestrationV2AppThread,
      ],
      [
        t2,
        {
          projectId: TARGET_PROJECT_ID,
          interactionMode: "default",
          archivedAt: null,
        } as unknown as OrchestrationV2AppThread,
      ],
      [
        t3,
        {
          projectId: TARGET_PROJECT_ID,
          interactionMode: "default",
          archivedAt: null,
        } as unknown as OrchestrationV2AppThread,
      ],
    ]);
    const activeWorkspaces: ReadonlyArray<ActiveTurnWorkspace> = [
      { threadId: t1, projectId: TARGET_PROJECT_ID, worktreePath: null },
      { threadId: t2, projectId: TARGET_PROJECT_ID, worktreePath: null },
      { threadId: t3, projectId: TARGET_PROJECT_ID, worktreePath: null },
    ];
    return { threads, activeWorkspaces };
  };

  it.effect(
    "serializes concurrent reservations on the same repo at 3/4, keeps local capacity unpolluted for peers, and releases slots after completion, failure, or interruption",
    () =>
      Effect.gen(function* () {
        const { threads, activeWorkspaces } = makeThreeActiveFixture();
        const deps = makeAdmissionDependencies({ activeWorkspaces, threads });
        const fullLayer = Layer.merge(
          deps,
          RepoConcurrencyAdmission.layerLive().pipe(Layer.provide(deps)),
        );

        yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          const hostResources = yield* HostResources.HostResources;
          const memoryAdmission = yield* MemoryAdmission.MemoryAdmission;
          const projections = yield* ProjectionStoreV2;
          const projects = yield* ProjectService.ProjectService;

          // 1. Two concurrent reservations at 3/4: first enters `use`, second sees 4/4 and is rejected.
          const firstEntered = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();

          const firstFiber = yield* admission
            .withReservation({ projectId: TARGET_PROJECT_ID }, () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(firstEntered, undefined);
                yield* Deferred.await(releaseFirst);
                return "first-done";
              }),
            )
            .pipe(Effect.forkChild);

          yield* Deferred.await(firstEntered);

          // While first holds its local in-flight slot, readLocalCapacity still reports 3 (never 4),
          // so a remote peer probing this host will not self-block the parent's remote delegation.
          const localCapacity = yield* MachinePlacement.readLocalCapacity({
            hostResources: Option.some(hostResources),
            memoryAdmission,
            projections: Option.some(projections),
            projects,
          });
          assert.equal(
            RepoConcurrencyAdmission.maxRepoCountForKeys(
              localCapacity.activeImplementationThreadsByRepo,
              ["github.com/pingdotgg/t3code", "github.com/gigazoro/codeship"],
            ),
            3,
          );

          // Meanwhile, a concurrent local admission for the same repo sees 4/4 and is rejected.
          const secondOutcome = yield* admission.withReservation(
            { projectId: TARGET_PROJECT_ID },
            () => Effect.succeed("should-not-run"),
          );
          assert.equal(secondOutcome.admitted, false);
          assert.equal(secondOutcome.decision.activeCount, 4);
          assert.equal(secondOutcome.decision.limit, 4);

          // Concurrent reservation on a DIFFERENT repo succeeds while first is still paused.
          const otherRepoOutcome = yield* admission.withReservation(
            { projectId: OTHER_PROJECT_ID },
            () => Effect.succeed("other-repo-ok"),
          );
          assert.equal(otherRepoOutcome.admitted, true);
          if (otherRepoOutcome.admitted) {
            assert.equal(otherRepoOutcome.value, "other-repo-ok");
          }

          yield* Deferred.succeed(releaseFirst, undefined);
          const firstOutcome = yield* Fiber.join(firstFiber);
          assert.equal(firstOutcome.admitted, true);
          if (firstOutcome.admitted) {
            assert.equal(firstOutcome.value, "first-done");
          }

          // After first releases, slot count returns to 3.
          const afterRelease = yield* admission.check({ projectId: TARGET_PROJECT_ID });
          assert.equal(afterRelease.allowed, true);
          assert.equal(afterRelease.activeCount, 3);

          // 2. Failure inside `use` releases the reserved slot.
          const failedExit = yield* Effect.exit(
            admission.withReservation({ projectId: TARGET_PROJECT_ID }, () =>
              Effect.fail("boom" as const),
            ),
          );
          assert.isTrue(Exit.isFailure(failedExit));
          const afterFailure = yield* admission.check({ projectId: TARGET_PROJECT_ID });
          assert.equal(afterFailure.allowed, true);
          assert.equal(afterFailure.activeCount, 3);

          // 3. Interruption inside `use` releases the reserved slot.
          const interruptEntered = yield* Deferred.make<void>();
          const neverFinishes = yield* Deferred.make<never>();
          const interruptedFiber = yield* admission
            .withReservation({ projectId: TARGET_PROJECT_ID }, () =>
              Deferred.succeed(interruptEntered, undefined).pipe(
                Effect.andThen(Deferred.await(neverFinishes)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(interruptEntered);
          yield* Fiber.interrupt(interruptedFiber);

          const afterInterrupt = yield* admission.check({ projectId: TARGET_PROJECT_ID });
          assert.equal(afterInterrupt.allowed, true);
          assert.equal(afterInterrupt.activeCount, 3);
        }).pipe(Effect.provide(fullLayer));
      }),
  );

  it.effect(
    "serializes overlapping check phases on the same repo so two simultaneous calls at 3/4 admit at most one",
    () =>
      Effect.gen(function* () {
        const { threads, activeWorkspaces } = makeThreeActiveFixture();
        const firstProbeStarted = yield* Deferred.make<void>();
        const releaseFirstProbe = yield* Deferred.make<void>();
        let probeCalls = 0;

        const layer = makeAdmissionLayer({
          activeWorkspaces,
          threads,
          peerLinks: [makeLink(PEER_A_ID, { label: "Peer" })],
          onPeerCall: () =>
            Effect.gen(function* () {
              probeCalls += 1;
              if (probeCalls === 1) {
                yield* Deferred.succeed(firstProbeStarted, undefined);
                yield* Deferred.await(releaseFirstProbe);
              }
              return { capacity: { activeImplementationThreadsByRepo: {} } };
            }),
        });

        yield* Effect.gen(function* () {
          const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;
          const releaseFirstUse = yield* Deferred.make<void>();
          const firstUseEntered = yield* Deferred.make<void>();

          const f1 = yield* admission
            .withReservation({ projectId: TARGET_PROJECT_ID }, () =>
              Deferred.succeed(firstUseEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstUse)),
                Effect.as("winner"),
              ),
            )
            .pipe(Effect.forkChild);

          // Wait until f1 is inside its peer probe (holding the per-repo check lock).
          yield* Deferred.await(firstProbeStarted);

          // Start f2 for the same repo while f1 is still probing.
          const f2 = yield* admission
            .withReservation({ projectId: TARGET_PROJECT_ID }, () => Effect.succeed("loser"))
            .pipe(Effect.forkChild);

          // Release f1's probe; f1 reserves slot 4/4 before f2 can run its check.
          yield* Deferred.succeed(releaseFirstProbe, undefined);
          yield* Deferred.await(firstUseEntered);

          // f2 now acquires the check lock, sees f1's in-flight reservation (4/4), and is rejected.
          const r2 = yield* Fiber.join(f2);
          assert.equal(r2.admitted, false);
          assert.equal(r2.decision.activeCount, 4);

          yield* Deferred.succeed(releaseFirstUse, undefined);
          const r1 = yield* Fiber.join(f1);
          assert.equal(r1.admitted, true);
        }).pipe(Effect.provide(layer));
      }),
  );
});
