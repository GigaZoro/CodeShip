import { t } from "~/i18n";
import {
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import type { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl from "../ProjectScriptsControl";
import type {
  ProjectScriptSaveInput,
  ProjectScriptSaveResult,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import { useState, type ComponentProps } from "react";
import { ThreadAgentActionsPanel } from "./ThreadAgentActionsPanel";
import { ThreadAgentStatusPanel } from "./ThreadAgentStatusPanel";
import { ThreadMachineLoadPanel } from "./ThreadMachineLoadPanel";
import { ThreadDetailsSummary } from "./ThreadDetailsSummary";
import { ThreadOutlinePanel } from "./ThreadOutlinePanel";
import { ThreadTasksPanel } from "./ThreadTasksPanel";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadRepositorySections } from "./ThreadRepositorySections";
import { ThreadServersPanel } from "./ThreadServersPanel";
import {
  ThreadDetailsContext,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import {
  resolveThreadDetailsVisibility,
  THREAD_DETAILS_ITEMS,
  threadDetailsVisibilityFor,
} from "./threadDetailsItems";
import { useClientSettings } from "../../hooks/useSettings";
import { useBrowserAssistants } from "../../browser/browserAssistants";
import { usePreviewAvailable } from "../../browser/previewRuntime";
import { useEnvironmentScope } from "../../state/session";
import { ThreadAssistantsControl } from "./ThreadAssistantsControl";
import { useProject, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { cn } from "../../lib/utils";
import { SlidersHorizontalIcon } from "lucide-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { Menu, MenuPopup } from "../ui/menu";

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  /** False when no worktree can come from this folder, so it offers no workspace modes. */
  offersWorkspaceModes: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  /** Omitted when this client cannot run terminal commands. */
  onRunProjectScript?: ((script: ProjectScript) => void) | undefined;
  onAddProjectScript: (input: ProjectScriptSaveInput) => Promise<ProjectScriptSaveResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: ProjectScriptSaveInput,
  ) => Promise<ProjectScriptSaveResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptSaveResult>;
  usage: ThreadDetailsUsageInput;
  /** The model and reasoning effort the thread runs on, as the composer labels them. */
  model: { readonly label: string; readonly effortLabel: string | null };
  /** The thread as the chat shows it; null on a draft. */
  threadShell: ComponentProps<typeof ThreadAgentStatusPanel>["shell"];
  /** Sends a request to the thread's agent; null hides the actions, as on a draft or before the thread has started. */
  agentActions: {
    readonly onAsk: (prompt: string) => void;
    /** False when git shows no changes to commit or review; null when unknown. */
    readonly hasChanges: boolean | null;
    /** Why the agent cannot take a message now, or null when it can. */
    readonly unavailableReason: string | null;
  } | null;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const isDraft = props.draftId !== undefined;
  const visible = threadDetailsVisibilityFor(
    useClientSettings(resolveThreadDetailsVisibility),
    isDraft,
  );
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  // The card opens information-first: the controls fold again for every thread.
  const threadKey = `${props.environmentId}:${props.threadId}`;
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // The panel outlives a thread switch, so leaving a thread forgets that it was expanded.
  if (expandedKey !== null && expandedKey !== threadKey) setExpandedKey(null);
  const controlsExpanded = expandedKey === threadKey;
  // A draft picks its machine and branch here before it is sent, so it keeps those controls open.
  const foldsControls =
    !isDraft &&
    (visible.environment ||
      visible.openIn ||
      visible.scripts ||
      visible.assistants ||
      visible.branch ||
      visible.gitActions ||
      visible.changes);
  const showControls = isDraft || controlsExpanded;
  const t3File = useT3ProjectFileState(
    props.environmentId,
    props.activeProjectScripts && visible.scripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const assistants = useBrowserAssistants();
  const previewAvailable = usePreviewAvailable(props.environmentId);
  const canOperatePreview = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const serverConfig = useServerConfigs().get(props.environmentId);
  const tracksFolders = (project?.trackedFolders?.length ?? 0) > 0;
  // A worktree thread reaches tracked repositories only through its own task folder.
  const taskFolderQuery = useEnvironmentQuery(
    // Asked whatever the project tracks now: a thread keeps its task folder when that changes.
    props.isServerThread && props.worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // A task folder's plain project directory can sit inside someone else's repository.
  const folderIsRepo = props.isGitRepo && taskFolder?.projectIsWorktree !== false;
  // A No project thread's folder sits inside the shared scratch root, so it must never get git.
  // Until the config and project load, a No project thread looks like any other folder.
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  const branchToolbarProps = {
    showGitControls: folderIsRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      contentKey={`${THREAD_DETAILS_ITEMS.filter((item) => visible[item.id])
        .map((item) => item.id)
        .join(",")}:${showControls ? "controls" : "folded"}`}
      onContextMenu={(event) => {
        // Popups the card opens bubble here through React; they, fields, links, and selected text
        // keep their own menus.
        const target = event.target;
        const selection = window.getSelection();
        if (
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          target.closest("input, textarea, [contenteditable], a[href]") ||
          (selection &&
            !selection.isCollapsed &&
            (event.currentTarget.contains(selection.anchorNode) ||
              event.currentTarget.contains(selection.focusNode)))
        )
          return;
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {(density) => {
        // Section flags follow the rows that will render, so no empty section steals the divider rule.
        const show = {
          environment: density === "full" && visible.environment,
          openIn: density !== "essential" && visible.openIn && props.showOpenInPicker,
          scripts: visible.scripts && props.activeProjectScripts !== undefined,
          assistants:
            density !== "essential" &&
            visible.assistants &&
            assistants.length > 0 &&
            previewAvailable &&
            canOperatePreview,
          branch: offersGit && folderIsRepo && visible.branch,
          // Without a branch selector, linked pull requests still need somewhere to show.
          pullRequests: !(offersGit && folderIsRepo) && visible.branch,
          // A plain folder that tracks repositories is not asked to become one itself.
          git:
            offersGit &&
            props.activeProjectName !== undefined &&
            (folderIsRepo || (!tracksFolders && taskFolder === null)) &&
            (visible.gitActions || (visible.changes && folderIsRepo)),
          // Also for a project that tracks nothing: a thread can change a submodule.
          repositories: offersGit && density !== "essential" && visible.gitActions,
        };
        return (
          <>
            <div className="group/details-items">
              {foldsControls ? (
                <ThreadDetailsSection
                  headingId="thread-details-summary-heading"
                  title={t("Workspace summary")}
                  separated={false}
                  showHeading={false}
                >
                  <ThreadDetailsSummary
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    gitCwd={props.gitCwd}
                    isGitRepo={props.isGitRepo}
                    expanded={controlsExpanded}
                    onToggle={() => setExpandedKey(controlsExpanded ? null : threadKey)}
                  />
                </ThreadDetailsSection>
              ) : null}

              {showControls &&
              (show.environment || show.openIn || show.scripts || show.assistants) ? (
                <ThreadDetailsSection
                  headingId="thread-details-workspace-heading"
                  title={t("Workspace")}
                  separated={foldsControls}
                  showHeading={false}
                >
                  <div className="flex flex-col">
                    {show.environment ? (
                      <BranchToolbar
                        layout="panel"
                        panelSection="workspace"
                        availableEnvironments={props.availableEnvironments}
                        {...(props.onEnvironmentChange
                          ? { onEnvironmentChange: props.onEnvironmentChange }
                          : {})}
                        autoEnvironmentLabel={props.autoEnvironmentLabel}
                        onAutoEnvironment={props.onAutoEnvironment}
                        {...branchToolbarProps}
                        // Workspace modes follow the composer's rule, not this folder's own status.
                        showGitControls={props.offersWorkspaceModes}
                      />
                    ) : null}

                    {show.openIn ? (
                      <OpenInPicker
                        keybindings={props.keybindings}
                        environmentId={props.environmentId}
                        availableEditors={props.availableEditors}
                        openInCwd={props.gitCwd}
                        enableShortcut={props.openInShortcutEnabled}
                        displayMode="panel"
                      />
                    ) : null}

                    {show.scripts && props.activeProjectScripts ? (
                      <ProjectScriptsControl
                        environmentId={props.environmentId}
                        scripts={props.activeProjectScripts}
                        fileScripts={t3File.scripts}
                        onActionsMenuOpen={t3File.refresh}
                        preferredScriptId={props.preferredScriptId}
                        onRunScript={props.onRunProjectScript}
                        onAddScript={props.onAddProjectScript}
                        onUpdateScript={props.onUpdateProjectScript}
                        onDeleteScript={props.onDeleteProjectScript}
                      />
                    ) : null}

                    {show.assistants ? (
                      <ThreadAssistantsControl
                        threadRef={activeThreadRef}
                        assistants={assistants}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {showControls &&
              (show.branch || show.pullRequests || show.git || show.repositories) ? (
                <ThreadDetailsSection
                  headingId="thread-details-version-control-heading"
                  title={t("Version Control")}
                  showHeading={false}
                  separated={density === "full"}
                >
                  <div className="flex flex-col">
                    {show.branch ? (
                      <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                    ) : null}
                    {show.pullRequests ? (
                      <ThreadDetailsThreadPrRows
                        threadRef={activeThreadRef}
                        project={project}
                        composerTarget={props.composerDraftTarget}
                      />
                    ) : null}
                    {show.git && props.gitCwd ? (
                      <GitActionsControl
                        compact={density !== "full"}
                        showActions={visible.gitActions}
                        showChanges={visible.changes}
                        gitCwd={props.gitCwd}
                        name={props.activeProjectName ?? ""}
                        workspaceMutationId={props.workspaceMutationId}
                        activeThreadRef={activeThreadRef}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                    {show.repositories ? (
                      <ThreadRepositorySections
                        environmentId={props.environmentId}
                        threadId={props.threadId}
                        projectId={props.projectId}
                        isServerThread={props.isServerThread}
                        threadCwd={props.gitCwd}
                        taskFolder={taskFolder}
                        reachesTracked={
                          props.worktreePath === null ? tracksFolders : taskFolder !== null
                        }
                        onTaskFolderChange={taskFolderQuery.refresh}
                        explainsEmpty={!folderIsRepo}
                        showActions={visible.gitActions}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {visible.status ? (
                <ThreadAgentStatusPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  shell={props.threadShell}
                  workspaceRoot={props.gitCwd ?? undefined}
                  modelLabel={props.model.label}
                  effortLabel={props.model.effortLabel}
                />
              ) : null}

              {visible.context && props.usage.contextWindow ? (
                <ThreadDetailsContext usage={props.usage.contextWindow} />
              ) : null}

              {density === "full" && visible.usage ? <ThreadDetailsUsage {...props.usage} /> : null}

              {visible.tasks ? (
                <ThreadTasksPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {visible.lineage || visible.sideChats ? (
                <ThreadRelationshipsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  showLineage={visible.lineage}
                  showSideChats={visible.sideChats}
                />
              ) : null}

              {visible.outline ? (
                <ThreadOutlinePanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {density === "full" && visible.machineLoad ? (
                <ThreadMachineLoadPanel environmentId={props.environmentId} />
              ) : null}

              {density === "full" && visible.servers ? (
                <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {density === "full" && visible.automations ? (
                <ThreadAutomationsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                />
              ) : null}

              {density === "full" && props.agentActions && visible.agentActions ? (
                <ThreadAgentActionsPanel
                  isGitRepo={props.isGitRepo}
                  hasChanges={props.agentActions.hasChanges}
                  unavailableReason={props.agentActions.unavailableReason}
                  onAsk={props.agentActions.onAsk}
                />
              ) : null}

              {/* Shown only when no section above has content, so an emptied card can be refilled. */}
              <div className="p-2 group-has-[>section>:last-child:not(:empty)]/details-items:hidden">
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="row"
                  panel
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenuPosition({ x: rect.left, y: rect.bottom });
                  }}
                >
                  <SlidersHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                  <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                    {t("Choose what to show")}
                  </span>
                </ThreadDetailsControl>
              </div>
            </div>

            <Menu
              open={menuPosition !== null}
              onOpenChange={(open) => !open && setMenuPosition(null)}
            >
              <MenuPopup
                anchor={
                  menuPosition
                    ? {
                        getBoundingClientRect: () =>
                          new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                      }
                    : undefined
                }
                align="start"
                side="bottom"
              >
                <ThreadDetailsItemsMenuItems />
              </MenuPopup>
            </Menu>
          </>
        );
      }}
    </ThreadDetailsCard>
  );
}
