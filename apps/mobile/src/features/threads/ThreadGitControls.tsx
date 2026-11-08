import * as Dialog from "../../components/ui/Dialog";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import {
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  type GitRunStackedActionResult,
  type ProjectScript,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { useNavigation } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { useEnvironmentScope } from "../../state/session";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { t } from "../../lib/i18n";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: VcsStatusResult): string {
  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(t("{count} changed", { count: gitStatus.workingTree.files.length }));
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push(t("Clean"));
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(t("{count} ahead", { count: gitStatus.aheadCount }));
  }
  if (gitStatus.behindCount > 0) {
    parts.push(t("{count} behind", { count: gitStatus.behindCount }));
  }
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(`${shortLabel} #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

function gitStatusMenuRow(
  gitStatus: VcsStatusResult | null,
  threadBranch: string | null,
): { readonly title: string; readonly subtitle?: string } {
  if (gitStatus === null) {
    return threadBranch === null
      ? { title: t("Checking status") }
      : { title: compactMenuBranchLabel(threadBranch), subtitle: t("Checking status") };
  }
  if (!gitStatus.isRepo) {
    return { title: t("Not a repo") };
  }
  return {
    title: compactMenuBranchLabel(gitStatus.refName ?? threadBranch ?? t("Detached HEAD")),
    subtitle: compactMenuStatus(gitStatus),
  };
}

type HeaderItem = Record<string, unknown>;
type HeaderItems = HeaderItem[];
type ThreadGitHeaderActionItems = {
  readonly terminal: HeaderItem;
  readonly files: HeaderItem;
  readonly git: HeaderItem;
};
type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

type ThreadGitMenuProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly hasThread?: boolean;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly onMergeBack?: () => void;
  readonly mergingBack?: boolean;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
};

export type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
  /** Opens the action editor for this thread's project. */
  readonly onAddProjectScript: () => void;
};

function useThreadGitControlModel(props: ThreadGitMenuProps) {
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const environmentId = props.environmentId;
  const canWriteSourceControl = useEnvironmentScope(
    environmentId ? EnvironmentId.make(String(environmentId)) : null,
    AuthSourceControlWriteScope,
  );
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const statusRow = gitStatusMenuRow(gitStatus, props.currentBranch);
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: t("Git unavailable"),
        disabled: true,
        kind: "show_hint" as const,
        hint: t("This workspace is not a git repository."),
      };
    }
    return resolveQuickAction({
      gitStatus,
      isBusy: busy,
      canWrite: canWriteSourceControl,
      surface: { publishesRepository: false, opensChangeRequest: true },
    });
  })();

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? t("This action is unavailable."))
    : null;

  const quickActionIcon: QuickActionIcon = (() => {
    if (quickAction.kind === "run_pull") return "arrow.down.circle";
    if (quickAction.kind === "open_pr") return "arrow.up.right.circle";
    if (quickAction.kind === "run_action") {
      if (quickAction.action === "commit") return "checkmark.circle";
      if (quickAction.action === "push" || quickAction.action === "commit_push")
        return "arrow.up.circle";
    }
    return "arrow.up.right.circle";
  })();

  const openExistingPr = async () => {
    const { shortLabel, singular } = sourceControlClients.get(
      gitStatus?.sourceControlProvider?.kind,
    ).changeRequest;
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(
        t("No open {label}", { label: shortLabel }),
        t("This branch does not have an open {term}.", { term: singular }),
      );
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(
        t("Unable to open {label}", { label: shortLabel }),
        t("The {term} could not be opened.", { term: singular }),
      );
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      if (props.hasThread === false) {
        Dialog.alert(
          t("Choose a feature branch"),
          t("Switch branches before publishing changes from this draft."),
        );
        return;
      }
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    await onRunAction(input);
  };

  const runQuickAction = async () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  };

  const openFiles = () => {
    if (props.onOpenFilesInspector) {
      props.onOpenFilesInspector();
      return;
    }
    navigation.navigate("ThreadFiles", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  const openReview = () => {
    navigation.navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  };

  const openGitInspector = () => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigation.navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  return {
    statusRow,
    isRepo,
    openFiles,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

function useThreadGitHeaderActionItems(props: ThreadGitControlsProps): ThreadGitHeaderActionItems {
  const model = useThreadGitControlModel(props);
  const canEditProjectScripts = useEnvironmentScope(
    props.environmentId ? EnvironmentId.make(String(props.environmentId)) : null,
    AuthSettingsWriteScope,
  );

  return {
    terminal: {
      accessibilityLabel: t("Open terminal"),
      disabled: !props.canOpenTerminal,
      icon: { name: "terminal", type: "sfSymbol" },
      identifier: "thread-right-terminal",
      label: t("Terminal"),
      menu: {
        items: [
          ...props.projectScripts.map((script) => ({
            description: script.command,
            disabled: !props.canOperateTerminal,
            icon: { name: projectScriptMenuIcon(script.icon), type: "sfSymbol" as const },
            label: projectScriptMenuLabel(script, { setup: t("setup"), settle: t("on settle") }),
            onPress: () => void props.onRunProjectScript(script),
            type: "action" as const,
          })),
          ...(props.projectScripts.length === 0
            ? [
                {
                  description: canEditProjectScripts
                    ? t("This project has no actions yet")
                    : t("This connection cannot change project actions."),
                  disabled: !canEditProjectScripts,
                  icon: { name: "plus", type: "sfSymbol" as const },
                  label: t("Add action"),
                  onPress: props.onAddProjectScript,
                  type: "action" as const,
                },
              ]
            : []),
          ...props.terminalSessions.map((session) => ({
            description: [
              getTerminalStatusLabel({
                status: session.status,
                hasRunningSubprocess: session.hasRunningSubprocess,
              }),
              basename(session.cwd),
            ]
              .filter(Boolean)
              .join(" · "),
            icon: { name: "terminal", type: "sfSymbol" as const },
            label: session.displayLabel,
            onPress: () => props.onOpenTerminal(session.terminalId),
            type: "action" as const,
          })),
          {
            description: t("Start another shell for this thread"),
            disabled: !props.canOperateTerminal,
            icon: { name: "plus", type: "sfSymbol" },
            label: t("Open new terminal"),
            onPress: props.onOpenNewTerminal,
            type: "action",
          },
        ],
        title: t("Terminal"),
      },
      sharesBackground: true,
      type: "menu",
      variant: "plain",
    },
    files: {
      accessibilityLabel: t("Open files"),
      disabled: !props.canOpenFiles,
      icon: { name: "folder", type: "sfSymbol" },
      identifier: "thread-right-files",
      label: t("Files"),
      onPress: model.openFiles,
      sharesBackground: true,
      type: "button",
      variant: "plain",
    },
    git: {
      accessibilityLabel: t("Git actions"),
      icon: { name: "point.topleft.down.curvedto.point.bottomright.up", type: "sfSymbol" },
      identifier: "thread-right-git",
      label: "Git",
      menu: {
        items: [
          {
            description: model.statusRow.subtitle,
            disabled: true,
            icon: {
              name: "point.topleft.down.curvedto.point.bottomright.up",
              type: "sfSymbol",
            },
            label: model.statusRow.title,
            onPress: (): void => {},
            type: "action",
          },
          {
            description: model.quickActionHint ?? undefined,
            disabled: model.quickAction.disabled,
            icon: { name: model.quickActionIcon, type: "sfSymbol" },
            label: model.quickAction.label,
            onPress: (): void => void model.runQuickAction(),
            type: "action",
          },
          {
            description:
              props.hasThread === false
                ? t("Available after the first message")
                : t("Turn diffs and worktree changes"),
            disabled: !model.isRepo || props.hasThread === false,
            icon: { name: "text.bubble", type: "sfSymbol" },
            label: t("Review changes"),
            onPress: model.openReview,
            type: "action",
          },
          ...(props.onMergeBack
            ? [
                {
                  description: props.mergingBack
                    ? t("Merging back…")
                    : t("Bring this thread's latest turn into its source"),
                  disabled: props.mergingBack === true,
                  icon: { name: PullRequestGlyph.merged, type: "sfSymbol" as const },
                  label: t("Merge back to source"),
                  onPress: props.onMergeBack,
                  type: "action" as const,
                },
              ]
            : []),
          {
            description:
              props.hasThread === false
                ? t("Available after the first message")
                : t("Commit, files, branches"),
            disabled: props.hasThread === false,
            icon: { name: "ellipsis", type: "sfSymbol" },
            label: t("More"),
            onPress: model.openGitInspector,
            type: "action",
          },
        ],
        title: "Git",
      },
      sharesBackground: true,
      type: "menu",
      variant: "plain",
    },
  };
}

export function useThreadGitRightHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return [actionItems.git, actionItems.files, actionItems.terminal] as HeaderItems;
}

export function useThreadGitCenterHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return [actionItems.files, actionItems.git, actionItems.terminal] as HeaderItems;
}

/** Returns menu data because native toolbars serialize direct items rather than rendering component children. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  const model = useThreadGitControlModel(props);
  return {
    title: t("Git controls"),
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    separateBackground: false,
    items: [
      {
        id: "git-status",
        title: model.statusRow.title,
        icon: "point.topleft.down.curvedto.point.bottomright.up",
        disabled: true,
        subtitle: model.statusRow.subtitle,
        onPress: () => {},
      },
      {
        id: "git-quick-action",
        title: model.quickAction.label,
        icon: model.quickActionIcon,
        disabled: model.quickAction.disabled,
        subtitle: model.quickActionHint ?? undefined,
        onPress: () => {
          void model.runQuickAction();
        },
      },
      {
        id: "git-review",
        title: t("Review changes"),
        icon: "text.bubble",
        disabled: !model.isRepo || props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? t("Available after the first message")
            : t("Turn diffs and worktree changes"),
        onPress: model.openReview,
      },
      {
        id: "git-more",
        title: t("More"),
        icon: "ellipsis",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? t("Available after the first message")
            : t("Commit, files, branches"),
        onPress: model.openGitInspector,
      },
    ],
  };
}
