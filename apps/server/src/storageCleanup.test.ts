// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercises the real setup script in a linked Git checkout.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Link identity requires native lstat, including dangling links.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture paths match host paths.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SCAN_CACHE_DIRECTORY_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import { isDarwinHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { withWorkspaceProcessStart } from "./workspace/workspaceLease.ts";
import { queueWorktreeRelease } from "./workspace/worktreeRelease.ts";
import { decodeReleaseRequest, encodeRequest } from "./workspace/worktreeReleaseReceipt.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(
        storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS, DEFAULT_SERVER_SETTINGS),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
          DEFAULT_SERVER_SETTINGS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
          DEFAULT_SERVER_SETTINGS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), activeRunId: RunId.make("run") },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), latestUserMessageAt: at(-1_000) },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  it.each([
    { name: "snoozed until a future reset", snooze: true, resetIn: DAY_MS, idle: false },
    { name: "set to auto-resume", autoResume: true, resetIn: DAY_MS, idle: false },
    { name: "with recovery turned off", resetIn: DAY_MS, idle: true },
    { name: "auto-resuming after the reset", autoResume: true, resetIn: -1_000, idle: false },
    { name: "snoozed past its reset", snooze: true, resetIn: -1_000, idle: true },
    {
      name: "settled with an auto-resume pending",
      autoResume: true,
      settled: true,
      resetIn: -1_000,
      idle: true,
    },
    { name: "not yet armed by the recovery worker", armed: false, resetIn: DAY_MS, idle: false },
    {
      name: "not yet armed, auto-resume after reset",
      armed: false,
      autoResumeSetting: true,
      resetIn: -1_000,
      idle: false,
    },
    {
      name: "not armed with recovery settings off",
      armed: false,
      settingsOff: true,
      resetIn: DAY_MS,
      idle: true,
    },
  ])(
    "treats a usage-limited thread $name as idle: $idle",
    ({
      autoResume = false,
      snooze = false,
      armed = true,
      autoResumeSetting = false,
      settled,
      settingsOff,
      resetIn,
      idle,
    }) => {
      const runId = RunId.make("run-1");
      const resetAt = DateTime.formatIso(at(resetIn));
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus("failed"),
            latestRunId: runId,
            lastErrorClass: "usage_limit",
            usageLimitResetAt: resetAt,
            settledOverride: settled ? "settled" : null,
            limitRecovery: armed ? { runId, resetAt, autoResume, snooze } : null,
          },
          NOW_MS,
          { autoResumeLimitedThreads: autoResumeSetting, snoozeLimitedThreads: !settingsOff },
        ),
      ).toBe(idle);
    },
  );

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});

const allocatedBytes = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const isWindows = yield* HostProcess.isWindows;
    const stat = yield* fs.stat(file);
    return Option.getOrElse(
      Option.map(stat.blocks, (blocks) =>
        isWindows && blocks === 0n ? Number(stat.size) : Number(blocks) * 512,
      ),
      () => Number(stat.size),
    );
  });

// Git hides `.git` on Windows, and opening a hidden file for plain write fails with EPERM.
const overwriteGitFile = (fs: FileSystem.FileSystem, file: string, content: string) =>
  fs.truncate(file).pipe(Effect.andThen(fs.writeFileString(file, content, { flag: "r+" })));

const underWorktrees = (
  fixture: { readonly config: { readonly worktreesDir: string } },
  relative: string,
) => NodePath.resolve(fixture.config.worktreesDir, relative);

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
  managedLayout = false,
  sqlOverride?: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    if (managedLayout) {
      const base = (yield* command(repo, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        "160000," + base + ",vendor/empty",
      ]);
      yield* command(repo, ["commit", "-m", "Record an uninitialized gitlink"]);
    }
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = NodePath.resolve(
      config.worktreesDir,
      ...(managedLayout ? ["project", "feature"] : ["feature"]),
    );
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    let settings: import("@t3tools/contracts").ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let deletedThreads: OrchestrationV2ThreadShell[] = [];
    let closedSideChats: ReadonlySet<ThreadId> = new Set();
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let beforeRemoval: Effect.Effect<void> = Effect.void;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let onLiveCheck: Effect.Effect<void> = Effect.void;
    let outboxStatus: string | null = null;
    const sqlReads: Array<{ readonly query: string; readonly background: boolean }> = [];
    let fullStatusCalls = 0;
    let failUnmergedCount = false;
    let snapshotReads = 0;
    let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const provideFixtureSql = (fallback: SqlClient.SqlClient) =>
      Effect.provideService(SqlClient.SqlClient, sqlOverride ?? fallback);
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            // Before Git's own clean check: inside `git worktree remove`, or on
            // Windows the same status check the removal makes before deleting.
            if (input.args.includes("remove") || input.args.includes("--porcelain"))
              yield* beforeRemoval;
            if (
              editBeforeRemoval &&
              (input.args.includes("remove") || input.args.includes("--porcelain"))
            )
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            return yield* git.execute(input);
          }),
        countUnmergedCommits: (input) =>
          failUnmergedCount
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.countUnmergedCommits",
                  command: "git",
                  cwd: input.cwd,
                  detail: "branch is unreadable",
                }),
              )
            : git.countUnmergedCommits(input),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            return {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        occupiedWorkspaces: Effect.succeed([]),
        isLive: () =>
          Effect.sync(() => sessionLive).pipe(Effect.tap(() => Effect.suspend(() => onLiveCheck))),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
        delegatedTaskResultPending: () => Effect.succeed(false),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      provideFixtureSql(((strings: TemplateStringsArray) =>
        Effect.sync(() =>
          strings.join("").includes('AS "deletedWorktree"')
            ? deletedThreads.map((thread) => ({
                deletedWorktree: thread.worktreePath,
                unused: closedSideChats.has(thread.id) ? JSON.stringify(thread) : null,
              }))
            : openSessionCwd !== null && strings.join("").includes("projection_provider_sessions")
              ? [
                  {
                    payload_json: JSON.stringify({
                      id: "session-1",
                      driver: "codex",
                      providerInstanceId: "codex",
                      status: "ready",
                      cwd: openSessionCwd,
                      model: null,
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: "2026-06-01T12:00:00.000Z",
                      updatedAt: "2026-06-01T12:00:00.000Z",
                      lastError: null,
                    }),
                  },
                ]
              : outboxStatus !== null && strings.join("").includes("orchestration_v2_effect_outbox")
                ? [{ status: outboxStatus }]
                : strings.join("").includes("deleted_at IS NOT NULL")
                  ? deletedThreads.map((thread) => ({
                      payload_json: JSON.stringify(thread),
                      workspaceRoot: repo,
                    }))
                  : strings.join("").includes('AS "worktreePath"')
                    ? [
                        ...threads.flatMap((thread) => thread.worktreePath ?? []),
                        ...storedWorktreePaths,
                      ].map((worktreePath) => ({ worktreePath }))
                    : [],
        ).pipe(
          Effect.tap(() =>
            Effect.map(NodeSqliteClient.Background, (background) => {
              sqlReads.push({ query: strings.join(""), background });
            }),
          ),
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            terminalListener = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      setTerminals: (terminals: TerminalSummary[]) =>
        terminalListener?.({ type: "snapshot", terminals }) ?? Effect.void,
      setBeforeRemoval: (hook: Effect.Effect<void>) => {
        beforeRemoval = hook;
      },
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setOnLiveCheck: (hook: Effect.Effect<void>) => {
        onLiveCheck = hook;
      },
      setOutboxStatus: (status: string | null) => {
        outboxStatus = status;
      },
      setDeletedThreads: (next: OrchestrationV2ThreadShell[], finishedUnused: ThreadId[] = []) => {
        deletedThreads = next;
        closedSideChats = new Set(finishedUnused);
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      sqlReads: () => sqlReads,
      openTerminal: (paths: { cwd: string; worktreePath: string | null }) =>
        terminalListener?.({
          type: "upsert",
          terminal: {
            threadId: "thread-1",
            terminalId: "terminal-1",
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-06-10T12:00:00.000Z",
            ...paths,
          },
        }) ?? Effect.void,
      fullStatusCalls: () => fullStatusCalls,
      failUnmergedCount: (fail: boolean) => {
        failUnmergedCount = fail;
      },
      snapshotReads: () => snapshotReads,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe.skipIf(isWindowsHost)("physical links in ignored dependency trees", () => {
  it.live("preserves directory, file, dangling and external symlinks and holds a replacement", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        const runId = RunId.make("delivered");
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: runId,
          latestRunCompletedAt: at(0),
        });
        fixture.setThreads([owner]);
        const modules = NodePath.join(fixture.worktree, "node_modules");
        yield* fixture.fs.makeDirectory(modules);
        const external = NodePath.join(fixture.repo, "external-file");
        yield* fixture.fs.writeFileString(external, "outside");
        const targets = ["../vendor", "../tracked.txt", "../absent", external];
        for (let i = 0; i < 1024; i++)
          yield* fixture.fs.symlink(
            targets[i % targets.length]!,
            NodePath.join(modules, String(i)),
          );
        const input = {
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        };
        yield* queueWorktreeRelease(input);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toMatch(/local data/i);
        const { savedFiles } = yield* queueWorktreeRelease({ ...input, saveIgnored: true });
        for (const [i, target] of targets.entries()) {
          const saved = NodePath.join(savedFiles!, "node_modules", String(i));
          const original = yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(modules, String(i)), { bigint: true }),
          );
          const copy = yield* Effect.promise(() => NodeFSP.lstat(saved, { bigint: true }));
          expect([copy.isSymbolicLink(), copy.dev, copy.ino]).toEqual([
            true,
            original.dev,
            original.ino,
          ]);
          expect(yield* fixture.fs.readLink(saved)).toBe(target);
        }
        const replaced = NodePath.join(modules, "0");
        yield* fixture.fs.remove(replaced);
        yield* fixture.fs.symlink(targets[0]!, replaced);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toMatch(/changed or lack/);
        yield* fixture.fs.remove(replaced);
        expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("removed");
        expect(yield* fixture.fs.readFileString(external)).toBe("outside");
      }),
    ),
  );
});

it.live("disposes partial capture after a sibling directory fails inspection", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture(undefined, true);
      const modules = NodePath.join(fixture.worktree, "node_modules");
      const nested = NodePath.join(modules, "local", ".git");
      yield* fixture.fs.makeDirectory(nested, { recursive: true });
      for (let i = 0; i < 128; i++)
        yield* fixture.fs.writeFileString(NodePath.join(modules, String(i)), "installed");
      const result = yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: "owner",
        runId: "run",
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
        saveIgnored: true,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(
        yield* fixture.fs.readDirectory(
          NodePath.join(fixture.config.stateDir, ServerConfig.WORKTREE_RELEASE_DIRECTORY),
        ),
      ).toEqual([]);
      expect(yield* fixture.fs.readFileString(NodePath.join(modules, "0"))).toBe("installed");
      expect(yield* fixture.fs.exists(nested)).toBe(true);
    }),
  ),
);

it.live.each(["redundant", "unique", "published"] as const)(
  "disposes only unpublished redundant backup links after a %s staging failure",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        const source = NodePath.join(fixture.worktree, ".env");
        yield* fixture.fs.writeFileString(source, "accepted");
        const input = {
          stateDir: fixture.config.stateDir,
          threadId: "owner",
          runId: "run",
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
          saveIgnored: true,
        };
        const accepted = yield* queueWorktreeRelease(input);
        yield* fixture.fs.remove(source);
        yield* fixture.fs.writeFileString(source, "second");
        const second = yield* queueWorktreeRelease(input).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (kind === "published") yield* fixture.fs.rename(from, to);
                if (kind === "unique") yield* fixture.fs.remove(source);
                return yield* fixture.fs.rename(from, NodePath.join(from, "impossible"));
              }),
          }),
          Effect.result,
        );
        expect(second._tag).toBe("Failure");
        expect(yield* fixture.fs.readFileString(NodePath.join(accepted.savedFiles!, ".env"))).toBe(
          "accepted",
        );
        const dir = NodePath.dirname(accepted.file);
        const names = yield* fixture.fs.readDirectory(dir);
        const acceptedName = NodePath.basename(accepted.savedFiles!);
        const backups = names.filter(
          (name) => name.startsWith("saved-") && !name.endsWith(".json"),
        );
        const other = backups.filter((name) => name !== acceptedName);
        expect(other).toHaveLength(kind === "redundant" ? 0 : 1);
        expect(
          names.filter((name) => name.startsWith("saved-") && name.endsWith(".json")).sort(),
        ).toEqual(backups.map((name) => name + ".json").sort());
        if (other.length)
          expect(yield* fixture.fs.readFileString(NodePath.join(dir, other[0]!, ".env"))).toBe(
            "second",
          );
        expect(JSON.parse(yield* fixture.fs.readFileString(accepted.file)).savedFiles).toBe(
          kind === "published" ? NodePath.join(dir, other[0]!) : accepted.savedFiles,
        );
      }),
    ),
);

it.live.each(["direct land", "no change"] as const)(
  "releases only the owner's completed run after delivery and teardown (%s)",
  (delivery) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        if (delivery === "direct land") {
          yield* fixture.fs.writeFileString(
            NodePath.join(fixture.worktree, "tracked.txt"),
            "delivered\n",
          );
          yield* fixture.command(fixture.worktree, ["commit", "-am", "delivered"]);
          yield* fixture.command(fixture.repo, ["merge", "--ff-only", "feature"]);
        }
        const runId = RunId.make("run-1");
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: runId,
          latestRunCompletedAt: at(0),
        });
        fixture.setThreads([owner]);
        const outputs = [
          ".t3/setup-done",
          "node_modules/example/index.js",
          ".vite-hooks/_/pre-commit",
          "apps/server/tsconfig.tsbuildinfo",
          "apps/marketing/.astro/content.d.ts",
          "apps/mobile/.generated/app.json",
        ];
        yield* fixture.fs.writeFileString(
          NodePath.join(fixture.repo, ".git/info/exclude"),
          ".t3/\n.vite-hooks/_/\n*.tsbuildinfo\n.astro/\n.generated/\n",
        );
        for (const output of outputs) {
          const target = NodePath.join(fixture.worktree, output);
          yield* fixture.fs.makeDirectory(NodePath.dirname(target), { recursive: true });
          yield* fixture.fs.writeFileString(target, output);
        }
        const { file: request, savedFiles } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
          saveIgnored: true,
        });
        fixture.setOpenSessionCwd(fixture.worktree);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Provider session is still open",
        );
        fixture.setOpenSessionCwd(null);
        fixture.setOutboxStatus("pending");
        yield* fixture.service.runNow;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        fixture.setOutboxStatus(null);
        yield* fixture.fs.writeFileString(NodePath.join(fixture.worktree, ".env"), "keep");
        yield* fixture.service.runNow;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        yield* fixture.fs.remove(NodePath.join(fixture.worktree, ".env"));
        if (isWindowsHost) {
          const refs = (yield* fixture.command(fixture.worktree, [
            "rev-parse",
            "--absolute-git-dir",
          ])).stdout.trim();
          const refDir = NodePath.join(refs, "refs");
          const privateFile = NodePath.join(refDir, "owner.txt");
          yield* fixture.fs.makeDirectory(refDir, { recursive: true });
          yield* fixture.fs.writeFileString(privateFile, "preserve");
          expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
            "Worktree has private refs",
          );
          expect(yield* fixture.fs.readFileString(privateFile)).toBe("preserve");
          yield* fixture.fs.remove(privateFile);
        }
        const insideGitlink = NodePath.join(fixture.worktree, "vendor", "empty", ".env");
        yield* fixture.fs.writeFileString(insideGitlink, "local");
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Gitlink contains local data",
        );
        yield* fixture.fs.remove(insideGitlink);
        const alias = NodePath.join(fixture.repo, "alias");
        yield* fixture.fs.symlink(NodePath.join(fixture.worktree, "vendor"), alias);
        const admitted = yield* Deferred.make<void>();
        const finishStart = yield* Deferred.make<void>();
        const admission = yield* withWorkspaceProcessStart(
          Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(finishStart))),
          [alias],
        ).pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "A workspace process is starting",
        );
        yield* Deferred.succeed(finishStart, undefined);
        yield* Fiber.join(admission);
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setSessionLive(false);
        fixture.setOnLiveCheck(
          withWorkspaceProcessStart(
            Effect.sync(() => fixture.setOnLiveCheck(Effect.void)),
            [alias],
          ),
        );
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "A workspace process started during inspection",
        );
        fixture.setOpenSessionCwd(null);
        const released = yield* fixture.service.runNow;
        expect(released.entries[0]).toMatchObject({
          outcome: "removed",
          reason: "Owner released the completed run",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        expect(yield* fixture.fs.exists(request)).toBe(false);
        expect(yield* fixture.fs.exists(request + ".released")).toBe(true);
        for (const output of outputs)
          expect(yield* fixture.fs.readFileString(NodePath.join(savedFiles!, output))).toBe(output);
      }),
    ),
);

describe("owned setup output", () => {
  const scenarios = [
    "standard setup only",
    "an added dependency file",
    "an edited dependency file",
    "a replaced done marker",
    "a changed proof",
    "a legacy done marker",
    "a real dotenv file",
    "a missing dotenv source",
    "a retargeted dependency symlink",
    "a dependency added during setup",
    "a dirty install input",
    "a dead setup owner",
    "an unpublished success marker",
    "a prior proof without dependencies",
    "an unknown proof directory with saved ignored files",
    "an external junction",
    "a private file stream",
    "a private directory stream",
    "unverifiable staged setup output",
    "a custom dependency ACL",
    "an existing stage junction",
    "a tracked stream on repeat",
    "a crashed setup publication",
    "a staged pnpmfile outside the checkout",
    "a dirty lock on repeat",
    "a dirty manifest on repeat",
    "an ignored override on repeat",
    "a committed lock change",
    "two in-place reruns",
    "a failed configure followed by recovery",
    "an interrupted install followed by two reruns",
    "an unrelated source edit on repeat",
    "a build cache added after setup",
  ] as const;
  const checkSetups = (
    title: string,
    run: (scenario: (typeof scenarios)[number]) => Effect.Effect<void, unknown>,
  ) => {
    const windowsOnly = [
      "an external junction",
      "a private file stream",
      "a private directory stream",
      "unverifiable staged setup output",
      "a custom dependency ACL",
      "an existing stage junction",
      "a tracked stream on repeat",
      "a crashed setup publication",
      "a staged pnpmfile outside the checkout",
      "a dirty lock on repeat",
      "a dirty manifest on repeat",
      "an ignored override on repeat",
      "a committed lock change",
      "two in-place reruns",
      "an interrupted install followed by two reruns",
      "an unrelated source edit on repeat",
    ];
    const windowsWithPosix = [
      "standard setup only",
      "an edited dependency file",
      "a dirty install input",
      "a failed configure followed by recovery",
      "a build cache added after setup",
    ];
    describe.skipIf(isWindowsHost)("POSIX", () => {
      it.live.each(scenarios.filter((name) => !windowsOnly.includes(name)))(title, run);
    });
    describe.runIf(isWindowsHost)("Windows", () => {
      it.live.each(
        scenarios.filter((name) => windowsOnly.includes(name) || windowsWithPosix.includes(name)),
      )(title, run);
    });
  };

  checkSetups(
    "releases an ordinary completed worktree only with unchanged setup output (%s)",
    (scenario) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture(undefined, true);
          fixture.disable();
          const { fs, repo, command } = fixture;
          const worktree = yield* fs.realPath(fixture.worktree);
          yield* fs.writeFileString(
            NodePath.join(repo, ".gitignore"),
            ".env\n.npmrc\nnode_modules/\n.t3/\n",
          );
          yield* fs.makeDirectory(NodePath.join(repo, "scripts/lib"), { recursive: true });
          yield* fs.makeDirectory(NodePath.join(repo, "packages/shared/src"), { recursive: true });
          yield* fs.makeDirectory(NodePath.join(repo, "apps/server"), { recursive: true });
          yield* fs.writeFileString(NodePath.join(repo, "apps/server/package.json"), "{}");
          yield* fs.writeFileString(
            NodePath.join(repo, "apps/server/local-source.txt"),
            "linked package source",
          );
          yield* fs.writeFileString(
            NodePath.join(repo, "pnpm-workspace.yaml"),
            "packages:\n  - apps/*\n",
          );
          yield* fs.writeFileString(NodePath.join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
          const configureFailure = scenario === "a failed configure followed by recovery";
          if (configureFailure) {
            const scripts = NodePath.join(repo, ".github/scripts");
            yield* fs.makeDirectory(scripts, { recursive: true });
            yield* fs.writeFileString(
              NodePath.join(scripts, "release-notes.cjs"),
              "if (process.env.T3_TEST_FAIL_CONFIGURE) process.exit(19);\n",
            );
          }
          for (const file of [
            "t3.json",
            "scripts/setup-worktree.ts",
            "scripts/lib/install-worktree-dependencies.ts",
            "scripts/lib/worktree-setup-proof.ts",
            "scripts/lib/posix-worktree-metadata.ts",
            "scripts/lib/windows-worktree-files.ts",
            "packages/shared/src/processProbe.ts",
          ]) {
            yield* fs.copyFile(
              NodePath.resolve(import.meta.dirname, "../../../", file),
              NodePath.join(repo, file),
            );
          }
          yield* command(repo, ["add", "."]);
          yield* command(repo, ["commit", "-m", "Configure standard setup"]);
          yield* command(worktree, ["merge", "--ff-only", "main"]);
          const mainEnv = NodePath.join(repo, ".env");
          const worktreeEnv = NodePath.join(worktree, ".env");
          const sentinel = NodePath.join(repo, "sentinel.txt");
          const existingStage = scenario === "an existing stage junction";
          if (existingStage) {
            yield* fs.writeFileString(sentinel, "keep");
            yield* fs.makeDirectory(NodePath.join(worktree, ".t3"));
            yield* Effect.promise(() =>
              NodeFSP.symlink(repo, NodePath.join(worktree, ".t3/setup-stage"), "junction"),
            );
          }
          if (!isWindowsHost) yield* fs.writeFileString(mainEnv, "example-main-value");
          if (scenario === "a real dotenv file")
            yield* fs.writeFileString(worktreeEnv, "local-value");
          if (scenario === "a dirty install input" || scenario === "two in-place reruns")
            yield* fs.writeFileString(
              NodePath.join(worktree, ".pnpmfile.cjs"),
              "use live checkout",
            );
          const fixturePackageManager = yield* fs.makeTempDirectoryScoped({ prefix: "setup-vp-" });
          yield* fs.writeFileString(
            NodePath.join(fixturePackageManager, "install.mjs"),
            String.raw`import * as fs from "node:fs";
import * as path from "node:path";
if (process.env.T3_TEST_REJECT_INSTALL) throw new Error("unexpected repeat install");
const inWindowsStage = process.platform === "win32" && process.cwd().includes(path.sep + "setup-stage" + path.sep);
fs.appendFileSync(process.env.T3_TEST_INSTALL_LOG, (inWindowsStage ? "stage" : "install") + "\n");
if (inWindowsStage && process.env.T3_TEST_SETUP_PID) {
  fs.writeFileSync("owner-sentinel.txt", "keep");
  process.kill(Number(process.env.T3_TEST_SETUP_PID), "SIGKILL");
  process.exit(1);
}
const withWindowsAliases = (value) =>
  inWindowsStage ? value[0].toLowerCase() + value.slice(1).split(path.sep).join("/") : value;
fs.mkdirSync("node_modules/.pnpm/example/node_modules/example", { recursive: true });
fs.mkdirSync("apps/server/node_modules", { recursive: true });
fs.writeFileSync("apps/server/node_modules/helper.js", "module");
if (!fs.existsSync("apps/server/node_modules/hardlinked.txt")) {
  fs.linkSync("apps/server/local-source.txt", "apps/server/node_modules/hardlinked.txt");
}
if (process.env.T3_TEST_CONCURRENT_WORKTREE) {
  const added = path.join(process.env.T3_TEST_CONCURRENT_WORKTREE, "apps/server/node_modules");
  fs.mkdirSync(added, { recursive: true });
  fs.writeFileSync(path.join(added, "local.js"), "added during setup");
}

fs.writeFileSync("node_modules/.pnpm/example/node_modules/example/index.js", "module");

if (!fs.existsSync("node_modules/example")) {
  const target = ".pnpm/example/node_modules/example";
  fs.symlinkSync(process.platform === "win32" ? withWindowsAliases(path.resolve("node_modules", target)) : target,
    "node_modules/example", process.platform === "win32" ? "junction" : "dir");
}
if (process.env.T3_TEST_STORE && !fs.existsSync("node_modules/shared.js")) {
  fs.linkSync(path.join(process.env.T3_TEST_STORE, "shared.js"), "node_modules/shared.js");
}
if (process.env.T3_TEST_STAGE_STREAM && inWindowsStage) {
  fs.writeFileSync("node_modules/.pnpm/example/node_modules/example/index.js:private", "keep");
}
fs.writeFileSync("node_modules/.modules.yaml", JSON.stringify({ storeDir: process.env.T3_TEST_VP }));
const cwd = process.cwd();
fs.writeFileSync("node_modules/.pnpm-workspace-state-v1.json", JSON.stringify({
  projects: { [withWindowsAliases(cwd)]: {}, [withWindowsAliases(path.join(cwd, "apps/server"))]: {} },
  pnpmfiles: [
    inWindowsStage && process.env.T3_TEST_OUTSIDE_PNPMFILE ||
    withWindowsAliases(path.join(cwd, ".pnpmfile.cjs"))
  ],
}));
if (fs.existsSync(".pnpmfile.cjs")) {
  fs.copyFileSync(".pnpmfile.cjs", "node_modules/seen-input.cjs");
}
fs.writeFileSync("node_modules/seen-inputs.json", JSON.stringify(Object.fromEntries(
  ["pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/server/package.json", ".npmrc"]
    .filter((name) => fs.existsSync(name))
    .map((name) => [name, fs.readFileSync(name, "utf8")])
)));
`,
          );
          for (const [name, body] of [
            ["vp", '#!/bin/sh\nexec "$T3_TEST_NODE" "$T3_TEST_VP/install.mjs"\n'],
            ["vp.cmd", '@"%T3_TEST_NODE%" "%T3_TEST_VP%\\install.mjs"\r\n'],
          ] as const) {
            yield* fs.writeFileString(NodePath.join(fixturePackageManager, name), body, {
              mode: 0o755,
            });
          }
          yield* fs.writeFileString(NodePath.join(fixturePackageManager, "shared.js"), "shared");
          const race = scenario === "a dependency added during setup";
          const stageStream = scenario === "unverifiable staged setup output";
          const outsidePnpmfile = scenario === "a staged pnpmfile outside the checkout";
          const outsideConfig = NodePath.join(fixturePackageManager, "outside.cjs");
          const installLog = NodePath.join(fixturePackageManager, "install.log");
          if (outsidePnpmfile) yield* fs.writeFileString(outsideConfig, "preserve");
          const env = {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
            ),
            T3_TEST_CONCURRENT_WORKTREE: race ? worktree : "",
            T3_TEST_NODE: process.execPath,
            T3_TEST_INSTALL_LOG: installLog,
            T3_TEST_OUTSIDE_PNPMFILE: outsidePnpmfile ? outsideConfig : "",
            T3_TEST_STAGE_STREAM: stageStream ? "1" : "",
            T3_TEST_VP: fixturePackageManager,
            T3_TEST_STORE: isWindowsHost ? fixturePackageManager : "",
            T3CODE_PROJECT_ROOT: repo,
            PATH: fixturePackageManager + NodePath.delimiter + process.env.PATH,
          };
          const setupCommand = JSON.parse(
            yield* fs.readFileString(NodePath.join(worktree, "t3.json")),
          ).scripts[0].command;
          expect(setupCommand).toBe("node scripts/setup-worktree.ts");
          const runSetup = (
            repeat = false,
            cwd = worktree,
            attempt?: "interrupt" | "fail configure",
          ) =>
            Effect.promise(
              () =>
                new Promise<{ success: boolean; output: string }>((resolve) => {
                  NodeChildProcess.execFile(
                    process.execPath,
                    attempt === "interrupt"
                      ? [
                          "--input-type=module",
                          "-e",
                          'process.env.T3_TEST_SETUP_PID = String(process.pid); await import("./scripts/setup-worktree.ts");',
                        ]
                      : setupCommand.split(" ").slice(1),
                    {
                      cwd,
                      env: {
                        ...env,
                        T3_TEST_REJECT_INSTALL: repeat ? "1" : "",
                        T3_TEST_FAIL_CONFIGURE: attempt === "fail configure" ? "1" : "",
                      },
                    },
                    (error, stdout, stderr) =>
                      resolve({ success: !error, output: stdout + stderr }),
                  );
                }),
            );
          if (scenario === "a dead setup owner") {
            const child = yield* Effect.acquireRelease(
              Effect.tryPromise(
                () =>
                  new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
                    const running = NodeChildProcess.spawn(
                      process.execPath,
                      [
                        "-e",
                        `
                  const fs = require("node:fs");
                  fs.mkdirSync(".t3", { recursive: true });
                  fs.mkdirSync(".t3/setup-owner-" + process.pid, { mode: 0o700 });
                  fs.writeFileSync(".t3/setup-running", process.pid + "\\n");
                  console.log("ready");
                  process.stdin.resume();
                `,
                      ],
                      { cwd: worktree, stdio: ["pipe", "pipe", "inherit"] },
                    );
                    running.stdout.once("data", () => resolve(running));
                    running.once("error", reject);
                    running.once("exit", () =>
                      reject(new Error("Setup owner quit before it was ready")),
                    );
                  }),
              ),
              (running) =>
                Effect.sync(() => {
                  running.stdin?.end();
                }),
            );
            const blocked = yield* runSetup();
            expect(blocked.success).toBe(false);
            expect(blocked.output).toContain("Another worktree setup");
            const claim = NodePath.join(worktree, ".t3", `setup-owner-${child.pid}`);
            expect(blocked.output).toContain(claim);
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                  child.kill("SIGKILL");
                }),
            );
            const proof = NodePath.join(claim, "proof");
            const unknown = NodePath.join(claim, "unknown");
            yield* fs.writeFileString(proof, "pending publication");
            yield* fs.writeFileString(unknown, "keep");
            const refused = yield* runSetup();
            expect(refused.success).toBe(false);
            expect(refused.output).toContain(unknown);
            expect(yield* fs.readFileString(proof)).toBe("pending publication");
            expect(yield* fs.readFileString(unknown)).toBe("keep");
            yield* fs.remove(unknown);
          }
          const done = NodePath.join(worktree, ".t3/setup-done");
          const failed = NodePath.join(worktree, ".t3/setup-failed");
          const proof = (yield* command(worktree, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "t3-setup-proof-v1",
          ])).stdout.trim();
          const interruptedInstall = scenario === "an interrupted install followed by two reruns";
          const preservedStage = NodePath.join(worktree, ".t3/setup-stage/repo/owner-sentinel.txt");
          const claimStream = NodePath.join(worktree, ".t3/setup-owner-2147483647:private");
          let deadClaim: string | undefined;
          if (interruptedInstall) {
            const interrupted = yield* runSetup(false, worktree, "interrupt");
            expect(interrupted.success).toBe(false);
            expect(yield* fs.readFileString(preservedStage)).toBe("keep");
            expect(yield* fs.exists(done)).toBe(false);
            expect(yield* fs.exists(proof)).toBe(false);
            const pid = (yield* fs.readFileString(
              NodePath.join(worktree, ".t3/setup-running"),
            )).trim();
            deadClaim = NodePath.join(worktree, ".t3", "setup-owner-" + pid);
            expect(yield* fs.exists(deadClaim)).toBe(true);
            yield* fs.makeDirectory(NodePath.join(worktree, ".t3/setup-owner-2147483647"));
            yield* Effect.promise(() => NodeFSP.writeFile(claimStream, "preserve"));
          }
          if (configureFailure) {
            const failedSetup = yield* runSetup(false, worktree, "fail configure");
            expect(failedSetup.success).toBe(false);
            expect(yield* fs.exists(failed)).toBe(true);
            expect(yield* fs.exists(done)).toBe(false);
            expect(yield* fs.exists(proof)).toBe(true);
          }
          const setup = yield* runSetup(configureFailure);
          expect(setup.success, setup.output).toBe(!race);
          if (existingStage || interruptedInstall)
            expect(setup.output).toContain(
              NodePath.join(".t3", "setup-stage") + ". Attempting an in-place install.",
            );
          if (race) expect(setup.output).toContain("setup destinations changed");
          if (stageStream) {
            expect(setup.output).toContain("Windows worktree inspection failed (private-stream)");
            expect(setup.output).not.toContain("-EncodedCommand");
          }
          expect(yield* fs.exists(done)).toBe(!race);
          if (configureFailure) {
            expect(yield* fs.exists(failed)).toBe(false);
            expect(yield* fs.readFileString(installLog)).toBe(
              isWindowsHost ? "stage\n" : "install\n",
            );
          }
          const inPlace =
            existingStage ||
            outsidePnpmfile ||
            stageStream ||
            interruptedInstall ||
            scenario === "two in-place reruns" ||
            scenario === "a real dotenv file" ||
            scenario === "a dirty install input";
          expect(yield* fs.exists(proof)).toBe(!race && (!inPlace || isWindowsHost));
          const expectLocalReceipt = () =>
            Effect.gen(function* () {
              const receipt = JSON.parse(yield* fs.readFileString(proof));
              expect(receipt.inPlace).toBe(true);
              expect(yield* fs.readFileString(done)).toBe(receipt.marker);
              expect(yield* fs.exists(failed)).toBe(false);
            });
          if (isWindowsHost && inPlace) yield* expectLocalReceipt();
          if (!race) {
            const state = JSON.parse(
              yield* fs.readFileString(
                NodePath.join(worktree, "node_modules/.pnpm-workspace-state-v1.json"),
              ),
            );
            expect(Object.keys(state.projects)).toEqual([
              worktree,
              NodePath.join(worktree, "apps/server"),
            ]);
            expect(state.pnpmfiles).toEqual([NodePath.join(worktree, ".pnpmfile.cjs")]);
          }
          if (scenario === "a dirty install input")
            expect(
              yield* fs.readFileString(NodePath.join(worktree, "node_modules/seen-input.cjs")),
            ).toBe("use live checkout");
          if (!race && !isWindowsHost)
            expect(yield* fs.readFileString(worktreeEnv)).toBe(
              scenario === "a real dotenv file" ? "local-value" : "example-main-value",
            );
          const dependency = NodePath.join(
            worktree,
            "node_modules/.pnpm/example/node_modules/example",
          );
          const sibling = NodePath.join(NodePath.dirname(worktree), "other");
          const abandonedClaim = NodePath.join(worktree, ".t3/setup-owner-2147483647");
          const privateStream = NodePath.join(
            worktree,
            scenario === "a private directory stream"
              ? "node_modules:private"
              : scenario === "a tracked stream on repeat"
                ? "tracked.txt:Zone.Identifier"
                : "tracked.txt:private",
          );
          const dependencyAcl = (...args: string[]) =>
            Effect.tryPromise(
              () =>
                new Promise<string>((resolve, reject) => {
                  NodeChildProcess.execFile(
                    NodePath.join(process.env.SystemRoot!, "System32", "icacls.exe"),
                    [NodePath.join(dependency, "index.js"), ...args],
                    { windowsHide: true },
                    (error, stdout) => {
                      if (error) reject(new Error(`Fixture ACL command failed (${error.code})`));
                      else resolve(stdout);
                    },
                  );
                }),
            );
          let customAcl: string | undefined;
          let refreshedInputs = false;
          switch (scenario) {
            case "a dirty lock on repeat":
            case "a dirty manifest on repeat":
            case "an ignored override on repeat":
            case "a committed lock change": {
              const [name, contents] =
                scenario === "a dirty manifest on repeat"
                  ? ["pnpm-workspace.yaml", "packages:\n  - apps/*\n\n# update\n"]
                  : scenario === "an ignored override on repeat"
                    ? [".npmrc", "node-linker=isolated\n"]
                    : ["pnpm-lock.yaml", "lockfileVersion: 9\n# update\n"];
              yield* fs.writeFileString(NodePath.join(worktree, name), contents);
              if (scenario === "a committed lock change") {
                yield* command(worktree, ["add", "--", name]);
                yield* command(worktree, ["commit", "-m", "Change the lockfile"]);
                yield* command(repo, ["merge", "--ff-only", "feature"]);
              }
              const repeated = yield* runSetup();
              expect(repeated.success, repeated.output).toBe(true);
              expect(yield* fs.readFileString(installLog)).toBe("stage\ninstall\n");
              expect(
                JSON.parse(
                  yield* fs.readFileString(
                    NodePath.join(worktree, "node_modules/seen-inputs.json"),
                  ),
                )[name],
              ).toBe(contents);
              yield* expectLocalReceipt();
              refreshedInputs = true;
              break;
            }
            case "two in-place reruns":
            case "an interrupted install followed by two reruns": {
              const priorInstalls = interruptedInstall ? "stage\ninstall\n" : "install\n";
              const reruns = interruptedInstall ? 1 : 2;
              for (let i = 0; i < reruns; i++) {
                const repeated = yield* runSetup();
                expect(repeated.success, repeated.output).toBe(true);
                yield* expectLocalReceipt();
              }
              expect(yield* fs.readFileString(installLog)).toBe(
                priorInstalls + "install\n".repeat(reruns),
              );
              if (deadClaim) expect(yield* fs.exists(deadClaim)).toBe(false);
              if (interruptedInstall) expect(yield* fs.readFileString(preservedStage)).toBe("keep");
              if (interruptedInstall)
                expect(yield* Effect.promise(() => NodeFSP.readFile(claimStream, "utf8"))).toBe(
                  "preserve",
                );
              break;
            }
            case "an unrelated source edit on repeat": {
              yield* fs.writeFileString(NodePath.join(worktree, "tracked.txt"), "preserve\n");
              const repeated = yield* runSetup(true);
              expect(repeated.success, repeated.output).toBe(true);
              expect(yield* fs.readFileString(installLog)).toBe("stage\n");
              expect(yield* fs.readFileString(NodePath.join(worktree, "tracked.txt"))).toBe(
                "preserve\n",
              );
              break;
            }
            case "a tracked stream on repeat": {
              yield* Effect.promise(() => NodeFSP.writeFile(privateStream, "keep"));
              const repeated = yield* runSetup(true);
              expect(repeated.success, repeated.output).toBe(true);
              break;
            }
            case "a crashed setup publication": {
              yield* fs.makeDirectory(abandonedClaim);
              yield* fs.writeFileString(
                NodePath.join(abandonedClaim, "proof"),
                "unrecognized data",
              );
              yield* Effect.promise(() =>
                NodeFSP.link(done, NodePath.join(abandonedClaim, "done")),
              );
              const repeated = yield* runSetup(true);
              expect(repeated.success, repeated.output).toBe(true);
              break;
            }
            case "a custom dependency ACL": {
              const inheritedAcl = yield* dependencyAcl();
              yield* dependencyAcl("/grant", "*S-1-1-0:(RX)");
              customAcl = yield* dependencyAcl();
              expect(customAcl !== inheritedAcl).toBe(true);
              break;
            }
            case "an external junction":
              yield* fs.writeFileString(sentinel, "keep");
              yield* Effect.promise(() =>
                NodeFSP.symlink(
                  repo,
                  NodePath.join(worktree, "node_modules", "external"),
                  "junction",
                ),
              );
              break;
            case "a private file stream":
            case "a private directory stream":
              yield* Effect.promise(() => NodeFSP.writeFile(privateStream, "keep"));
              break;
            case "a build cache added after setup": {
              const cache = NodePath.join(worktree, "node_modules/.vite-temp");
              yield* fs.makeDirectory(cache);
              yield* fs.writeFileString(NodePath.join(cache, "bundle.txt"), "built after setup");
              break;
            }
            case "standard setup only":
            case "an unpublished success marker": {
              if (isWindowsHost && scenario === "standard setup only") {
                yield* command(repo, ["worktree", "add", "-b", "other", sibling]);
                const second = yield* runSetup(false, sibling);
                expect(second.success, second.output).toBe(true);
                const shared = (checkout: string) =>
                  Effect.promise(() =>
                    NodeFSP.stat(NodePath.join(checkout, "node_modules/shared.js")),
                  );
                const firstFile = yield* shared(worktree);
                expect(firstFile.nlink).toBeGreaterThanOrEqual(3);
                expect((yield* shared(sibling)).ino).toBe(firstFile.ino);
              }
              if (scenario === "an unpublished success marker") yield* fs.remove(done);
              const repeated = yield* runSetup(true);
              expect(repeated.success, repeated.output).toBe(true);
              expect(yield* fs.exists(done)).toBe(true);
              break;
            }
            case "a prior proof without dependencies": {
              for (const name of ["node_modules", "apps/server/node_modules", ".env"])
                yield* fs.remove(NodePath.join(worktree, name), { recursive: true });
              const repeated = yield* runSetup();
              expect(repeated.success, repeated.output).toBe(true);
              expect(yield* fs.exists(proof)).toBe(true);
              break;
            }
            case "an unknown proof directory with saved ignored files":
              yield* fs.remove(proof);
              yield* fs.makeDirectory(proof);
              yield* fs.writeFileString(NodePath.join(proof, "owner.txt"), "preserve this");
              break;
            case "an added dependency file": {
              yield* fs.writeFileString(NodePath.join(dependency, "local.js"), "added");
              const repeated = yield* runSetup(true);
              expect(repeated.success).toBe(false);
              expect(repeated.output).toContain("Installed files changed");
              break;
            }
            case "an edited dependency file": {
              const file = NodePath.join(dependency, "index.js");
              const original = yield* fs.stat(file);
              yield* fs.writeFileString(file, "edited");
              if (Option.isSome(original.atime) && Option.isSome(original.mtime))
                yield* fs.utimes(file, original.atime.value, original.mtime.value);
              break;
            }
            case "a replaced done marker":
              yield* fs.remove(done);
              yield* fs.writeFileString(done, "");
              break;
            case "a changed proof":
              yield* fs.writeFileString(proof, "{}");
              break;
            case "a legacy done marker":
              yield* fs.remove(proof);
              break;
            case "a missing dotenv source":
              yield* fs.remove(mainEnv);
              break;
            case "a retargeted dependency symlink": {
              const link = NodePath.join(worktree, "node_modules/example");
              yield* fs.remove(link);
              yield* fs.symlink("missing-target", link);
              break;
            }
          }
          const status = (yield* command(worktree, [
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=matching",
            "--untracked-files=all",
          ])).stdout;
          expect(status.split("\0")).toContain("!! apps/server/node_modules/");
          if (!race) expect(status.split("\0")).toContain("!! node_modules/");
          expect(status).not.toContain("index.js");
          expect(status).not.toContain("local.js");
          const runId = RunId.make("finished-setup");
          const owner = shell({
            branch: "feature",
            worktreePath: worktree,
            status: "completed",
            latestRunId: runId,
            latestRunCompletedAt: at(0),
          });
          fixture.setThreads([owner]);
          const { file, savedFiles } = yield* queueWorktreeRelease({
            stateDir: fixture.config.stateDir,
            threadId: owner.id,
            runId,
            worktreePath: worktree,
            durableRef: "refs/heads/main",
            ...(scenario === "an unknown proof directory with saved ignored files"
              ? { saveIgnored: true }
              : {}),
          });
          const released =
            configureFailure ||
            scenario === "standard setup only" ||
            scenario === "a dead setup owner" ||
            scenario === "a build cache added after setup" ||
            scenario === "an unpublished success marker" ||
            scenario === "a prior proof without dependencies";
          const result = (yield* fixture.service.runNow).entries[0];
          expect(result).toMatchObject(
            released
              ? { outcome: "removed", reason: "Owner released the completed run" }
              : {
                  outcome: "kept",
                  reason:
                    stageStream || existingStage || interruptedInstall
                      ? "Worktree has a preserved setup stage"
                      : race ||
                          inPlace ||
                          refreshedInputs ||
                          scenario === "a legacy done marker" ||
                          scenario === "an unrelated source edit on repeat"
                        ? "Worktree contains tracked, untracked or ignored local data"
                        : scenario === "a changed proof" ||
                            scenario === "an unknown proof directory with saved ignored files"
                          ? "Worktree setup metadata requires its owner (Unrecognized setup proof)"
                          : scenario === "a private file stream" ||
                              scenario === "a private directory stream" ||
                              scenario === "a tracked stream on repeat"
                            ? "Windows worktree contains data or filesystem entries that could not be verified (private-stream)"
                            : scenario === "a custom dependency ACL"
                              ? "Windows worktree contains data or filesystem entries that could not be verified (explicit-ace)"
                              : scenario === "an external junction"
                                ? "Standard setup output changed or could not be verified (Dependency links outside the worktree)"
                                : "Standard setup output changed or could not be verified",
                },
          );
          expect(yield* fs.exists(worktree)).toBe(!released);
          expect(yield* fs.exists(file + ".released")).toBe(released);
          const registrations = (yield* command(repo, ["worktree", "list", "--porcelain"])).stdout;
          expect(registrations.includes(worktree.split(NodePath.sep).join("/"))).toBe(!released);
          if (!isWindowsHost && scenario !== "a missing dotenv source") {
            expect(yield* fs.readFileString(mainEnv)).toBe("example-main-value");
          }
          if (scenario === "a build cache added after setup")
            expect(
              yield* fs.readFileString(
                NodePath.join(savedFiles!, "node_modules/.vite-temp/bundle.txt"),
              ),
            ).toBe("built after setup");
          if (
            scenario === "standard setup only" ||
            scenario === "a build cache added after setup"
          ) {
            yield* command(repo, ["worktree", "add", worktree, "feature"]);
            const followUp = yield* runSetup();
            expect(followUp.success, followUp.output).toBe(true);
            expect(
              yield* fs.readFileString(NodePath.join(worktree, "node_modules/example/index.js")),
            ).toBe("module");
            if (isWindowsHost && scenario === "standard setup only")
              expect(
                yield* fs.readFileString(NodePath.join(sibling, "node_modules/example/index.js")),
              ).toBe("module");
          }
          if (scenario === "an external junction" || existingStage)
            expect(yield* fs.readFileString(sentinel)).toBe("keep");
          if (outsidePnpmfile) expect(yield* fs.readFileString(outsideConfig)).toBe("preserve");
          if (existingStage)
            expect(yield* fs.realPath(NodePath.join(worktree, ".t3/setup-stage"))).toBe(repo);
          if (scenario === "a crashed setup publication") {
            expect(yield* fs.readFileString(NodePath.join(abandonedClaim, "proof"))).toBe(
              "unrecognized data",
            );
            expect(yield* fs.readFileString(NodePath.join(abandonedClaim, "done"))).toBe(
              yield* fs.readFileString(done),
            );
          }
          if (customAcl !== undefined) {
            expect((yield* dependencyAcl()) === customAcl).toBe(true);
            expect(yield* fs.readFileString(NodePath.join(dependency, "index.js"))).toBe("module");
          }
          if (stageStream)
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(
                  NodePath.join(
                    worktree,
                    ".t3/setup-stage/repo/node_modules/.pnpm/example/node_modules/example/index.js:private",
                  ),
                  "utf8",
                ),
              ),
            ).toBe("keep");
          if (
            scenario === "a private file stream" ||
            scenario === "a private directory stream" ||
            scenario === "a tracked stream on repeat"
          )
            expect(yield* Effect.promise(() => NodeFSP.readFile(privateStream, "utf8"))).toBe(
              "keep",
            );
          if (scenario === "an unknown proof directory with saved ignored files")
            expect(yield* fs.readFileString(NodePath.join(proof, "owner.txt"))).toBe(
              "preserve this",
            );
          if (scenario === "an added dependency file")
            expect(yield* fs.readFileString(NodePath.join(dependency, "local.js"))).toBe("added");
          if (scenario === "an edited dependency file")
            expect(yield* fs.readFileString(NodePath.join(dependency, "index.js"))).toBe("edited");
          if (race)
            expect(
              yield* fs.readFileString(
                NodePath.join(worktree, "apps/server/node_modules/local.js"),
              ),
            ).toBe("added during setup");
        }),
      ),
  );
});

it.live.each([
  "HEAD tree",
  "different tree",
  "commit",
  "symbolic ref",
  "newline-less tree",
  "symlink",
  "oversized",
  "active merge",
] as const)("inspects a worktree with AUTO_MERGE metadata (%s)", (kind) =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture(undefined, true);
      fixture.disable();
      const { fs, repo, worktree, command } = fixture;
      const marker = (yield* command(worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "AUTO_MERGE",
      ])).stdout.trim();
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      const tree = (yield* command(worktree, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      if (kind === "active merge") {
        yield* fs.writeFileString(NodePath.join(repo, "merge.txt"), "incoming");
        yield* command(repo, ["add", "merge.txt"]);
        yield* command(repo, ["commit", "-m", "Incoming commit"]);
        yield* command(worktree, ["merge", "--no-ff", "--no-commit", "main"]);
      }
      switch (kind) {
        case "newline-less tree":
          yield* fs.writeFileString(marker, tree);
          break;
        case "symbolic ref":
          yield* fs.writeFileString(marker, "ref: refs/heads/main\n");
          break;
        case "symlink": {
          const target = NodePath.join(repo, ".git", "auto-merge-target");
          yield* fs.writeFileString(target, tree + "\n");
          yield* fs.symlink(target, marker);
          break;
        }
        case "oversized":
          yield* fs.writeFileString(marker, tree.padEnd(66, " "));
          break;
        case "different tree": {
          const other = (yield* command(repo, ["rev-parse", "HEAD~1^{tree}"])).stdout.trim();
          expect(other).not.toBe(tree);
          yield* command(worktree, ["update-ref", "AUTO_MERGE", other]);
          break;
        }
        default:
          yield* command(worktree, ["update-ref", "AUTO_MERGE", kind === "commit" ? head : tree]);
      }
      const runId = RunId.make("finished-integration");
      const owner = shell({
        branch: "feature",
        worktreePath: worktree,
        status: "completed",
        latestRunId: runId,
        latestRunCompletedAt: at(0),
      });
      fixture.setThreads([owner]);
      yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: owner.id,
        runId,
        worktreePath: worktree,
        durableRef: "refs/heads/main",
      });
      const result = (yield* fixture.service.runNow).entries[0];
      if (kind === "HEAD tree") {
        expect(result).toMatchObject({ outcome: "removed" });
        expect(yield* fs.exists(worktree)).toBe(false);
        return;
      }
      expect(result?.outcome).toBe("kept");
      if (kind === "active merge") {
        expect(result?.reason).toMatch(
          /^Worktree metadata MERGE_(HEAD|MODE|MSG) requires its owner$/,
        );
      } else {
        expect(result?.reason).toBe(
          kind === "symlink" && isWindowsHost
            ? "Worktree metadata requires its owner (reparse-point)"
            : kind === "symlink" || kind === "oversized"
              ? "Worktree metadata requires its owner"
              : "Worktree has an unpreserved auto-merge tree",
        );
      }
      expect(yield* fs.exists(marker)).toBe(true);
      expect(yield* fs.exists(worktree)).toBe(true);
    }),
  ),
);

it.live(
  "unrelated process starts proceed during inspection and removal of a different worktree",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        const sibling = fixture.worktree + "-sibling";
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "sibling", sibling]);
        const alias = NodePath.join(fixture.repo, "directory-alias");
        yield* fixture.fs.symlink(NodePath.join(fixture.worktree, "vendor"), alias);
        const runId = RunId.make("delivered");
        const owner = shell({
          status: "completed",
          branch: "feature",
          worktreePath: fixture.worktree,
          latestRunId: runId,
          latestRunCompletedAt: at(0),
        });
        fixture.setThreads([owner]);
        yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setSessionLive(false);
        fixture.setOnLiveCheck(
          withWorkspaceProcessStart(
            Effect.sync(() => fixture.setOnLiveCheck(Effect.void)),
            [sibling],
          ),
        );
        const removing = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        fixture.setBeforeRemoval(
          Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        );
        const sweep = yield* fixture.service.runNow.pipe(Effect.forkChild);
        expect(
          yield* Effect.raceFirst(
            Deferred.await(removing).pipe(Effect.as("removing")),
            Fiber.join(sweep).pipe(Effect.map((r) => r.entries[0]?.reason)),
          ),
        ).toBe("removing");
        const conflictingPath = (yield* HostProcess.isWindows)
          ? NodePath.toNamespacedPath(alias.toUpperCase())
          : alias;
        const conflicting = yield* withWorkspaceProcessStart(fixture.fs.exists(fixture.worktree), [
          conflictingPath,
        ]).pipe(Effect.forkChild({ startImmediately: true }));
        const unknown = yield* withWorkspaceProcessStart(fixture.fs.exists(fixture.worktree), [
          null,
        ]).pipe(Effect.forkChild({ startImmediately: true }));
        for (const [caller, paths] of Object.entries({
          command: [sibling, fixture.repo],
          terminal: [sibling, NodePath.join(sibling, "vendor")],
          provider: [sibling],
        })) {
          expect(
            yield* withWorkspaceProcessStart(fixture.fs.exists(fixture.worktree), paths),
            caller,
          ).toBe(true);
        }
        yield* Deferred.succeed(finish, undefined);
        expect((yield* Fiber.join(sweep)).entries[0]?.outcome).toBe("removed");
        expect(yield* Fiber.join(conflicting)).toBe(false);
        expect(yield* Fiber.join(unknown)).toBe(false);
      }),
    ),
);

it.live.each(["truncated", "incompatible", "mismatched"] as const)(
  "isolates a %s release request from other worktrees and ordinary cleanup",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        const sibling = fixture.worktree + "-other";
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "other", sibling]);
        const runId = RunId.make("completed");
        const owner = shell({
          status: "completed",
          branch: "feature",
          worktreePath: fixture.worktree,
          latestRunId: runId,
          latestRunCompletedAt: at(0),
        });
        const alias = NodePath.join(fixture.repo, "worktrees-alias");
        yield* fixture.fs.symlink(NodePath.dirname(sibling), alias);
        const other = shell({
          id: ThreadId.make("other"),
          branch: "other",
          worktreePath: NodePath.join(alias, NodePath.basename(sibling)),
        });
        fixture.setThreads([other, owner]);
        const queue = (thread: typeof owner) =>
          queueWorktreeRelease({
            stateDir: fixture.config.stateDir,
            threadId: thread.id,
            runId,
            worktreePath: thread.worktreePath!,
            durableRef: "refs/heads/main",
          });
        const valid = yield* queue(owner);
        const damaged = yield* queue(other);
        yield* fixture.fs.writeFileString(
          damaged.file,
          kind === "truncated"
            ? "{"
            : kind === "mismatched"
              ? yield* fixture.fs.readFileString(valid.file)
              : JSON.stringify({
                  ...JSON.parse(yield* fixture.fs.readFileString(damaged.file)),
                  version: 99,
                }),
        );
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((e) => e.path === fixture.worktree)?.outcome).toBe("removed");
        expect(report.entries.find((e) => e.path === other.worktreePath)?.reason).toMatch(
          /release request/i,
        );
        expect(yield* fixture.fs.exists(sibling)).toBe(true);
        expect(yield* fixture.fs.exists(damaged.file)).toBe(true);
      }),
    ),
);

const seedDelegateResult = (
  sql: SqlClient.SqlClient,
  input: {
    readonly childId: ThreadId;
    readonly childRunId: RunId;
    readonly parentId: ThreadId;
    readonly observerRunId: RunId;
  },
) =>
  Effect.gen(function* () {
    const { childId, childRunId, parentId, observerRunId } = input;
    const taskId = NodeId.make("node:delegated-task:release-result");
    const spawnedAt = DateTime.formatIso(at(-3 * DAY_MS));
    const reportedAt = DateTime.formatIso(at(-2 * DAY_MS));
    const observedAt = DateTime.formatIso(at(-DAY_MS));
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES
        ('spawner', ${parentId}, 1, 'codex', 'completed', ${spawnedAt}, ${spawnedAt}, '{}'),
        (${childRunId}, ${childId}, 1, 'codex', 'completed', ${spawnedAt}, ${reportedAt},
          ${JSON.stringify({ delegatedTaskId: taskId })}),
        (${observerRunId}, ${parentId}, 2, 'codex', 'completed', ${reportedAt}, ${observedAt}, '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin,
       status, completed_at, updated_at, payload_json, completion_delivery_state)
      VALUES (${taskId}, ${parentId}, 'spawner', 'root', 'codex', ${childId}, 'app_owned',
        'completed', ${reportedAt}, ${reportedAt},
        ${JSON.stringify({
          result: "Finished delegated work",
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        })}, 'acknowledged')`;
    yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
      (context_transfer_id, source_thread_id, target_thread_id, target_run_id, type, status,
       updated_at, payload_json)
      VALUES ('transfer', ${childId}, ${parentId}, 'spawner', 'subagent_result', 'consumed',
        ${reportedAt}, ${JSON.stringify({ sourcePoint: { runId: childRunId } })})`;
    return sql`UPDATE orchestration_v2_projection_subagents
      SET payload_json = json_set(payload_json, '$.completionDelivery.observedByRunId', ${observerRunId},
        '$.completionDelivery.observedAt', ${observedAt}),
        updated_at = ${observedAt}
      WHERE subagent_id = ${taskId}`;
  });

it.effect(
  "replays an owner-qualified delegated checkout release after its parent receives the result",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* cleanupFixture(undefined, true, sql);
        fixture.disable();
        const runId = RunId.make("delegate-run");
        const parentId = ThreadId.make("parent");
        const thread = shell({
          status: "completed",
          branch: "feature",
          worktreePath: fixture.worktree,
          latestRunId: runId,
          latestRunCompletedAt: at(-2 * DAY_MS),
          settledAt: at(-DAY_MS),
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        });
        fixture.setThreads([thread]);
        const recordParentRead = yield* seedDelegateResult(sql, {
          childId: thread.id,
          childRunId: runId,
          parentId,
          observerRunId: RunId.make("reader"),
        });
        const { file: request } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: thread.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Parent has not received this delegate's result",
        );
        yield* fixture.fs.rename(request, request + ".releasing");
        yield* recordParentRead;
        yield* fixture.activate(Stream.empty);
        yield* fixture.service.reports.pipe(
          Stream.filter((report) => report?.counts.removed === 1),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* fixture.fs.exists(request + ".released")).toBe(true);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
    ),
);

it.effect("requires the approved child's result and a completed parent run that received it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const taskId = NodeId.make("node:delegated-task:command:fixture");
    const child = shell({
      id: ThreadId.make("child"),
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        rootThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
      forkedFrom: { type: "node", nodeId: taskId },
    });
    const run = RunId.make("child-run");
    const consumed = () => StorageCleanup.familyDelegateResultConsumed(sql, child, run);
    const now = DateTime.formatIso(at(0));
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES (${run}, 'child', 1, 'test', 'completed', ${now}, ${now}, '{}'),
        ('spawner', 'parent', 1, 'test', 'completed', ${now}, ${now}, '{}'),
        ('reader', 'parent', 2, 'test', 'completed', ${now}, ${now}, '{"userMessageId":"wake"}'),
        ('stranger', 'elsewhere', 1, 'test', 'completed', ${now}, ${now}, '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin,
       status, completed_at, updated_at, payload_json, completion_delivery_state)
      VALUES (${taskId},'parent','spawner','root','test','child','app_owned','completed',${now},${now},
        '{"result":"Done","completionDelivery":{"observedByRunId":"reader"}}','acknowledged')`;
    yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
      (context_transfer_id, source_thread_id, target_thread_id, target_run_id, type, status, updated_at, payload_json)
      VALUES ('transfer','child','parent','spawner','subagent_result','consumed',${now},'{"sourcePoint":{"runId":"previous"}}')`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_context_transfers
      SET payload_json = json_set(payload_json, '$.sourcePoint.runId', ${run})`;
    // A later write can carry an observer that acknowledged the task before it published its result.
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json,
      '$.terminalResultObservation', json(${JSON.stringify({ runId: "reader", at: now })}))`;
    expect(yield* consumed()).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_remove(payload_json, '$.terminalResultObservation')`;
    const later = DateTime.formatIso(at(DAY_MS));
    yield* sql`UPDATE orchestration_v2_projection_subagents SET updated_at = ${later}`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json =
      json_set(payload_json, '$.completionDelivery.observedAt', ${now})`;
    expect(yield* consumed()).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET completed_at = ${later}`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET completed_at = ${now}, updated_at = ${now}`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"delegatedTaskId":"other-task"}' WHERE run_id = ${run}`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.delegatedTaskId', ${taskId}) WHERE run_id = ${run}`;
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json =
      json_set(payload_json, '$.completionDelivery.observedByRunId', 'stranger')`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET completion_delivery_state = 'delivered'`;
    const fullText = `Delegated task ${taskId} [completed]:\nDone`;
    const wake = {
      createdBy: "agent",
      creationSource: "server",
      text: fullText,
      delegatedCompletion: { parentRunId: "spawner", taskIds: [taskId] },
    };
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('wake','parent','reader','user',0,${now},${now},${JSON.stringify(wake)})`;
    expect(yield* consumed()).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'failed' WHERE run_id = 'reader'`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = '{"userMessageId":"started-earlier"}' WHERE run_id = 'reader'`;
    expect(yield* consumed()).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_context_transfers SET target_thread_id = 'elsewhere'`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_context_transfers SET target_thread_id = 'parent'`;
    // Older notifications can retain a display ID from before the structured task was remapped.
    const historicText =
      "Delegated task node:delegated-task:command%253Afixture (Build) [completed]:\nDone";
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json, '$.title', 'Build') WHERE subagent_id = ${taskId}`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"userMessageId":"wake"}' WHERE run_id = 'reader'`;
    const setWake = (message: typeof wake) =>
      sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${JSON.stringify(message)} WHERE message_id = 'wake'`;
    for (const changed of [
      { ...wake, text: historicText.replace("command%253Afixture", "command%253Aother") },
      { ...wake, text: historicText.replace("(Build)", "(Different task)") },
      { ...wake, text: historicText + " later" },
      { ...wake, text: historicText.slice(0, -1) },
      { ...wake, text: historicText, creationSource: "client" },
      {
        ...wake,
        text: historicText,
        delegatedCompletion: { parentRunId: "spawner", taskIds: [NodeId.make("other")] },
      },
      {
        ...wake,
        text: historicText,
        delegatedCompletion: { parentRunId: "other", taskIds: [taskId] },
      },
    ]) {
      yield* setWake(changed);
      expect(yield* consumed()).toBe(false);
    }
    yield* setWake({ ...wake, text: historicText });
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{}' WHERE run_id = 'reader'`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"userMessageId":"wake"}' WHERE run_id = 'reader'`;
    expect(yield* consumed()).toBe(true);
    const oversizedResult = "é".repeat(8_000);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json, '$.result', ${oversizedResult}) WHERE subagent_id = ${taskId}`;
    yield* setWake({ ...wake, text: historicText.replace("Done", oversizedResult) });
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_remove(json_set(payload_json, '$.result', 'Done'), '$.title') WHERE subagent_id = ${taskId}`;
    // A sibling can quote the full result even when the budget omitted this task's own report.
    const sibling = fullText.padStart(15_970, "x");
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, run_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('s','parent','spawner','root','test','app_owned','completed',${now},${JSON.stringify({ result: sibling })})`;
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${JSON.stringify({
      ...wake,
      delegatedCompletion: { parentRunId: "spawner", taskIds: ["s", taskId] },
      text: `Delegated task s [completed]:\n${sibling}\n\nDelegated task ${taskId} [completed]. Use task_status with taskId ${taskId} to read the result.`,
    })}`;
    expect(yield* consumed()).toBe(false);
    // A Stop closes the spawning run's delivery, which ends a wake already delivered.
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json,
      '$.delegatedCompletion', json('{"disposition":"stopped","nextGeneration":2,"delivery":null}'))
      WHERE run_id = 'spawner'`;
    expect(yield* consumed()).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{}' WHERE run_id = 'spawner'`;
    expect(yield* consumed()).toBe(false);
    yield* sql`UPDATE orchestration_v2_projection_subagents SET completion_delivery_state = 'disposed',
      payload_json = json_set(payload_json, '$.completionDelivery', json('{"state":"disposed","observedByRunId":null}'))
      WHERE subagent_id = ${taskId}`;
    expect(yield* consumed()).toBe(true);
    // A result whose spawning run is gone was dropped without anyone deciding to.
    yield* sql`UPDATE orchestration_v2_projection_runs SET thread_id = 'gone' WHERE run_id = 'spawner'`;
    expect(yield* consumed()).toBe(false);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["private delegate", "background command", "foreign background command"] as const)(
  "requires a completed result consumer to release the %s checkout",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* cleanupFixture(undefined, true, sql);
        fixture.disable();
        const child = kind === "private delegate";
        const foreign = kind === "foreign background command";
        const ownerId = ThreadId.make("thread-1");
        const parentId = child
          ? ThreadId.make("parent")
          : foreign
            ? ThreadId.make("foreign")
            : ownerId;
        const taskId = NodeId.make("node:delegated-task:result-consumer");
        const childRun = RunId.make("child-run");
        const laterRun = RunId.make("later-run");
        const ownerRun = child ? childRun : foreign ? RunId.make("owner-finished") : laterRun;
        const result = "Final task result";
        const cwd = foreign
          ? NodePath.join(fixture.config.stateDir, "command-alias")
          : fixture.worktree;
        if (foreign) {
          yield* Effect.promise(() =>
            NodeFSP.symlink(fixture.worktree, cwd, isWindowsHost ? "junction" : "dir"),
          );
        }
        const command = {
          command: "echo result",
          cwd,
          logPath: "command.log",
          timeoutMinutes: 1,
        };
        const reportedAt = DateTime.formatIso(at(-3 * DAY_MS));
        const failedAt = DateTime.formatIso(at(-2 * DAY_MS));
        const laterAt = DateTime.formatIso(at(-DAY_MS));
        // Only work recorded after the checkout's Git pointer was written can concern it.
        const checkoutBorn = DateTime.formatIso(
          DateTime.makeUnsafe(
            Number(
              (yield* Effect.promise(() =>
                NodeFSP.stat(NodePath.join(fixture.worktree, ".git"), { bigint: true }),
              )).birthtimeNs / 1_000_000n,
            ),
          ),
        );
        const insertCommandRun = () => sql`INSERT INTO command_runs
          (task_id, thread_id, run_id, command, cwd, directory, status, exit_code, started_at, deadline_at, ended_at, delivered_at)
          VALUES (${taskId}, ${parentId}, 'spawner', ${command.command}, ${cwd},
            ${fixture.config.stateDir}, 'exited', 0, ${reportedAt}, ${failedAt}, ${reportedAt}, ${reportedAt})`;
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: ownerRun,
          latestRunCompletedAt: child ? at(-3 * DAY_MS) : at(-DAY_MS),
          ...(child && {
            forkedFrom: { type: "node" as const, nodeId: taskId },
            lineage: {
              rootThreadId: parentId,
              parentThreadId: parentId,
              relationshipToParent: "subagent" as const,
            },
          }),
        });
        fixture.setThreads([owner]);
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
          VALUES ('spawner', ${parentId}, 1, 'test', 'completed', ${reportedAt}, ${reportedAt}, '{}'),
            ('failed-reader', ${parentId}, 2, 'test', 'failed', ${reportedAt}, ${failedAt}, '{"userMessageId":"wake"}'),
            (${laterRun}, ${parentId}, 3, 'test', 'completed', ${failedAt}, ${laterAt}, '{"userMessageId":"unrelated"}'),
            ('foreign-reader', 'another-parent', 1, 'test', 'completed', ${failedAt}, ${laterAt}, '{}')`;
        if (child) {
          yield* sql`INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
            VALUES (${childRun}, ${ownerId}, 1, 'test', 'completed', ${reportedAt}, ${reportedAt},
              ${JSON.stringify({ delegatedTaskId: taskId })})`;
          yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
            (context_transfer_id, source_thread_id, target_thread_id, target_run_id, type, status, updated_at, payload_json)
            VALUES ('transfer', ${ownerId}, ${parentId}, 'spawner', 'subagent_result', 'consumed', ${reportedAt},
              ${JSON.stringify({ sourcePoint: { runId: childRun } })})`;
        } else {
          if (foreign) {
            yield* sql`INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
              VALUES (${ownerRun}, ${ownerId}, 1, 'test', 'completed', ${failedAt}, ${laterAt}, '{}')`;
          }
          yield* insertCommandRun();
        }
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status,
           completed_at, updated_at, payload_json, completion_delivery_state)
          VALUES (${taskId}, ${parentId}, 'spawner', 'root', 'test', ${child ? ownerId : null},
            'app_owned', 'completed', ${reportedAt}, ${foreign ? checkoutBorn : reportedAt},
            ${JSON.stringify({ result, ...(child ? {} : { command }), completionDelivery: { state: "delivered", observedByRunId: null } })}, 'delivered')`;
        const wake = {
          createdBy: "agent",
          creationSource: "server",
          text: `${child ? "Delegated task" : "Command"} ${taskId} [completed]:\n${result}`,
          delegatedCompletion: { parentRunId: "spawner", generation: 1, taskIds: [taskId] },
        };
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('wake', ${parentId}, 'failed-reader', 'user', 0, ${reportedAt}, ${reportedAt}, ${JSON.stringify(wake)}),
            ('unrelated', ${parentId}, ${laterRun}, 'user', 0, ${failedAt}, ${failedAt}, '{"text":"Unrelated work"}')`;
        const { file } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: ownerId,
          runId: ownerRun,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        const receipt = yield* fixture.fs.readFileString(file);
        const expectKept = (evidence: string) =>
          Effect.gen(function* () {
            const entry = (yield* fixture.service.runNow).entries.find(
              (row) => row.threadId === ownerId,
            );
            expect(entry?.outcome, `${evidence}: ${entry?.reason}`).toBe("kept");
            expect(yield* fixture.fs.readFileString(file)).toBe(receipt);
            expect(yield* fixture.fs.exists(file + ".released")).toBe(false);
            expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
          });
        const recordDelivery = (
          state: "acknowledged" | "disposed",
          observedByRunId: string | null,
        ) => sql`
          UPDATE orchestration_v2_projection_subagents
          SET completion_delivery_state = ${state},
            payload_json = json_set(payload_json, '$.completionDelivery',
              json(${JSON.stringify({ state, observedByRunId })}))
          WHERE subagent_id = ${taskId}`;

        yield* expectKept("failed wake followed by an unrelated completed run");
        if (foreign) {
          yield* sql`DELETE FROM command_runs WHERE task_id = ${taskId}`;
          yield* expectKept("foreign unread command in an aliased cwd after command-run pruning");
          yield* insertCommandRun();
        }
        yield* recordDelivery("acknowledged", null);
        yield* expectKept("acknowledgement without an observer");
        yield* recordDelivery("acknowledged", "failed-reader");
        yield* expectKept("acknowledgement from a failed observer");
        // Only a result whose spawning run is gone still needs a reader once its delivery is disposed.
        yield* sql`UPDATE orchestration_v2_projection_runs SET thread_id = 'gone' WHERE run_id = 'spawner'`;
        yield* recordDelivery("disposed", null);
        yield* expectKept("completion delivery disposed without being read");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'failed-reader'`;
        yield* expectKept("disposed result in an otherwise valid wake");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'failed' WHERE run_id = 'failed-reader'`;
        yield* recordDelivery("acknowledged", laterRun);
        yield* sql`UPDATE orchestration_v2_projection_subagents
          SET completion_delivery_state = 'disposed' WHERE subagent_id = ${taskId}`;
        yield* expectKept("disposed delivery column without a matching payload state");
        yield* recordDelivery("disposed", "foreign-reader");
        yield* expectKept("disposed result with an observer on another thread");
        yield* recordDelivery("disposed", "failed-reader");
        yield* expectKept("disposed result with a failed observer");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running', completed_at = NULL WHERE run_id = ${laterRun}`;
        yield* recordDelivery("disposed", laterRun);
        yield* expectKept("disposed result read by a parent run that is still running");
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ${laterAt} WHERE run_id = ${laterRun}`;
        yield* sql`UPDATE orchestration_v2_projection_runs SET thread_id = ${parentId} WHERE run_id = 'spawner'`;
        if (!child) {
          yield* sql`UPDATE command_runs SET run_id = 'wrong-spawner' WHERE task_id = ${taskId}`;
          yield* expectKept("command belongs to a different run than its projected task");
          yield* sql`UPDATE command_runs SET run_id = 'spawner' WHERE task_id = ${taskId}`;
        }
        if (foreign) {
          yield* sql`UPDATE orchestration_v2_projection_subagents
            SET payload_json = json_set(payload_json, '$.command.cwd', ${fixture.repo})
            WHERE subagent_id = ${taskId}`;
          yield* expectKept("command cwd disagrees with its projected task");
          yield* sql`UPDATE orchestration_v2_projection_subagents
            SET payload_json = json_set(payload_json, '$.command.cwd', ${cwd})
            WHERE subagent_id = ${taskId}`;
          yield* sql`DELETE FROM command_runs WHERE task_id = ${taskId}`;
          yield* sql`INSERT INTO orchestration_v2_projection_subagents
            (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status,
             completed_at, updated_at, payload_json, completion_delivery_state)
            VALUES ('node:delegated-task:earlier-checkout', ${parentId}, 'earlier-spawner', 'root', 'test',
              NULL, 'app_owned', 'completed', ${reportedAt}, ${reportedAt},
              ${JSON.stringify({ result, command, completionDelivery: { state: "delivered", observedByRunId: null } })}, 'delivered')`;
        }
        const entry = (yield* fixture.service.runNow).entries.find(
          (row) => row.threadId === ownerId,
        );
        expect(entry?.outcome, entry?.reason).toBe("removed");
        expect(yield* fixture.fs.exists(file + ".released")).toBe(true);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
    ),
);

it.effect.each(
  (["command", "delegate"] as const).flatMap((kind) =>
    (
      [
        ["cancelled", "Cancelled.", "disposed", "disposed", "open", "removed"],
        ["cancelled", null, "disposed", "disposed", "open", "removed"],
        ["completed", "Final output", "disposed", "disposed", "open", "removed"],
        ["failed", "Exited with 1", "disposed", "disposed", "open", "removed"],
        ["interrupted", "Stopped with its parent.", "disposed", "disposed", "stopped", "removed"],
        ["completed", "Final output", "disposed", "disposed", "archived", "removed"],
        ["completed", "Final output", "delivered", "delivered", "stopped", "removed"],
        ["completed", "Final output", "delivered", "delivered", "open", "kept"],
        ["cancelled", "Cancelled.", "disposed", "delivered", "open", "kept"],
        ["completed", "Final output", "disposed", "disposed", "missing", "kept"],
        ["interrupted", "Stopped with its parent.", "disposed", "disposed", "missing", "kept"],
      ] as const
    ).map(([status, result, delivery, payloadState, spawner, outcome]) => ({
      kind,
      status,
      result,
      delivery,
      payloadState,
      spawner,
      outcome,
    })),
  ),
)(
  "a $status $kind result with delivery $delivery ($payloadState in its payload) whose spawning run is $spawner leaves its owner $outcome",
  ({ kind, status, result, delivery, payloadState, spawner, outcome }) =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* cleanupFixture(undefined, true, sql);
        fixture.disable();
        const ownerId = ThreadId.make("thread-1");
        const ownerRun = RunId.make("owner-run");
        const taskId = NodeId.make("node:delegated-task:disposed");
        const stoppedAt = DateTime.formatIso(at(-2 * DAY_MS));
        const finishedAt = DateTime.formatIso(at(-DAY_MS));
        const command = {
          command: "sleep 600",
          cwd: fixture.worktree,
          logPath: "command.log",
          timeoutMinutes: 10,
        };
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            status: "completed",
            latestRunId: ownerRun,
            latestRunCompletedAt: at(-DAY_MS),
          }),
        ]);
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
          VALUES ('spawner', ${spawner === "missing" ? "gone" : ownerId}, 1, 'test', 'cancelled',
              ${stoppedAt}, ${stoppedAt}, ${JSON.stringify(
                spawner === "stopped" || spawner === "archived"
                  ? {
                      delegatedCompletion: {
                        disposition: spawner === "stopped" ? "stopped" : "disposed",
                        nextGeneration: 2,
                        delivery: null,
                      },
                    }
                  : {},
              )}),
            (${ownerRun}, ${ownerId}, 2, 'test', 'completed', ${stoppedAt}, ${finishedAt}, '{}')`;
        if (kind === "command") {
          yield* sql`INSERT INTO command_runs
            (task_id, thread_id, run_id, command, cwd, directory, status, exit_code, started_at, deadline_at, ended_at, delivered_at)
            VALUES (${taskId}, ${ownerId}, 'spawner', ${command.command}, ${command.cwd},
              ${fixture.config.stateDir}, 'stopped', NULL, ${stoppedAt}, ${finishedAt}, ${stoppedAt}, ${stoppedAt})`;
        }
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status,
           completed_at, updated_at, payload_json, completion_delivery_state)
          VALUES (${taskId}, ${ownerId}, 'spawner', 'root', 'test',
            ${kind === "delegate" ? "child-thread" : null}, 'app_owned', ${status}, ${stoppedAt}, ${stoppedAt},
            ${JSON.stringify({
              ...(result === null ? {} : { result }),
              ...(kind === "command" ? { command } : {}),
              completionDelivery: { state: payloadState, observedByRunId: null },
            })}, ${delivery})`;
        const { file } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: ownerId,
          runId: ownerRun,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        const entry = (yield* fixture.service.runNow).entries.find(
          (row) => row.threadId === ownerId,
        );
        expect(entry?.outcome, entry?.reason).toBe(outcome);
        if (outcome === "kept") {
          expect(entry?.reason).toContain("has no verified consumer in a completed run");
        }
        expect(yield* fixture.fs.exists(file + ".released")).toBe(outcome === "removed");
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(outcome === "kept");
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
    ),
);

it.live("releases the bound family only after every member settles and delivers", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* cleanupFixture(undefined, true, sql);
      fixture.disable();
      const ownerRunId = RunId.make("root-run");
      const childRunId = RunId.make("child-run");
      const owner = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        status: "completed",
        latestRunId: ownerRunId,
        latestRunCompletedAt: at(-DAY_MS),
        settledAt: at(-DAY_MS),
        settledOverride: "settled",
      });
      const child = {
        ...owner,
        id: ThreadId.make("child"),
        latestRunId: childRunId,
        latestRunCompletedAt: at(-2 * DAY_MS),
        lineage: {
          ...owner.lineage,
          parentThreadId: owner.id,
          relationshipToParent: "subagent" as const,
        },
      };
      fixture.setThreads([child, owner]);
      const recordParentRead = yield* seedDelegateResult(sql, {
        childId: child.id,
        childRunId,
        parentId: owner.id,
        observerRunId: ownerRunId,
      });
      const { file } = yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: owner.id,
        runId: ownerRunId,
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
      });
      expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
      const request = JSON.parse(yield* fixture.fs.readFileString(file));
      request.family = [child, owner].map((member) => ({
        threadId: member.id,
        runId: member.latestRunId,
        projectId: member.projectId,
        lineage: member.lineage,
      }));
      yield* fixture.fs.writeFileString(file, JSON.stringify(request));
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
        "Parent has not received this delegate's result",
      );
      yield* recordParentRead;
      for (const changed of [
        { ...child, status: "failed" as const },
        { ...child, latestRunId: RunId.make("another-run") },
        { ...child, settledAt: null },
      ]) {
        fixture.setThreads([owner, changed]);
        expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
      }
      fixture.setThreads([
        owner,
        child,
        shell({ id: ThreadId.make("other"), worktreePath: fixture.worktree }),
      ]);
      expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
      const staleParent = NodePath.join(fixture.repo, "former-worktree-parent");
      yield* fixture.fs.writeFileString(staleParent, "replacement");
      const historical = shell({
        id: ThreadId.make("historical"),
        worktreePath: NodePath.join(staleParent, NodePath.basename(fixture.worktree)),
        archivedAt: at(-DAY_MS),
      });
      fixture.setThreads([child, owner, historical]);
      const report = yield* fixture.service.runNow;
      const entry = report.entries.find((item) => item.threadId === owner.id);
      expect(report.entries.some((item) => item.threadId === historical.id)).toBe(false);
      expect(entry?.outcome, entry?.reason).toBe("removed");
      expect(yield* fixture.fs.exists(file + ".released")).toBe(true);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      expect(
        (yield* fixture.command(fixture.repo, ["worktree", "list", "--porcelain"])).stdout,
      ).not.toContain(fixture.worktree);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  ),
);

it.live("releases a settled family through ancestor aliases and rechecks new alias owners", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture(undefined, true);
      fixture.disable();
      const parent = NodePath.dirname(fixture.worktree);
      const ownerAlias = NodePath.join(fixture.repo, "owner-worktrees");
      const otherAlias = NodePath.join(fixture.repo, "other-worktrees");
      const linkedCheckout = NodePath.join(fixture.repo, "checkout-link");
      for (const [target, alias] of [
        [parent, ownerAlias],
        [parent, otherAlias],
        [fixture.worktree, linkedCheckout],
      ] as const)
        yield* Effect.promise(() =>
          NodeFSP.symlink(target, alias, isWindowsHost ? "junction" : "dir"),
        );
      const root = shell({
        branch: "feature",
        worktreePath: NodePath.join(ownerAlias, NodePath.basename(fixture.worktree)),
        status: "completed",
        latestRunId: RunId.make("finished-root"),
        latestRunCompletedAt: at(-3 * DAY_MS),
        settledAt: at(-DAY_MS),
        settledOverride: "settled",
      });
      const side = shell({
        id: ThreadId.make("side"),
        latestRunId: RunId.make("finished-side"),
        latestRunCompletedAt: at(-2 * DAY_MS),
        status: "completed",
        branch: root.branch,
        worktreePath: fixture.worktree,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "fork",
          sideChat: true,
        },
      });
      fixture.setThreads([root, side]);
      const { file } = yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: root.id,
        runId: root.latestRunId!,
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
      });
      const request = JSON.parse(yield* fixture.fs.readFileString(file));
      request.family = [root, side].map((member) => ({
        threadId: member.id,
        projectId: member.projectId,
        runId: member.latestRunId,
        lineage: member.lineage,
      }));
      yield* fixture.fs.writeFileString(file, JSON.stringify(request));
      for (const changes of [
        { worktreePath: linkedCheckout },
        { settledOverride: "active" as const },
        { autoSettleDisabledAt: at(-DAY_MS) },
        { latestRunCompletedAt: at(0) },
        { updatedAt: at(0) },
        { snoozedUntil: at(DAY_MS) },
      ]) {
        fixture.setThreads([root, { ...side, ...changes }]);
        expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
      }
      fixture.setThreads([root, side]);
      const unrelated = shell({
        id: ThreadId.make("unrelated-alias"),
        branch: root.branch,
        worktreePath: NodePath.join(otherAlias, NodePath.basename(fixture.worktree)),
      });
      fixture.setOpenSessionCwd(fixture.worktree);
      fixture.setSessionLive(false);
      fixture.setOnLiveCheck(Effect.sync(() => fixture.setThreads([root, side, unrelated])));
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
        "Checkout is shared by another thread",
      );
      expect(yield* fixture.fs.exists(file)).toBe(true);
      fixture.setOnLiveCheck(Effect.void);
      fixture.setThreads([root, side]);
      fixture.setDeletedThreads([{ ...unrelated, deletedAt: at(0) }]);
      expect(
        (yield* fixture.service.runNow).entries.find((entry) => entry.threadId === root.id)?.reason,
      ).toBe("Checkout still has a deleted owner");
      fixture.setDeletedThreads([]);
      const result = (yield* fixture.service.runNow).entries[0];
      expect(result?.outcome, result?.reason).toBe("removed");
      expect(yield* fixture.fs.exists(file + ".released")).toBe(true);
    }),
  ),
);

it.live(
  "rechecks deleted owners and ignores only a finished unused side chat from this checkout family",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        const root = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: RunId.make("finished-root"),
          latestRunCompletedAt: at(-2 * DAY_MS),
          settledAt: at(-DAY_MS),
          settledOverride: "settled",
        });
        const closed = shell({
          id: ThreadId.make("closed-side"),
          branch: root.branch,
          worktreePath: root.worktreePath,
          deletedAt: at(-DAY_MS),
          lineage: {
            rootThreadId: root.id,
            parentThreadId: root.id,
            relationshipToParent: "fork",
            sideChat: true,
          },
        });
        fixture.setThreads([root]);
        const { file } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: root.id,
          runId: root.latestRunId!,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        fixture.setDeletedThreads([closed]);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Checkout still has a deleted owner",
        );
        fixture.setDeletedThreads([{ ...closed, projectId: ProjectId.make("other") }], [closed.id]);
        expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
        fixture.setDeletedThreads(
          [{ ...closed, lineage: { ...closed.lineage, parentThreadId: ThreadId.make("missing") } }],
          [closed.id],
        );
        expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("kept");
        fixture.setDeletedThreads([closed], [closed.id]);
        // A different deleted owner appears after the first ownership check.
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setSessionLive(false);
        fixture.setOnLiveCheck(
          Effect.sync(() =>
            fixture.setDeletedThreads(
              [closed, { ...closed, id: ThreadId.make("another-owner") }],
              [closed.id],
            ),
          ),
        );
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Checkout still has a deleted owner",
        );
        fixture.setOnLiveCheck(Effect.void);
        fixture.setDeletedThreads([closed], [closed.id]);
        const result = (yield* fixture.service.runNow).entries[0];
        expect(result?.outcome, result?.reason).toBe("removed");
        expect(yield* fixture.fs.exists(file + ".released")).toBe(true);
      }),
    ),
);

it.live.skipIf(!isWindowsHost)(
  "keeps a tracked NTFS stream written after the owner queues an ordinary release",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        const runId = RunId.make("finished");
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: runId,
          latestRunCompletedAt: at(0),
        });
        fixture.setThreads([owner]);
        const { file } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        const queued = yield* fixture.fs.readFileString(file);
        const stream = NodePath.join(fixture.worktree, "tracked.txt:private");
        yield* Effect.promise(() => NodeFSP.writeFile(stream, "owner data"));

        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.threadId === owner.id)).toMatchObject({
          outcome: "kept",
          reason:
            "Windows worktree contains data or filesystem entries that could not be verified (private-stream)",
        });
        expect(yield* Effect.promise(() => NodeFSP.readFile(stream, "utf8"))).toBe("owner data");
        expect(yield* fixture.fs.readFileString(file)).toBe(queued);
        expect(yield* fixture.fs.exists(file + ".released")).toBe(false);
        const { stdout } = yield* fixture.command(fixture.repo, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        expect(stdout.split(/\r?\n/)).toContain("branch refs/heads/feature");
      }),
    ),
);

it.live("retains worktree-only history and rejects a release overtaken by a follow-up", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture(undefined, true);
      fixture.disable();
      const runId = RunId.make("finished");
      const owner = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        status: "completed",
        latestRunId: runId,
        latestRunCompletedAt: at(0),
      });
      fixture.setThreads([owner]);
      yield* fixture.command(fixture.worktree, ["commit", "--allow-empty", "-m", "private"]);
      const unique = (yield* fixture.command(fixture.worktree, [
        "rev-parse",
        "HEAD",
      ])).stdout.trim();
      yield* fixture.command(fixture.worktree, ["reset", "--hard", "main"]);
      yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: owner.id,
        runId,
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
      });
      const messageFile = (yield* fixture.command(fixture.worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "COMMIT_EDITMSG",
      ])).stdout.trim();
      yield* fixture.fs.remove(messageFile);
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
        "Worktree has commits outside the durable ref",
      );
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      const archive = "refs/archive/worktree-handoff/private";
      yield* fixture.command(fixture.repo, ["update-ref", archive, unique]);
      yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: owner.id,
        runId,
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
        alsoDurable: [archive],
      });
      fixture.setThreads([{ ...owner, latestRunId: RunId.make("follow-up") }]);
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
        "Requested run has unfinished work or was superseded",
      );
      fixture.setThreads([owner]);
      const privateRef = "refs/worktree/review";
      yield* fixture.command(fixture.worktree, ["update-ref", privateRef, unique]);
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe("Worktree has private refs");
      yield* fixture.command(fixture.worktree, ["update-ref", "-d", privateRef]);
      const admin = (yield* fixture.command(fixture.worktree, [
        "rev-parse",
        "--absolute-git-dir",
      ])).stdout.trim();
      yield* fixture.fs.makeDirectory(`${admin}/logs/refs/worktree`, { recursive: true });
      yield* fixture.fs.writeFileString(`${admin}/logs/refs/worktree/review`, "");
      expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
        "Worktree has private reflogs",
      );
      // Deleting a worktree-only ref and its reflog leaves their emptied folders.
      yield* fixture.command(fixture.worktree, [
        "update-ref",
        "--create-reflog",
        privateRef,
        unique,
      ]);
      yield* fixture.command(fixture.worktree, ["update-ref", "-d", privateRef]);
      yield* fixture.fs.makeDirectory(`${admin}/refs/worktree`, { recursive: true });
      yield* fixture.fs.makeDirectory(`${admin}/logs/refs/worktree`, { recursive: true });
      if (!isWindowsHost) {
        const logs = NodePath.join(admin, "logs");
        const savedLogs = NodePath.join(fixture.repo, "saved-worktree-logs");
        const emptyDirectory = yield* fixture.fs.makeTempDirectoryScoped();
        yield* fixture.fs.rename(logs, savedLogs);
        yield* fixture.fs.symlink(emptyDirectory, logs);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Worktree has private reflogs",
        );
        yield* fixture.fs.remove(logs);
        yield* fixture.fs.rename(savedLogs, logs);
      }
      expect((yield* fixture.service.runNow).entries[0]?.outcome).toBe("removed");
    }),
  ),
);

it.live.each([
  { policy: "tracked-changes", kind: "worktree" },
  { policy: "tracked-changes", kind: "repository" },
  { policy: "tracked-changes", kind: "uppercase" },
  { policy: "tracked-changes", kind: "bare" },
  { policy: "uncommitted-changes", kind: "worktree" },
  { policy: "uncommitted-changes", kind: "repository" },
  { policy: "uncommitted-changes", kind: "uppercase" },
  { policy: "uncommitted-changes", kind: "bare" },
] as const)("keeps an ignored nested $policy / $kind", ({ policy, kind }) =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
      setPolicy(policy);
      const nested = `${worktree}/dist/nested`;
      if (kind === "worktree" || kind === "uppercase") {
        yield* command(repo, ["worktree", "add", "-b", "nested", nested]);
      } else {
        yield* command(repo, [
          "clone",
          "--no-hardlinks",
          ...(kind === "bare" ? ["--bare"] : []),
          repo,
          nested,
        ]);
      }
      if (kind === "uppercase") yield* fs.rename(`${nested}/.git`, `${nested}/.GIT`);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "irreplaceable work\n");
      expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toBe("");
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("irreplaceable work\n");
      expect(
        (yield* command(nested, [
          ...(kind === "uppercase"
            ? [
                `--git-dir=${(yield* fs.readFileString(`${nested}/.GIT`)).trim().slice(8)}`,
                "--work-tree=.",
              ]
            : []),
          "-c",
          "safe.bareRepository=all",
          "rev-parse",
          "--is-bare-repository",
        ])).stdout.trim(),
      ).toBe(String(kind === "bare"));
    }),
  ),
);

const submoduleCleanupFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { command, repo, worktree } = fixture;
    const submodule = `${worktree}/module`;
    const child = `${submodule}/child`;
    for (const [cwd, name] of [
      [worktree, "module"],
      [submodule, "child"],
    ] as const) {
      yield* command(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", repo, name]);
      yield* command(`${cwd}/${name}`, ["config", "user.name", "Cleanup test"]);
      yield* command(`${cwd}/${name}`, ["config", "user.email", "cleanup@example.test"]);
    }
    const recordSubmodules = () =>
      Effect.gen(function* () {
        yield* command(submodule, ["commit", "-am", "record child"]);
        yield* command(submodule, ["push", "origin", "HEAD:submodule"]);
        yield* command(worktree, ["commit", "-am", "record module"]);
      });
    yield* recordSubmodules();
    return { ...fixture, submodule, child, recordSubmodules };
  });

it.live.each(["repository", "worktree"] as const)(
  "inspects a %s in a pnpm store excluded from reclaimed bytes",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-store-" });
        const nested = `${worktree}/node_modules/.pnpm/nested`;
        yield* command(
          repo,
          kind === "worktree"
            ? ["worktree", "add", "-b", "nested", nested]
            : ["clone", "--no-hardlinks", repo, nested],
        );
        yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
        yield* fs.writeFileString(
          `${worktree}/node_modules/.modules.yaml`,
          JSON.stringify({ storeDir, virtualStoreDir: ".pnpm" }),
        );
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "kept",
          reason: "Contains a nested Git repository",
        });
        expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
      }),
    ),
);

describe.skipIf(!isDarwinHost)("automatic cleanup on macOS", () => {
  it.live.each(["checkout", "nested submodule"] as const)(
    "keeps a tracked resource fork in the %s",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* submoduleCleanupFixture();
          const cwd = location === "checkout" ? fixture.worktree : fixture.child;
          const fork = `${cwd}/tracked.txt/..namedfork/rsrc`;
          fixture.setPolicy("tracked-changes");
          yield* fixture.fs.writeFileString(fork, "owner data");
          yield* fixture.fs.writeFileString(`${fixture.worktree}/.env`, "keep while held");
          expect((yield* fixture.command(cwd, ["status", "--porcelain"])).stdout).toBe("");
          const report = yield* fixture.service.runNow;
          const entry = report.entries.find((item) => item.path === fixture.worktree);
          expect(entry?.outcome, entry?.reason).toBe("kept");
          expect(entry?.reason).toMatch(/tracked POSIX metadata/i);
          expect(yield* fixture.fs.readFileString(fork)).toBe("owner data");
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/.env`)).toBe(
            "keep while held",
          );
        }),
      ),
  );
});

it.live("keeps an ignored repository inside a registered submodule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const nested = `${submodule}/dist/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);

it.live("removes clean submodules recursively, including deinitialized repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(submodule, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      const legacy = `${worktree}/legacy`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, legacy]);
      yield* command(worktree, ["submodule", "add", repo, "legacy"]);
      expect((yield* fs.stat(`${legacy}/.git`)).type).toBe("Directory");
      yield* command(legacy, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "child",
      ]);
      yield* command(legacy, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      yield* command(legacy, [
        "-c",
        "user.name=Cleanup test",
        "-c",
        "user.email=cleanup@example.test",
        "commit",
        "-am",
        "record legacy children",
      ]);
      yield* command(legacy, ["push", "origin", "HEAD:legacy"]);
      yield* command(legacy, ["submodule", "deinit", "stored"]);
      yield* recordSubmodules();
      yield* command(submodule, ["submodule", "deinit", "stored"]);
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "removed",
      });
      expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
      expect(yield* fs.exists(worktree)).toBe(false);
      expect(yield* fs.exists(admin)).toBe(false);
    }),
  ),
);

it.live("keeps nested submodule files protected by the current keep rule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      yield* fs.writeFileString(`${child}/tracked.txt`, "local edit\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("local edit\n");
      yield* fs.writeFileString(`${child}/tracked.txt`, "original\n");
      setPolicy("any-local-files");
      yield* fs.writeFileString(`${child}/.env`, "local secret\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/.env`)).toBe("local secret\n");

      yield* fs.remove(`${child}/.env`);
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${child}/.env`, "secret after deinit\n");
      const report = yield* service.runNow;
      expect({
        outcome: report.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/.env`))
          ? yield* fs.readFileString(`${child}/.env`)
          : null,
      }).toEqual({ outcome: "kept", contents: "secret after deinit\n" });

      yield* fs.remove(`${child}/.env`);
      setPolicy("uncommitted-changes");
      yield* fs.writeFileString(`${child}/notes.txt`, "notes after deinit\n");
      const untrackedReport = yield* service.runNow;
      expect({
        outcome: untrackedReport.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/notes.txt`))
          ? yield* fs.readFileString(`${child}/notes.txt`)
          : null,
      }).toEqual({ outcome: "kept", contents: "notes after deinit\n" });
    }),
  ),
);

it.live("keeps unpushed submodule history after checkout and deinitialization", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(child, ["checkout", "-b", "local-only"]);
      yield* fs.writeFileString(`${child}/tracked.txt`, "unpublished work\n");
      yield* command(child, ["commit", "-am", "local work"]);
      const local = (yield* command(child, ["rev-parse", "HEAD"])).stdout.trim();
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("unpublished work\n");

      yield* command(child, ["checkout", "main"]);
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, [
          "--git-dir",
          childGit,
          "rev-parse",
          "refs/heads/local-only",
        ])).stdout.trim(),
      ).toBe(local);
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", "local-only:tracked.txt"]))
          .stdout,
      ).toBe("unpublished work\n");
      yield* command(worktree, ["--git-dir", childGit, "branch", "-D", "local-only"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", `${local}:tracked.txt`])).stdout,
      ).toBe("unpublished work\n");
    }),
  ),
);

it.live("keeps submodules when stored repository metadata is malformed", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command } = yield* submoduleCleanupFixture();
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${childGit}/HEAD`, "not a ref\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("inspected") });
      expect(yield* fs.exists(worktree)).toBe(true);
      expect(yield* fs.readFileString(`${childGit}/HEAD`)).toBe("not a ref\n");
    }),
  ),
);

it.live("preserves late tracked edits when submodules were never initialized", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, fs, worktree, command } = fixture;
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        `${worktree}/.gitmodules`,
        '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
      );
      yield* command(worktree, ["add", ".gitmodules"]);
      yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
      yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
      yield* fs.makeDirectory(`${worktree}/module`);
      fixture.editBeforeRemoval();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "failed" });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
    }),
  ),
);

describe("subagent worktree ownership", () => {
  it.effect.each([
    "idle",
    "grandchild",
    "null-branch",
    "stale-branch",
    "isolated-owner",
    "fork-owner",
    "missing-parent",
    "cycle",
    "two-tops",
    "wrong-root",
    "running",
    "pending",
    "unrelated",
    "fork",
    "side-chat",
    "recent-activity",
    "recent-inactive",
    "recent-grace",
    "recent-settle",
    "child-settled-now",
    "child-settled-only",
  ] as const)("checks the whole owner group (%s)", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeSettledAfterDays: scenario === "recent-inactive" ? null : 8,
          worktreeAfterDays: scenario === "recent-inactive" ? 8 : null,
        },
      });
      const root = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        settledAt: scenario === "child-settled-only" ? null : at(-20 * DAY_MS),
        ...(scenario === "isolated-owner" || scenario === "fork-owner"
          ? {
              lineage: {
                parentThreadId: ThreadId.make("ancestor"),
                rootThreadId: ThreadId.make("ancestor"),
                relationshipToParent:
                  scenario === "fork-owner" ? ("fork" as const) : ("subagent" as const),
              },
            }
          : {}),
      });
      const child = shell({
        id: ThreadId.make("child"),
        branch:
          scenario === "null-branch"
            ? null
            : scenario === "stale-branch"
              ? "t3/15a6e5ae"
              : "feature",
        worktreePath: fixture.worktree,
        lineage: {
          parentThreadId:
            scenario === "missing-parent"
              ? ThreadId.make("missing")
              : scenario === "cycle"
                ? ThreadId.make("child")
                : scenario === "two-tops"
                  ? null
                  : root.id,
          rootThreadId:
            scenario === "wrong-root" ? ThreadId.make("other-root") : root.lineage.rootThreadId,
          relationshipToParent:
            scenario === "fork" || scenario === "side-chat"
              ? "fork"
              : scenario === "unrelated"
                ? null
                : "subagent",
          ...(scenario === "side-chat" ? { sideChat: true } : {}),
        },
        status: scenario === "running" ? "running" : "completed",
        pendingBackgroundTasks: scenario === "pending" ? [{ taskId: "task", kind: "command" }] : [],
        latestRunCompletedAt:
          scenario === "recent-activity" || scenario === "recent-inactive"
            ? at(-2 * DAY_MS)
            : scenario === "recent-grace"
              ? at(-30_000)
              : null,
        settledAt: scenario === "child-settled-only" ? at(-20 * DAY_MS) : null,
      });
      const grandchild = {
        ...child,
        id: ThreadId.make("grandchild"),
        lineage: { ...child.lineage, parentThreadId: child.id },
      };
      fixture.setThreads(
        scenario === "grandchild"
          ? [grandchild, child, root]
          : scenario === "isolated-owner" || scenario === "fork-owner"
            ? [child, root, shell({ id: ThreadId.make("ancestor") })]
            : [child, root],
      );
      if (scenario === "recent-settle" || scenario === "child-settled-now")
        fixture.setThreads([
          {
            ...child,
            settledAt: scenario === "recent-settle" ? at(0) : at(-20 * DAY_MS),
            updatedAt: at(0),
          },
          root,
        ]);
      const report = yield* fixture.service.runNow;
      const removed = ["idle", "grandchild", "isolated-owner", "fork-owner", "side-chat"].includes(
        scenario,
      );
      const shared = [
        "unrelated",
        "fork",
        "missing-parent",
        "cycle",
        "two-tops",
        "wrong-root",
      ].includes(scenario);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(!removed);
      expect(report.entries[0]).toMatchObject({
        threadId: shared ? child.id : root.id,
        outcome: removed ? "removed" : "kept",
        reason: removed
          ? "Settled for 20 days"
          : scenario === "running" || scenario === "pending"
            ? "Thread is running or has pending work"
            : shared
              ? "Shared by 2 threads"
              : scenario === "null-branch" || scenario === "stale-branch"
                ? "A subagent thread's branch differs from this worktree's branch"
                : scenario === "recent-activity"
                  ? "Settled for 2 of 8 days"
                  : scenario === "recent-inactive"
                    ? "Inactive for 2 of 8 days"
                    : ["recent-grace", "recent-settle", "child-settled-now"].includes(scenario)
                      ? "Settled moments ago"
                      : "Not settled",
      });
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.live.each([
    "running",
    "pending",
    "activity",
    "unrelated",
    "settled",
    "resettled",
    "null-branch",
    "stale-branch",
  ] as const)("cancels removal when a child changes during measurement (%s)", (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const root = shell({ branch: "feature", worktreePath: fixture.worktree });
        const child = {
          ...root,
          id: ThreadId.make("child"),
          settledAt: change === "resettled" ? at(-20 * DAY_MS) : null,
          lineage: {
            parentThreadId: root.id,
            rootThreadId: root.id,
            relationshipToParent: "subagent" as const,
          },
        };
        fixture.setThreads([child, root]);
        const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads([
          root,
          {
            ...child,
            branch:
              change === "null-branch"
                ? null
                : change === "stale-branch"
                  ? "t3/15a6e5ae"
                  : child.branch,
            settledAt: change === "settled" ? at(-20 * DAY_MS) : child.settledAt,
            updatedAt: change === "settled" || change === "resettled" ? at(0) : child.updatedAt,
            status: change === "running" ? "running" : "idle",
            pendingBackgroundTasks:
              change === "pending" ? [{ taskId: "task", kind: "command" }] : [],
            latestRunCompletedAt: change === "activity" ? at(-DAY_MS) : null,
          },
          ...(change === "unrelated" ? [shell({ ...root, id: ThreadId.make("other") })] : []),
        ]);
        yield* Deferred.succeed(fixture.resume, undefined);
        expect((yield* Fiber.join(run)).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
});

describe("deleted thread worktrees", () => {
  const parent = (worktreePath: string) =>
    shell({ branch: "feature", worktreePath, deletedAt: at(-DAY_MS) });
  // Deleting the parent leaves its native subagent thread in the projection.
  const subagent = (
    owner: OrchestrationV2ThreadShell,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shell({
      id: ThreadId.make("child"),
      title: "Subagent",
      branch: "feature",
      worktreePath: owner.worktreePath,
      status: "completed",
      createdBy: "agent",
      creationSource: "provider",
      lineage: {
        rootThreadId: owner.id,
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
      },
      ...overrides,
    });

  it.effect.each(["no subagents", "native subagent"] as const)(
    "removes a deleted thread's worktree with %s",
    (scenario) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads(scenario === "native subagent" ? [subagent(owner)] : []);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          threadId: owner.id,
          outcome: "removed",
          reason: "Thread was deleted",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("applies the remaining subagent's rules when deletion cleanup is off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: 8,
        worktreeOnDelete: false,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: child.id,
        outcome: "removed",
        reason: "Inactive for 30 days",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  // Releases one stopped-session event after the startup sweep and returns the snapshot reads it caused.
  const stopSessionAfterStartupSweep = (
    fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
    threadId: ThreadId,
    beforeStop: Effect.Effect<void> = Effect.void,
    cwd = fixture.worktree,
  ) =>
    Effect.gen(function* () {
      const startupSwept = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const stopped: OrchestrationV2DomainEvent = {
        id: EventId.make("event:session-stopped"),
        type: "provider-session.updated",
        threadId,
        occurredAt: at(0),
        payload: {
          id: ProviderSessionId.make("session-1"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "stopped",
          cwd,
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: at(-DAY_MS),
          updatedAt: at(0),
          lastError: null,
        },
      };
      yield* fixture.activate(
        Stream.fromEffect(Deferred.await(startupSwept)).pipe(
          Stream.flatMap(() => Stream.make(stopped)),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
          ),
        ),
      );
      yield* fixture.service.reports.pipe(
        Stream.filter((report) => report !== null),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* fixture.service.drain;
      yield* beforeStop;
      const readsBefore = fixture.snapshotReads();
      yield* Deferred.succeed(startupSwept, undefined);
      yield* Deferred.await(delivered);
      yield* fixture.service.drain;
      return fixture.snapshotReads() - readsBefore;
    });

  it.effect("does not sweep when a live thread's session stops and no deleted worktree waits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      const reads = yield* stopSessionAfterStartupSweep(fixture, ThreadId.make("thread-1"));
      expect(reads, "a live thread's stopped session re-read every thread").toBe(0);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once its session stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        owner.id,
        Effect.sync(() => fixture.setSessionLive(false)),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      // These rechecks hold the workspace lease a turn start waits for.
      const recheckLanes = fixture
        .sqlReads()
        .filter((read) => /projection_provider_sessions|effect_outbox/.test(read.query))
        .map((read) => read.background);
      expect(new Set(recheckLanes)).toEqual(new Set([false]));
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once a live thread's session in it stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        child.id,
        Effect.gen(function* () {
          expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
            threadId: owner.id,
            outcome: "kept",
            reason: "Provider session is still open",
          });
          fixture.setSessionLive(false);
        }),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree once its terminal closes and its session stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.setTerminals([
          {
            threadId: owner.id,
            terminalId: "terminal-1",
            cwd: fixture.worktree,
            worktreePath: fixture.worktree,
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: DateTime.formatIso(at(0)),
          },
        ]);
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Open terminal",
            });
            yield* fixture.setTerminals([]);
          }),
          fixture.repo,
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "retries a deleted thread's worktree kept for another reason when a session in it stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Has uncommitted changes (1 file)",
            });
            yield* fixture.fs
              .writeFileString(`${fixture.worktree}/tracked.txt`, "original\n")
              .pipe(Effect.orDie);
          }),
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("does not sweep for a kept deleted worktree when a session elsewhere stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      fixture.setDeletedThreads([parent(fixture.worktree)]);
      fixture.setThreads([]);
      yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        ThreadId.make("thread-elsewhere"),
        Effect.void,
        fixture.repo,
      );
      expect(reads).toBe(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "does not sweep for a deleted thread whose cleanup effect failed when a session elsewhere stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        fixture.setOutboxStatus("failed");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          ThreadId.make("thread-elsewhere"),
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Thread deletion is still pending",
            });
          }),
          fixture.repo,
        );
        expect(reads).toBe(0);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree when its session stops during the deletion's sweep",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setThreads([]);
        const startupSwept = yield* Deferred.make<void>();
        const sessionChecked = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const deleted = {
          id: EventId.make("event:thread-deleted"),
          type: "thread.deleted",
          threadId: owner.id,
          occurredAt: at(0),
          payload: owner,
        } as unknown as OrchestrationV2DomainEvent;
        const stopped: OrchestrationV2DomainEvent = {
          id: EventId.make("event:session-stopped"),
          type: "provider-session.updated",
          threadId: owner.id,
          occurredAt: at(0),
          payload: {
            id: ProviderSessionId.make("session-1"),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "stopped",
            cwd: fixture.worktree,
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: at(-DAY_MS),
            updatedAt: at(0),
            lastError: null,
          },
        };
        yield* fixture.activate(
          Stream.fromEffect(Deferred.await(startupSwept)).pipe(
            Stream.flatMap(() => Stream.make(deleted)),
            Stream.concat(Stream.fromEffect(Deferred.await(sessionChecked)).pipe(Stream.drain)),
            Stream.concat(Stream.make(stopped)),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
            ),
          ),
        );
        yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* fixture.service.drain;
        fixture.setDeletedThreads([owner]);
        fixture.setOpenSessionCwd(fixture.worktree);
        // The deletion's sweep sees the session live; it stops before that sweep publishes its result.
        fixture.setOnLiveCheck(
          Effect.gen(function* () {
            fixture.setOnLiveCheck(Effect.void);
            yield* Deferred.succeed(sessionChecked, undefined);
            yield* Deferred.await(delivered);
            fixture.setSessionLive(false);
          }),
        );
        yield* Deferred.succeed(startupSwept, undefined);
        yield* Deferred.await(delivered);
        yield* fixture.service.drain;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("waits out the settle grace of a subagent that just settled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([subagent(owner, { settledAt: at(0), updatedAt: at(0) })]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: owner.id,
        outcome: "kept",
        reason: "Settled moments ago",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

describe("orphan worktree reports", () => {
  it.live("keeps orphan results visible when thread results fill the report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads(
          Array.from({ length: 205 }, (_, index) =>
            shell({
              id: ThreadId.make(`busy-${index}`),
              branch: "busy",
              worktreePath: underWorktrees(fixture, `busy-${index}`),
              status: "running",
            }),
          ),
        );
        for (let index = 0; index < 205; index++) {
          yield* fixture.fs.makeDirectory(underWorktrees(fixture, `busy-${index}`));
        }
        const orphans = ["one", "two"].map((name) => underWorktrees(fixture, `repository/${name}`));
        for (const orphan of orphans) {
          yield* fixture.fs.makeDirectory(orphan, { recursive: true });
          yield* fixture.fs.utimes(orphan, 1, 1);
        }
        const report = yield* fixture.service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(
          report.entries
            .slice(0, 2)
            .map((entry) => entry.path)
            .sort(),
        ).toEqual(orphans);
        expect(report.counts).toEqual({ removed: 0, kept: 207, failed: 0 });
        expect(report.omittedCount).toBe(7);
      }),
    ),
  );

  it.live.each(["canonical", "win32", "linux"] as const)(
    "skips an ancestor of a referenced thread worktree (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform === "win32" ? "win32" : "linux"),
          );
          fixture.setThreads([]);
          const ancestor = underWorktrees(fixture, `repository/stack`);
          const worktree = `${ancestor}/feature`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "nested", worktree]);
          const alias = `${fixture.repo}/alias`;
          if (platform === "canonical") yield* fixture.fs.symlink(worktree, alias);
          fixture.setStoredWorktreePaths([
            platform === "canonical"
              ? alias
              : platform === "win32"
                ? worktree.toUpperCase()
                : worktree,
          ]);
          yield* fixture.fs.utimes(ancestor, 1, 1);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(worktree)).toBe(true);
        }),
      ),
  );

  it.live("continues reporting when a project root cannot be probed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const loop = `${fixture.repo}/loop`;
        yield* fixture.fs.symlink(loop, loop);
        fixture.setProjectRoots([fixture.repo, loop]);
        const orphan = underWorktrees(fixture, `repository/orphan`);
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.utimes(orphan, 1, 1);
        expect((yield* fixture.service.runNow).entries).toEqual([
          expect.objectContaining({ path: orphan, outcome: "kept", bytes: 0 }),
        ]);
      }),
    ),
  );

  it.live.each(["nested", "direct"] as const)(
    "reports a linked orphan's size without removing its files (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const orphan = underWorktrees(
            fixture,
            `${location === "nested" ? "repository/" : ""}orphan`,
          );
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
          const sizes = yield* Effect.forEach(yield* fixture.fs.readDirectory(orphan), (name) =>
            allocatedBytes(fixture.fs, `${orphan}/${name}`),
          );
          const outside = yield* fixture.fs.makeTempDirectoryScoped();
          yield* fixture.fs.writeFileString(`${outside}/external`, "outside data");
          yield* fixture.fs.symlink(outside, `${orphan}/linked-directory`);
          yield* fixture.fs.symlink(`${outside}/missing`, `${orphan}/dangling-link`);
          yield* fixture.fs.utimes(orphan, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([
            {
              kind: "worktree",
              outcome: "kept",
              reason: "No thread uses this worktree",
              path: orphan,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: sizes.reduce((sum, size) => sum + size, 0),
              files: null,
            },
          ]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
          expect(yield* fixture.fs.readFileString(`${outside}/external`)).toBe("outside data");
          expect(
            (yield* fixture.command(orphan, ["rev-parse", "--is-inside-work-tree"])).stdout.trim(),
          ).toBe("true");
        }),
      ),
  );

  it.live.each(["active", "outside-active-snapshot"] as const)(
    "does not report a folder referenced by a thread (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const worktreePath = underWorktrees(fixture, `repository/referenced`);
          yield* fixture.command(fixture.repo, [
            "worktree",
            "add",
            "-b",
            "referenced",
            worktreePath,
          ]);
          fixture.setThreads(
            location === "active"
              ? [shell({ branch: "referenced", worktreePath, status: "running" })]
              : [],
          );
          if (location !== "active")
            fixture.setStoredWorktreePaths([fixture.worktree, worktreePath]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries.filter((entry) => entry.threadId === null)).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "nested", "symlink"] as const)(
    "does not report a folder containing a project checkout (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const worktreePath = underWorktrees(fixture, `repository/project-checkout`);
          yield* fixture.fs.makeDirectory(`${worktreePath}/nested`, { recursive: true });
          const alias = `${fixture.repo}/alias`;
          if (location === "symlink") yield* fixture.fs.symlink(`${worktreePath}/nested`, alias);
          fixture.setProjectRoots([
            fixture.repo,
            location === "exact"
              ? worktreePath
              : location === "nested"
                ? `${worktreePath}/nested`
                : alias,
          ]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "contains", "symlink"] as const)(
    "does not report project internals under a custom managed root (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const source = `${fixture.repo}/src`;
          yield* fixture.fs.makeDirectory(`${source}/nested/deep`, { recursive: true });
          const alias = underWorktrees(fixture, `project-alias`);
          if (location === "symlink") {
            yield* fixture.fs.symlink(fixture.repo, alias);
            fixture.setProjectRoots([alias]);
          }
          if (location === "contains") fixture.setProjectRoots([fixture.repo, `${source}/nested`]);
          fixture.setSettings({
            worktreesDirectory: location === "contains" ? source : fixture.repo,
          });
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(`${source}/nested/deep`)).toBe(true);
        }),
      ),
  );

  it.live("skips symbolic links at both directory levels and disabled cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const outside = yield* fixture.fs.makeTempDirectoryScoped();
        yield* fixture.fs.makeDirectory(`${outside}/checkout`);
        const projectDirectory = underWorktrees(fixture, `repository`);
        yield* fixture.fs.makeDirectory(projectDirectory);
        yield* fixture.fs.symlink(outside, underWorktrees(fixture, `linked-project`));
        yield* fixture.fs.symlink(`${outside}/checkout`, `${projectDirectory}/linked-checkout`);
        yield* fixture.fs.symlink(`${outside}/missing`, `${projectDirectory}/dangling-link`);
        expect((yield* fixture.service.runNow).entries).toEqual([]);
        const orphan = `${projectDirectory}/orphan`;
        yield* fixture.fs.makeDirectory(orphan);
        fixture.disable();
        expect((yield* fixture.service.runNow).entries).toEqual([]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live("reports ordinary folders with an honest reason and keeps their files", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const folder = underWorktrees(fixture, `repository/leftover`);
        yield* fixture.fs.makeDirectory(folder, { recursive: true });
        yield* fixture.fs.writeFileString(`${folder}/payload`, "leftover data");
        yield* fixture.fs.utimes(folder, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: folder,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${folder}/payload`),
            reason: "No thread uses this folder, and it isn't a git worktree",
          }),
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${folder}/payload`)).toBe("leftover data");
      }),
    ),
  );

  it.live("continues after an inaccessible directory's git probe", (context) =>
    runCleanupTest(
      Effect.gen(function* () {
        if ((yield* HostProcess.isWindows) || (yield* HostProcess.UserId) === 0)
          return context.skip();
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const blocked = underWorktrees(fixture, `a-inaccessible`);
        const orphan = underWorktrees(fixture, `z-repository/orphan`);
        yield* fixture.fs.makeDirectory(blocked);
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.writeFileString(`${orphan}/file`, "x");
        yield* fixture.fs.chmod(blocked, 0);
        yield* fixture.fs.utimes(orphan, 1, 1);
        const report = yield* fixture.service.runNow.pipe(
          Effect.ensuring(fixture.fs.chmod(blocked, 0o700).pipe(Effect.orDie)),
        );
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: orphan,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${orphan}/file`),
          }),
        ]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live.each(["win32", "linux"] as const)(
    "compares thread paths with host casing rules and excludes existing projects (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          fixture.setThreads([]);
          const parent = underWorktrees(fixture, `repository`);
          const referenced = NodePath.join(parent, "Referenced");
          const project = `${parent}/Project`;
          const nested = `${parent}/Nested`;
          for (const folder of [referenced, project, nested]) {
            yield* fixture.fs.makeDirectory(`${folder}/child`, { recursive: true });
            yield* fixture.fs.utimes(folder, 1, 1);
          }
          fixture.setStoredWorktreePaths([fixture.worktree, referenced.toUpperCase()]);
          fixture.setProjectRoots([fixture.repo, project, `${nested}/child`]);
          const report = yield* fixture.service.runNow;
          expect(report.entries.map((entry) => entry.path).sort()).toEqual(
            platform === "win32" ? [] : [referenced],
          );
        }),
      ),
  );

  it.live.each([
    ["win32", "cwd"],
    ["win32", "worktreePath"],
    ["linux", "cwd"],
    ["linux", "worktreePath"],
  ] as const)(
    "matches a terminal at the worktree root with host casing rules (%s, %s)",
    ([platform, field]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          const upper = fixture.worktree.toUpperCase();
          yield* fixture.openTerminal(
            field === "cwd"
              ? { cwd: upper, worktreePath: null }
              : { cwd: fixture.repo, worktreePath: upper },
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject(
            platform === "win32"
              ? { outcome: "kept", reason: "Open terminal" }
              : { outcome: "removed" },
          );
        }),
      ),
  );

  it.live.each(["win32", "linux"] as const)(
    "matches a provider session at the worktree root with host casing rules (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          fixture.setOpenSessionCwd(fixture.worktree.toUpperCase());
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject(
            platform === "win32"
              ? { outcome: "kept", reason: "Provider session is still open" }
              : { outcome: "removed" },
          );
        }),
      ),
  );
});

it.live.each(["new receipt", "legacy receipt"] as const)(
  "keeps a queued checkout when its pull request base is set later (%s), then releases after requeue",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, true);
        fixture.disable();
        const runId = RunId.make("finished");
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          status: "completed",
          latestRunId: runId,
          latestRunCompletedAt: at(-DAY_MS),
          settledAt: at(-DAY_MS),
          settledOverride: "settled",
        });
        fixture.setThreads([owner]);
        const input = {
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        };
        const { file } = yield* queueWorktreeRelease(input);
        if (kind === "legacy receipt") {
          const request = yield* decodeReleaseRequest(yield* fixture.fs.readFileString(file));
          const { branchBase, ...legacy } = request;
          void branchBase;
          yield* fixture.fs.writeFileString(file, yield* encodeRequest(legacy));
        }
        yield* fixture.command(fixture.repo, [
          "config",
          "--local",
          "branch.feature.t3-merge-base",
          "main",
        ]);
        const held = yield* fixture.service.runNow;
        expect(held.entries.find((entry) => entry.threadId === owner.id)).toMatchObject({
          outcome: "kept",
          reason:
            kind === "legacy receipt"
              ? "The release receipt predates base recording; queue the release again"
              : "The recorded pull request base changed",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        yield* queueWorktreeRelease(input);
        const released = yield* fixture.service.runNow;
        expect(released.entries.find((entry) => entry.threadId === owner.id)).toMatchObject({
          outcome: "removed",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
);

it.live("releases a legacy receipt when no pull request base exists", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture(undefined, true);
      fixture.disable();
      const runId = RunId.make("finished");
      const owner = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        status: "completed",
        latestRunId: runId,
        latestRunCompletedAt: at(-DAY_MS),
        settledAt: at(-DAY_MS),
        settledOverride: "settled",
      });
      fixture.setThreads([owner]);
      const { file } = yield* queueWorktreeRelease({
        stateDir: fixture.config.stateDir,
        threadId: owner.id,
        runId,
        worktreePath: fixture.worktree,
        durableRef: "refs/heads/main",
      });
      const request = yield* decodeReleaseRequest(yield* fixture.fs.readFileString(file));
      const { branchBase, ...legacy } = request;
      void branchBase;
      yield* fixture.fs.writeFileString(file, yield* encodeRequest(legacy));
      expect(
        (yield* fixture.service.runNow).entries.find((entry) => entry.threadId === owner.id),
      ).toMatchObject({ outcome: "removed" });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }),
  ),
);

describe("storage cleanup reports and local file policies", () => {
  it.effect("automatically removes an eligible archived thread checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: at(-DAY_MS),
          }),
        ]);
        yield* fixture.activate(Stream.empty);
        const [report] = yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runCollect,
        );
        yield* fixture.service.drain;
        expect(report).toMatchObject({
          trigger: "automatic",
          counts: { removed: 1, kept: 0, failed: 0 },
          entries: [
            {
              threadId: "thread-1",
              path: fixture.worktree,
              outcome: "removed",
              reason: "Inactive for 30 days",
            },
          ],
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );
  it.live("skips a stored worktree path whose parent is a regular file", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        const legacyRoot = underWorktrees(fixture, `legacy-root`);
        yield* fixture.fs.writeFileString(legacyRoot, "");
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: `${legacyRoot}/stored-workspace` }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([]);
        expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 });
      }),
    ),
  );
  it.live.each([
    "replaced parent",
    "registration remains",
    "branch moved",
    "removed by Git",
    "missing parent",
    "withdrawn before receipt read",
    "withdrawn before receipt rename",
  ] as const)("reconciles a claimed release after interruption (%s)", (state) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let claimed: string | undefined;
        const fixture = yield* cleanupFixture(undefined, true).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              state === "withdrawn before receipt rename" && from === claimed
                ? fs.remove(from).pipe(Effect.andThen(fs.rename(from, to)))
                : fs.rename(from, to),
          }),
        );
        fixture.disable();
        const runId = RunId.make("finished");
        const owner = shell({
          status: "completed",
          branch: "feature",
          worktreePath: fixture.worktree,
          latestRunId: runId,
          latestRunCompletedAt: at(-DAY_MS),
          settledAt: at(-DAY_MS),
        });
        fixture.setThreads([owner]);
        const { file } = yield* queueWorktreeRelease({
          stateDir: fixture.config.stateDir,
          threadId: owner.id,
          runId,
          worktreePath: fixture.worktree,
          durableRef: "refs/heads/main",
        });
        const contents = yield* fixture.fs.readFileString(file);
        yield* fixture.fs.rename(file, file + ".releasing");
        claimed = file + ".releasing";
        const parent = NodePath.dirname(fixture.worktree);
        const moved = NodePath.join(fixture.repo, "original-checkout");
        if (state === "replaced parent") {
          yield* fixture.fs.rename(parent, NodePath.join(fixture.repo, "original-checkout-parent"));
          yield* fixture.fs.writeFileString(parent, "replacement");
        } else if (state === "registration remains") {
          yield* fixture.fs.rename(fixture.worktree, moved);
        } else if (state === "branch moved") {
          yield* fixture.command(fixture.repo, ["worktree", "move", "--", fixture.worktree, moved]);
        } else {
          yield* fixture.command(fixture.repo, ["worktree", "remove", "--", fixture.worktree]);
          if (state === "missing parent") yield* Effect.promise(() => NodeFSP.rmdir(parent));
        }
        if (state === "withdrawn before receipt read")
          fixture.setBeforeRemoval(fs.remove(claimed, { force: true }).pipe(Effect.orDie));

        const report = yield* fixture.service.runNow;
        if (state === "removed by Git" || state === "missing parent") {
          expect(yield* fixture.fs.readFileString(file + ".released")).toBe(contents);
          expect(yield* fixture.fs.exists(file + ".releasing")).toBe(false);
          expect(report.entries).toEqual([]);
          expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 });
          return;
        }
        if (
          state === "withdrawn before receipt read" ||
          state === "withdrawn before receipt rename"
        ) {
          expect(yield* fixture.fs.exists(file + ".releasing")).toBe(false);
          expect(yield* fixture.fs.exists(file + ".released")).toBe(false);
          expect(report.entries).toMatchObject([
            {
              outcome: "kept",
              reason: "Owner withdrew or replaced the release request",
            },
          ]);
          return;
        }
        expect(yield* fixture.fs.readFileString(file + ".releasing")).toBe(contents);
        expect(yield* fixture.fs.exists(file + ".released")).toBe(false);
        if (state === "replaced parent")
          expect(yield* fixture.fs.readFileString(parent)).toBe("replacement");
        if (state === "branch moved") {
          expect((yield* fixture.command(moved, ["branch", "--show-current"])).stdout.trim()).toBe(
            "feature",
          );
          expect(yield* fixture.fs.readFileString(NodePath.join(moved, "tracked.txt"))).toBe(
            "original\n",
          );
        }
        expect(report.entries).toMatchObject([
          {
            threadId: owner.id,
            outcome: "kept",
            reason:
              state === "replaced parent"
                ? "Cannot resolve checkout for release request"
                : state === "branch moved"
                  ? "Git lists the requested branch under a different path spelling. Check git worktree list --porcelain for a moved checkout or path alias"
                  : "Git still lists the missing checkout path. Inspect its registration with git worktree list --porcelain",
          },
        ]);
      }),
    ),
  );
  it.live.each(["before-check", "while-measuring"] as const)(
    "keeps a worktree protected by a missing project root (%s)",
    (timing) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          if (timing === "before-check")
            fixture.setProjectRoots([fixture.repo, `${fixture.worktree}/removed-checkout`]);
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          if (timing === "while-measuring") {
            yield* Deferred.await(fixture.measuring);
            fixture.setProjectRoots([fixture.repo, `${fixture.worktree}/removed-checkout`]);
          }
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Contains a project checkout",
          });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
            "original\n",
          );
        }),
      ),
  );

  it.live("reports allocated bytes of single-link files without following symlinks", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          allocatedBytes(fs, `${worktree}/${name}`),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.writeFileString(`${outside}/store-file`, "shared ".repeat(10_000));
        yield* fs.makeDirectory(`${worktree}/node_modules/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/node_modules/nested/file`, "count me");
        sizes.push(yield* allocatedBytes(fs, `${worktree}/node_modules/nested/file`));
        yield* fs.link(`${outside}/store-file`, `${worktree}/node_modules/hardlinked`);
        yield* fs.symlink(outside, `${worktree}/node_modules/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/node_modules/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/node_modules/dangling-link`);
        const report = yield* service.runNow;
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes, files: null });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
        expect(yield* fs.readFileString(`${outside}/store-file`)).toBe("shared ".repeat(10_000));
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live.each(["same-device", "other-device", "no-manifest"] as const)(
    "counts the pnpm virtual store only when its store forces copies (%s)",
    (store) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "pnpm-store-" });
          const statted: string[] = [];
          const { service, worktree, setPolicy } = yield* cleanupFixture().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: (target) => {
                statted.push(target);
                return fs
                  .stat(target)
                  .pipe(
                    Effect.map((info) =>
                      store === "other-device" && target === storeDir
                        ? { ...info, dev: info.dev + 1n }
                        : info,
                    ),
                  );
              },
            }),
          );
          setPolicy("tracked-changes");
          const nodeModules = NodePath.join(worktree, "node_modules");
          yield* fs.makeDirectory(`${nodeModules}/.pnpm/pkg@1.0.0`, { recursive: true });
          yield* fs.makeDirectory(`${nodeModules}/.vite`);
          yield* fs.writeFileString(
            `${nodeModules}/.pnpm/pkg@1.0.0/index.js`,
            "clone ".repeat(10_000),
          );
          yield* fs.writeFileString(`${nodeModules}/.vite/deps.js`, "cache");
          if (store !== "no-manifest")
            yield* fs.writeFileString(
              `${nodeModules}/.modules.yaml`,
              JSON.stringify({ storeDir, virtualStoreDir: ".pnpm" }),
            );
          const counted = [
            ...(yield* fs.readDirectory(worktree)).flatMap((name) =>
              name === "node_modules" ? [] : [`${worktree}/${name}`],
            ),
            `${nodeModules}/.vite/deps.js`,
            ...(store === "no-manifest" ? [] : [`${nodeModules}/.modules.yaml`]),
            ...(store === "same-device" ? [] : [`${nodeModules}/.pnpm/pkg@1.0.0/index.js`]),
          ];
          const bytes = (yield* Effect.forEach(counted, (file) => allocatedBytes(fs, file))).reduce(
            (sum, size) => sum + size,
            0,
          );
          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes });
          expect(statted.includes(storeDir)).toBe(store !== "no-manifest");
        }),
      ),
  );
  // An agent can write this manifest. Statting its store sent the Windows
  // user's NTLM credentials to attacker.test during a background sweep.
  it.live.each([
    { storeDir: "\\\\attacker.test\\s" },
    { storeDir: "/local/store", virtualStoreDir: "//attacker.test/s" },
  ])("never stats a network pnpm store %o", (manifest) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statted: Array<string> = [];
        const { service, worktree, setPolicy } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (target) => {
              statted.push(target);
              return fs.stat(target);
            },
          }),
        );
        setPolicy("tracked-changes");
        yield* fs.makeDirectory(`${worktree}/node_modules`);
        yield* fs.writeFileString(
          `${worktree}/node_modules/.modules.yaml`,
          JSON.stringify(manifest),
        );
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(statted.filter((target) => target.includes("attacker.test"))).toEqual([]);
      }),
    ),
  );
  it.effect.each(["progressing", "stalled"] as const)(
    "bounds a %s inspection by its filesystem progress",
    (scenario) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const entered = yield* Effect.forEach([0, 1], () => Deferred.make<void>());
          const resume = yield* Effect.forEach([0, 1], () => Deferred.make<void>());
          const directories: string[] = [];
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: (directory, options) =>
                Effect.gen(function* () {
                  const index = directories.indexOf(directory);
                  if (index >= 0) {
                    yield* Deferred.succeed(entered[index]!, undefined);
                    yield* Deferred.await(resume[index]!);
                  }
                  return yield* fs.readDirectory(directory, options);
                }),
            }),
          );
          directories.push(fixture.worktree, NodePath.join(fixture.worktree, "nested"));
          yield* fs.makeDirectory(directories[1]!);
          yield* TestClock.setTime(NOW_MS);
          const sweep = yield* fixture.service.runNow.pipe(Effect.forkChild);
          for (const index of [0, 1]) {
            yield* Deferred.await(entered[index]!);
            yield* TestClock.adjust(
              index === 1 && scenario === "stalled" ? "31 seconds" : "18 seconds",
            );
            yield* Deferred.succeed(resume[index]!, undefined);
          }
          expect((yield* Fiber.join(sweep)).entries[0]?.outcome).toBe(
            scenario === "stalled" ? "kept" : "removed",
          );
        }),
      ),
  );
  it.live("keeps a worktree when the inspection cannot read its directories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Worktree could not be fully inspected",
          bytes: null,
          files: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live.each([
    [
      "its owner's branch is cleared",
      (worktree: string) => [shell({ branch: null, worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its owner's branch changes",
      (worktree: string) => [shell({ branch: "other", worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its thread starts",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree, status: "running" }),
      ],
    ],
    [
      "another thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
      ],
    ],
    [
      "an archived thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({
          id: ThreadId.make("thread-2"),
          branch: "feature",
          worktreePath: worktree,
          archivedAt: at(-DAY_MS),
        }),
      ],
    ],
  ] as const)("keeps a worktree when %s during size measurement", ([, threadsWhileMeasuring]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const { fs, worktree } = fixture;
        fixture.setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads(threadsWhileMeasuring(worktree));
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe("untracked\n");
      }),
    ),
  );
  it.live("does not measure a worktree kept for an open provider session", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const walked: Array<string> = [];
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) => {
              walked.push(directory);
              return fs.readDirectory(directory, options);
            },
          }),
        );
        const root = yield* fs.realPath(fixture.worktree);
        fixture.setOpenSessionCwd(fixture.worktree);
        const kept = yield* fixture.service.runNow;
        expect(kept.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(walked.filter((directory) => directory.startsWith(root))).toEqual([]);
        fixture.setSessionLive(false);
        const removed = yield* fixture.service.runNow;
        expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
        expect(removed.entries[0]?.bytes).toBeGreaterThan(0);
        expect(walked).toContain(root);
      }),
    ),
  );
  it.live("compares the checked-out branch without a full status", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setThreads, fullStatusCalls } =
          yield* cleanupFixture();
        const changed = { outcome: "kept", reason: "Repository or branch changed" };
        yield* command(worktree, ["checkout", "--detach"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* command(worktree, ["switch", "--orphan", "other"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* command(worktree, ["switch", "-c", "(feature)", "feature"]);
        setThreads([shell({ branch: "(feature)", worktreePath: worktree })]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        yield* command(worktree, ["tag", "feature", "feature"]);
        // Newer Git refuses to create a tag named HEAD, but still reads one.
        yield* command(worktree, ["update-ref", "refs/tags/HEAD", "refs/heads/feature"]);
        yield* command(worktree, ["switch", "feature"]);
        const index = (yield* command(worktree, ["rev-parse", "--git-path", "index"])).stdout;
        yield* fs.writeFileString(`${index.trim()}.lock`, "");
        const locked = (yield* service.runNow).entries[0];
        expect(locked).toMatchObject({
          outcome: "failed",
          projectPath: repo,
          path: worktree,
          threadId: "thread-1",
          threadTitle: "Thread",
        });
        expect(locked?.reason).toContain("Git index is locked");
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("original\n");
        yield* fs.remove(`${index.trim()}.lock`);
        const gitFile = yield* fs.readFileString(`${worktree}/.git`);
        yield* overwriteGitFile(fs, `${worktree}/.git`, "gitdir: /missing-git-directory\n");
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* overwriteGitFile(fs, `${worktree}/.git`, gitFile);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(fullStatusCalls()).toBe(0);
      }),
    ),
  );
  it.live.each([
    ["any-local-files", ".env", "kept"],
    ["uncommitted-changes", ".env", "removed"],
    ["tracked-changes", ".env", "removed"],
    ["any-local-files", "notes.txt", "kept"],
    ["uncommitted-changes", "notes.txt", "kept"],
    ["tracked-changes", "notes.txt", "removed"],
    ["any-local-files", "tracked.txt", "kept"],
    ["uncommitted-changes", "tracked.txt", "kept"],
    ["tracked-changes", "tracked.txt", "kept"],
  ] as const)("applies %j", ([policy, file, outcome]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          allocatedBytes(fs, `${worktree}/${name}`),
        );
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        const report = yield* service.runNow;
        yield* service.drain;
        expect(report.trigger).toBe("manual");
        expect(report.entries.filter((entry) => entry.kind === "worktree")).toMatchObject([
          {
            outcome,
            path: worktree,
            threadId: "thread-1",
            threadTitle: "Thread",
            bytes: outcome === "removed" ? bytes : null,
            files: null,
          },
        ]);
        expect(report.bytesFreed).toBe(outcome === "removed" ? bytes : 0);
        expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        expect(yield* service.latestReport).toEqual(report);
        if (outcome === "kept")
          expect(report.entries[0]?.reason).toContain(
            file === ".env" ? "ignored files (.env)" : "uncommitted changes (1 file)",
          );
      }),
    ),
  );
  it.live.each([
    ["unchanged", "removed", "No commits beyond the project branch"],
    ["unmerged", "kept", "Has commits beyond the project branch"],
    ["detached", "kept", "Project branch is unavailable"],
    ["merged-only", "kept", "No remote is configured for merged-worktree cleanup"],
  ] as const)("cleans archived local-only worktrees: %s", ([state, outcome, reason]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setThreads } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: state !== "merged-only",
          worktreeOnMerge: true,
        });
        yield* command(repo, ["branch", "-m", "main", "trunk"]);
        setThreads([shell({ branch: "feature", worktreePath: worktree, archivedAt: at(-DAY_MS) })]);
        if (state === "unmerged") {
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "unmerged work\n");
          yield* command(worktree, ["commit", "-am", "unmerged work"]);
        }
        if (state === "detached") yield* command(repo, ["checkout", "--detach"]);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome, reason });
        expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        expect(
          (yield* command(repo, ["show-ref", "--verify", "refs/heads/feature"])).stdout,
        ).not.toBe("");
      }),
    ),
  );
  it.live(
    "discovers trunk without a remote HEAD or tracking ref and removes an integrated worktree",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* command(repo, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
          expect((yield* command(repo, ["for-each-ref", "refs/remotes/origin"])).stdout).toBe("");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "removed",
            reason: "Its changes are on the default branch",
          });
          expect(yield* fs.exists(worktree)).toBe(false);
        }),
      ),
  );
  it.live.each([
    ["cherry-picked", "removed", "Its changes are on the default branch"],
    ["cherry-picked with an extra commit", "kept", "Has commits beyond the default branch"],
  ] as const)(
    "a worktree whose commit reached the default branch by %s is %s",
    ([state, outcome, reason]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "main"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "shipped work\n");
          yield* command(worktree, ["commit", "-am", "shipped work"]);
          const shipped = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
          // The default branch moves first, so the pick gets a SHA of its own.
          yield* fs.writeFileString(`${repo}/other.txt`, "other\n");
          yield* command(repo, ["add", "other.txt"]);
          yield* command(repo, ["commit", "-m", "other"]);
          yield* command(repo, ["cherry-pick", shipped]);
          yield* command(repo, ["push", "origin", "main:main"]);
          yield* command(repo, ["fetch", "origin"]);
          yield* command(repo, ["remote", "set-head", "origin", "main"]);
          if (state !== "cherry-picked") {
            yield* fs.writeFileString(`${worktree}/extra.txt`, "extra\n");
            yield* command(worktree, ["add", "extra.txt"]);
            yield* command(worktree, ["commit", "-m", "extra"]);
          }

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({ outcome, reason });
          expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        }),
      ),
  );
  it.live(
    "keeps worktree commits present on nondefault main but absent from advertised trunk",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "unmerged work\n");
          yield* command(worktree, ["commit", "-am", "unmerged work"]);
          yield* command(repo, ["push", "origin", "feature:main"]);
          expect(
            (yield* command(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Has commits beyond the default branch",
          });
          expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("unmerged work\n");
        }),
      ),
  );
  it.live("keeps the worktree when the remote default is unavailable even if main exists", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: true,
        });
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "trunk"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        // The remote HEAD names an unborn trunk; main exists but is not its default.
        yield* command(repo, ["push", "origin", "main"]);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Default branch is unavailable",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("keeps the worktree and reports the failure when the unmerged-commit count fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: true,
        });
        const { service, fs, repo, worktree, command } = fixture;
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "main"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "shipped work\n");
        yield* command(worktree, ["commit", "-am", "shipped work"]);
        yield* command(repo, ["push", "origin", "main:main"]);
        yield* command(repo, ["fetch", "origin"]);
        yield* command(repo, ["remote", "set-head", "origin", "main"]);
        fixture.failUnmergedCount(true);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed" });
        expect(report.entries[0]?.reason).toContain("branch is unreadable");
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        yield* fixture.fs.writeFileString(`${fixture.worktree}/notes.txt`, "untracked\n");
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(report.entries[0]?.reason).toContain("contains modified or untracked files");
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
        expect(yield* fixture.fs.exists(`${fixture.worktree}/notes.txt`)).toBe(false);
      }),
    ),
  );
  it.live("caps entries while preserving totals and prioritizing removals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture();
        const threads = [];
        for (let i = 0; i < 205; i++) {
          const worktreePath = `${worktree}-${i}`;
          yield* fs.makeDirectory(worktreePath);
          threads.push(
            shell({
              id: ThreadId.make(`thread-${i + 2}`),
              branch: "feature",
              worktreePath,
              status: "running",
            }),
          );
        }
        threads.push(shell({ branch: "feature", worktreePath: worktree }));
        setThreads(threads);
        const report = yield* service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(report.omittedCount).toBe(6);
        expect(report.counts).toEqual({ removed: 1, kept: 205, failed: 0 });
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(report.entries[0]?.bytes).toBeGreaterThan(0);
        expect(report.bytesFreed).toBe(report.entries[0]?.bytes);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live.each([
    ["any-local-files", "untracked", "Local changes exceed the inspection limit"],
    ["uncommitted-changes", "untracked", "Local changes exceed the inspection limit"],
    ["any-local-files", "ignored", "Ignored files exceed the inspection limit"],
  ] as const)(
    "keeps a worktree under %s when its %s file listing exceeds the inspection limit",
    ([policy, kind, reason]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
          setPolicy(policy);
          const files = Array.from({ length: 3000 }, (_, i) =>
            kind === "untracked"
              ? `${worktree}/many/untracked-file-with-a-long-name-${i}.txt`
              : `${worktree}/many/ignored-directory-with-a-long-name-${i}/.env`,
          );
          yield* fs.makeDirectory(`${worktree}/many`);
          yield* Effect.forEach(
            files,
            (file) =>
              Effect.gen(function* () {
                if (kind === "ignored") yield* fs.makeDirectory(file.slice(0, -"/.env".length));
                yield* fs.writeFileString(file, "local\n");
              }),
            { concurrency: 64, discard: true },
          );
          expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept", reason });
          expect(yield* fs.exists(files[0]!)).toBe(true);
        }),
      ),
  );
  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture();
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports.flatMap((report) => report.entries).filter((entry) => entry.kind === "worktree"),
        ).toMatchObject([{ outcome: "removed" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
        disable();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          const file = config.browserArtifactsDir + "/" + name;
          yield* fs.writeFileString(file, "capture");
          yield* fs.utimes(file, 1, 1);
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          const file = config.logsDir + "/" + name;
          yield* fs.writeFileString(file, "log");
          yield* fs.utimes(file, 1, 1);
        }
        const report = yield* service.runNow;
        expect(report.entries.filter((entry) => entry.kind !== "worktree")).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(config.logsDir + "/server.log")).toBe(true);
        expect(yield* fs.exists(config.logsDir + "/server.log.1")).toBe(false);
        expect(yield* fs.exists(config.logsDir + "/server.log.2")).toBe(false);
      }),
    ),
  );
  it.live.each([
    { linked: "home", outcome: "removed", reason: "Removed 1 rotated logs" },
    { linked: "logs folder", outcome: "kept", reason: "No expired files" },
  ] as const)(
    "rotated logs behind a symlinked $linked are $outcome",
    ({ linked, outcome, reason }) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const disk = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          yield* fs.makeDirectory(`${disk}/real/logs`, { recursive: true });
          if (linked === "home") {
            yield* fs.symlink(`${disk}/real`, `${disk}/home`);
          } else {
            yield* fs.makeDirectory(`${disk}/home`);
            yield* fs.symlink(`${disk}/real/logs`, `${disk}/home/logs`);
          }
          yield* fs.writeFileString(`${disk}/real/logs/server.log.1`, "log");
          yield* fs.utimes(`${disk}/real/logs/server.log.1`, 1, 1);
          const { service, enableFiles, disable } = yield* cleanupFixture().pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              logsDir: `${disk}/home/logs`,
            }),
          );
          disable();
          enableFiles();
          const report = yield* service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "logs")).toMatchObject([
            { outcome, reason },
          ]);
          expect(yield* fs.exists(`${disk}/real/logs/server.log.1`)).toBe(outcome === "kept");
        }),
      ),
  );
  it.live("reports git failures without aborting the remaining categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, worktree, command, enableFiles } = yield* cleanupFixture();
        enableFiles();
        yield* command(worktree, ["worktree", "lock", worktree]);
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed" });
        expect(report.entries[0]?.reason).toContain("git worktree remove: fatal:");
        expect(report.entries.map((entry) => entry.kind)).toEqual([
          "worktree",
          "browser-artifacts",
          "logs",
        ]);
      }),
    ),
  );
});

describe("settled worktree rechecks", () => {
  it.live.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "keeps a usage-limited checkout when %s is enabled during measurement",
    (preference) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          fixture.setSettings({ autoResumeLimitedThreads: false, snoozeLimitedThreads: false });
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              status: "failed",
              latestRunId: RunId.make("limited-run"),
              lastErrorClass: "usage_limit",
              usageLimitResetAt: DateTime.formatIso(at(DAY_MS)),
            }),
          ]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setSettings({ [preference]: true });
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.outcome).toBe("kept");
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live.each([{ settledAt: null }, { settledAt: at(DAY_MS) }])(
    "keeps a checkout changed during measurement (%j)",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const thread = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(0),
          });
          fixture.setSettings({
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeSettledAfterDays: 0,
            },
          });
          fixture.setThreads([thread]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setThreads([{ ...thread, ...change }]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.reason).toBe(
            "Thread activity or shared worktree changed since check",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

it.live("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeSettledAfterDays: 0 },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      const storeDir = `${fixture.config.stateDir}/${SCAN_CACHE_DIRECTORY_NAME}`;
      yield* fixture.fs.makeDirectory(storeDir, { recursive: true });
      const cachePath = `${storeDir}/00000000-0000-4000-8000-000000000000-1.json`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);
