import { t } from "~/i18n";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import {
  machineAvailability,
  machineShowsLastKnownState,
} from "@t3tools/client-runtime/connection";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { useRightPanelStore } from "../rightPanelStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ContextMenuItem,
  type EnvironmentId,
  type VcsRef,
  type ThreadId,
} from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useOptimistic,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { useDebouncedValue, usePaginatedBranches } from "../state/queries";
import { useEnvironmentConnectionSummary } from "../state/environments";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsPrRows } from "./chat/ThreadDetailsPrRows";
import { parsePullRequestReference } from "@t3tools/client-runtime/pull-request-link-input";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
  shouldOfferCreateRef,
} from "./BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";

import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { ComposerControl } from "./chat/ComposerControl";
import { MiddleTruncate } from "./ui/middle-truncate";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface BranchToolbarBranchSelectorHandle {
  open: () => void;
}

interface BranchToolbarBranchSelectorProps {
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

const BRANCH_SEARCH_DEBOUNCE_MS = 150;
const EMPTY_REFS: ReadonlyArray<VcsRef> = [];

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t("An error occurred.");
}

export function BranchToolbarBranchSelector({
  forceNewWorktree = false,
  ref,
  className,
  displayMode = "toolbar",
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const updateEmptyThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const serverThread = useQuietThreadShell(threadRef);
  const serverSession = serverThread?.runtime ?? null;
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = forceNewWorktree
    ? null
    : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
  const canUpdateThreadBranch = !hasServerThread || canOperateThread;
  const canChangeThreadBranch = canWriteSourceControl && canUpdateThreadBranch;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  const setThreadBranch = (
    branch: string | null,
    worktreePath: string | null,
    automatic = false,
  ) => {
    if (
      !activeThreadId ||
      !activeProject ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    )
      return;
    if (serverSession && worktreePath !== activeWorktreePath) {
      void stopThreadSession({
        environmentId,
        input: { threadId: activeThreadId },
      });
    }
    if (hasServerThread) {
      void (automatic ? updateEmptyThreadMetadata : updateThreadMetadata)({
        environmentId,
        input: {
          threadId: activeThreadId,
          branch,
          worktreePath,
          ...(automatic ? { expectedEmpty: true } : {}),
        },
      });
    }
    if (hasServerThread) {
      onActiveThreadBranchOverrideChange?.(branch);
      return;
    }
    const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
      nextWorktreePath: worktreePath,
      currentWorktreePath: activeWorktreePath,
      effectiveEnvMode,
    });
    setDraftThreadContext(draftId ?? threadRef, {
      branch,
      worktreePath,
      envMode: nextDraftEnvMode,
      environmentSelection: automatic ? (draftThread?.environmentSelection ?? "auto") : "manual",
      projectRef: scopeProjectRef(environmentId, activeProject.id),
    });
  };

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");

  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const trimmedBranchQuery = branchQuery.trim();
  // Substring search needs sanitized names to detect new-branch collisions; refs cannot contain ASCII
  // spaces.
  const newRefName = sanitizeNewRefName(trimmedBranchQuery);
  const searchedQuery = useDebouncedValue(newRefName, BRANCH_SEARCH_DEBOUNCE_MS);
  const branchRefState = usePaginatedBranches({
    environmentId,
    cwd: branchCwd,
    query: searchedQuery,
  });
  const searchedRefs = branchRefState.data === null ? null : branchRefState.refs;
  // Kept from earlier renders: a new search keeps showing the last list, filtered here, until it answers.
  const [heldRefs, setHeldRefs] = useState<{
    readonly cwd: string | null;
    readonly query: string;
    readonly refs: ReadonlyArray<VcsRef>;
  } | null>(null);
  if (
    searchedRefs !== null &&
    (heldRefs === null || heldRefs.cwd !== branchCwd || heldRefs.query !== searchedQuery)
  ) {
    setHeldRefs({ cwd: branchCwd, query: searchedQuery, refs: searchedRefs });
  }
  const refs = searchedRefs ?? (heldRefs?.cwd === branchCwd ? heldRefs.refs : EMPTY_REFS);
  const branchByName = new Map(refs.map((refName) => [refName.name, refName] as const));
  const searchSettled = searchedRefs !== null && searchedQuery === newRefName;
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  // A switch would move the checkout the agent is editing, and a ref in another worktree stops its turn.
  const turnActive = threadRuntimeIsActive(serverSession);
  const checkoutPullRequestItemValue =
    canChangeThreadBranch && prReference && onCheckoutPullRequestRequest
      ? `__checkout_pull_request__:${prReference}`
      : null;
  const createBranchItemValue =
    canChangeThreadBranch &&
    !isSelectingWorktreeBase &&
    shouldOfferCreateRef({
      newRefName,
      searchedQuery,
      searchedRefNames:
        searchedRefs === null ? null : new Set(searchedRefs.map((refName) => refName.name)),
    })
      ? `__create_new_branch__:${trimmedBranchQuery}`
      : null;
  const defaultBranchName = searchedRefs?.find((refName) => refName.isDefault)?.name ?? null;
  const branchPickerItems = [
    ...(checkoutPullRequestItemValue ? [checkoutPullRequestItemValue] : []),
    ...refs.map((refName) => refName.name),
    ...(createBranchItemValue ? [createBranchItemValue] : []),
  ];
  const filteredBranchPickerItems =
    normalizedBranchQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) =>
          shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery: normalizedBranchQuery,
            createBranchItemValue,
            checkoutPullRequestItemValue,
          }),
        );
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const connection = useEnvironmentConnectionSummary(environmentId);
  const availability = connection ? machineAvailability(connection.connectionState) : null;
  const machineUnreachable = availability !== null && machineShowsLastKnownState(availability);
  const currentGitBranch =
    branchStatusQuery.data?.refName ??
    searchedRefs?.find((refName) => refName.current)?.name ??
    null;
  const sourceControlPresentation = getSourceControlPresentation(
    branchStatusQuery.data?.sourceControlProvider,
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const listedActiveBranch =
    resolvedActiveBranch === null ? null : (branchByName.get(resolvedActiveBranch) ?? null);
  const activeBranchRefQuery = useEnvironmentQuery(
    branchCwd !== null && resolvedActiveBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: branchCwd,
            query: resolvedActiveBranch,
            limit: 10,
          },
        })
      : null,
  );
  const queriedActiveBranch = activeBranchRefQuery.data?.refs.find(
    (refName) => refName.name === resolvedActiveBranch,
  );
  const resolvedActiveBranchIsRemote =
    listedActiveBranch !== null
      ? listedActiveBranch.isRemote === true
      : queriedActiveBranch
        ? queriedActiveBranch.isRemote === true
        : null;
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const totalBranchCount = branchRefState.data?.totalCount ?? 0;
  const branchStatusText = turnActive
    ? t("Branches can't change while the agent is working.")
    : machineUnreachable
      ? availability === "error"
        ? t("Can't connect to this machine.")
        : refs.length > 0
          ? t("This machine is offline. Showing the last known refs.")
          : t("This machine is offline. Refs load when it reconnects.")
      : (branchRefState.error ??
        (!searchSettled && branchCwd !== null
          ? t("Loading refs...")
          : isFetchingNextPage
            ? t("Loading more refs...")
            : hasNextPage
              ? t("Showing {count} of {total} refs", {
                  count: refs.length,
                  total: totalBranchCount,
                })
              : null));

  const copyBranchName = (branchName: string) => {
    void writeTextToClipboard(branchName, t("branch name")).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: t("Branch name copied"),
          description: branchName,
        });
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to copy branch name"),
            description: toBranchActionErrorMessage(error),
          }),
        );
      },
    );
  };

  const handleBranchContextMenu = (event: ReactMouseEvent, branchName: string | null) => {
    if (!branchName) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    const items: ContextMenuItem<"copy-branch-name">[] = [
      { id: "copy-branch-name", label: t("Copy branch name"), icon: "copy" },
    ];
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
      if (action === "copy-branch-name") copyBranchName(branchName);
    });
  };

  const runBranchAction = (action: () => Promise<void>) => {
    if (
      !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Action unavailable"),
          description: t("This connection cannot change the thread's branch."),
        }),
      );
      return;
    }
    startBranchActionTransition(async () => {
      await action();
      branchRefState.refresh();
      branchStatusQuery.refresh();
    });
  };

  const selectBranch = (refName: VcsRef) => {
    if (
      !canUpdateThreadBranch ||
      !branchCwd ||
      !activeProjectCwd ||
      isBranchActionPending ||
      turnActive
    )
      return;

    if (isSelectingWorktreeBase) {
      setThreadBranch(refName.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      refName,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name)
      : refName.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(selectedBranchName);
      const checkoutResult = await switchRef({
        environmentId,
        input: {
          cwd: selectionTarget.checkoutCwd,
          refName: refName.name,
        },
      });
      if (checkoutResult._tag === "Success") {
        const nextBranchName = refName.isRemote
          ? (checkoutResult.value.refName ?? selectedBranchName)
          : selectedBranchName;
        setOptimisticBranch(nextBranchName);
        setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to switch ref."),
            description: toBranchActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    if (!canChangeThreadBranch) return;
    const name = sanitizeNewRefName(rawName);
    if (!branchCwd || !name || isBranchActionPending || turnActive) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      const createBranchResult = await createRefMutation({
        environmentId,
        input: {
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        },
      });
      if (createBranchResult._tag === "Success") {
        setOptimisticBranch(createBranchResult.value.refName);
        setThreadBranch(createBranchResult.value.refName, activeWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(createBranchResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to create and switch ref."),
            description: toBranchActionErrorMessage(squashAtomCommandFailure(createBranchResult)),
          }),
        );
      }
    });
  };

  const worktreeBaseBranchCandidate =
    searchedRefs === null ? null : (defaultBranchName ?? currentGitBranch);

  // The server sets started threads' branches; defaulting here would detach the agent from its worktree.
  const threadStarted = serverSession !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a default base branch to the server thread or draft once branches load for a new worktree thread
  useEffect(() => {
    if (
      threadStarted ||
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !worktreeBaseBranchCandidate
    ) {
      return;
    }
    setThreadBranch(worktreeBaseBranchCandidate, null, true);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    effectiveEnvMode,
    setThreadBranch,
    threadStarted,
    worktreeBaseBranchCandidate,
  ]);

  const handleOpenChange = (open: boolean) => {
    setIsBranchMenuOpen(open);
    if (open && !isBranchMenuOpen && branchCwd !== null) {
      void refreshStatus({ environmentId, input: { cwd: branchCwd, localOnly: true } });
    }
    if (!open) {
      setBranchQuery("");
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (isBranchActionPending) return;
        handleOpenChange(true);
      },
    }),
    [handleOpenChange, isBranchActionPending],
  );

  const triggerLabel = resolveBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  });

  const branchPrBranch = resolveBranchToolbarPrBranch({
    activeThreadBranch,
    resolvedActiveBranch,
  });
  const branchPr =
    branchPrBranch !== null && branchStatusQuery.data?.refName === branchPrBranch
      ? (branchStatusQuery.data.pr ?? null)
      : null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId);
  const linkedStatus = useLinkedThreadPullRequest(
    environmentId,
    serverThread?.linkedPullRequest,
    true,
    serverThread?.pullRequests,
    serverThread?.branchPullRequest,
  );
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(serverThread?.pullRequests ?? [])
    : null;
  const prBadge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(serverThread?.pullRequests)
    : null;
  const displayedPr = linkedStatus?.pr ?? (currentLinkedPr === null ? branchPr : null);
  const displayedPrStatus = prStatusIndicator(
    displayedPr,
    linkedStatus?.sourceControlProvider ?? branchStatusQuery.data?.sourceControlProvider,
  );
  const prNumber = currentLinkedPr?.number ?? displayedPr?.number;
  const prUrl = currentLinkedPr?.url ?? displayedPr?.url;
  const openPrLink = useOpenPrLink(threadRef);
  const panelPrLabel =
    prNumber === undefined
      ? ""
      : `#${prNumber}${displayedPr?.title.trim() ? `: ${displayedPr.title}` : ""}`;

  function selectPickerItem(itemValue: string) {
    if (itemValue === checkoutPullRequestItemValue && prReference && onCheckoutPullRequestRequest) {
      handleOpenChange(false);
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(prReference);
    } else if (itemValue === createBranchItemValue) {
      createRef(trimmedBranchQuery);
    } else {
      const refName = branchByName.get(itemValue);
      if (refName) selectBranch(refName);
    }
  }

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                {t("Checkout {kind}", { kind: sourceControlPresentation.terminology.singular })}
              </span>
              <span className="truncate text-muted-foreground text-xs">{prReference}</span>
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          disabled={turnActive}
          onClick={() => selectPickerItem(itemValue)}
        >
          <span className="truncate">{t('Create new ref "{name}"', { name: newRefName })}</span>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    return (
      <BranchPickerRefItem
        branch={refName}
        projectCwd={activeProjectCwd}
        index={index}
        value={itemValue}
        disabled={
          !canUpdateThreadBranch ||
          turnActive ||
          (!canWriteSourceControl &&
            !isSelectingWorktreeBase &&
            (!activeProjectCwd ||
              !resolveBranchSelectionTarget({
                activeProjectCwd,
                activeWorktreePath,
                refName,
              }).reuseExistingWorktree))
        }
        onClick={() => selectPickerItem(itemValue)}
        onContextMenu={(event) => handleBranchContextMenu(event, itemValue)}
      />
    );
  }

  return (
    <BranchPicker
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      open={isBranchMenuOpen}
      onOpenChange={handleOpenChange}
      onSelectItem={selectPickerItem}
      value={resolvedActiveBranch}
      query={branchQuery}
      onQueryChange={setBranchQuery}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadNext={branchRefState.loadNext}
      statusText={branchStatusText}
      statusAction={
        branchRefState.error !== null && !turnActive && !machineUnreachable
          ? { label: t("Try again"), onAction: branchRefState.refresh }
          : undefined
      }
      settled={searchSettled}
      renderItem={renderPickerItem}
      getItemType={(item) =>
        item === checkoutPullRequestItemValue
          ? "checkout-pull-request"
          : item === createBranchItemValue
            ? "create-branch"
            : "branch"
      }
      originControl={
        isSelectingWorktreeBase
          ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
          : undefined
      }
      popupProps={{
        align: displayMode === "panel" ? "start" : "end",
        side: displayMode === "panel" ? "bottom" : "top",
        className: cn("flex flex-col", displayMode === "panel" ? "w-(--anchor-width)" : "w-80"),
        ...(displayMode === "toolbar" ? composerFloatingLayerProps : {}),
      }}
    >
      <div
        className={cn(
          "flex min-w-0",
          displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
          className,
        )}
      >
        {displayMode !== "panel" ? (
          <ThreadPullRequestBadgeControl
            render={<ComposerControl size="xs" />}
            badge={prBadge}
            pullRequests={serverThread?.pullRequests ?? []}
            number={prNumber}
            url={prUrl}
            status={displayedPrStatus}
            onOpenList={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
            onOpenPullRequest={(event, targetUrl = prUrl) => {
              if (targetUrl) openPrLink(event, targetUrl);
            }}
          />
        ) : null}
        <span
          className="flex min-w-0"
          onMouseDownCapture={(event) => {
            if (event.button !== 0 || event.ctrlKey) {
              event.stopPropagation();
            }
          }}
          onContextMenu={(event) => handleBranchContextMenu(event, resolvedActiveBranch)}
        >
          <ComboboxTrigger
            render={
              displayMode === "panel" ? (
                <ThreadDetailsControl part="select" />
              ) : (
                <ComposerControl size="xs" />
              )
            }
            className="min-w-0 max-w-full active:scale-100"
            disabled={isBranchActionPending}
          >
            <GitBranchIcon
              className={cn(
                "size-3 shrink-0",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
              )}
            />
            <ComposerContextLabel displayMode={displayMode}>
              <MiddleTruncate value={triggerLabel} variant="cap-aligned" className="w-full" />
            </ComposerContextLabel>
          </ComboboxTrigger>
        </span>
        {displayMode === "panel" && prNumber !== undefined && prUrl !== undefined ? (
          <ThreadDetailsPrRows
            threadRef={threadRef}
            links={serverThread?.pullRequests ?? []}
            currentLink={currentLinkedPr}
            onOpenLink={openPrLink}
            environmentId={environmentId}
            pr={displayedPr}
            number={prNumber}
            reference={currentLinkedPr}
            status={displayedPrStatus}
            project={activeProject}
            label={panelPrLabel}
            openAriaLabel={t("Open {kind} #{number}", {
              kind: sourceControlPresentation.terminology.singular,
              number: prNumber,
            })}
            onOpen={(event) => openPrLink(event, prUrl)}
            onActed={() => branchStatusQuery.refresh()}
          />
        ) : null}
      </div>
    </BranchPicker>
  );
}
