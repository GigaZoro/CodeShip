import { t, tx } from "~/i18n";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryLeafName,
  getCloneDirectoryPath,
  getDefaultCloneUrl,
  getNewProjectPathPreview,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  addProjectRemoteSourceLabel,
  buildAddProjectRemoteSourceReadiness,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  connectionStatusText,
  distinctEnvironmentLabels,
} from "@t3tools/client-runtime/connection";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@t3tools/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  SourceControlProviderKind,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ArrowLeftIcon,
  BlocksIcon,
  BugIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  LayoutGridIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PaletteIcon,
  ArchiveIcon,
  RotateCcwIcon,
  ServerIcon,
  SettingsIcon,
  ShapesIcon,
  SparklesIcon,
  MonitorIcon,
  NotebookPenIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TextSearchIcon,
  UserPlusIcon,
} from "lucide-react";
import { openThreadFind } from "./chat/threadFindStore";
import { stepTimelinePrompt } from "./chat/timelineOutlineStore";
import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { copyThreadReference } from "../lib/copyThreadReference";
import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../lib/workspaceFocus";
import {
  composerPromptLink,
  copyPromptLink,
  promptLinkRepositoryOf,
} from "./promptLinks/copyPromptLink";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useStartTriage } from "../hooks/useStartTriage";
import { pickTriageEnvironment } from "../lib/triageTarget";
import { useNewProject } from "../hooks/useNewProject";
import { useOrderWhileOpen } from "../hooks/useOrderWhileOpen";
import { reportProjectFailure, useProjectPin } from "../hooks/useProjectGroupUpdate";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useEnvironmentThreadRefs,
  useProjects,
  useServerConfigs,
  useVisibleThreadShells,
  waitForProject,
} from "../state/entities";
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isScratchProject,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@t3tools/client-runtime/state/projects";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import {
  resolveCommandPaletteProject,
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildRootGroups,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  newThreadNoProjectIndex,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteReturnContext,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  buildNestedSearchItems,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  RECENT_THREADS_GROUP,
  createCommandPaletteSearchState,
  type CommandPaletteGroup,
  resolveAddProjectEntry,
  type AddProjectCloneFlow,
  type AddProjectEnvironmentOption,
  errorMessage,
  getEnvironmentBrowsePlatform,
  remoteProjectInputPlaceholder,
  reduceCommandPaletteSearchState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  selectCommandPaletteClientSettings,
  useEnvironmentLookups,
  useProjectLookups,
  useSortedProjectGroups,
} from "./CommandPaletteLookups";
import {
  buildNewThreadInProjectItems,
  buildProjectSearchItems,
} from "./CommandPaletteProjectItems";
import {
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "./CommandPaletteAddProject";
import { useCommandPaletteThreadItems } from "./CommandPaletteThreadItems";
import { useCommandPaletteThemeItems } from "./CommandPaletteThemeItems";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Checkbox } from "./ui/checkbox";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { openLinkPullRequestDialog } from "./pullRequest/LinkPullRequestDialog";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import { useOpenSetupWizard } from "../onboarding/setupRerun";
import { hasSnoozeRows, useActiveThreadPaletteItems } from "./CommandPaletteThreadActions";
import { ThreadRenameDialogHost } from "./ThreadRenameDialog";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { suggestAppAccessForRemote } from "./sourceControlAppAccessToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectPickerEntries } from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useSideChat } from "./chat/useSideChat";
import { availableAgentActions, useAgentActionsTarget } from "./chat/agentActions";
import { useSidebarFolderControls } from "./sidebar/sidebarFolderControls";
import { threadRecentUse } from "@t3tools/shared/paletteSearch";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const ADD_PROJECT_ENTRY_GROUP = "add-project";
const NEW_THREAD_IN_GROUP = "projects";
// Its own view, so going Back and choosing "New thread in..." lists every machine again.
const NEW_THREAD_ON_MACHINE_GROUP_PREFIX = "projects-on:";

/** The submenu an open intent starts in; its groups resolve while rendering. */
function openIntentView(intent: CommandPaletteOpenIntent | null): CommandPaletteView | null {
  switch (intent?.kind) {
    case "add-project":
      return {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: ADD_PROJECT_ENTRY_GROUP, label: "", items: [] }],
      };
    case "new-thread-in":
      return {
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value:
              intent.environmentId === undefined
                ? NEW_THREAD_IN_GROUP
                : `${NEW_THREAD_ON_MACHINE_GROUP_PREFIX}${intent.environmentId}`,
            label: t("Projects"),
            items: [],
          },
        ],
      };
    case "change-theme":
      return {
        addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "themes", label: t("Change theme"), items: [] }],
      };
    case "search":
    case "recent-threads":
    case undefined:
      return null;
  }
}

const NEW_THREAD_NO_PROJECT_VALUE = "new-thread-in:no-project";

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          session={state.session}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openChildSearch={openChildSearch}
          initialContext={state.restoredSearch}
        />
      </CommandDialog>
      <ThreadRenameDialogHost />
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? t("File picker")
          : props.mode === "content"
            ? t("Search project contents")
            : t("Command palette")
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        if (!composer) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          key={props.session}
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openChildSearch={props.openChildSearch}
          initialContext={props.initialContext}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const navigate = useNavigate();
  const openSetupWizard = useOpenSetupWizard();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { openChildSearch, setOpen } = props;
  // Keyed by palette session: the intent and restored search only seed this
  // mount, and closing must not change what the closing palette shows.
  const [initialSearch] = useState(
    () =>
      props.initialContext ?? {
        query: props.openIntent?.kind === "search" ? props.openIntent.query : "",
        linkedThreadSearch: props.openIntent?.kind === "search" ? props.openIntent : null,
      },
  );
  const linkedThreadSearch = initialSearch.linkedThreadSearch;
  const [opensOnRecentThreads] = useState(() => props.openIntent?.kind === "recent-threads");
  const [newThreadMachineId] = useState(() =>
    props.openIntent?.kind === "new-thread-in" ? (props.openIntent.environmentId ?? null) : null,
  );
  // Rows were captured when the palette opened; drop any hidden since then.
  const hiddenKeys = useHiddenThreadKeys();
  const linkedEnvironmentId = linkedThreadSearch?.linkedThreads?.environmentId ?? null;
  const hidingAnywhere = useAnyEnvironmentHiding();
  const linkedThreadRefs = useEnvironmentThreadRefs(linkedEnvironmentId);
  const [searchState, dispatchSearch] = useReducer(reduceCommandPaletteSearchState, null, () => {
    const view = props.initialContext ? null : openIntentView(props.openIntent);
    return view
      ? { query: "", views: [{ view, parentQuery: "" }] }
      : createCommandPaletteSearchState(initialSearch.query);
  });
  const { query, views: viewStack } = searchState;
  const setQuery = (query: string) => dispatchSearch({ type: "query", query });
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // A pushed view drops the typed highlight until the user moves it again.
  const highlightClearedRef = useRef(viewStack.length > 0);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const startTriage = useStartTriage();
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const paletteRouteTarget = useThreadRouteTarget();
  const projects = useProjects();
  const referenceThreadRef =
    pathname === "/pull-requests"
      ? environments.some((environment) => environment.serverConfig !== null)
        ? PULL_REQUESTS_PANEL_REF
        : null
      : activeThread
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null;
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(referenceThreadRef);
  const agentActionsTarget = useAgentActionsTarget();
  const customAgentActions = useClientSettings((settings) => settings.customAgentActions);
  const sidebarFolderControls = useSidebarFolderControls();
  const activeThreadServerConfig = useServerConfigs().get(
    activeThread?.environmentId ?? ("" as EnvironmentId),
  );
  // Same offer as ChatView: side chats do not nest or start from subagents.
  const sideChat = useSideChat({
    threadRef:
      activeThread &&
      activeThread.lineage.sideChat !== true &&
      activeThread.lineage.relationshipToParent !== "subagent" &&
      activeThreadServerConfig?.environment.capabilities.sideChats === true
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : null,
    onError: (message) =>
      toastManager.add({
        type: "error",
        title: t("Could not start a side chat"),
        description: message,
      }),
  });
  const canShareActiveThreadWithGuest = useAtomValue(
    canShareWithGuestAtom(activeThread?.environmentId ?? ("" as EnvironmentId)),
  );
  const activeThreadReferenceCopyTarget =
    referenceThreadRef === null || (pathname === "/pull-requests" && !openPanelPullRequestUrl)
      ? null
      : resolveThreadReferenceCopyTarget({
          threadRef: referenceThreadRef,
          title: activeThread?.title ?? "",
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl:
            activeThread?.linkedPullRequest?.url ?? activeThread?.branchPullRequest?.url ?? null,
        });
  const copyActiveThreadReference = async () => {
    if (activeThreadReferenceCopyTarget === null) return;
    await copyThreadReference(activeThreadReferenceCopyTarget);
  };
  const threads = useVisibleThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activeThreadLifecycleItems = useActiveThreadPaletteItems(activeThread);
  const providersByEnvironment = useEnvironmentProviders();
  const { changeThemeItem, changeAppearanceItem, themeEditorItem } = useCommandPaletteThemeItems();
  const currentView = viewStack.at(-1)?.view ?? null;
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [newProjectFlow, setNewProjectFlow] = useState<{
    readonly environmentId: EnvironmentId;
    readonly sourcesEnvironmentId: EnvironmentId | null;
  } | null>(null);
  const [newProjectPublishes, setNewProjectPublishes] = useState(false);
  const [newProjectPublishKind, setNewProjectPublishKind] =
    useState<SourceControlProviderKind | null>(null);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);
  // State lags a render behind, so a repeated Enter could start a second create.
  const newProjectSubmittingRef = useRef(false);
  const createNewProject = useNewProject();
  const cloneLookupGeneration = useRef(0);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const { environmentLabelById, projectEnvironmentLocationById } = useEnvironmentLookups();
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: contextualProjectRef,
  });
  const pickerProjects = projectPickerEntries.map(({ group, targetProject }) => ({
    ...targetProject,
    displayName: group.displayName,
  }));
  const projectGroupByTargetKey = new Map(
    projectPickerEntries.map(({ group, targetProject }) => [
      `${targetProject.environmentId}:${targetProject.id}`,
      group,
    ]),
  );
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  // A row's target record can change when another machine's copy loads, so the kept
  // order follows the project group instead.
  const rowOrderKey = (prefix: string) => (item: CommandPaletteActionItem) =>
    projectGroupByTargetKey.get(item.value.slice(prefix.length + 1))?.projectKey ?? item.value;
  const projectPin = (project: CommandPaletteProject) => {
    const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
    return group && canPinProjectGroup(group)
      ? {
          name: group.displayName,
          pinned: group.pinned,
          toggle: () => toggleProjectGroupPin(group),
        }
      : null;
  };

  const addProjectEnvironmentOptions = (() => {
    const options = environments
      .filter((environment) => canCreateProjectInEnvironment(environment.connection.phase))
      .map((environment): AddProjectEnvironmentOption => {
        const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
        return {
          environmentId: environment.environmentId,
          label: resolveEnvironmentOptionLabel({
            isPrimary,
            environmentId: environment.environmentId,
            runtimeLabel: environment.label,
          }),
          isPrimary,
          machine: resolveEnvironmentMachineKind(environment.serverConfig),
          isConnected: canCreateProjectInEnvironment(environment.connection.phase),
          status: connectionStatusText(environment.connection),
        };
      });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  })();
  const defaultAddProjectEnvironmentId =
    addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;
  const wslAddProjectEnvironmentOption =
    addProjectEnvironmentOptions.find((option) => {
      if (!option.isConnected) {
        return false;
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === option.environmentId,
      );
      return environment
        ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
        : false;
    }) ?? null;
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const canCreateProject = useEnvironmentScope(browseEnvironmentId, AuthOrchestrationOperateScope);
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  const browseEnvironmentIsDesktopLocal =
    browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
  // pickFolder routes desktop-local environments by pool id, not catalog environmentId.
  const browseDesktopInstanceId = (() => {
    if (!browseEnvironmentIsDesktopLocal || browseEnvironment === null) {
      return null;
    }
    const displayUrl = browseEnvironment.displayUrl;
    if (displayUrl === null) {
      return null;
    }
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === displayUrl)?.id ?? null
    );
  })();
  const sourceControlDiscovery = useEnvironmentQuery(
    browseEnvironmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: browseEnvironmentId,
          input: {},
        }),
  );
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  const pinnedCloneDirectoryName =
    addProjectCloneFlow?.step === "confirm"
      ? getCloneDirectoryLeafName(
          addProjectCloneFlow.remoteUrl,
          environments.find(
            (candidate) => candidate.environmentId === addProjectCloneFlow.environmentId,
          )?.serverConfig?.settings.ghqCloneLayout === true,
          addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
        )
      : "";
  const canBrowsePaths =
    browseEnvironmentId !== null && !isRemoteProjectRepositoryStep && newProjectFlow === null;
  const browsePath = getFilesystemBrowsePath(query, browseEnvironmentPlatform, canBrowsePaths);
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = (environmentId: EnvironmentId | null): string => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    const environmentSettings = environment?.serverConfig?.settings ?? null;
    const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
    if (baseDirectory.length === 0) {
      return "~/";
    }
    return ensureBrowseDirectoryPath(baseDirectory);
  };

  const { projectByKey } = useProjectLookups();

  const activeThreadKey = activeThread
    ? scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))
    : null;
  const supportsThreadFind =
    environments.find((environment) => environment.environmentId === activeThread?.environmentId)
      ?.serverConfig?.threadFind === true;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const scratchTargetEnvironmentId = scratchEnvironmentId(currentProjectEnvironmentId);
  const supportsTriage = (environmentId: EnvironmentId | null) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.triage === true;
  const triageEnvironmentId = pickTriageEnvironment({
    onScreen: currentProjectEnvironmentId,
    primary: primaryEnvironmentId,
    connected: environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
    supportsTriage,
  });
  const canTriage =
    useAtomValue(serverEnvironment.prepareTriage.permissionAtom(triageEnvironmentId)) &&
    supportsTriage(triageEnvironmentId);
  const currentProject = resolveCommandPaletteProject(
    projectByKey,
    currentProjectEnvironmentId,
    currentProjectId,
  );
  const currentProjectCwd = currentProject?.workspaceRoot ?? null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = (environmentId: EnvironmentId | null): string | null =>
    environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseAccess = useFilesystemReadAccess(browseEnvironmentId);
  const hasBrowseTarget =
    isBrowsing &&
    browsePath.directoryPath.length > 0 &&
    browseEnvironmentId !== null &&
    !relativePathNeedsActiveProject;
  const browseQuery = useEnvironmentQuery(
    browseAccess.canReadFiles && hasBrowseTarget
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = hasBrowseTarget && (browseAccess.isPending || browseQuery.isPending);
  const browseAccessError =
    hasBrowseTarget && !browseAccess.isPending && !browseAccess.canReadFiles
      ? (browseAccess.error ?? t("This connection cannot browse host folders."))
      : null;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } =
    pinnedCloneDirectoryName
      ? filterPinnedBrowseEntries({
          browseEntries,
          filterQuery: browsePath.filterQuery,
          pinnedDirectoryName: pinnedCloneDirectoryName,
          caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
        })
      : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery);

  const prefetchBrowsePath = async (
    partialPath: string,
    environmentId: EnvironmentId | null = browseEnvironmentId,
    cwd: string | null = currentProjectCwdForBrowse,
  ): Promise<void> => {
    if (!environmentId) {
      return;
    }
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
      !canPreloadBrowsePath(environment?.connection.phase)
    ) {
      return;
    }

    await loadBrowsePath({
      environmentId,
      input: {
        partialPath,
        ...(cwd ? { cwd } : {}),
      },
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the browse navigation coordinator and in-flight clone lookups when the palette session unmounts
  useEffect(
    () => () => {
      browseNavigation.invalidate();
      // A replaced or closed session must not report its in-flight lookup.
      cloneLookupGeneration.current += 1;
    },
    [browseNavigation],
  );

  const openProjectFromSearch = async (project: (typeof projects)[number]) => {
    const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
    const groupedProjectKeys = group
      ? new Set(
          group.memberProjectRefs.map(
            (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
          ),
        )
      : null;
    const latestThread = groupedProjectKeys
      ? (sortThreads(
          threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
          ),
          clientSettings.sidebarThreadSortOrder,
        )[0] ?? null)
      : getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === project.environmentId),
          project.id,
          clientSettings.sidebarThreadSortOrder,
        );
    if (latestThread) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(latestThread.environmentId, latestThread.id)),
      });
      return;
    }

    await handleNewThread(scopeProjectRef(project.environmentId, project.id));
  };

  // Pinning from a row keeps rows in place while the palette is open.
  const projectSearchItems = useOrderWhileOpen(
    buildProjectSearchItems({
      projects: pickerProjects,
      projectGroupByTargetKey,
      locationByEnvironmentId: projectEnvironmentLocationById,
      runProject: openProjectFromSearch,
      pin: projectPin,
    }),
    rowOrderKey("project"),
    true,
  );

  const openingOrderThreadItems = useOrderWhileOpen(
    (() => {
      const isScratch = (project: CommandPaletteProject) =>
        isScratchProject(project, scratchWorkspaceRootFor(project.environmentId));
      const projectItems = buildNewThreadInProjectItems({
        projects: pickerProjects.filter((project) => !isScratch(project)),
        projectGroupByTargetKey,
        locationByEnvironmentId: projectEnvironmentLocationById,
        pin: projectPin,
        runProject: async (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const contextualRefBelongsToGroup =
            contextualProjectRef !== null &&
            group?.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === contextualProjectRef.environmentId &&
                projectRef.projectId === contextualProjectRef.projectId,
            );
          await handleNewThread(
            contextualRefBelongsToGroup
              ? contextualProjectRef
              : scopeProjectRef(project.environmentId, project.id),
          );
        },
      });
      if (scratchTargetEnvironmentId === null) return projectItems;

      const noProjectIndex = newThreadNoProjectIndex(
        projectPickerEntries.map(({ group, targetProject, isPreferred }) => ({
          isScratch: isScratchProject(
            targetProject,
            scratchWorkspaceRootFor(targetProject.environmentId),
          ),
          pinned: group.pinned,
          isPreferred,
        })),
      );
      return [
        ...projectItems.slice(0, noProjectIndex),
        {
          kind: "action" as const,
          value: NEW_THREAD_NO_PROJECT_VALUE,
          searchTerms: ["no project", "without project", "none"],
          title: t("No project"),
          icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "chat.newWithoutProject" as const,
          run: () => startScratchThread(scratchTargetEnvironmentId),
        },
        ...projectItems.slice(noProjectIndex),
      ];
    })(),
    rowOrderKey("new-thread-in"),
    true,
  );
  // Jump shortcuts follow the rows as shown, so a pin cannot move a number to another row.
  const projectJumpItems = new Map(
    enumerateCommandPaletteItems(
      openingOrderThreadItems.filter((item) => item.value !== NEW_THREAD_NO_PROJECT_VALUE),
    ).map((item) => [item.value, item] as const),
  );
  const projectThreadItems = openingOrderThreadItems.map(
    (item) => projectJumpItems.get(item.value) ?? item,
  );

  // Every open checkout on the machine, since a group may hold several of them there.
  const machineThreadGroup = (() => {
    if (newThreadMachineId === null) return null;
    const entries = pickableProjectGroups(projectGroups).flatMap((group) =>
      group.memberProjects
        .filter(
          (member) =>
            member.environmentId === newThreadMachineId &&
            !isScratchProject(member, scratchWorkspaceRootFor(newThreadMachineId)),
        )
        .map((member) => ({ group, project: { ...member, displayName: group.displayName } })),
    );
    const projectItems = enumerateCommandPaletteItems(
      buildNewThreadInProjectItems({
        projects: entries.map((entry) => entry.project),
        projectGroupByTargetKey: new Map(
          entries.map((entry) => [
            `${entry.project.environmentId}:${entry.project.id}`,
            entry.group,
          ]),
        ),
        locationByEnvironmentId: projectEnvironmentLocationById,
        runProject: async (project) => {
          await handleNewThread(scopeProjectRef(project.environmentId, project.id));
        },
      }),
    );
    const machineLabel =
      distinctEnvironmentLabels(environments)[
        environments.findIndex((environment) => environment.environmentId === newThreadMachineId)
      ];
    return {
      value: `${NEW_THREAD_ON_MACHINE_GROUP_PREFIX}${newThreadMachineId}`,
      label: machineLabel ? t("Projects on {machine}", { machine: machineLabel }) : t("Projects"),
      items:
        scratchWorkspaceRootFor(newThreadMachineId) === null
          ? projectItems
          : [
              ...projectItems,
              {
                kind: "action" as const,
                value: "new-thread-in:no-project",
                searchTerms: ["no project", "without project", "none"],
                title: t("No project"),
                icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
                run: () => startScratchThread(newThreadMachineId),
              },
            ],
    };
  })();

  const {
    threadItems: allThreadItems,
    threadMessageItems,
    now: searchNow,
    isSearchPending: isThreadSearchPending,
  } = useCommandPaletteThreadItems({ activeThread: activeThread ?? null, threadSearchQuery });
  // Recent means used recently: written in or opened, whichever is later. The
  // open thread would always lead that list, so it is left out.
  const activeThreadValue = activeThread
    ? `thread:${activeThread.environmentId}:${activeThread.id}`
    : null;
  const recentThreadItems = allThreadItems
    .filter((item) => item.value !== activeThreadValue)
    .toSorted(
      (left, right) =>
        (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
        (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
    )
    .slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useStableCallback((view: CommandPaletteView): void => {
    browseNavigation.invalidate();
    dispatchSearch({ type: "push", view });
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  });

  function popView(): void {
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    } else if (newProjectFlow?.sourcesEnvironmentId) {
      setAddProjectEnvironmentId(newProjectFlow.sourcesEnvironmentId);
    }
    dispatchSearch({ type: "back" });
    setHighlightedItemValue(null);
  }

  function handleQueryChange(nextQuery: string): void {
    browseNavigation.invalidate();
    clearTypedHighlight();
    setQuery(canBrowsePaths ? resolvePastedPath(query, nextQuery) : nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = async (environmentId: EnvironmentId): Promise<void> => {
    const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
    const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
    const browseCwd = getBrowseCwdForEnvironment(environmentId);
    const view: CommandPaletteView = {
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [],
      initialQuery,
    };

    await browseNavigation.run(
      () =>
        initialBrowsePath.length > 0
          ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
          : Promise.resolve(),
      () => {
        setAddProjectEnvironmentId(environmentId);
        setAddProjectCloneFlow(null);
        pushPaletteView(view);
      },
    );
  };

  const startAddProjectClone = (
    environmentId: EnvironmentId,
    source: AddProjectRemoteSource,
  ): void => {
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow({ step: "repository", environmentId, source });
    pushPaletteView({
      addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
      groups: [],
      initialQuery: "",
    });
  };

  const newProjectsRootFor = (environmentId: EnvironmentId | null): string | null =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.newProjectsRoot ?? null;

  const startNewProject = (
    environmentId: EnvironmentId,
    sourcesEnvironmentId: EnvironmentId | null,
  ): void => {
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow(null);
    setNewProjectFlow({ environmentId, sourcesEnvironmentId });
    setNewProjectPublishes(false);
    setNewProjectPublishKind(null);
    pushPaletteView({
      addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
      groups: [],
    });
  };

  const openSourceControlSettings = () => {
    setOpen(false);
    void navigate({ to: "/settings/source-control" });
  };

  const buildAddProjectSourceGroups = (
    environmentId: EnvironmentId,
    readinessBySource: AddProjectRemoteSourceReadiness,
  ): CommandPaletteView["groups"] => {
    const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
      {
        kind: "action",
        value: `action:add-project:${environmentId}:local`,
        searchTerms: ["local", "folder", "directory", "browse"],
        title: t("Local folder"),
        description: t("Browse a folder on disk"),
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          await startAddProjectBrowse(environmentId);
        },
      },
    ];

    if (newProjectsRootFor(environmentId) !== null) {
      sourceItems.unshift({
        kind: "action",
        value: `action:add-project:${environmentId}:new`,
        searchTerms: ["new project", "create", "empty", "repository", "git init"],
        title: t("New project"),
        description: t("Start a new Git repository from a name"),
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          startNewProject(environmentId, environmentId);
        },
      });
    }

    const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
      "url",
      ...sortAddProjectProviderSources(readinessBySource),
    ];

    for (const source of orderedSources) {
      const label = addProjectRemoteSourceLabel(source);
      const title =
        source === "url" ? t("Git URL") : t("{provider} repository", { provider: label });
      const description =
        source === "url"
          ? t("Clone from a remote URL")
          : t("Clone {provider} {hint}", {
              provider: label,
              hint: addProjectRemoteSourcePathHint(source),
            });
      const readiness = readinessBySource(source);
      const disabledHint = readiness.hint;

      const titleTrailingContent = readiness.ready ? undefined : (
        <span className="ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="warning-outline"
                  size="micro"
                  onClick={() => {
                    openSourceControlSettings();
                  }}
                >
                  {t("Setup Required")}
                </Button>
              }
            />
            <TooltipPopup align="end" side="left">
              {disabledHint ?? t("Open Settings -> Source control to configure this provider.")}
            </TooltipPopup>
          </Tooltip>
        </span>
      );

      if (!readiness.ready) {
        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}:not-ready`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
          title,
          description,
          disabled: true,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          run: async () => {},
        });
        continue;
      }

      sourceItems.push({
        kind: "action",
        value: `action:add-project:${environmentId}:${source}`,
        searchTerms: ["clone", "remote", "repository", "repo", "git", label],
        title,
        description,
        icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
        ...(titleTrailingContent ? { titleTrailingContent } : {}),
        keepOpen: true,
        run: async () => {
          startAddProjectClone(environmentId, source);
        },
      });
    }

    return [{ value: `sources:${environmentId}`, label: t("Sources"), items: sourceItems }];
  };

  const startAddProjectSourceSelection = (environmentId: EnvironmentId): void => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Environment unavailable"),
          description: environment?.label
            ? t("{environment} is not connected.", { environment: environment.label })
            : t("The selected environment is not connected."),
        }),
      );
      return;
    }
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow(null);
    pushPaletteView({
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: buildAddProjectSourceGroups(
        environmentId,
        buildAddProjectRemoteSourceReadiness(
          browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
        ),
      ),
    });
  };

  const buildEnvironmentItem = (
    option: AddProjectEnvironmentOption,
    value: string,
    run: (environmentId: EnvironmentId) => void,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
    title: option.label,
    description: option.isConnected
      ? option.isPrimary
        ? t("This device")
        : option.environmentId
      : option.status,
    disabled: !option.isConnected,
    icon: <EnvironmentMachineIcon kind={option.machine} className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      run(option.environmentId);
    },
  });
  const addProjectEnvironmentItems = addProjectEnvironmentOptions.map((option) =>
    buildEnvironmentItem(
      option,
      `action:add-project:environment:${option.environmentId}`,
      startAddProjectSourceSelection,
    ),
  );
  const newProjectEnvironmentOptions = addProjectEnvironmentOptions.filter(
    (option) => option.isConnected && newProjectsRootFor(option.environmentId) !== null,
  );

  const addProjectEnvironmentGroups = [
    {
      value: "environments",
      label: t("Environments"),
      items: addProjectEnvironmentItems,
    },
  ];

  const openConnectionSettings = () => {
    setOpen(false);
    void navigate({ to: "/settings/connections" });
  };
  const addProjectEntry = resolveAddProjectEntry(
    addProjectEnvironmentOptions,
    defaultAddProjectEnvironmentId,
  );

  const openAddProjectFlow = () => {
    switch (addProjectEntry.kind) {
      case "connect-environment":
        openConnectionSettings();
        return;
      case "choose-environment":
        pushPaletteView({
          addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
          groups: addProjectEnvironmentGroups,
        });
        return;
      case "choose-source":
        startAddProjectSourceSelection(addProjectEntry.environmentId);
        return;
    }
  };

  // The view an "Add project" intent opens to follows the environments as they
  // connect, so it resolves here instead of being fixed when the palette opened.
  const addProjectEntryGroups = (): ReadonlyArray<CommandPaletteGroup> => {
    switch (addProjectEntry.kind) {
      case "connect-environment":
        return [
          {
            value: ADD_PROJECT_ENTRY_GROUP,
            label: "",
            items: [
              {
                kind: "action",
                value: "action:add-project:connect-environment",
                searchTerms: ["connect", "environment", "connection", "settings"],
                title: t("Connect an environment"),
                description: t("No connected environment can add a project"),
                icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
                keepOpen: true,
                run: async () => {
                  openConnectionSettings();
                },
              },
            ],
          },
        ];
      case "choose-environment":
        return addProjectEnvironmentGroups;
      case "choose-source":
        return buildAddProjectSourceGroups(
          addProjectEntry.environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === addProjectEntry.environmentId
              ? sourceControlDiscovery.data
              : null,
          ),
        );
    }
  };

  const openNewProjectFlow = () => {
    const firstOption = newProjectEnvironmentOptions[0];
    if (firstOption) startNewProject(firstOption.environmentId, null);
  };

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      currentProject?.title ??
      null;

    if (activeProjectTitle) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "chat", "create", "draft"],
        title: (
          <>
            {tx("New thread in {project}", {
              project: <span className="font-semibold">{activeProjectTitle}</span>,
            })}
          </>
        ),
        searchTitle: t("New thread in {project}", { project: activeProjectTitle }),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newLocal",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread: activeThread ?? undefined,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: t("New thread in..."),
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: NEW_THREAD_IN_GROUP, label: t("Projects"), items: projectThreadItems }],
    });
  }

  if (scratchTargetEnvironmentId !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: ["new thread", "no project", "without project", "none", "chat"],
      title: t("New thread without a project"),
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newWithoutProject",
      run: () => startScratchThread(scratchTargetEnvironmentId),
    });
  }

  if (triageEnvironmentId !== null && canTriage) {
    actionItems.push({
      kind: "action",
      value: "action:triage",
      searchTerms: ["triage", "bug", "issue", "report", "broken", "debug", "help", "support"],
      title: t("Triage an issue"),
      description: t("An agent investigates a T3.CodeShip problem and helps file an issue"),
      icon: <BugIcon className={ITEM_ICON_CLASS} />,
      run: () => startTriage(triageEnvironmentId),
    });
  }

  if (activeThreadKey !== null) {
    actionItems.push(
      {
        kind: "action",
        value: "action:previous-prompt",
        title: t("Jump to previous prompt"),
        searchTerms: ["previous", "prompt", "message", "jump", "scroll", "up"],
        icon: <ChevronUpIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.previousPrompt",
        run: async () => {
          stepTimelinePrompt(activeThreadKey, "previous");
        },
      },
      {
        kind: "action",
        value: "action:next-prompt",
        title: t("Jump to next prompt"),
        searchTerms: ["next", "prompt", "message", "jump", "scroll", "down"],
        icon: <ChevronDownIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.nextPrompt",
        run: async () => {
          stepTimelinePrompt(activeThreadKey, "next");
        },
      },
    );
  }

  if (activeThreadKey !== null && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: t("Find in current thread"),
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        openThreadFind(activeThreadKey);
      },
    });
  }

  const promptLinkTarget = paletteRouteTarget
    ? paletteRouteTarget.kind === "server"
      ? paletteRouteTarget.threadRef
      : paletteRouteTarget.draftId
    : null;
  const promptLinkProjectRef = activeThread ?? activeDraftThread;
  const promptLinkInput =
    promptLinkTarget === null
      ? null
      : {
          target: promptLinkTarget,
          project: projects.find(
            (project) =>
              project.environmentId === promptLinkProjectRef?.environmentId &&
              project.id === promptLinkProjectRef.projectId,
          ),
          providers:
            (promptLinkProjectRef
              ? providersByEnvironment.get(promptLinkProjectRef.environmentId)
              : undefined) ?? [],
          threadModelSelection: activeThread?.modelSelection ?? null,
        };
  const plainPromptLink = promptLinkInput
    ? composerPromptLink({ ...promptLinkInput, withContext: false })
    : null;
  if (promptLinkInput !== null && plainPromptLink !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: t("Copy prompt link"),
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plainPromptLink),
    });
    if (promptLinkRepositoryOf(promptLinkInput.project) !== null) {
      const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
      if (contextLink !== null) {
        actionItems.push({
          kind: "action",
          value: "action:copy-prompt-link-with-context",
          searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
          title: t("Copy prompt link with repo and model"),
          icon: <LinkIcon className={ITEM_ICON_CLASS} />,
          run: () => copyPromptLink(contextLink),
        });
      }
    }
  }

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms:
        activeThreadReferenceCopyTarget.kind === "pull-request"
          ? ["copy", "pull request", "link", "reference"]
          : ["copy", "thread", "thread id", "reference"],
      title:
        activeThreadReferenceCopyTarget.kind === "pull-request"
          ? t("Copy PR link")
          : t("Copy thread"),
      description: activeThreadReferenceCopyTarget.description,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (
    activeThread !== null &&
    threadPullRequestLinkMode(activeThreadServerConfig?.environment.capabilities) !== "unsupported"
  ) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:link-pull-request",
      searchTerms: ["link", "pull request", "pr", "attach", "stack"],
      title: t("Link pull request to thread"),
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkPullRequestDialog(threadRef);
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:open-thread-pull-requests",
      searchTerms: ["pull requests", "linked", "stack", "prs"],
      title: t("Show linked pull requests"),
      disabled: visibleThreadPullRequests(activeThread.pullRequests).length === 0,
      icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().open(threadRef, "pull-requests");
      },
    });
  }

  actionItems.push(...activeThreadLifecycleItems);

  if (activeThread !== null) {
    actionItems.push({
      kind: "action",
      value: "action:side-chat",
      searchTerms: ["side chat", "ask", "question", "aside", "btw"],
      title: t("Start side chat"),
      description: t("Ask about this thread without adding to it"),
      disabled: !sideChat.available,
      icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.sideChat",
      run: async () => {
        await sideChat.open();
      },
    });
  }

  if (agentActionsTarget !== null && agentActionsTarget.threadKey === activeThreadKey) {
    const target = agentActionsTarget;
    for (const action of availableAgentActions(target.isGitRepo, customAgentActions)) {
      actionItems.push({
        kind: "action",
        value: `action:ask-agent:${action.id}`,
        searchTerms: ["ask", "agent", ...action.searchTerms],
        title: t("Ask the agent: {action}", { action: action.label }),
        description: target.unavailableReason ?? action.preview,
        disabled: target.unavailableReason !== null,
        icon: <action.icon className={ITEM_ICON_CLASS} />,
        run: async () => {
          target.ask(action.prompt);
        },
      });
    }
  }

  if (activeThread !== null && canShareActiveThreadWithGuest) {
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    actionItems.push({
      kind: "action",
      value: "action:share-thread-with-guest",
      searchTerms: ["share", "guest", "invite", "link", "teammate"],
      title: t("Share with guest"),
      icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openGuestShareDialog(threadRef);
      },
    });
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: t("Restart agent session"),
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        toastManager.add({
          type: "success",
          title: t("Agent session will restart"),
          description: t("Your next message starts a fresh session."),
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: t("Go to file"),
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openChildSearch("files", { query, linkedThreadSearch });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: t("Search project contents"),
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openChildSearch("content", { query, linkedThreadSearch });
    },
  });

  if (newProjectEnvironmentOptions.length > 0) {
    actionItems.push({
      kind: "action",
      value: "action:new-project",
      searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
      title: t("New project"),
      icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openNewProjectFlow();
      },
    });
  }

  const addProjectAction: CommandPaletteActionItem = {
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      ...sourceControlClients.definitions.flatMap((definition) =>
        definition.pickerLabel
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter(Boolean),
      ),
      "url",
      "environment",
    ],
    title: t("Add project"),
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  };
  actionItems.push(addProjectAction);

  if (wslAddProjectEnvironmentOption) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: t("Open WSL folder"),
      description: wslAddProjectEnvironmentOption.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
      },
    });
  }

  actionItems.push(changeThemeItem);
  actionItems.push(changeAppearanceItem);

  actionItems.push(themeEditorItem);

  if (environments.some((environment) => environment.serverConfig !== null)) {
    actionItems.push({
      kind: "action",
      value: "action:pull-requests",
      searchTerms: [
        ...new Set(
          sourceControlClients.definitions.flatMap((definition) => {
            const shortLabel = definition.changeRequest.shortLabel.toLowerCase();
            return [
              definition.changeRequest.plural,
              `${shortLabel}s`,
              shortLabel,
              ...definition.label.toLowerCase().split(/[^a-z0-9]+/u),
            ].filter(Boolean);
          }),
        ),
        "review",
        "merge",
        "branch",
      ],
      title: t("Open pull requests"),
      icon: <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:projects",
    searchTerms: ["projects", "overview", "dashboard", "board", "all threads", "manage"],
    title: t("Open projects"),
    icon: <LayoutGridIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/projects" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:artifacts",
    searchTerms: ["artifacts", "pages", "visual", "charts", "diagrams", "mockups", "renders"],
    title: t("Open artifacts"),
    icon: <ShapesIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/artifacts" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:extensions",
    searchTerms: ["extensions", "add-ons", "skills", "plugins", "mcp", "connectors"],
    title: t("Open extensions"),
    icon: <BlocksIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/extensions" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:skills",
    searchTerms: ["skills", "agent skills", "capabilities", "extensions"],
    title: t("Open skills"),
    icon: <SparklesIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/extensions", search: { tab: "skills" } });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:plugins",
    searchTerms: ["plugins", "extensions", "marketplace", "install", "add-ons"],
    title: t("Open plugins"),
    icon: <BlocksIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/extensions", search: { tab: "plugins" } });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:mcp",
    searchTerms: ["mcp", "mcp servers", "model context protocol", "tools", "connectors"],
    title: t("Open MCP servers"),
    icon: <ServerIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/extensions", search: { tab: "mcp" } });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:archived-threads",
    searchTerms: ["archived", "archive", "restore", "unarchive", "old threads"],
    title: t("Open archived threads"),
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/archived" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:run-setup",
    searchTerms: ["setup", "welcome", "onboarding", "wizard", "first run", "get started"],
    title: t("Run setup again"),
    icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openSetupWizard();
    },
  });

  if (sidebarFolderControls !== null) {
    const controls = sidebarFolderControls;
    for (const expanded of [false, true]) {
      actionItems.push({
        kind: "action",
        value: expanded ? "action:sidebar-expand-folders" : "action:sidebar-collapse-folders",
        searchTerms: expanded
          ? ["expand", "open", "unfold", "sidebar", "folders", "projects", "all"]
          : ["collapse", "close", "fold", "sidebar", "folders", "projects", "all"],
        title: expanded ? t("Expand all sidebar folders") : t("Collapse all sidebar folders"),
        icon: expanded ? (
          <ChevronsUpDownIcon className={ITEM_ICON_CLASS} />
        ) : (
          <ChevronsDownUpIcon className={ITEM_ICON_CLASS} />
        ),
        run: async () => {
          controls.setAllExpanded(expanded);
        },
      });
    }
  }

  actionItems.push({
    kind: "action",
    value: "action:scheduled-tasks",
    searchTerms: ["scheduled", "tasks", "automations", "recurring", "cron", "webhook"],
    title: t("Open scheduled tasks"),
    icon: <CalendarClockIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/scheduled-tasks" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:thread-page",
    searchTerms: ["threadpage", "thread.page", "notes", "notebook", "work log", "decisions"],
    title: t("Open ThreadPage"),
    icon: <NotebookPenIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/thread-page" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: t("Open usage"),
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  for (const direction of [1, -1] as const) {
    const title =
      direction === 1 ? t("Focus Next Workspace Area") : t("Focus Previous Workspace Area");
    actionItems.push({
      kind: "action",
      value: `action:workspace-focus:${direction}`,
      title,
      searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious",
      run: async () => {
        queueWorkspaceFocusFromPalette(direction);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: t("Open settings"),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // Every group, so an archived project's thread still opens its own settings.
  const currentProjectGroup =
    (contextualProjectRef
      ? projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === contextualProjectRef.environmentId &&
              ref.projectId === contextualProjectRef.projectId,
          ),
        )
      : null) ?? null;
  if (currentProjectGroup && canPinProjectGroup(currentProjectGroup)) {
    actionItems.push({
      kind: "action",
      value: "action:project-pin",
      searchTerms: ["pin", "unpin", "project", "favorite"],
      title: currentProjectGroup.pinned ? t("Unpin project") : t("Pin project"),
      description: currentProjectGroup.displayName,
      icon: currentProjectGroup.pinned ? (
        <PinOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PinIcon className={ITEM_ICON_CLASS} />
      ),
      run: async () => toggleProjectGroupPin(currentProjectGroup),
    });
  }
  const contextualProjectGroup = currentProjectGroup ?? projectGroups[0] ?? null;
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "t3.json",
      ],
      title: t("Project settings"),
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  // Every setting goes to the palette's own matcher, so settings get the same
  // word starts and typo tolerance as threads.
  const settingsSearchItems: CommandPaletteActionItem[] = settingsForThisPlatform(
    availableSettingsSearchItems,
  ).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
    title: t(item.title),
    description: t("Settings · {section}", { section: t(SETTINGS_SECTION_LABELS[item.to]) }),
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : currentView?.groups[0]?.value === ADD_PROJECT_ENTRY_GROUP
        ? addProjectEntryGroups()
        : currentView?.groups[0]?.value === NEW_THREAD_IN_GROUP
          ? [
              {
                value: NEW_THREAD_IN_GROUP,
                label: t("Projects"),
                // Every project archived and no "No project" home leaves only adding one.
                items: projectThreadItems.length > 0 ? projectThreadItems : [addProjectAction],
              },
            ]
          : machineThreadGroup !== null &&
              currentView?.groups[0]?.value === machineThreadGroup.value
            ? [machineThreadGroup]
            : currentView?.groups[0]?.value === "themes"
              ? changeThemeItem.groups
              : currentView?.groups[0]?.value === "appearance"
                ? changeAppearanceItem.groups
                : (currentView?.groups ??
                  (opensOnRecentThreads && deferredQuery === "" && recentThreadItems.length > 0
                    ? rootGroups.filter((group) => group.value === RECENT_THREADS_GROUP)
                    : rootGroups));

  const isLinkedThreadSearch =
    linkedThreadSearch?.linkedThreads !== undefined && deferredQuery === linkedThreadSearch.query;
  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    ...(deferredQuery.trim().length > 0
      ? {
          allOptions: {
            rootGroups,
            nestedItems: buildNestedSearchItems(actionItems, deferredQuery),
          },
        }
      : {}),
    projectSearchItems: projectSearchItems,
    settingsSearchItems,
    threadSearchItems:
      isLinkedThreadSearch && linkedThreadSearch?.linkedThreads
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            threads: visibleLinkedThreads(
              linkedThreadSearch.linkedThreads.threads,
              linkedThreadSearch.linkedThreads.environmentId,
              linkedThreadRefs,
              hiddenKeys,
              hidingAnywhere,
            ),
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : allThreadItems,
    threadMessageItems: isLinkedThreadSearch ? [] : threadMessageItems,
    now: searchNow,
  });

  const handleAddProjectForEnvironment = async (input: {
    readonly environmentId: EnvironmentId;
    readonly rawCwd: string;
    readonly platform: string;
    readonly currentProjectCwd: string | null;
  }) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Environment unavailable"),
          description: environment?.label
            ? t("{environment} is not connected.", { environment: environment.label })
            : t("The selected environment is not connected."),
        }),
      );
      return;
    }
    const rawCwd = input.rawCwd;

    if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to add project"),
          description: t("Windows-style paths are only supported on Windows."),
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to add project"),
          description: t("Relative paths require an active project."),
        }),
      );
      return;
    }

    const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
    if (cwd.length === 0) return;

    const existing = findProjectByPath(
      projects.filter((project) => project.environmentId === input.environmentId),
      cwd,
    );
    if (existing) {
      // Adding an archived project's folder again brings the project back.
      if (existing.archivedAt != null) {
        void updateProject({
          environmentId: existing.environmentId,
          input: { projectId: existing.id, archived: false },
        }).then((result) => reportProjectFailure(t("Failed to unarchive project"), result));
      }
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === existing.environmentId),
        existing.id,
        clientSettings.sidebarThreadSortOrder,
      );
      if (latestThread && latestThread.settledOverride !== "settled") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
      } else {
        const navigationResult = await settlePromise(() =>
          handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
        );
        if (navigationResult._tag === "Failure") {
          const error = squashAtomCommandFailure(navigationResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Failed to open project"),
              description: error instanceof Error ? error.message : t("An error occurred."),
            }),
          );
          return;
        }
      }
      setOpen(false);
      return;
    }

    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Cannot add project"),
          description: t("This connection cannot add projects."),
        }),
      );
      return;
    }
    const projectId = newProjectId();
    const createResult = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(cwd),
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (createResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(createResult)) {
        const error = squashAtomCommandFailure(createResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to add project"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      }
      return;
    }

    const navigationResult = await settlePromise(() =>
      handleNewThread(scopeProjectRef(input.environmentId, projectId)),
    );
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to add project"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        }),
      );
      return;
    }
    setOpen(false);
  };

  const handleAddProject = async (rawCwd: string) => {
    if (!browseEnvironmentId) return;
    await handleAddProjectForEnvironment({
      environmentId: browseEnvironmentId,
      rawCwd,
      platform: browseEnvironmentPlatform,
      currentProjectCwd: currentProjectCwdForBrowse,
    });
  };

  const newProjectPublishTargets =
    newProjectFlow === null ? [] : getNewProjectPublishTargets(sourceControlDiscovery.data ?? null);
  const newProjectPublishTarget = getNewProjectPublishTarget(
    newProjectPublishTargets,
    newProjectPublishKind,
  );
  const newProjectName = query.trim();
  const canSubmitNewProject =
    newProjectFlow !== null &&
    newProjectName.length > 0 &&
    !isCreatingNewProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  async function submitNewProject(): Promise<void> {
    if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
      return;
    }
    newProjectSubmittingRef.current = true;
    setIsCreatingNewProject(true);
    const created = await settlePromise(() =>
      createNewProject({
        environmentId: newProjectFlow.environmentId,
        name: newProjectName,
        publishTo: newProjectPublishes ? newProjectPublishTarget : null,
      }),
    );
    newProjectSubmittingRef.current = false;
    setIsCreatingNewProject(false);
    if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    if (created.value) setOpen(false);
  }

  function getDefaultCloneDestination(
    environmentId: EnvironmentId,
    remoteUrl: string,
    repository: string,
  ): string {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return getCloneDestinationPath(
      getAddProjectInitialQueryForEnvironment(environmentId),
      getCloneDirectoryPath(
        remoteUrl,
        environment?.serverConfig?.settings.ghqCloneLayout === true,
        repository,
      ),
    );
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }
    if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Environment unavailable"),
          description: browseEnvironment?.label
            ? t("{environment} is not connected.", { environment: browseEnvironment.label })
            : t("The selected environment is not connected."),
        }),
      );
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const incompleteOwnerMessage = githubIncompleteOwnerRepositoryMessage(
        addProjectCloneFlow.source,
        rawRepository,
      );
      if (incompleteOwnerMessage) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Repository name incomplete"),
            description: incompleteOwnerMessage,
          }),
        );
        return;
      }

      const provider = addProjectRemoteSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const remoteUrl = normalizePastedCloneUrl(rawRepository);
        const destinationPath = getDefaultCloneDestination(
          addProjectCloneFlow.environmentId,
          remoteUrl,
          rawRepository,
        );
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl,
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupGeneration = ++cloneLookupGeneration.current;
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
      if (lookupGeneration !== cloneLookupGeneration.current) return;
      setIsRemoteProjectLookingUp(false);
      if (lookupResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(lookupResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Repository lookup failed"),
              description: errorMessage(squashAtomCommandFailure(lookupResult)),
            }),
          );
        }
        return;
      }
      const repository = lookupResult.value;
      const remoteUrl = getDefaultCloneUrl(repository);
      const destinationPath = getDefaultCloneDestination(
        addProjectCloneFlow.environmentId,
        remoteUrl,
        repository.nameWithOwner,
      );
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl,
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthOrchestrationOperateScope)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Clone unavailable"),
          description: t(
            "This connection needs permission to write source control and add projects.",
          ),
        }),
      );
      return;
    }
    if (rawDestination.length === 0 || isRemoteProjectCloning) return;

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Clone failed"),
          description: t("Windows-style paths are only supported on Windows."),
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Clone failed"),
          description: t("Relative paths require an active project."),
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    const projectId = newProjectId();
    setIsRemoteProjectCloning(true);
    const startResult = await startProjectClone({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(destinationPath),
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        createdAt: new Date().toISOString(),
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (startResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(startResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Clone failed"),
            description: errorMessage(squashAtomCommandFailure(startResult)),
          }),
        );
      }
      return;
    }
    setOpen(false);
    void suggestAppAccessForRemote(
      addProjectCloneFlow.environmentId,
      addProjectCloneFlow.remoteUrl,
    );
    const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
    await waitForProject(projectRef, 3_000).catch(() => null);
    const navigationResult = await settlePromise(() => handleNewThread(projectRef));
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to open project"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        }),
      );
    }
  }

  const browseTo = async (name: string): Promise<void> => {
    const nextQuery = pinnedCloneDirectoryName
      ? getCloneDestinationBrowsePath({
          browseDirectoryPath: browsePath.directoryPath,
          selectedDirectoryName: name,
          cloneDirectoryName: pinnedCloneDirectoryName,
          caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
        })
      : appendBrowsePathSegment(query, name);
    await browseNavigation.run(
      () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const browseUp = async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = browseGroups.map((group) =>
    group.value === "directories" ? { ...group, label: t("Select where to clone") } : group,
  );

  const newProjectsRoot = newProjectFlow ? newProjectsRootFor(newProjectFlow.environmentId) : null;
  const newProjectPathPreview =
    newProjectsRoot === null ? null : getNewProjectPathPreview(newProjectsRoot, newProjectName);
  const newProjectPublishToggleValue = "new-project:publish";
  const showExistingProjectSources = (environmentId: EnvironmentId) => {
    const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
    if (sourcesEnvironmentId === environmentId) {
      popView();
      return;
    }
    if (sourcesEnvironmentId !== null) {
      dispatchSearch({ type: "back" });
    }
    popView();
    startAddProjectSourceSelection(environmentId);
  };
  const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
    setNewProjectFlow((flow) => (flow === null ? flow : { ...flow, environmentId }));
    setAddProjectEnvironmentId(environmentId);
  };
  const selectedNewProjectEnvironment =
    newProjectFlow === null
      ? undefined
      : newProjectEnvironmentOptions.find(
          (option) => option.environmentId === newProjectFlow.environmentId,
        );
  const showNewProjectMachines =
    newProjectFlow !== null &&
    (newProjectEnvironmentOptions.length > 1 ||
      (selectedNewProjectEnvironment === undefined && newProjectEnvironmentOptions.length > 0));
  const newProjectEnvironmentLabel = showNewProjectMachines
    ? (selectedNewProjectEnvironment?.label ??
      environmentLabelById.get(newProjectFlow.environmentId) ??
      null)
    : null;
  const newProjectMachineGroup: CommandPaletteView["groups"][number] | null =
    !showNewProjectMachines || newProjectFlow === null
      ? null
      : {
          value: "new-project-machines",
          label: t("Environments"),
          items: newProjectEnvironmentOptions.map((option) => ({
            ...buildEnvironmentItem(
              option,
              `new-project:environment:${option.environmentId}`,
              switchNewProjectEnvironment,
            ),
            ...(isCreatingNewProject ? { disabled: true } : {}),
            ...(option.environmentId === newProjectFlow.environmentId
              ? {
                  titleTrailingContent: (
                    <CheckIcon className="ms-auto size-4 shrink-0 text-muted-foreground/70" />
                  ),
                }
              : {}),
          })),
        };
  const newProjectExistingGroup: CommandPaletteView["groups"][number] | null =
    newProjectFlow === null
      ? null
      : {
          value: "new-project-existing",
          label: "",
          items: [
            {
              kind: "action",
              value: "new-project:existing",
              searchTerms: [],
              title: t("Add existing project"),
              description: t("Open a folder or clone a repository"),
              icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
              titleTrailingContent: (
                <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
              ),
              keepOpen: true,
              run: async () => {
                showExistingProjectSources(newProjectFlow.environmentId);
              },
            },
          ],
        };
  const newProjectOptionGroups: CommandPaletteView["groups"] =
    newProjectPublishTarget === null || newProjectPathPreview === null
      ? []
      : [
          {
            value: "new-project-options",
            label: t("Options"),
            items: [
              {
                kind: "action",
                value: newProjectPublishToggleValue,
                searchTerms: [],
                title:
                  newProjectPublishTargets.length > 1
                    ? t("Create private repository")
                    : t("Create private repository on {host}", {
                        host: newProjectPublishTarget.definition.label,
                      }),
                description:
                  newProjectName.length > 0
                    ? getNewProjectRepository(newProjectPublishTarget, newProjectPathPreview)
                    : (newProjectPublishTarget.owner ??
                      t("Your {host} account", { host: newProjectPublishTarget.definition.label })),
                icon: sourceControlHostIcon(newProjectPublishTarget.definition, ITEM_ICON_CLASS),
                titleTrailingContent: (
                  <span className="ms-auto flex items-center gap-2">
                    {newProjectPublishTargets.length > 1 ? (
                      <NewProjectPublishHostPicker
                        disabled={isCreatingNewProject}
                        targets={newProjectPublishTargets}
                        value={newProjectPublishTarget.definition.kind}
                        onValueChange={setNewProjectPublishKind}
                      />
                    ) : null}
                    <span className="pointer-events-none flex">
                      <Checkbox checked={newProjectPublishes} tabIndex={-1} aria-hidden />
                    </span>
                  </span>
                ),
                ...(isCreatingNewProject ? { disabled: true } : {}),
                keepOpen: true,
                run: async () => {
                  setNewProjectPublishes((publishes) => !publishes);
                },
              },
            ],
          },
        ];

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (newProjectFlow !== null) {
    displayedGroups = [
      ...(newProjectMachineGroup ? [newProjectMachineGroup] : []),
      ...newProjectOptionGroups,
      ...(newProjectExistingGroup ? [newProjectExistingGroup] : []),
    ];
  } else if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const autoHighlightsFirstRow =
    !isBrowsing && !isRemoteProjectCloneFlow && newProjectFlow === null;

  const inputPlaceholder =
    newProjectFlow !== null
      ? t("Project name")
      : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
        getCommandPaletteInputPlaceholder(paletteMode));
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canWriteSourceControl = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateClonedProject = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canCloneProject = canWriteSourceControl && canCreateClonedProject;
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProject &&
    (!isCloneDestinationStep || canCloneProject) &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    browseAccessError === null &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? t("Create & Clone")
      : t("Clone")
    : willCreateProjectPath
      ? t("Create & Add")
      : t("Add");
  // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const hasHighlightedNewProjectItem = newProjectFlow !== null && highlightedItemValue !== null;
  const createShortcutLabel = hasHighlightedNewProjectItem
    ? // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
      `${submitModifierLabel} Enter`
    : // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
      "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? t("Continue")
      : t("Lookup")
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = (() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  })();

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      // Confirming an IME candidate must not submit a path or select a row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    });
    if (
      command === "thread.snooze" &&
      !event.nativeEvent.isComposing &&
      hasSnoozeRows(activeThreadLifecycleItems)
    ) {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedItemValue(null);
      setQuery(">Snooze");
      return;
    }
    if (command === "thread.pin") {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ??
          (autoHighlightsFirstRow ? (resultRows.itemValues[0] ?? null) : null),
      );
      if (highlightedItem?.kind === "action" && highlightedItem.pin) {
        event.preventDefault();
        event.stopPropagation();
        highlightedItem.pin.toggle();
        return;
      }
    }
    // Global new-thread handlers ignore shortcuts while the palette is open.
    const isJump = threadJumpIndexFromCommand(command ?? "") !== null;
    const isNewThread =
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      (command === "chat.new" ||
        command === "chat.newLocal" ||
        command === "chat.newWithoutProject");
    // Any row's displayed shortcut runs that row; find and copy have their own handling below.
    const runsDisplayedShortcut =
      command !== null &&
      command !== "chat.find" &&
      command !== "thread.copyReference" &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229;
    const matchingItem =
      isJump || isNewThread || runsDisplayedShortcut
        ? displayedGroups
            .flatMap((group) => group.items)
            .find((item) => item.shortcutCommand === command)
        : undefined;
    if (isJump || matchingItem) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }
    // ChatView ignores shortcuts while the palette is open, so intercept find here.
    if (command === "chat.find" && activeThreadKey !== null && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      if (supportsThreadFind) openThreadFind(activeThreadKey);
      else
        toastManager.add({
          id: "thread-find-unavailable",
          title: t("Thread search is unavailable on this server."),
          description: t("Update the server to enable it."),
        });
      return;
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    if (
      newProjectFlow !== null &&
      event.key === "Enter" &&
      (!hasHighlightedNewProjectItem || isPrimaryModifierPressed(event)) &&
      // Enter that confirms an IME composition is part of typing the name.
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      // Base UI would otherwise also click the highlighted row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      void submitNewProject();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;

    if (event.key === "Tab" && isBrowsing && !relativePathNeedsActiveProject) {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      if (highlightedItemValue === "browse:up") {
        void browseUp();
        return;
      }
      const highlightedEntry = visibleBrowseEntries.find(
        (entry) => `browse:${entry.fullPath}` === highlightedItemValue,
      );
      const completion = highlightedEntry
        ? { name: highlightedEntry.name, isComplete: true }
        : getFilesystemBrowseTabCompletion(visibleBrowseEntries, browsePath.filterQuery);
      if (completion?.isComplete) {
        void browseTo(completion.name);
      } else if (completion && !pinnedCloneDirectoryName) {
        setHighlightedItemValue(null);
        setQuery(`${getBrowseDirectoryPath(query)}${completion.name}`);
      }
      return;
    }

    const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Virtualization may unmount the highlighted row; handle Enter directly instead of Base UI's click.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushPaletteView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Unable to run command"),
          description: error instanceof Error ? error.message : t("An unexpected error occurred."),
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    let desktopWslState: DesktopWslState | null = null;
    try {
      desktopWslState =
        browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      // WSL-only primaries need their pool id from desktop settings; the native picker converts WSL UNC
      // paths.
      const pickerTargetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId,
        primaryEnvironmentId,
        desktopInstanceId: browseDesktopInstanceId,
        wslConfiguration: desktopWslState,
      });
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
        ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      if (desktopWslState === null) {
        desktopWslState = (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      }
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {}
      const selection = resolveWslProjectSelection(
        pickedPath,
        applyWslEnvironmentConfiguration(
          environments.flatMap((environment) => {
            const backendId = desktopLocalBackendId(environment.entry.target);
            if (!backendId) {
              return [];
            }

            const bootstrap = desktopLocalBootstraps.find(
              (candidate) => candidate.httpBaseUrl === environment.displayUrl,
            );
            const runningDistro = bootstrap?.runningDistro ?? null;
            return [{ environmentId: environment.environmentId, backendId, runningDistro }];
          }),
          primaryEnvironmentId,
          desktopWslState ?? null,
          primaryRunningDistro,
        ),
      );
      if (!selection) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not add WSL project"),
            description: t("Start the matching WSL backend, then choose the folder again."),
          }),
        );
        return;
      }
      await handleAddProjectForEnvironment({
        environmentId: selection.environmentId,
        rawCwd: selection.linuxPath,
        platform: "Linux",
        currentProjectCwd: null,
      });
      return;
    }
    await handleAddProject(pickedPath);
  };

  const inputAccessory =
    newProjectFlow !== null ? (
      <CommandPaletteSubmitButton
        label={isCreatingNewProject ? t("Creating") : t("Create")}
        shortcutLabel={createShortcutLabel}
        ariaLabel={t("Create ({shortcut})", { shortcut: createShortcutLabel })}
        tooltip={t("Create ({shortcut})", { shortcut: createShortcutLabel })}
        disabled={!canSubmitNewProject}
        onSubmit={() => {
          void submitNewProject();
        }}
      />
    ) : addProjectCloneFlow?.step === "repository" ? (
      <CommandPaletteSubmitButton
        label={isRemoteProjectPending ? t("Working") : remoteProjectButtonLabel}
        shortcutLabel="Enter"
        ariaLabel={t("{action} (Enter)", { action: remoteProjectButtonLabel ?? t("Continue") })}
        tooltip={t("{action} (Enter)", { action: remoteProjectButtonLabel ?? t("Continue") })}
        disabled={!canSubmitRemoteProjectFlow}
        onSubmit={() => {
          void submitAddProjectCloneFlow();
        }}
      />
    ) : isBrowsing ? (
      <CommandPaletteSubmitButton
        label={isCloneDestinationStep && isRemoteProjectPending ? t("Cloning") : submitActionLabel}
        shortcutLabel={addShortcutLabel}
        ariaLabel={t("{action} ({shortcut})", {
          action: submitActionLabel,
          shortcut: addShortcutLabel,
        })}
        tooltip={
          isCloneDestinationStep && !canCloneProject
            ? t("This connection needs permission to write source control and add projects.")
            : canCreateProject
              ? t("{action} ({shortcut})", {
                  action: submitActionLabel,
                  shortcut: addShortcutLabel,
                })
              : t("This connection cannot add projects.")
        }
        disabled={
          !canCreateProject ||
          !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
          relativePathNeedsActiveProject ||
          (isCloneDestinationStep && (!canCloneProject || isRemoteProjectPending))
        }
        onSubmit={() => {
          if (relativePathNeedsActiveProject) {
            return;
          }
          if (isCloneDestinationStep) {
            void submitAddProjectCloneFlow(resolvedAddProjectPath);
          } else {
            void handleAddProject(resolvedAddProjectPath);
          }
        }}
      />
    ) : null;

  const footerActionLabel =
    newProjectFlow !== null
      ? highlightedItemValue === null
        ? t("Create")
        : highlightedItemValue === newProjectPublishToggleValue
          ? t("Toggle")
          : t("Select")
      : addProjectCloneFlow?.step === "repository"
        ? (remoteProjectButtonLabel ?? t("Continue"))
        : !canSubmitBrowsePath || hasHighlightedBrowseItem
          ? t("Select")
          : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <CommandFooterAction
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {t("Open in {fileManager}", { fileManager: fileManagerName })}
    </CommandFooterAction>
  ) : isThreadSearchPending && !isLinkedThreadSearch && !isBrowsing ? (
    // In the footer, so the list keeps its height while message results may
    // still arrive below it.
    <span className="text-muted-foreground text-xs">{t("Searching messages…")}</span>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${newProjectFlow ? "new-project" : (addProjectCloneFlow?.step ?? "none")}`}
      aria-label={t("Command palette")}
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className: hasHighlightedNewProjectItem
          ? "*:data-[slot=autocomplete-input]:pe-38!"
          : addProjectCloneFlow?.step === "repository" || newProjectFlow !== null
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label={t("Back")}
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      {newProjectPathPreview !== null ? (
        <NewProjectSummary
          name={newProjectName}
          pathPreview={newProjectPathPreview}
          projectsRoot={newProjectsRoot}
          environmentLabel={newProjectEnvironmentLabel}
        />
      ) : null}
      {addProjectCloneFlow?.step === "confirm" ? (
        <RemoteRepositorySummary
          source={addProjectCloneFlow.source}
          title={
            addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput
          }
          description={addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl}
        />
      ) : null}
      {browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {t("Loading folders...")}
        </div>
      ) : null}
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? t("Enter a Git clone URL and press Enter to continue.")
                  : t("Enter a repository path and press Enter to look it up."),
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: t("Choose a destination path and press Enter to clone.") }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: t("Relative paths require an active project.") }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: t(
                      "Press Enter to create this folder and add it as a project.",
                    ),
                  }
                : isThreadSearchPending
                  ? { emptyStateMessage: t("Searching thread messages…") }
                  : {})}
      />
    </CommandPaletteContent>
  );
}
