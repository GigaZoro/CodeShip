import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";
import { t } from "@t3tools/shared/i18n";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: t("Commit"),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: t("Push"),
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: t("View {shortLabel}", { shortLabel: terminology.shortLabel }),
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: t("Create {shortLabel}", { shortLabel: terminology.shortLabel }),
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
): GitQuickAction {
  if (isBusy) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Git action in progress."),
    };
  }

  if (!gitStatus) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Git status is unavailable."),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Create and checkout a branch before pushing or opening {shortLabelWithArticle}.", {
        shortLabelWithArticle: terminology.shortLabelWithArticle,
      }),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasOriginRemote)) {
      return { label: t("Commit"), disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("Commit & push"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: t("Commit, push & {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return {
          label: t("View {shortLabel}", { shortLabel: terminology.shortLabel }),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: t("Push"),
        disabled: true,
        kind: "show_hint",
        hint: t('Add an "origin" remote before pushing or creating {shortLabelWithArticle}.', {
          shortLabelWithArticle: terminology.shortLabelWithArticle,
        }),
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: t("View {shortLabel}", { shortLabel: terminology.shortLabel }),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: t("Push"),
        disabled: true,
        kind: "show_hint",
        hint: t("No local commits to push."),
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: t("Sync branch"),
      disabled: true,
      kind: "show_hint",
      hint: t("Branch has diverged from upstream. Rebase/merge first."),
    };
  }

  if (isBehind) {
    return {
      label: t("Pull"),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: t("View {shortLabel}", { shortLabel: terminology.shortLabel }),
      disabled: false,
      kind: "open_pr",
    };
  }

  return {
    label: t("Commit"),
    disabled: true,
    kind: "show_hint",
    hint: t("Branch is up to date. No action needed."),
  };
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return t("Git action in progress.");
  if (!gitStatus) return t("Git status is unavailable.");

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return t("Worktree is clean. Make changes before committing.");
    }
    return t("Commit is currently unavailable.");
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return t("Detached HEAD: checkout a branch before pushing.");
    }
    if (hasChanges) {
      return t("Commit or stash local changes before pushing.");
    }
    if (isBehind) {
      return t("Branch is behind upstream. Pull/rebase before pushing.");
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return t('Add an "origin" remote before pushing.');
    }
    if (!isAhead) {
      return t("No local commits to push.");
    }
    return t("Push is currently unavailable.");
  }

  if (hasOpenPr) {
    return t("View {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel });
  }
  if (!hasBranch) {
    return t("Detached HEAD: checkout a branch before creating {shortLabelWithArticle}.", {
      shortLabelWithArticle: terminology.shortLabelWithArticle,
    });
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return t('Add an "origin" remote before creating {shortLabelWithArticle}.', {
      shortLabelWithArticle: terminology.shortLabelWithArticle,
    });
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return t("No local commits to include in {shortLabelWithArticle}.", {
      shortLabelWithArticle: terminology.shortLabelWithArticle,
    });
  }
  if (isBehind) {
    return t("Branch is behind upstream. Pull/rebase before creating {shortLabelWithArticle}.", {
      shortLabelWithArticle: terminology.shortLabelWithArticle,
    });
  }
  return t("Create {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel });
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { shortLabel, shortLabelWithArticle } = input.terminology;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("Commit & push to default branch?"),
        description: t(
          'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch: branchLabel },
        ),
        continueLabel: t("Commit & push to {branch}", { branch: branchLabel }),
      };
    }
    return {
      title: t("Push to default branch?"),
      description: t(
        'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
        { branch: branchLabel },
      ),
      continueLabel: t("Push to {branch}", { branch: branchLabel }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("Commit, push & create {shortLabel} from default branch?", { shortLabel }),
      description: t(
        'This action will commit, push, and create {shortLabelWithArticle} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
        { shortLabelWithArticle, branch: branchLabel },
      ),
      continueLabel: t("Commit, push & create {shortLabel}", { shortLabel }),
    };
  }
  return {
    title: t("Push & create {shortLabel} from default branch?", { shortLabel }),
    description: t(
      'This action will push local commits and create {shortLabelWithArticle} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
      { shortLabelWithArticle, branch: branchLabel },
    ),
    continueLabel: t("Push & create {shortLabel}", { shortLabel }),
  };
}
