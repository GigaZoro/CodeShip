import { t } from "~/i18n";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { contextMenuSourceOf } from "~/contextMenuSource";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, PinIcon, PinOffIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Button } from "../ui/button";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useAtomValue } from "@effect/atom-react";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { reserveTitlebarControlsSpace } from "~/lib/titlebarControlsSpace";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { GuestShareIndicator } from "./GuestShareControls";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  /** Absent where this thread cannot be pinned or the connection cannot change it. */
  threadPin?: { pinned: boolean; toggle: () => void } | null | undefined;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** Kept inside the space this header reserves clear of the title bar controls. */
  trailing?: ReactNode;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

function ThreadPinButton(props: {
  pin: { pinned: boolean; toggle: () => void };
  keybindings: ResolvedKeybindingsConfig;
}) {
  const label = props.pin.pinned ? t("Unpin thread") : t("Pin thread");
  const shortcut = shortcutLabelForCommand(props.keybindings, "thread.pin");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.pin.pinned ? "ghost" : "ghost-muted"}
            size="icon-xs"
            aria-label={label}
            aria-pressed={props.pin.pinned}
            onClick={props.pin.toggle}
            className="group/pin"
          />
        }
      >
        {props.pin.pinned ? (
          <>
            <PinIcon
              aria-hidden
              className="fill-current group-hover/pin:hidden group-focus-visible/pin:hidden"
            />
            <PinOffIcon
              aria-hidden
              className="hidden group-hover/pin:block group-focus-visible/pin:block"
            />
          </>
        ) : (
          <PinIcon aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{shortcut ? `${label} (${shortcut})` : label}</TooltipPopup>
    </Tooltip>
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  threadPin,
  parentThreadLink,
  onOpenThread,
  onNewThreadInProject,
  onOpenProjectSettings,
  onFindInThread,
  trailing,
}: ChatHeaderProps) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const allProjects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The thread list names a project by its group, so the header uses the same name.
  const activeProjectGroupLabel = activeProject
    ? buildProjectGroups({
        projects: allProjects,
        settings: groupingSettings,
        preferredEnvironmentId: primaryEnvironmentId,
        groupScratchProjects: true,
      }).find((group) =>
        group.memberProjectRefs.some(
          (ref) =>
            ref.environmentId === activeProject.environmentId && ref.projectId === activeProject.id,
        ),
      )?.label
    : undefined;
  const activeProjectName = activeProject?.isScratch
    ? t("No project")
    : (activeProjectGroupLabel ?? activeProject?.title);
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [attachBreadcrumbContainer] = useState(() => (element: HTMLDivElement | null) => {
    breadcrumbContainerRef.current = element;
    return element === null ? undefined : reserveTitlebarControlsSpace(element);
  });
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- these inputs change the dimensions measured from the DOM
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: t("Thread title cannot be empty") });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: t("Failed to rename thread"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
    canShareWithGuest,
  });
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ x: rect.left, y: rect.bottom + 4 }, contextMenuSourceOf(event));
  };
  // A native menu takes the second click, so only the in-page menu lets a double-click reach here.
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show(
          [{ id: "project-settings", label: t("Project settings"), icon: "settings" }],
          { x: event.clientX, y: event.clientY },
          contextMenuSourceOf(event),
        )
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  return (
    <div
      ref={attachBreadcrumbContainer}
      className="@container/chat-header flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel={t("Thread breadcrumb")}
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {activeProject ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("New thread in {project}", {
                        project: activeProjectName ?? "",
                      })}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon project={activeProject} className="size-3.5" />
                  <MiddleTruncate
                    data-slot="workspace-breadcrumb-text"
                    value={activeProjectName ?? ""}
                    showTitle={false}
                    variant="cap-aligned"
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {t("New thread in {project}", { project: activeProjectName ?? "" })}
                </TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        {parentThreadLink ? (
          <>
            <WorkspaceBreadcrumbItem>
              <SharedTooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("Open parent thread: {title}", {
                      title: parentThreadLink.title,
                    })}
                    onClick={() => onOpenThread(parentThreadLink.threadId)}
                    className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
                label={parentThreadLink.title}
              >
                <WorkspaceBreadcrumbText
                  aria-hidden
                  className={collapseParentTitle ? "w-0" : undefined}
                >
                  {parentThreadLink.title}
                </WorkspaceBreadcrumbText>
                {collapseParentTitle ? (
                  <span aria-hidden data-parent-breadcrumb-ellipsis>
                    ...
                  </span>
                ) : null}
              </SharedTooltipTrigger>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              dir="auto"
              aria-label={t("Thread title")}
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <SharedTooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t("Thread actions for {title}", { title: activeThreadTitle })}
                  aria-haspopup="menu"
                  onClick={openMenuFromTitle}
                  onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                  className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
              label={activeThreadTitle}
            >
              <h2 className="min-w-0" dir={textDirection(activeThreadTitle)}>
                <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
              </h2>
              <ChevronDownIcon
                aria-hidden
                data-thread-title-chevron
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
              />
            </SharedTooltipTrigger>
          ) : (
            <SharedTooltipTrigger
              render={
                <h2
                  aria-label={activeThreadTitle}
                  className="min-w-0 flex-1"
                  dir={textDirection(activeThreadTitle)}
                />
              }
              label={activeThreadTitle}
            >
              <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
            </SharedTooltipTrigger>
          )}
          {renamingTitle === null && activeThreadLinkOrigin ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="info" size="sm" />}>
                {t("From {origin}", { origin: activeThreadLinkOrigin })}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {t("Started by an agent on {origin} through a linked environment.", {
                  origin: activeThreadLinkOrigin,
                })}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {threadPin ? <ThreadPinButton pin={threadPin} keybindings={keybindings} /> : null}
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
      {trailing}
    </div>
  );
});
