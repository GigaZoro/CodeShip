import { GitCommandError, SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsUnmergedWorkResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    | "latestUserAuthoredMessageAt"
    | "startedByScheduledTask"
    | "hasPendingScheduledWork"
    | "parentWorktreePath"
    | "parentResultAt"
    | "parentResultKey"
  >;

function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
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
    latestUserAuthoredMessageAt: overrides.latestUserMessageAt ?? null,
    startedByScheduledTask: false,
    hasPendingScheduledWork: false,
    parentWorktreePath: null,
    parentResultAt: null,
    parentResultKey: null,
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

function persistedLink(
  state: "open" | null,
  linkedAt: DateTime.Utc,
): NonNullable<SettlementShell["pullRequests"]>[number] {
  return {
    host: "example.test",
    repository: "owner/repository",
    number: 42,
    url: "https://example.test/owner/repository/pull/42",
    source: "manual",
    linkedAt: DateTime.formatIso(linkedAt),
    snapshot:
      state === null
        ? null
        : {
            state,
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: DateTime.formatIso(linkedAt),
            syncedAt: DateTime.formatIso(linkedAt),
          },
    stack: null,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("settles a thread whose only background work is a command left running", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("never settles, or keeps snoozed, a thread whose guest is waiting on the owner", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ pendingGuestMessageCount: 1 }),
        NOW_MS,
      ),
    ).toBe(false);
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
      pendingGuestMessageCount: 1,
    });
    expect(ThreadSettlementService.isSnoozed(snoozed, NOW_MS)).toBe(false);
  });

  it("keeps snoozed threads parked until a fresh failure or timer wake", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, snoozedUntil: at(-1) }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe("dropExpiredHolds", () => {
  it("drops only the holds that have run out", () => {
    const holds = new Map([
      ["expired", 1_000],
      ["ends-now", 2_000],
      ["running", 3_000],
    ]);
    ThreadSettlementService.dropExpiredHolds(holds, 2_000);
    expect([...holds.keys()]).toEqual(["running"]);
  });
});

describe("resolveAutoSettlementAt", () => {
  it("settles scheduled threads at completion only when the setting is on and work is clear", () => {
    const thread = shell({
      startedByScheduledTask: true,
      status: "completed",
      latestRunCompletedAt: at(-1),
    });
    const input = {
      thread,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: false,
      autoSettleScheduledThreads: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-1));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        autoSettleScheduledThreads: false,
      }),
    ).toBeNull();
    for (const changes of [
      { startedByScheduledTask: false },
      { status: "failed" as const },
      { hasPendingScheduledWork: true },
      { pinnedAt: at(-10) },
      { pullRequests: [persistedLink("open", at(-10))] },
    ]) {
      expect(
        ThreadSettlementService.resolveAutoSettlementAt({
          ...input,
          thread: { ...thread, ...changes },
        }),
      ).toBeNull();
    }
  });

  it("keeps threads with a PR from inactivity settlement only when asked", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        linkedPullRequest: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repo",
          number: 1,
          url: "https://example.test/owner/repo/pull/1",
        },
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      autoSettleKeepPullRequests: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        autoSettleKeepPullRequests: false,
      }),
    ).toEqual(at(-4 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
      }),
    ).toEqual(at(-4 * DAY_MS));
  });

  it("settles an idle thread with an open persisted link only while retention is off", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        pullRequests: [persistedLink("open", at(-5 * DAY_MS))],
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      autoSettleKeepPullRequests: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-4 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        autoSettleKeepPullRequests: true,
      }),
    ).toBeNull();
    // The open link outranks a merged lookup, so only inactivity can settle it.
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
        autoSettleAfterDays: null,
      }),
    ).toBeNull();
  });

  it("keeps an idle thread whose persisted link was never synced", () => {
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        thread: shell({
          latestUserMessageAt: at(-4 * DAY_MS),
          pullRequests: [persistedLink(null, at(-5 * DAY_MS))],
        }),
        pullRequest: null,
        nowMs: NOW_MS,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
        autoSettleKeepPullRequests: false,
      }),
    ).toBeNull();
  });

  it("uses the latest activity time when the inactivity window elapses", () => {
    const idle = shell({
      latestUserMessageAt: at(-4 * DAY_MS),
      latestRunRequestedAt: at(-4 * DAY_MS),
      latestRunStartedAt: at(-4 * DAY_MS),
      latestRunCompletedAt: at(-3 * DAY_MS),
    });
    const input = {
      thread: idle,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 5 }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
  });

  it("anchors an empty thread's inactivity at its creation time", () => {
    const input = {
      thread: shell({ createdAt: at(-3 * DAY_MS) }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell({ createdAt: at(-DAY_MS) }),
      }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...input.thread, lastSnoozeWakeAt: at(-DAY_MS) },
      }),
    ).toBeNull();
  });

  it.each(["manual", "timer"])("restarts inactivity on a %s snooze wake", (wake) => {
    const thread = {
      ...shell({ latestRunCompletedAt: at(-4 * DAY_MS) }),
      ...(wake === "manual"
        ? { lastSnoozeWakeAt: at(-1_000) }
        : { snoozedAt: at(-3 * DAY_MS), snoozedUntil: at(-1_000) }),
    };
    const input = {
      thread,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 1,
      autoSettleOnMerge: false,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, nowMs: NOW_MS + DAY_MS }),
    ).toEqual(at(-1_000));
  });

  it("settles on merge only after the user's last action and preserves the activity time", () => {
    const thread = shell({
      latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunCompletedAt: at(-90 * 60 * 1_000),
    });
    const input = {
      thread,
      pullRequest: {
        state: "merged" as const,
        mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-90 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleOnMerge: false }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-3 * 60 * 60 * 1_000)) },
      }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell(),
        pullRequest: { state: "closed", closedAt: DateTime.formatIso(at(-1)) },
        autoSettleOnMerge: false,
      }),
    ).toBeNull();
  });

  it("settles on merge after agent-started runs, but not after the user writes again", () => {
    const woken = shell({
      latestUserMessageAt: at(-30 * 60 * 1_000),
      latestUserAuthoredMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunRequestedAt: at(-30 * 60 * 1_000),
      latestRunCompletedAt: at(-29 * 60 * 1_000),
    });
    const input = {
      thread: woken,
      pullRequest: { state: "merged" as const, mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)) },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-29 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...woken, latestUserAuthoredMessageAt: at(-30 * 60 * 1_000) },
      }),
    ).toBeNull();
  });

  it("does not settle on pull requests that were already merged when linked", () => {
    const link = (number: number, linkedAt: DateTime.Utc, mergedAt: DateTime.Utc) => ({
      host: "example.test",
      repository: "owner/repository",
      number,
      url: `https://example.test/owner/repository/pull/${number}`,
      source: "agent" as const,
      linkedAt: DateTime.formatIso(linkedAt),
      snapshot: {
        state: "merged" as const,
        title: "Pull request",
        headBranch: `feature-${number}`,
        baseBranch: "main",
        isDraft: false,
        updatedAt: DateTime.formatIso(mergedAt),
        syncedAt: DateTime.formatIso(linkedAt),
        mergedAt: DateTime.formatIso(mergedAt),
      },
      stack: null,
    });
    const recorded = link(1, at(-50 * 60 * 1_000), at(-55 * 60 * 1_000));
    const input = {
      thread: shell({
        latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
        latestRunCompletedAt: at(-45 * 60 * 1_000),
        pullRequests: [recorded],
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: {
          ...input.thread,
          pullRequests: [recorded, link(2, at(-90 * 60 * 1_000), at(-40 * 60 * 1_000))],
        },
      }),
    ).toEqual(at(-45 * 60 * 1_000));
  });

  it("defers merge settlement while the merged pull request is still watched", () => {
    const watch = {
      startedAt: DateTime.formatIso(at(-50 * 60 * 1_000)),
      headSha: "abc123",
      failedChecks: [],
      passed: true,
      passedChecks: [],
      remarksThrough: DateTime.formatIso(at(-50 * 60 * 1_000)),
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const open = persistedLink("open", at(-60 * 60 * 1_000));
    const merged = {
      ...open,
      snapshot: {
        ...open.snapshot!,
        state: "merged" as const,
        mergedAt: DateTime.formatIso(at(-1_000)),
        syncedAt: DateTime.formatIso(at(-1_000)),
      },
    };
    const input = {
      thread: shell({
        latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
        latestRunCompletedAt: at(-45 * 60 * 1_000),
        pullRequests: [{ ...merged, watch }],
      }),
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...input.thread, pullRequests: [{ ...merged, endedWatch: watch }] },
      }),
    ).toEqual(at(-45 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...input.thread, pullRequests: [merged] },
      }),
    ).toEqual(at(-45 * 60 * 1_000));
    const later = (state: "closed" | "merged") => ({
      ...open,
      number: 43,
      url: "https://example.test/owner/repository/pull/43",
      snapshot: {
        ...open.snapshot!,
        headBranch: "feature-43",
        state,
        [state === "merged" ? "mergedAt" : "closedAt"]: DateTime.formatIso(at(-500)),
        syncedAt: DateTime.formatIso(at(-500)),
      },
    });
    for (const state of ["closed", "merged"] as const) {
      const withLater = (first: ReturnType<typeof persistedLink>) =>
        ThreadSettlementService.resolveAutoSettlementAt({
          ...input,
          thread: { ...input.thread, pullRequests: [first, later(state)] },
        });
      expect(withLater({ ...merged, watch }), `watched merge, later ${state}`).toBeNull();
      expect(withLater({ ...merged, endedWatch: watch }), `ended watch, later ${state}`).toEqual(
        at(-45 * 60 * 1_000),
      );
      expect(withLater(merged), `no watch, later ${state}`).toEqual(at(-45 * 60 * 1_000));
    }
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

describe("autoSettlementSettingsKey", () => {
  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });
});

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(id: string, overrides: Partial<SettlementShell> = {}): SettlementShell {
  return shell({
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    ...overrides,
  });
}

type SettlementSnapshot = Omit<OrchestrationV2ShellSnapshot, "threads"> & {
  readonly threads: ReadonlyArray<SettlementShell>;
};

function makeSnapshot(
  threads: ReadonlyArray<SettlementShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): SettlementSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
  };
}

// The checkout's commits are all in a pull request whose head is WORKTREE_HEAD.
const WORKTREE_HEAD = "worktree-head";
const UNFETCHED_HEAD = "unfetched-head";

function makeBranchPullRequest(state: "open" | "closed" | "merged", headSha = WORKTREE_HEAD) {
  return {
    number: 42,
    title: "Pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "feature",
    state,
    repositoryKey: "example.test/owner/repository",
    updatedAt: NOW,
    closedAt: state === "closed" ? NOW : null,
    mergedAt: state === "merged" ? NOW : null,
    headSha,
  } satisfies GitManager.GitBranchPullRequest;
}

interface HarnessOptions {
  readonly snapshot: SettlementSnapshot;
  readonly settings?: ContractServerSettings;
  readonly branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService.PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly unmergedWork?: VcsUnmergedWorkResult;
  readonly hasPrimaryRemote?: boolean;
  /** Threads only agents or scheduled tasks wrote in; the user wrote in every other thread. */
  readonly unwrittenThreadIds?: ReadonlyArray<ThreadId>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
  readonly onCloseIdle?: () => Effect.Effect<void>;
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const candidateReads = yield* Ref.make<
    ReadonlyArray<{ readonly threadId: string | undefined; readonly background: boolean }>
  >([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReadCount = yield* Ref.make(0);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>
  >([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);
  const stackedActions = yield* Ref.make<ReadonlyArray<GitRunStackedActionInput>>([]);
  const pullRequestLinks = yield* Ref.make<ReadonlyArray<string>>([]);
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const scriptRuns =
    yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"] = (
    input,
    lookupOptions,
  ) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input, lookupOptions) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type === "thread.pull-request.link") {
      return Ref.update(pullRequestLinks, (links) => [...links, command.threadId]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.update(settingsReadCount, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(settings)),
    ),
    updateSettings,
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    updateProjectScripts: () => Effect.die("Unexpected action change"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getSettlementCandidates: (threadId) =>
        Effect.gen(function* () {
          const background = yield* NodeSqliteClient.Background;
          yield* Ref.update(candidateReads, (reads) => [...reads, { threadId, background }]);
        }).pipe(
          Effect.andThen(Ref.updateAndGet(snapshotReadCount, (count) => count + 1)),
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
          Effect.map((snapshot) =>
            threadId === undefined
              ? snapshot.threads
              : snapshot.threads.filter((thread) => thread.id === threadId),
          ),
        ),
      hasUserWrittenMessage: (threadId) =>
        Effect.succeed(!(options.unwrittenThreadIds ?? []).includes(threadId)),
      getThread: (threadId) => {
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents),
      dispatch,
      getThreadShell: (threadId) =>
        Ref.get(snapshots).pipe(
          Effect.map(
            (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
          ),
        ),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedNone,
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      unmergedWork: () =>
        Effect.succeed(
          options.unmergedWork ?? { refName: null, changedFileCount: 0, unmergedCommitCount: 0 },
        ),
      countUnmergedCommits: ({ baseRef }) =>
        baseRef === UNFETCHED_HEAD
          ? Effect.fail(
              new GitCommandError({
                operation: "test.countUnmergedCommits",
                command: "git",
                cwd: "/worktrees/feature",
                detail: "bad revision",
              }),
            )
          : Effect.succeed(baseRef === WORKTREE_HEAD ? 0 : 1),
      localStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: options.hasPrimaryRemote ?? true,
          isDefaultRef: false,
          refName: options.unmergedWork?.refName ?? null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      runStackedAction: (input) =>
        Ref.update(stackedActions, (actions) => [...actions, input]).pipe(
          Effect.as({
            action: input.action,
            branch: { status: "skipped_not_requested" },
            commit: { status: "created" },
            push: { status: "pushed" },
            pr: { status: "created", number: 7, url: "https://github.com/owner/repository/pull/7" },
            toast: { title: "Created pull request", cta: { kind: "none" } },
          } satisfies GitRunStackedActionResult),
        ),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: (input) =>
        Queue.offer(closedIdle, input).pipe(Effect.andThen(options.onCloseIdle?.() ?? Effect.void)),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Queue.offer(scriptRuns, input).pipe(
          Effect.andThen(options.onScriptRun?.(input) ?? Effect.void),
          Effect.as({ status: "no-script" } as const),
        ),
    }),
    Layer.mock(GitManager.GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    settingsReadCount,
    snapshotReads,
    candidateReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    stackedActions,
    pullRequestLinks,
    closedIdle,
    scriptRuns,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    updateSettings,
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: Layer.effect(
      ThreadSettlementService.ThreadSettlementServiceV2,
      ThreadSettlementService.make,
    ).pipe(Layer.provide(layerDependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementService.ThreadSettlementServiceV2["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("skips settings and PR decisions for recent branchless threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const threads = Array.from({ length: 32 }, (_, index) =>
          makeThread(`recent-${index}`, {
            updatedAt: DateTime.makeUnsafe(NOW),
            latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
          }),
        );
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          assert.deepEqual(yield* Ref.get(fixture.commands), []);
          assert.deepEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.equal(yield* Ref.get(fixture.settingsReadCount), 2);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          assert.deepEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set(threads.map((thread) => thread.id)),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("settles a merged pull request stored only in the thread links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("merged-link", {
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
              stack: null,
            },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an idle thread with an open persisted link on the inactivity sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("open-link", {
          pullRequests: [persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"))],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: 3,
            sidebarAutoSettleKeepPullRequests: false,
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("opens a pull request for unmerged worktree work instead of settling it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const unmerged = { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 };
        const pushed = { refName: "feature", changedFileCount: 0, unmergedCommitCount: 2 };
        const cases = [
          { name: "clean", work: undefined, pr: null, settles: true, opensPr: false },
          { name: "no pull request", work: unmerged, pr: null, settles: false, opensPr: true },
          { name: "pushed to open PR", work: pushed, pr: "open", settles: true, opensPr: false },
          // Commits made after the pull request's head are in no pull request yet.
          { name: "ahead of open PR", work: pushed, pr: "open", settles: false, opensPr: true },
          { name: "unfetched open PR", work: pushed, pr: "open", settles: false, opensPr: true },
          { name: "closed PR", work: pushed, pr: "closed", settles: true, opensPr: false },
          // Work made after the user closed the pull request stays in view without a new one.
          {
            name: "ahead of closed PR",
            work: pushed,
            pr: "closed",
            settles: false,
            opensPr: false,
          },
          {
            name: "edited after closed PR",
            work: unmerged,
            pr: "closed",
            settles: false,
            opensPr: false,
          },
          { name: "setting off", work: unmerged, pr: null, settles: false, opensPr: false },
          { name: "no remote", work: unmerged, pr: null, settles: false, opensPr: false },
          // Agents wrote its prompts, so the agent that started it decides how its own worktree's
          // work lands.
          { name: "subagent", work: unmerged, pr: null, settles: false, opensPr: false },
          // Agents and scheduled runs own how their work lands; auto-settle never publishes it.
          { name: "nobody wrote", work: unmerged, pr: null, settles: false, opensPr: false },
        ] as const;
        for (const testCase of cases) {
          const threadId = ThreadId.make(`worktree-${testCase.name}`);
          const thread = makeThread(threadId, {
            branch: "feature",
            worktreePath: "/worktrees/feature",
            ...(testCase.name === "subagent"
              ? {
                  lineage: {
                    parentThreadId: ThreadId.make("parent"),
                    relationshipToParent: "subagent",
                    rootThreadId: ThreadId.make("parent"),
                  },
                }
              : {}),
          });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([thread]),
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: 3,
              sidebarAutoSettleOpensPullRequests: testCase.name !== "setting off",
            },
            existingWorktreePaths: ["/worktrees/feature"],
            ...(testCase.work === undefined ? {} : { unmergedWork: testCase.work }),
            hasPrimaryRemote: testCase.name !== "no remote",
            unwrittenThreadIds:
              testCase.name === "nobody wrote" || testCase.name === "subagent" ? [threadId] : [],
            branchPullRequest: () =>
              Effect.succeed(
                testCase.pr === null
                  ? null
                  : makeBranchPullRequest(
                      testCase.pr,
                      testCase.name.startsWith("ahead of")
                        ? "pull-request-head"
                        : testCase.name === "unfetched open PR"
                          ? UNFETCHED_HEAD
                          : WORKTREE_HEAD,
                    ),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            expect(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              testCase.name,
            ).toEqual(testCase.settles ? [thread.id] : []);
            expect(
              (yield* Ref.get(fixture.stackedActions)).map((input) => input.action),
              testCase.name,
            ).toEqual(testCase.opensPr ? ["commit_push_pr"] : []);
            expect(yield* Ref.get(fixture.pullRequestLinks), testCase.name).toEqual(
              testCase.opensPr ? [thread.id] : [],
            );
          }).pipe(Effect.provide(fixture.layer));
        }
      }),
    ),
  );

  it.effect("settles only the project opted in while environment settlement is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("project-opt-in", {
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const other = makeThread("environment-off", { projectId: ProjectId.make("other-project") });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, other]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleAfterDays: 2 } },
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId)).toEqual([thread.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a closed pull request only in the project whose merge rule is on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const optedIn = makeThread("closed-opted-in", { branch: "feature" });
        const optedOut = makeThread("closed-opted-out", {
          branch: "feature",
          projectId: ProjectId.make("other-project"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([optedIn, optedOut]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
          },
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("closed")),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId)).toEqual([optedIn.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("stops settling the rest of a sweep once auto-settlement is turned off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        // Sweeps settle 8 threads at a time, so the ninth starts after a dispatch turned it off.
        const threads = Array.from({ length: 9 }, (_, index) => makeThread(`idle-${index}`));
        let disable: Effect.Effect<unknown> = Effect.void;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
          onDispatch: () => disable,
        });
        disable = fixture.updateSettings({ sidebarAutoSettleAfterDays: null });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const settled = (yield* Ref.get(fixture.commands)).map((command) => command.threadId);
          expect(settled).not.toContain(threads[8]!.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const mergedThreadSettled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "Owner/Repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a merged thread when its background work ends, during a slow full sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const mergedLink: NonNullable<SettlementShell["pullRequests"]>[number] = {
          ...persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z")),
          snapshot: {
            state: "merged",
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: NOW,
            syncedAt: NOW,
            mergedAt: NOW,
          },
        };
        const waiting = makeThread("waiting-on-subagent", {
          pullRequests: [mergedLink],
          pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
        });
        const slow = makeThread("slow-periodic-lookup", {
          branch: "another-feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([waiting, slow]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([{ ...waiting, pendingBackgroundTasks: [] }, slow]),
          );
          yield* fixture.publishEvent({
            type: "run.background-work-cancelled",
            id: EventId.make("event:background-ended"),
            threadId: waiting.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: { runId: RunId.make("run:waiting"), restartCancelledBackgroundWork: [] },
          });
          yield* Deferred.await(settled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [waiting.id],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a stopped thread while another thread's lookup is slow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const slowLookupStarted = yield* Deferred.make<void>();
        const releaseSlowLookup = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const recent = DateTime.makeUnsafe("2026-08-27T00:00:00.000Z");
        const slow = makeThread("slow-lookup", { branch: "feature", latestUserMessageAt: recent });
        const merged = makeThread("merged", {
          latestUserMessageAt: recent,
          pullRequests: [
            {
              ...persistedLink("open", recent),
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
            },
          ],
          pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([slow, merged]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(slowLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSlowLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });
        const backgroundEnded = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
          type: "run.background-work-cancelled",
          id: EventId.make(`event:background-ended:${threadId}`),
          threadId,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { runId: RunId.make(`run:${threadId}`), restartCancelledBackgroundWork: [] },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(backgroundEnded(slow.id));
          yield* Deferred.await(slowLookupStarted);
          // More events for the slow thread coalesce into one more pass, not more sweeps.
          for (let index = 0; index < 9; index++) {
            yield* fixture.publishEvent(backgroundEnded(slow.id));
          }

          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([slow, { ...merged, pendingBackgroundTasks: [] }]),
          );
          yield* fixture.publishEvent(backgroundEnded(merged.id));
          yield* Deferred.await(settled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [merged.id],
          );
          yield* Deferred.succeed(releaseSlowLookup, undefined);
          yield* reactor.drain;
          // The startup sweep, the first per-thread sweep, and one coalesced rerun.
          assert.strictEqual(yield* Ref.get(branchLookupCount), 3);
          // Only full sweeps read on the background readers, behind other scans.
          assert.deepStrictEqual(
            new Set(
              (yield* Ref.get(fixture.candidateReads)).map(
                (read) => `${read.threadId === undefined ? "full" : "thread"}:${read.background}`,
              ),
            ),
            new Set(["full:true", "thread:false"]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an unlinked branch thread its agent merged from a shell, past the cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const settled = yield* Deferred.make<void>();
        const thread = makeThread("shell-merged", {
          branch: "saved-feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          // The host already merged it; only a fresh read sees that past the cached open lookup.
          branchPullRequest: (_input, lookupOptions) =>
            Effect.succeed(makeBranchPullRequest(lookupOptions?.refresh ? "merged" : "open")),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });
        const at = DateTime.makeUnsafe(NOW);
        const runId = RunId.make("run:shell-merged");
        const runEnded: OrchestrationV2DomainEvent = {
          type: "run.background-work-cancelled",
          id: EventId.make("event:shell-merged:run-ended"),
          threadId: thread.id,
          occurredAt: at,
          payload: { runId, restartCancelledBackgroundWork: [] },
        };

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(runEnded);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishEvent({
            type: "turn-item.updated",
            id: EventId.make("event:shell-merged:command"),
            threadId: thread.id,
            runId,
            occurredAt: at,
            payload: {
              id: TurnItemId.make("item:shell-merged:command"),
              threadId: thread.id,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "command_execution",
              input: "gh pr merge 42 --squash",
            },
          });
          yield* Deferred.await(settled);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [thread.id],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("looks up a merged branch held for unmerged work only once per hold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("held-work", {
          branch: "feature",
          worktreePath: "/worktrees/feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        });
        const lookups: Array<Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1]> =
          [];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOpensPullRequests: false },
          existingWorktreePaths: ["/worktrees/feature"],
          unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
          branchPullRequest: (_input, lookupOptions) =>
            Effect.sync(() => lookups.push(lookupOptions)).pipe(
              Effect.as(makeBranchPullRequest("merged")),
            ),
        });
        const sweepThread = (index: number) =>
          Effect.gen(function* () {
            const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* fixture.publishEvent({
              type: "run.background-work-cancelled",
              id: EventId.make(`event:held-work:${index}`),
              threadId: thread.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: { runId: RunId.make("run:held-work"), restartCancelledBackgroundWork: [] },
            });
            yield* Queue.take(fixture.snapshotReads);
            yield* reactor.drain;
          });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          // The settling lookup and the unmerged-work check read fresh git state before acting.
          expect(lookups).toEqual([
            { refresh: false },
            { freshGitState: true },
            { freshGitState: true },
          ]);
          yield* sweepThread(1);
          expect(lookups).toHaveLength(3);
          yield* TestClock.adjust("1 hour");
          yield* sweepThread(2);
          expect(lookups.length).toBeGreaterThan(3);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("checks a worktree shared by two threads for unmerged work only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const threads = ["shared-a", "shared-b"].map((id) =>
          makeThread(id, { branch: "feature", worktreePath: "/worktrees/feature" }),
        );
        const lookups: Array<Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1]> =
          [];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: 3,
            sidebarAutoSettleOpensPullRequests: false,
          },
          existingWorktreePaths: ["/worktrees/feature"],
          unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
          // The yield stands in for git's I/O, which lets the other thread's check run meanwhile.
          branchPullRequest: (_input, lookupOptions) =>
            Effect.sync(() => lookups.push(lookupOptions)).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.as(null),
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(lookups).toEqual([{ freshGitState: true }]);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "a thread nobody wrote in does not hold back the pull request of one sharing its worktree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          // The scheduled run sorts first, so its check runs before the user's thread every sweep.
          const scheduled = makeThread("shared-scheduled", {
            branch: "feature",
            worktreePath: "/worktrees/feature",
            updatedAt: DateTime.makeUnsafe("2026-08-19T00:00:00.000Z"),
          });
          const written = makeThread("shared-written", {
            branch: "feature",
            worktreePath: "/worktrees/feature",
          });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([scheduled, written]),
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
            existingWorktreePaths: ["/worktrees/feature"],
            unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
            unwrittenThreadIds: [scheduled.id],
          });

          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            // A check of the same worktree in flight keeps the other thread for one sweep at most.
            yield* fixture.publishEvent({
              type: "run.background-work-cancelled",
              id: EventId.make("event:shared-written"),
              threadId: written.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: {
                runId: RunId.make("run:shared-written"),
                restartCancelledBackgroundWork: [],
              },
            });
            yield* Queue.take(fixture.snapshotReads);
            yield* service.drain;
            const openedFor = (yield* Ref.get(fixture.stackedActions)).map(
              (input) => input.threadId,
            );
            expect(new Set(openedFor)).toEqual(new Set([written.id]));
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("checks a thread nobody wrote in again as soon as the settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("unwritten-held", {
          branch: "feature",
          worktreePath: "/worktrees/feature",
        });
        const lookups: Array<Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1]> =
          [];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
          existingWorktreePaths: ["/worktrees/feature"],
          unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
          unwrittenThreadIds: [thread.id],
          branchPullRequest: (_input, lookupOptions) =>
            Effect.sync(() => lookups.push(lookupOptions)).pipe(Effect.as(null)),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(lookups).toEqual([{ freshGitState: true }]);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 2 });
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          expect(lookups).toEqual([{ freshGitState: true }, { freshGitState: true }]);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.stackedActions), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "settles branch threads on a pull request merge without waiting for the next sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const state = yield* Ref.make<"open" | "merged">("open");
          const mergedThreadSettled = yield* Deferred.make<void>();
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("branch-thread", {
                branch: "saved-feature",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              }),
            ]),
            branchPullRequest: () => Ref.get(state).pipe(Effect.map(makeBranchPullRequest)),
            onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);

            yield* Ref.set(state, "merged");
            yield* fixture.publishMerge;
            yield* Deferred.await(mergedThreadSettled);

            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              [ThreadId.make("branch-thread")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), ["/workspace/project"]);
            yield* reactor.drain;
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("a merge does not settle threads linked to an unrelated pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const mergedThreadSettled = yield* Deferred.make<void>();
        const mergeLookupStarted = yield* Deferred.make<void>();
        const releaseMergeLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated-linked", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 99,
                url: "https://example.test/owner/repository/pull/99",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 3 ? Deferred.succeed(mergeLookupStarted, undefined) : Effect.void,
              ),
              Effect.tap((count) =>
                count === 3 ? Deferred.await(releaseMergeLookup) : Effect.void,
              ),
              Effect.map(() => makePullRequestSummary({ ...input, state: "open" })),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergeLookupStarted);
          yield* Deferred.await(mergedThreadSettled);
          yield* Deferred.succeed(releaseMergeLookup, undefined);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls))
              .map((call) => call.number)
              .toSorted((left, right) => left - right),
            [42, 99, 99],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  describe("delegated children", () => {
    const nowMs = Date.parse(NOW);
    const minutesAgo = (minutes: number) => DateTime.makeUnsafe(nowMs - minutes * 60_000);
    const parentId = ThreadId.make("parent");
    const resultAt = minutesAgo(1);
    const ranAt = minutesAgo(2);
    // A delegate_task child in its parent's worktree whose run produced the parent's result.
    const child = (id: string, overrides: Partial<SettlementShell> = {}) =>
      makeThread(id, {
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        },
        createdBy: "agent",
        creationSource: "mcp",
        worktreePath: "/worktrees/parent",
        parentWorktreePath: "/worktrees/parent",
        updatedAt: resultAt,
        latestUserMessageAt: minutesAgo(10),
        latestRunId: RunId.make(`run:${id}`),
        latestRunRequestedAt: minutesAgo(10),
        latestRunStartedAt: minutesAgo(10),
        latestRunCompletedAt: ranAt,
        status: "completed",
        parentResultAt: resultAt,
        parentResultKey: `task:${id}:hash`,
        ...overrides,
      });
    const delivered = child("delivered");
    const native = child("native", {
      creationSource: "provider",
      latestUserMessageAt: null,
      latestRunId: null,
      latestRunRequestedAt: null,
      latestRunStartedAt: null,
      latestRunCompletedAt: null,
      status: "idle",
    });
    // The parent's latest task on these has no result, or the child ran again after it.
    const keptActive = [
      child("failed", { status: "failed", parentResultAt: null, parentResultKey: null }),
      child("interrupted", { status: "interrupted", parentResultAt: null, parentResultKey: null }),
      child("ran-again", { latestRunCompletedAt: DateTime.makeUnsafe(nowMs) }),
      child("waiting", {
        status: "waiting",
        activityRunStatus: "waiting",
        latestRunCompletedAt: null,
      }),
      child("queued", { status: "queued", latestRunCompletedAt: null }),
      child("own-worktree", { worktreePath: "/worktrees/own" }),
    ];

    it.effect("settles children whose parent holds their result and keeps the rest active", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(nowMs);
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([delivered, native, ...keptActive]),
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
            existingWorktreePaths: ["/worktrees/parent", "/worktrees/own"],
            // The parent's worktree has work to land; it, not its children, keeps it in view.
            unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
            unwrittenThreadIds: [delivered, native, ...keptActive].map((thread) => thread.id),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            const settled = (yield* Ref.get(fixture.commands)).map((command) => ({
              threadId: command.threadId,
              settledAt: command.settledAt,
              parentResultKey: command.parentResultKey,
              rule: command.commandId.split(":").slice(0, 2).join(":"),
            }));
            const onResult = { rule: "server:settle-delivered-child" };
            expect(
              settled.toSorted((left, right) => left.threadId.localeCompare(right.threadId)),
            ).toEqual([
              {
                threadId: delivered.id,
                settledAt: ranAt,
                parentResultKey: "task:delivered:hash",
                ...onResult,
              },
              {
                threadId: native.id,
                settledAt: resultAt,
                parentResultKey: "task:native:hash",
                ...onResult,
              },
            ]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );

    it.effect("keeps a delivered own-worktree child active without any pull request work", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(nowMs);
          const own = child("own-delivered", { worktreePath: "/worktrees/own" });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([own]),
            // The user wrote in the thread and the setting is on, so only the delivery rule can stop it.
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: 3,
              sidebarAutoSettleOpensPullRequests: true,
            },
            existingWorktreePaths: ["/worktrees/own"],
            unmergedWork: { refName: "feature", changedFileCount: 1, unmergedCommitCount: 2 },
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.stackedActions), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );

    it.effect("settles a child on its result while automatic settlement is off", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(nowMs);
          const idle = makeThread("idle-branch", { branch: "feature" });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([idle, delivered]),
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: null,
              sidebarAutoSettleOnMerge: false,
            },
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
              delivered.id,
            ]);
            assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );

    it.effect("settles a child as soon as its parent records the result", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(nowMs);
          const waiting = child("awaiting-result", { parentResultAt: null, parentResultKey: null });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([waiting]),
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            yield* Ref.set(
              fixture.snapshots,
              makeSnapshot([
                {
                  ...waiting,
                  parentResultAt: resultAt,
                  parentResultKey: "task:awaiting-result:hash",
                },
              ]),
            );
            yield* fixture.publishEvent({
              type: "subagent.updated",
              id: EventId.make("event:task-completed"),
              threadId: parentId,
              runId: RunId.make("run:parent"),
              nodeId: NodeId.make("node:task"),
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              occurredAt: resultAt,
              payload: {
                id: NodeId.make("node:task"),
                threadId: parentId,
                runId: RunId.make("run:parent"),
                parentNodeId: NodeId.make("node:parent"),
                origin: "app_owned",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId: null,
                childThreadId: waiting.id,
                nativeTaskRef: null,
                prompt: "Do the work",
                title: "Task",
                model: null,
                status: "completed",
                result: "Done",
                startedAt: minutesAgo(10),
                completedAt: resultAt,
                updatedAt: resultAt,
              },
            });
            yield* Queue.take(fixture.snapshotReads);
            yield* service.drain;
            expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
              waiting.id,
            ]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );
  });
});

describe("ThreadSettlementServiceV2 terminals", () => {
  const appThread = (
    id: string,
    settledOverride: OrchestrationV2AppThread["settledOverride"],
    worktreePath: string | null = null,
  ): OrchestrationV2AppThread => {
    const threadId = ThreadId.make(id);
    return {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: PROJECT_ID,
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      archivedAt: null,
      settledOverride,
      settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };
  const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
    type: "thread.settled",
    id: EventId.make(`event:settled:${thread.id}`),
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: thread,
  });

  it.effect("keeps the terminals of a thread re-engaged before the event ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaged-thread", "settled");
        const reengaged = appThread("reengaged-thread", "active");
        const marker = appThread("marker-thread", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [reengaged, marker],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script in the thread's own worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = appThread("shared-checkout-thread", "settled");
        const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
        const parent = appThread("parent-thread", "active", "/worktrees/parent");
        const inParentWorktree = (
          id: string,
          lineage: Pick<OrchestrationV2AppThread["lineage"], "relationshipToParent" | "sideChat">,
        ): OrchestrationV2AppThread => ({
          ...appThread(id, "settled", "/worktrees/parent"),
          lineage: { parentThreadId: parent.id, rootThreadId: parent.id, ...lineage },
        });
        // The parent still works in this worktree, so its children leave the settle action to it.
        const subagent = inParentWorktree("subagent-thread", { relationshipToParent: "subagent" });
        const sideChat = inParentWorktree("side-chat-thread", {
          relationshipToParent: "fork",
          sideChat: true,
        });
        const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [shared, missing, parent, subagent, sideChat, worktree],
          existingWorktreePaths: ["/worktrees/thread", "/worktrees/parent"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(shared));
          yield* fixture.publishEvent(settledEvent(missing));
          yield* fixture.publishEvent(settledEvent(subagent));
          yield* fixture.publishEvent(settledEvent(sideChat));
          yield* fixture.publishEvent(settledEvent(worktree));
          const run = yield* Queue.take(fixture.scriptRuns);
          assert.strictEqual(run.threadId, worktree.id);
          assert.strictEqual(run.worktreePath, "/worktrees/thread");
          assert.strictEqual(run.trigger, "settle");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the settle script for a thread re-engaged while its shells close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaging-thread", "settled", "/worktrees/reengaging");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const currentThreads = [settled, marker];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads,
          existingWorktreePaths: ["/worktrees/reengaging", "/worktrees/marker"],
          onCloseIdle: () =>
            Effect.sync(() => {
              currentThreads[0] = { ...settled, settledOverride: "active" };
            }),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script once when a settlement is re-emitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repeated = appThread("repeated-thread", "settled", "/worktrees/repeated");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [repeated, marker],
          existingWorktreePaths: ["/worktrees/repeated", "/worktrees/marker"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, repeated.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retries the settle script on a re-emitted settlement after a failed start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("failed-start-thread", "settled", "/worktrees/failed-start");
        const starts = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [thread],
          existingWorktreePaths: ["/worktrees/failed-start"],
          onScriptRun: () =>
            Ref.updateAndGet(starts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.die(new Error("terminal failed to open")) : Effect.void,
              ),
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(thread));
          yield* fixture.publishEvent(settledEvent(thread));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("isSnoozed", () => {
  const snoozed = { snoozedAt: at(-2 * DAY_MS), snoozedUntil: at(DAY_MS) };
  it("keeps a run requested and completed after snoozing parked until the timer", () => {
    const thread = shell({
      ...snoozed,
      status: "completed",
      latestRunRequestedAt: at(-2 * DAY_MS + 1),
      latestRunStartedAt: at(-DAY_MS - 1),
      latestRunCompletedAt: at(-DAY_MS),
    });

    expect(ThreadSettlementService.isSnoozed(thread, NOW_MS)).toBe(true);
    expect(ThreadSettlementService.isAutoSettlementCandidate(thread, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        thread,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-1)) },
        nowMs: NOW_MS,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBeNull();
  });
});
