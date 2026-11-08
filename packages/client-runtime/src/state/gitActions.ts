import type {
  GitActionProgressPhase,
  GitActionProgressStep,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsPullResult,
  VcsStatusResult,
} from "@t3tools/contracts";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";
import { t } from "@t3tools/shared/i18n";

export type GitActionIconName = "commit" | "push" | "pull" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pull" | "pr";
  label: string;
  disabled: boolean;
  /** Why the item is disabled; null exactly when it is enabled. */
  disabledReason: string | null;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr" | "run_pull";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  /** Set whenever the action is disabled. */
  hint?: string;
}

export interface GitActionSurface {
  /** Web publishes a repository that has no remote; mobile has no publish flow. */
  readonly publishesRepository: boolean;
  /** Mobile opens the open change request from these actions; web lists it in its own panel. */
  readonly opensChangeRequest: boolean;
}

export interface GitActionState {
  readonly gitStatus: VcsStatusResult | null;
  /** Why the status is missing. A missing status without an error is still loading. */
  readonly gitStatusError?: string | null;
  readonly isBusy: boolean;
  /** False on connections without the source-control write scope. */
  readonly canWrite: boolean;
  readonly surface: GitActionSurface;
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

function writeBlocker(state: GitActionState): string | null {
  if (!state.canWrite) return t("This connection cannot change source control.");
  if (state.isBusy) return t("Git action in progress.");
  return null;
}

function menuItem(
  item: Omit<GitActionMenuItem, "disabled" | "disabledReason">,
  disabledReason: string | null,
): GitActionMenuItem {
  return { ...item, disabled: disabledReason !== null, disabledReason };
}

function commitBlocker(state: GitActionState, status: VcsStatusResult): string | null {
  return (
    writeBlocker(state) ??
    (status.hasWorkingTreeChanges ? null : t("Worktree is clean. Make changes before committing."))
  );
}

function pushBlocker(state: GitActionState, status: VcsStatusResult): string | null {
  const blocker = writeBlocker(state);
  if (blocker) return blocker;
  if (status.refName === null) return t("Detached HEAD: check out a branch before pushing.");
  if (!status.hasUpstream && !status.hasPrimaryRemote) {
    return t('Add an "origin" remote before pushing.');
  }
  if (status.behindCount > 0) return t("Branch is behind upstream. Pull/rebase before pushing.");
  if (status.aheadCount <= 0) return t("No local commits to push.");
  return null;
}

function pullBlocker(state: GitActionState, status: VcsStatusResult): string | null {
  return (
    writeBlocker(state) ??
    (status.aheadCount > 0 ? t("Branch has diverged from upstream. Rebase/merge first.") : null)
  );
}

function createChangeRequestBlocker(
  state: GitActionState,
  status: VcsStatusResult,
  terminology: ChangeRequestTerminology,
): string | null {
  const blocker = writeBlocker(state);
  if (blocker) return blocker;
  const kind = terminology.singular;
  if (status.refName === null) {
    return t("Detached HEAD: check out a branch before creating a {kind}.", { kind });
  }
  if (!status.hasUpstream && !status.hasPrimaryRemote) {
    return t('Add an "origin" remote before creating a {kind}.', { kind });
  }
  if (status.isDefaultRef) return t("Switch to a feature branch to create a {kind}.", { kind });
  if (status.behindCount > 0) {
    return t("Branch is behind upstream. Pull/rebase before creating a {kind}.", { kind });
  }
  if ((status.aheadOfDefaultCount ?? status.aheadCount) <= 0) {
    return t("No local commits to include in a {kind}.", { kind });
  }
  return null;
}

export function buildMenuItems(state: GitActionState): GitActionMenuItem[] {
  const status = state.gitStatus;
  if (!status) return [];
  const terminology = changeRequestTerminologyFor(status);

  const commitItem = menuItem(
    {
      id: "commit",
      label: t("Commit"),
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    commitBlocker(state, status),
  );
  if (state.surface.publishesRepository && !status.hasPrimaryRemote) {
    return [commitItem];
  }

  const items = [
    commitItem,
    menuItem(
      { id: "push", label: t("Push"), icon: "push", kind: "open_dialog", dialogAction: "push" },
      pushBlocker(state, status),
    ),
  ];
  if (status.behindCount > 0) {
    items.push(
      menuItem(
        { id: "pull", label: t("Pull"), icon: "pull", kind: "run_pull" },
        pullBlocker(state, status),
      ),
    );
  }
  if (status.pr?.state !== "open") {
    items.push(
      menuItem(
        {
          id: "pr",
          label: t("Create {kind}", { kind: terminology.shortLabel }),
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
        createChangeRequestBlocker(state, status, terminology),
      ),
    );
  } else if (state.surface.opensChangeRequest) {
    items.push(
      menuItem(
        {
          id: "pr",
          label: t("View {shortLabel}", { shortLabel: terminology.shortLabel }),
          icon: "pr",
          kind: "open_pr",
        },
        state.isBusy ? t("Git action in progress.") : null,
      ),
    );
  }
  return items;
}

function hint(label: string, reason: string): GitQuickAction {
  return { label, disabled: true, kind: "show_hint", hint: reason };
}

function resolveAvailableQuickAction(state: GitActionState): GitQuickAction {
  const status = state.gitStatus;
  if (state.isBusy) return hint(t("Commit"), t("Git action in progress."));
  if (!status) {
    return state.gitStatusError
      ? hint(t("Git status unavailable"), state.gitStatusError)
      : hint(t("Checking status"), t("Checking git status..."));
  }

  const terminology = changeRequestTerminologyFor(status);
  const { shortLabel } = terminology;
  const hasOpenPr = status.pr?.state === "open";
  const isAhead = status.aheadCount > 0;
  const isBehind = status.behindCount > 0;
  const isDefaultRef = status.isDefaultRef;
  const viewChangeRequest: GitQuickAction = {
    label: t("View {shortLabel}", { shortLabel }),
    disabled: false,
    kind: "open_pr",
  };
  const upToDate =
    hasOpenPr && state.surface.opensChangeRequest
      ? viewChangeRequest
      : hint(t("Commit"), t("Branch is up to date. No action needed."));
  const pushAhead: GitQuickAction =
    hasOpenPr || isDefaultRef
      ? { label: t("Push"), disabled: false, kind: "run_action", action: "push" }
      : {
          label: t("Push & create {kind}", { kind: shortLabel }),
          disabled: false,
          kind: "run_action",
          action: "create_pr",
        };

  if (status.refName === null) {
    return hint(
      t("Commit"),
      t("Create and checkout a ref before pushing or opening a {kind}.", {
        kind: terminology.singular,
      }),
    );
  }

  if (status.hasWorkingTreeChanges) {
    // Pull first: committing on a branch that is behind leaves it diverged, which pull --ff-only can't fix.
    if (isBehind && !isAhead) return { label: t("Pull"), disabled: false, kind: "run_pull" };
    if (isBehind || (!status.hasUpstream && !status.hasPrimaryRemote)) {
      return { label: t("Commit"), disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: t("Commit & push"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: t("Commit, push & {kind}", { kind: shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!status.hasUpstream) {
    if (!status.hasPrimaryRemote) {
      if (state.surface.publishesRepository) {
        return { label: t("Publish repository"), disabled: false, kind: "open_publish" };
      }
      if (hasOpenPr && !isAhead && state.surface.opensChangeRequest) return viewChangeRequest;
      return hint(
        t("Push"),
        t('Add an "origin" remote before pushing or creating a {kind}.', {
          kind: terminology.singular,
        }),
      );
    }
    if (isAhead) return pushAhead;
    return hasOpenPr ? upToDate : hint(t("Push"), t("No local commits to push."));
  }

  if (isAhead && isBehind) {
    return hint(t("Sync ref"), t("Branch has diverged from upstream. Rebase/merge first."));
  }
  if (isBehind) return { label: t("Pull"), disabled: false, kind: "run_pull" };
  if (isAhead) return pushAhead;
  if (hasOpenPr) return upToDate;
  if ((status.aheadOfDefaultCount ?? 0) > 0 && !isDefaultRef) {
    return {
      label: t("Create {kind}", { kind: shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }
  return hint(t("Commit"), t("Branch is up to date. No action needed."));
}

export function resolveQuickAction(state: GitActionState): GitQuickAction {
  const quickAction = resolveAvailableQuickAction(state);
  if (state.canWrite || quickAction.disabled || quickAction.kind === "open_pr") {
    return quickAction;
  }
  return {
    ...quickAction,
    disabled: true,
    hint: t("This connection cannot change source control."),
  };
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

/**
 * The server's `featureBranch` flag names the new branch from uncommitted changes, so it only
 * works for actions that commit, on a tree that has changes.
 */
export function resolveFeatureBranchUnavailableReason(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  hasWorkingTreeChanges: boolean;
}): string | null {
  if (input.action !== "commit_push" && input.action !== "commit_push_pr") {
    return t(
      "Only actions that commit can move to a new feature branch. Create a branch yourself or continue on {branch}.",
      { branch: input.branchName },
    );
  }
  if (input.hasWorkingTreeChanges) return null;
  return t(
    "There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
    { branch: input.branchName },
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { terminology } = input;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("Commit & push to default ref?"),
        description: t(
          'This action will commit and push changes on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
          { branch: branchLabel },
        ),
        continueLabel: t("Commit & push to {branch}", { branch: branchLabel }),
      };
    }
    return {
      title: t("Push to default ref?"),
      description: t(
        'This action will push local commits on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
        { branch: branchLabel },
      ),
      continueLabel: t("Push to {branch}", { branch: branchLabel }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("Commit, push & create {kind} from default ref?", { kind: terminology.shortLabel }),
      description: t(
        'This action will commit, push, and create a {kind} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
        { kind: terminology.singular, branch: branchLabel },
      ),
      continueLabel: t("Commit, push & create {kind}", { kind: terminology.shortLabel }),
    };
  }
  return {
    title: t("Push & create {kind} from default ref?", { kind: terminology.shortLabel }),
    description: t(
      'This action will push local commits and create a {kind} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
      { kind: terminology.singular, branch: branchLabel },
    ),
    continueLabel: t("Push & create {kind}", { kind: terminology.shortLabel }),
  };
}

const SHORT_SHA_LENGTH = 7;

export interface GitActionResultSummary {
  readonly title: string;
  readonly description: string | null;
}

export function summarizeGitActionResult(
  result: Pick<GitRunStackedActionResult, "commit" | "push" | "pr">,
  terminology: ChangeRequestTerminology,
): GitActionResultSummary {
  const { commit, push, pr } = result;
  const { shortLabel } = terminology;
  const sha = commit.commitSha?.slice(0, SHORT_SHA_LENGTH);
  const subject = commit.subject ?? null;

  if (pr.status === "created" || pr.status === "opened_existing") {
    const number = pr.number;
    const created = pr.status === "created";
    const title =
      number === undefined
        ? created
          ? t("Created {shortLabel}", { shortLabel })
          : t("Opened {shortLabel}", { shortLabel })
        : created
          ? t("Created {shortLabel} #{number}", { shortLabel, number })
          : t("Opened {shortLabel} #{number}", { shortLabel, number });
    return { title, description: pr.title ?? null };
  }

  if (push.status === "pushed") {
    const branch = push.upstreamBranch ?? push.branch;
    const title = branch
      ? sha
        ? t("Pushed {sha} to {branch}", { sha, branch })
        : t("Pushed to {branch}", { branch })
      : sha
        ? t("Pushed {sha}", { sha })
        : t("Pushed");
    return { title, description: subject };
  }

  if (commit.status === "created") {
    return {
      title: sha ? t("Committed {sha}", { sha }) : t("Committed changes"),
      description: subject,
    };
  }

  if (commit.status === "skipped_no_changes") {
    return { title: t("No changes to commit"), description: null };
  }
  if (push.status === "skipped_up_to_date") {
    return { title: t("Already up to date"), description: null };
  }
  return { title: t("Done"), description: null };
}

export function summarizePullResult(result: VcsPullResult): GitActionResultSummary {
  return result.status === "pulled"
    ? {
        title: t("Pulled"),
        description: t("Updated {ref} from {upstream}", {
          ref: result.refName,
          upstream: result.upstreamRef ?? t("upstream"),
        }),
      }
    : {
        title: t("Already up to date"),
        description: t("{ref} is already synchronized.", { ref: result.refName }),
      };
}

// Servers that predate `step` report only the phase.
const PHASE_DEFAULT_STEP: Readonly<Record<GitActionProgressPhase, GitActionProgressStep>> = {
  branch: "prepare_feature_branch",
  commit: "commit",
  push: "push",
  pr: "create_change_request",
};

export function describeGitActionProgress(
  event: {
    readonly phase: GitActionProgressPhase;
    readonly step?: GitActionProgressStep | undefined;
  },
  terminology: ChangeRequestTerminology,
): string {
  const { shortLabel } = terminology;
  switch (event.step ?? PHASE_DEFAULT_STEP[event.phase]) {
    case "prepare_feature_branch":
      return t("Preparing feature branch...");
    case "generate_commit_message":
      return t("Generating commit message...");
    case "commit":
      return t("Committing...");
    case "push":
      return t("Pushing...");
    case "prepare_change_request":
      return t("Preparing {shortLabel}...", { shortLabel });
    case "generate_change_request":
      return t("Generating {shortLabel} content...", { shortLabel });
    case "create_change_request":
      return t("Creating {shortLabel}...", { shortLabel });
  }
}
