import * as Dialog from "../../../components/ui/Dialog";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionMenuItem,
  type GitActionRequestInput,
  buildMenuItems,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import type { ThreadRepositorySection } from "@t3tools/client-runtime/state/thread-repositories";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { use, useEffect, useState } from "react";
import { RefreshControl } from "../../../components/ui/RefreshControl";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { groupedListInsets } from "../../../components/ui/listMetrics";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetPane } from "../../../components/ui/SheetPane";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { filesystemEnvironment } from "../../../state/filesystem";
import { useEnvironmentQuery } from "../../../state/query";
import {
  gitRepositoryRouteParams,
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../../../state/thread-git-target";
import {
  unpinRepositoryFromThread,
  useThreadRepositoryPins,
} from "../../../state/thread-repository-pins";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { menuItemIconName, statusSummary } from "./gitSheetComponents";
import { ThreadRepositoryRows } from "./ThreadRepositoryRows";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";
import { t, tn } from "../../../lib/i18n";

type GitOverviewSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
  } & GitRepositoryRouteParams
> & {
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <GitOverviewSheetContent {...props} />;
}

function GitOverviewSheetContent(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const closeInspectorSheet = use(InspectorSheetContext);
  const presentRoute = (present: () => void) =>
    closeInspectorSheet ? closeInspectorSheet(present) : present();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  // A tracked repository instead of the thread's own folder: thread-only rows stay off for it.
  const repository = gitRepositoryTargetFromRoute(props.route.params);
  const repositoryParams = gitRepositoryRouteParams(repository);
  const threadWorktree = useSelectedThreadWorktree();
  const { selectedThreadWorktreePath } = threadWorktree;
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const threadRef = { environmentId, threadId };
  const pinnedRepositories = useThreadRepositoryPins(threadRef);
  const isPinnedRepository =
    repository !== undefined &&
    pinnedRepositories.some((pin) => pin.repositoryPath === repository.key);
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState(repository);
  const gitActions = useSelectedThreadGitActions(repository);
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const isRepo = gitStatus.data?.isRepo ?? true;
  // A plain folder that tracks repositories has no branch of its own; its turns still have diffs.
  const projectRepositoryCount = selectedThreadProject?.trackedFolders?.length ?? 0;
  const trackedRepositoryCount = isRepo || repository !== undefined ? 0 : projectRepositoryCount;
  // A worktree thread reaches tracked repositories only through its own task folder.
  const taskFolderQuery = useEnvironmentQuery(
    selectedThread !== null && selectedThreadWorktreePath !== null && projectRepositoryCount > 0
      ? filesystemEnvironment.taskFolder({
          environmentId: selectedThread.environmentId,
          input: { worktreePath: selectedThreadWorktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // Also for a project that tracks nothing: a thread can change a submodule.
  const listsRepositories = repository === undefined && selectedThreadProject !== null;
  const reachesTracked =
    projectRepositoryCount > 0 && (selectedThreadWorktreePath === null || taskFolder !== null);
  const currentBranchLabel =
    repository !== undefined
      ? repository.name
      : trackedRepositoryCount > 0
        ? // A task folder's plain project folder has no branch; its repositories are on the thread's.
          ((taskFolder === null ? null : selectedThread?.branch) ??
          selectedThreadProject?.title ??
          t("Repositories"))
        : (gitStatus.data?.refName ?? selectedThread?.branch ?? t("Detached HEAD"));
  const currentStatusSummary =
    repository !== undefined
      ? gitStatus.data?.isRepo
        ? `${gitStatus.data.refName ?? t("Detached HEAD")} · ${statusSummary(gitStatus.data)}`
        : statusSummary(gitStatus.data)
      : taskFolder !== null && trackedRepositoryCount > 0
        ? tn(
            taskFolder.repositories.length,
            "{count} repository worktree",
            "{count} repository worktrees",
          )
        : trackedRepositoryCount > 0
          ? tn(trackedRepositoryCount, "{count} repository", "{count} repositories")
          : statusSummary(gitStatus.data);
  const currentWorktreePath = repository === undefined ? selectedThreadWorktreePath : null;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;
  const menuItems = isRepo
    ? buildMenuItems({
        gitStatus: gitStatus.data,
        isBusy: busy,
        canWrite: canWriteSourceControl,
        surface: { publishesRepository: false, opensChangeRequest: true },
      })
    : [];
  const { shortLabel, singular } = sourceControlClients.get(
    gitStatus.data?.sourceControlProvider?.kind,
  ).changeRequest;

  const openExistingPr = async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
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
    const branchName = gitStatus.data?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      presentRoute(() =>
        navigation.navigate("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          ...repositoryParams,
          confirmAction: confirmableAction,
        }),
      );
      return;
    }

    // Close a sheet so the thread shows the action's progress.
    if (!isInspector) navigation.goBack();
    else closeInspectorSheet?.();
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const onPressMenuItem = async (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (item.kind === "run_pull") {
      await gitActions.onPullSelectedThreadBranch();
      return;
    }
    if (item.dialogAction === "commit") {
      presentRoute(() =>
        navigation.navigate("GitCommit", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          ...repositoryParams,
        }),
      );
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const rowStatusDetail = (item: GitActionMenuItem): string | undefined => {
    const status = gitStatus.data;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return tn(fileCount, "{count} file changed", "{count} files changed");
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return tn(ahead, "{count} commit ahead", "{count} commits ahead");
    }
    if (item.kind === "run_pull") {
      return tn(
        status.behindCount,
        "{count} commit behind upstream",
        "{count} commits behind upstream",
      );
    }
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return t("{label} #{number} {state}", {
        label: shortLabel,
        number: status.pr.number,
        state: status.pr.state ?? "open",
      });
    }
    return undefined;
  };

  const openRepository = (section: ThreadRepositorySection) => {
    const params = {
      environmentId: String(environmentId),
      threadId: String(threadId),
      repositoryCwd: section.cwd,
      repositoryName: section.name,
    };
    // A sheet swaps in place, so closing the repository or running an action lands on the thread.
    if (presentation === "sheet") {
      navigation.dispatch(StackActions.replace("GitOverview", params));
    } else {
      presentRoute(() => navigation.dispatch(StackActions.push("GitOverview", params)));
    }
  };

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  const content = (
    <NativeScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        ...groupedListInsets(isInspector),
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
      }}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
      }
    >
      {menuItems.length > 0 ? (
        <ListSection>
          {menuItems.map((item) => (
            <ListRow
              key={`${item.id}-${item.label}`}
              icon={menuItemIconName(item.icon)}
              label={item.label}
              description={item.disabledReason ?? rowStatusDetail(item)}
              disabled={item.disabled}
              onPress={() => void onPressMenuItem(item)}
            />
          ))}
        </ListSection>
      ) : null}

      {listsRepositories ? (
        <ThreadRepositoryRows
          threadRef={threadRef}
          projectId={selectedThreadProject.id}
          threadCwd={selectedThreadCwd}
          taskFolder={taskFolder}
          reachesTracked={reachesTracked}
          onTaskFolderChange={taskFolderQuery.refresh}
          explainsEmpty={!isRepo}
          onOpen={openRepository}
        />
      ) : null}

      {repository === undefined || isPinnedRepository ? (
        <ListSection>
          {repository === undefined ? (
            <>
              <ListRow
                icon="text.bubble"
                label={t("Review changes")}
                description={
                  trackedRepositoryCount > 0
                    ? t("Inspect turn diffs")
                    : t("Inspect changes, uncommitted edits, and turn diffs")
                }
                disabled={busy || !(isRepo || trackedRepositoryCount > 0)}
                onPress={() => {
                  const params = { environmentId, threadId };
                  if (presentation === "sheet") {
                    navigation.dispatch(StackActions.replace("ThreadReview", params));
                  } else {
                    presentRoute(() =>
                      navigation.dispatch(CommonActions.navigate("ThreadReview", params)),
                    );
                  }
                }}
              />
              <ListRow
                icon="point.topleft.down.curvedto.point.bottomright.up"
                label={t("Branches & worktrees")}
                description={
                  canChangeThreadBranch
                    ? t("Switch branch, create branch, or move to a worktree")
                    : t("View branches and worktrees")
                }
                disabled={busy || !isRepo}
                onPress={() =>
                  presentRoute(() =>
                    navigation.navigate("GitBranches", {
                      environmentId: String(environmentId),
                      threadId: String(threadId),
                    }),
                  )
                }
              />
              {linkedPrActions.canLink ? (
                <ListRow
                  icon="link"
                  label={t("Link {term}", { term: linkedPrActions.terminology.singular })}
                  description={t("Attach a {term} by URL or number", {
                    term: linkedPrActions.terminology.singular,
                  })}
                  onPress={linkedPrActions.promptLink}
                />
              ) : null}
            </>
          ) : isPinnedRepository ? (
            <ListRow
              icon="pin.slash"
              label={t("Remove from this thread")}
              description={t("The repository stays tracked by the project")}
              disabled={busy}
              onPress={() => {
                unpinRepositoryFromThread(threadRef, repository.key);
                navigation.goBack();
              }}
            />
          ) : null}
        </ListSection>
      ) : null}

      {repository === undefined && linkedPrLines.length > 0 ? (
        <ListSection title={t("Linked {terms}", { terms: linkedPrActions.terminology.plural })}>
          {linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={openPullRequest}
              actions={linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}

      {currentWorktreePath ? (
        <ListSection title={t("Worktree")}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {currentWorktreePath}
          </Text>
        </ListSection>
      ) : null}
    </NativeScrollView>
  );

  const refresh = {
    accessibilityLabel: t("Refresh repository status"),
    disabled: busy || isRefreshing,
    onPress: () => void handleRefresh(),
  };

  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={currentBranchLabel}
        subtitle={currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={refresh}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
