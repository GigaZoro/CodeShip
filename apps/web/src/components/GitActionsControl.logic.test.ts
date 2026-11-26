import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  buildMenuItems,
  resolveQuickAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  type DefaultBranchConfirmableAction,
} from "@t3tools/client-runtime/state/vcs";
import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { assert, describe, it } from "vite-plus/test";
import {
  hasUsableGitMenuContent,
  resolveChangesTotals,
  resolveLiveThreadBranchUpdate,
} from "./GitActionsControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const webSurface = { publishesRepository: true, opensChangeRequest: false };

function gitState(gitStatus: VcsStatusResult, isBusy = false) {
  return { gitStatus, isBusy, canWrite: true, surface: webSurface };
}

function pushDisabledReason(gitStatus: VcsStatusResult): string | null {
  const item = buildMenuItems(gitState(gitStatus)).find((menuItem) => menuItem.id === "push");
  assert.isDefined(item);
  return item.disabledReason;
}

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      gitState(
        status({
          aheadCount: 3,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        }),
      ),
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(gitState(syncedFeature));
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(gitState(syncedFeature));
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(gitState(dirtyFeature)).find((item) => item.id === "pr")?.disabled,
      false,
    );
    assert.equal(pushDisabledReason(dirtyFeature), "No local commits to push.");
  });

  it("offers the actions menu only when something in it is usable", () => {
    const hasContent = (
      gitStatus: VcsStatusResult,
      overrides: Partial<Parameters<typeof hasUsableGitMenuContent>[0]> = {},
    ) =>
      hasUsableGitMenuContent({
        menuItems: buildMenuItems(gitState(gitStatus)),
        canWriteSourceControl: true,
        canPublishRepository: false,
        hasNotice: false,
        ...overrides,
      });
    const clean = status();
    const dirty = status({ hasWorkingTreeChanges: true });

    assert.isFalse(hasContent(clean));
    assert.isTrue(hasContent(dirty));
    assert.isTrue(hasContent(status({ aheadCount: 1 })));
    assert.isFalse(hasContent(dirty, { canWriteSourceControl: false }));
    assert.isTrue(hasContent(status({ hasPrimaryRemote: false }), { canPublishRepository: true }));
    assert.isTrue(hasContent(clean, { hasNotice: true }));
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      gitState({ ...status({ refName: "main", hasWorkingTreeChanges: true }), isDefaultRef: true }),
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("resolveQuickAction pushes without committing when the tree is clean and ahead", () => {
    const withUpstream = resolveQuickAction(
      gitState({ ...status({ refName: "main", aheadCount: 1 }), isDefaultRef: true }),
    );
    assert.deepInclude(withUpstream, { kind: "run_action", action: "push", label: "Push" });

    const withoutUpstream = resolveQuickAction(
      gitState({
        ...status({ refName: "main", aheadCount: 1, hasUpstream: false }),
        isDefaultRef: true,
      }),
    );
    assert.deepInclude(withoutUpstream, { kind: "run_action", action: "push", label: "Push" });
  });

  it("offers a feature branch only to actions that commit the changes", () => {
    const reason = (action: DefaultBranchConfirmableAction, hasWorkingTreeChanges: boolean) =>
      resolveFeatureBranchUnavailableReason({ action, branchName: "main", hasWorkingTreeChanges });
    assert.isNull(reason("commit_push", true));
    assert.isNull(reason("commit_push_pr", true));
    assert.isNotNull(reason("commit_push", false));
    assert.isNotNull(reason("push", true));
    assert.isNotNull(reason("create_pr", true));
  });
});

describe("when: local changes are behind upstream", () => {
  it("keeps the commit action available without pushing, with or without an open PR", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = {
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    } as const;
    assert.deepEqual(resolveQuickAction(gitState(behind)), commit);
    assert.equal(
      pushDisabledReason({ ...behind, aheadCount: 1 }),
      "Branch is behind upstream. Pull/rebase before pushing.",
    );
    assert.deepEqual(
      resolveQuickAction(
        gitState({
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        }),
      ),
      commit,
    );
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      gitState(
        status({
          hasUpstream: false,
          aheadCount: 2,
          pr: null,
        }),
      ),
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      gitState({
        ...status({
          hasUpstream: false,
          aheadCount: 2,
          pr: null,
        }),
        isDefaultRef: false,
        hasPrimaryRemote: false,
      }),
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("when: the ref is on GitLab", () => {
  const gitLab = {
    sourceControlProvider: {
      kind: SourceControlProviderKind.make("gitlab"),
      name: "GitLab",
      baseUrl: "https://gitlab.com",
    },
  };

  it("names merge requests in actions and the default-ref dialog", () => {
    const ahead = status({ ...gitLab, hasUpstream: false, aheadCount: 2 });
    assert.equal(resolveQuickAction(gitState(ahead)).label, "Push & create MR");
    assert.equal(
      resolveQuickAction(gitState(status({ ...gitLab, hasWorkingTreeChanges: true }))).label,
      "Commit, push & MR",
    );
    assert.equal(
      buildMenuItems(gitState(ahead)).find((item) => item.id === "pr")?.label,
      "Create MR",
    );

    const copy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      terminology: sourceControlClients.get("gitlab").changeRequest,
    });
    assert.equal(copy.title, "Push & create MR from default ref?");
    assert.include(copy.description, "create a merge request on");
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});

describe("resolveChangesTotals", () => {
  it("does not let an empty branchChanges hide a dirty working tree", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          hasWorkingTreeChanges: true,
          branchChanges: { baseRef: "main", insertions: 0, deletions: 0 },
          workingTree: {
            files: [
              { path: "a.ts", insertions: 4, deletions: 1 },
              { path: "README.md", insertions: 1, deletions: 0 },
            ],
            insertions: 5,
            deletions: 1,
          },
        }),
      ),
      {
        insertions: 5,
        deletions: 1,
        breakdown: {
          code: { additions: 4, deletions: 1 },
          tests: { additions: 0, deletions: 0 },
          mocks: { additions: 0, deletions: 0 },
          generated: { additions: 0, deletions: 0 },
          docs: { additions: 1, deletions: 0 },
        },
      },
    );
  });

  it("keeps non-zero branchChanges over the working tree", () => {
    assert.deepEqual(
      resolveChangesTotals(
        status({
          branchChanges: { baseRef: "origin/master", insertions: 20, deletions: 3 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
        }),
      ),
      { insertions: 20, deletions: 3, baseRef: "origin/master", breakdown: null },
    );
  });

  it("uses the panel's branch comparison when it has file stats", () => {
    const dirty = status({
      branchChanges: { baseRef: "main", insertions: 20, deletions: 3 },
    });
    const source = {
      id: "branch-range",
      kind: "branch-range",
      title: "Changes vs release",
      baseRef: "release",
      headRef: "feature/test",
      diff: "",
      diffHash: "hash",
      truncated: false,
    } as const;
    assert.deepEqual(
      resolveChangesTotals(dirty, {
        ...source,
        files: [
          { path: "a.ts", previousPath: null, additions: 4, deletions: 1 },
          { path: "a.test.ts", previousPath: null, additions: 2, deletions: 0 },
        ],
      }),
      {
        insertions: 6,
        deletions: 1,
        baseRef: "release",
        breakdown: {
          code: { additions: 4, deletions: 1 },
          tests: { additions: 2, deletions: 0 },
          mocks: { additions: 0, deletions: 0 },
          generated: { additions: 0, deletions: 0 },
          docs: { additions: 0, deletions: 0 },
        },
      },
    );
    assert.deepEqual(resolveChangesTotals(dirty, source), {
      insertions: 20,
      deletions: 3,
      baseRef: "main",
      breakdown: null,
    });
  });

  it("falls back to the working tree when branchChanges is omitted", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          workingTree: {
            files: [{ path: "a.ts", insertions: 2, deletions: 0 }],
            insertions: 2,
            deletions: 0,
          },
        }),
      ),
      { insertions: 2, deletions: 0 },
    );
  });
});
