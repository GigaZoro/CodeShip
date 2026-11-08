import {
  SourceControlProviderKind,
  type GitRunStackedActionResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { activateLanguage } from "@t3tools/shared/i18n";
import { describe, expect, it } from "vite-plus/test";

import uk from "../i18n/locales/uk.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  describeGitActionProgress,
  type GitActionState,
  type GitActionSurface,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  resolveQuickAction,
  summarizeGitActionResult,
  summarizePullResult,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const WEB: GitActionSurface = { publishesRepository: true, opensChangeRequest: false };
const MOBILE: GitActionSurface = { publishesRepository: false, opensChangeRequest: true };

function state(
  gitStatus: VcsStatusResult | null,
  overrides: Partial<Omit<GitActionState, "gitStatus">> = {},
): GitActionState {
  return { gitStatus, isBusy: false, canWrite: true, surface: WEB, ...overrides };
}

function menuItem(input: GitActionState, id: string) {
  return buildMenuItems(input).find((item) => item.id === id);
}

const gitLab = {
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
};

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

const github = sourceControlClients.get("github").changeRequest;

const commitResult: Pick<GitRunStackedActionResult, "commit" | "push" | "pr"> = {
  commit: { status: "created", commitSha: "abc1234def", subject: "Add login" },
  push: { status: "skipped_not_requested" },
  pr: { status: "skipped_not_requested" },
};

function inUkrainian(run: () => void) {
  activateLanguage({ language: "uk", catalog: uk, formattingLocale: "uk" });
  try {
    run();
  } finally {
    activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
  }
}

describe("resolveQuickAction", () => {
  it.each([
    {
      name: "pushes an open PR's new commits",
      input: state(status({ aheadCount: 3, pr: openPr })),
      expected: { kind: "run_action", action: "push", label: "Push" },
    },
    {
      name: "creates a PR for a synced branch that is ahead of the default ref",
      input: state(status({ aheadOfDefaultCount: 1 })),
      expected: { kind: "run_action", action: "create_pr", label: "Create PR" },
    },
    {
      name: "commits and pushes local changes on the default ref",
      input: state(status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true })),
      expected: { kind: "run_action", action: "commit_push", label: "Commit & push" },
    },
    {
      name: "only pushes a clean default ref, so a tree dirtied later is not committed",
      input: state(status({ refName: "main", isDefaultRef: true, aheadCount: 2 })),
      expected: { kind: "run_action", action: "push", label: "Push" },
    },
    {
      name: "only pushes a clean default ref without an upstream",
      input: state(
        status({ refName: "main", isDefaultRef: true, hasUpstream: false, aheadCount: 2 }),
      ),
      expected: { kind: "run_action", action: "push", label: "Push" },
    },
    {
      name: "pulls before committing changes on a branch that is behind",
      input: state(status({ hasWorkingTreeChanges: true, behindCount: 2, pr: openPr })),
      expected: { kind: "run_pull", label: "Pull", disabled: false },
    },
    {
      name: "commits without pushing when the branch has diverged",
      input: state(status({ hasWorkingTreeChanges: true, behindCount: 2, aheadCount: 1 })),
      expected: { kind: "run_action", action: "commit", label: "Commit" },
    },
    {
      name: "pushes and creates a PR for a branch without an upstream",
      input: state(status({ hasUpstream: false, aheadCount: 2 })),
      expected: { kind: "run_action", action: "create_pr", label: "Push & create PR" },
    },
    {
      name: "publishes a repository without a remote on web",
      input: state(status({ hasUpstream: false, hasPrimaryRemote: false, aheadCount: 2 })),
      expected: { kind: "open_publish", label: "Publish repository", disabled: false },
    },
    {
      name: "asks for a remote on mobile, which cannot publish",
      input: state(status({ hasUpstream: false, hasPrimaryRemote: false, aheadCount: 2 }), {
        surface: MOBILE,
      }),
      expected: {
        kind: "show_hint",
        disabled: true,
        hint: 'Add an "origin" remote before pushing or creating a pull request.',
      },
    },
    {
      name: "opens an up-to-date branch's PR on mobile",
      input: state(status({ pr: openPr }), { surface: MOBILE }),
      expected: { kind: "open_pr", label: "View PR", disabled: false },
    },
    {
      name: "has nothing to do for an up-to-date branch's PR on web",
      input: state(status({ pr: openPr })),
      expected: { kind: "show_hint", disabled: true },
    },
    {
      name: "says the status is loading while it has no snapshot",
      input: state(null),
      expected: { label: "Checking status", disabled: true },
    },
    {
      name: "shows why the status is missing",
      input: state(null, { gitStatusError: "fatal: not a git repository" }),
      expected: { disabled: true, hint: "fatal: not a git repository" },
    },
    {
      name: "is unavailable on a read-only connection",
      input: state(status({ aheadCount: 1 }), { canWrite: false }),
      expected: { disabled: true, hint: "This connection cannot change source control." },
    },
    {
      name: "still opens the PR on a read-only connection",
      input: state(status({ pr: openPr }), { canWrite: false, surface: MOBILE }),
      expected: { kind: "open_pr", disabled: false },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveQuickAction(input)).toMatchObject(expected);
  });
});

describe("buildMenuItems", () => {
  it.each([
    {
      name: "allows pushing commits with a dirty tree",
      input: state(status({ hasWorkingTreeChanges: true, aheadCount: 1 })),
      id: "push",
      reason: null,
    },
    {
      name: "names the upstream, not local changes, as the push blocker of a dirty branch that is behind",
      input: state(status({ hasWorkingTreeChanges: true, behindCount: 1 })),
      id: "push",
      reason: "Branch is behind upstream. Pull/rebase before pushing.",
    },
    {
      name: "allows creating a PR with a dirty tree",
      input: state(status({ hasWorkingTreeChanges: true, aheadOfDefaultCount: 1 })),
      id: "pr",
      reason: null,
    },
    {
      name: "asks for a feature branch before creating a PR from the default ref",
      input: state(status({ refName: "main", isDefaultRef: true, aheadCount: 2 })),
      id: "pr",
      reason: "Switch to a feature branch to create a pull request.",
    },
    {
      name: "offers a fast-forward pull when behind",
      input: state(status({ hasWorkingTreeChanges: true, behindCount: 1 })),
      id: "pull",
      reason: null,
    },
    {
      name: "cannot fast-forward a diverged branch",
      input: state(status({ behindCount: 1, aheadCount: 1 })),
      id: "pull",
      reason: "Branch has diverged from upstream. Rebase/merge first.",
    },
    {
      name: "explains a read-only connection",
      input: state(status({ hasWorkingTreeChanges: true }), { canWrite: false }),
      id: "commit",
      reason: "This connection cannot change source control.",
    },
  ])("$name", ({ input, id, reason }) => {
    expect(menuItem(input, id)).toMatchObject({
      disabled: reason !== null,
      disabledReason: reason,
    });
  });

  it("lists pull only while the branch is behind", () => {
    expect(menuItem(state(status()), "pull")).toBeUndefined();
  });

  it("leaves only commit for a repository web can publish", () => {
    const noRemote = status({ hasUpstream: false, hasPrimaryRemote: false });
    expect(buildMenuItems(state(noRemote)).map((item) => item.id)).toEqual(["commit"]);
    expect(buildMenuItems(state(noRemote, { surface: MOBILE })).map((item) => item.id)).toEqual([
      "commit",
      "push",
      "pr",
    ]);
  });

  it("views an open PR on mobile and leaves it to its panel on web", () => {
    expect(menuItem(state(status({ pr: openPr })), "pr")).toBeUndefined();
    expect(menuItem(state(status({ pr: openPr }), { surface: MOBILE }), "pr")).toMatchObject({
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("confirms actions that push from the default ref", () => {
    expect(requiresDefaultBranchConfirmation("commit", true)).toBe(false);
    expect(requiresDefaultBranchConfirmation("push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("create_pr", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push_pr", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("push", false)).toBe(false);
  });
});

describe("resolveFeatureBranchUnavailableReason", () => {
  it.each([
    { action: "push", hasWorkingTreeChanges: true, available: false },
    { action: "create_pr", hasWorkingTreeChanges: true, available: false },
    { action: "commit_push", hasWorkingTreeChanges: true, available: true },
    { action: "commit_push_pr", hasWorkingTreeChanges: true, available: true },
    { action: "commit_push", hasWorkingTreeChanges: false, available: false },
  ] as const)(
    "$action with changes: $hasWorkingTreeChanges",
    ({ action, hasWorkingTreeChanges, available }) => {
      expect(
        resolveFeatureBranchUnavailableReason({
          action,
          branchName: "main",
          hasWorkingTreeChanges,
        }),
      ).toEqual(available ? null : expect.any(String));
    },
  );
});

describe("git action copy", () => {
  it("says MR for a GitLab ref", () => {
    expect(resolveQuickAction(state(status({ ...gitLab, aheadCount: 1 })))).toMatchObject({
      label: "Push & create MR",
    });
    expect(
      resolveQuickAction(state(status({ ...gitLab, hasWorkingTreeChanges: true }))),
    ).toMatchObject({ label: "Commit, push & MR" });
    expect(menuItem(state(status(gitLab)), "pr")).toMatchObject({
      label: "Create MR",
      disabledReason: "No local commits to include in a merge request.",
    });
    expect(
      describeGitActionProgress(
        { phase: "pr", step: "generate_change_request" },
        sourceControlClients.get("gitlab").changeRequest,
      ),
    ).toBe("Generating MR content...");
  });

  it("names the host's change request in the default-ref dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default ref?");
    const gitLabCopy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      terminology: sourceControlClients.get("gitlab").changeRequest,
    });
    expect(gitLabCopy.title).toBe("Push & create MR from default ref?");
    expect(gitLabCopy.description).toContain("create a merge request on");
  });

  it("builds results from the steps, not the server's toast", () => {
    expect(summarizeGitActionResult(commitResult, github)).toEqual({
      title: "Committed abc1234",
      description: "Add login",
    });
    expect(
      summarizeGitActionResult(
        { ...commitResult, push: { status: "pushed", branch: "feature/test" } },
        github,
      ),
    ).toEqual({ title: "Pushed abc1234 to feature/test", description: "Add login" });
    expect(
      summarizeGitActionResult(
        {
          commit: { status: "skipped_not_requested" },
          push: { status: "skipped_up_to_date" },
          pr: { status: "skipped_not_requested" },
        },
        github,
      ).title,
    ).toBe("Already up to date");
  });

  it("reads results and every progress step in Ukrainian", () => {
    inUkrainian(() => {
      expect(summarizeGitActionResult(commitResult, github)).toEqual({
        title: "Створено коміт abc1234",
        description: "Add login",
      });
      expect(
        summarizeGitActionResult(
          {
            ...commitResult,
            push: { status: "pushed", branch: "feature/test", upstreamBranch: "origin/feature" },
          },
          github,
        ).title,
      ).toBe("Надіслано abc1234 в origin/feature");
      expect(
        summarizeGitActionResult(
          {
            ...commitResult,
            pr: { status: "created", number: 12, title: "Add login" },
          },
          github,
        ),
      ).toEqual({ title: "Створено PR #12", description: "Add login" });
      expect(
        summarizeGitActionResult(
          { ...commitResult, pr: { status: "opened_existing", number: 12 } },
          github,
        ).title,
      ).toBe("Відкрито PR #12");
      expect(
        summarizePullResult({ status: "pulled", refName: "main", upstreamRef: "origin/main" }),
      ).toEqual({ title: "Зміни отримано", description: "Оновлено main з origin/main" });
      expect(
        (
          [
            { phase: "branch", step: "prepare_feature_branch" },
            { phase: "commit", step: "generate_commit_message" },
            { phase: "commit", step: "commit" },
            { phase: "push", step: "push" },
            { phase: "pr", step: "prepare_change_request" },
            { phase: "pr", step: "generate_change_request" },
            { phase: "pr", step: "create_change_request" },
            { phase: "pr" },
          ] as const
        ).map((event) => describeGitActionProgress(event, github)),
      ).toEqual([
        "Підготовка окремої гілки…",
        "Генерування повідомлення коміту…",
        "Створення коміту…",
        "Надсилання…",
        "Підготовка PR…",
        "Генерування вмісту PR…",
        "Створення PR…",
        "Створення PR…",
      ]);
    });
  });
});
