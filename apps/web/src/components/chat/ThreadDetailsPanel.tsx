import {
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, useState, type ComponentProps } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ThreadAgentActionsPanel } from "./ThreadAgentActionsPanel";
import { ThreadDetailsSummary } from "./ThreadDetailsSummary";
import { ThreadOutlinePanel } from "./ThreadOutlinePanel";
import { ThreadTasksPanel } from "./ThreadTasksPanel";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import {
  ThreadDetailsContext,
  ThreadDetailsUsage,
  type ThreadDetailsUsageInput,
} from "./ThreadDetailsUsage";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import { resolveThreadDetailsVisibility, THREAD_DETAILS_ITEMS } from "./threadDetailsItems";
import { useClientSettings } from "../../hooks/useSettings";
import { useBrowserAssistants } from "../../browser/browserAssistants";
import { usePreviewAvailable } from "../../browser/previewRuntime";
import { useEnvironmentScope } from "../../state/session";
import { ThreadAssistantsControl } from "./ThreadAssistantsControl";
import { cn } from "../../lib/utils";
import { SlidersHorizontalIcon } from "lucide-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { Menu, MenuPopup } from "../ui/menu";
import { t } from "~/i18n";

const GitActionsControl = memo(BaseGitActionsControl);

const THREAD_DETAILS_CONTROLS_EXPANDED_KEY = "t3code:thread-details:controls-expanded";

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
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
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
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  usage: ThreadDetailsUsageInput;
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
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [controlsExpanded, setControlsExpanded] = useLocalStorage(
    THREAD_DETAILS_CONTROLS_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // A draft picks its machine and branch here before it is sent, so it keeps every control open.
  const foldsControls =
    props.draftId === undefined &&
    (visible.environment ||
      visible.openIn ||
      visible.scripts ||
      visible.assistants ||
      visible.branch ||
      visible.gitActions ||
      visible.changes);
  const showControls = props.draftId !== undefined || controlsExpanded;
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts && visible.scripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const assistants = useBrowserAssistants();
  const previewAvailable = usePreviewAvailable(props.environmentId);
  const canOperatePreview = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
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
            !props.draftId &&
            assistants.length > 0 &&
            previewAvailable &&
            canOperatePreview,
          branch: props.gitCwd !== null && props.isGitRepo && visible.branch,
          git:
            props.gitCwd !== null &&
            props.activeProjectName !== undefined &&
            (visible.gitActions || (visible.changes && props.isGitRepo)),
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
                    onToggle={() => setControlsExpanded((expanded) => !expanded)}
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
                        fileScripts={fileScripts}
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

              {showControls && props.gitCwd && (show.branch || show.git) ? (
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
                    {show.git ? (
                      <GitActionsControl
                        compact={density !== "full"}
                        showActions={visible.gitActions}
                        showChanges={visible.changes}
                        gitCwd={props.gitCwd}
                        activeThreadRef={activeThreadRef}
                        {...(props.draftId ? { draftId: props.draftId } : {})}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {!props.draftId && visible.tasks ? (
                <ThreadTasksPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {props.agentActions && visible.agentActions ? (
                <ThreadAgentActionsPanel
                  isGitRepo={props.isGitRepo}
                  hasChanges={props.agentActions.hasChanges}
                  unavailableReason={props.agentActions.unavailableReason}
                  onAsk={props.agentActions.onAsk}
                />
              ) : null}

              {density === "full" && !props.draftId && visible.servers ? (
                <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {density === "full" && !props.draftId && visible.automations ? (
                <ThreadAutomationsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                />
              ) : null}

              {density === "full" && !props.draftId && (visible.lineage || visible.sideChats) ? (
                <ThreadRelationshipsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  showLineage={visible.lineage}
                  showSideChats={visible.sideChats}
                />
              ) : null}

              {!props.draftId && visible.outline ? (
                <ThreadOutlinePanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {visible.usage ? <ThreadDetailsUsage {...props.usage} /> : null}

              {visible.context && props.usage.contextWindow ? (
                <ThreadDetailsContext usage={props.usage.contextWindow} />
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
