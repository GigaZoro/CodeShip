import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
  sidebarMachineFolderKey,
} from "../Sidebar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly disconnected: boolean;
}

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(folderKey: string) {
  return `folder:${folderKey}`;
}

export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  folderKey: string;
  group: SidebarProjectSnapshot;
  /** The group's project on the machine folder this folder sits in. */
  member: SidebarProjectGroupMember | null;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (folderKey: string) => void;
  onNewThread: (group: SidebarProjectSnapshot, member: SidebarProjectGroupMember | null) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    member: SidebarProjectGroupMember | null,
    position: { x: number; y: number },
  ) => void;
}) {
  const { folderKey, group, member } = props;
  return (
    <SidebarFolderHeader
      rowId={sidebarFolderRowId(folderKey)}
      parentRowId={
        member ? sidebarFolderRowId(sidebarMachineFolderKey(member.environmentId)) : undefined
      }
      icon={<ProjectFavicon project={group} className="size-4 shrink-0" />}
      label={group.displayName}
      collapsed={props.collapsed}
      hiddenThreads={props.hiddenThreads}
      onToggle={() => props.onToggle(folderKey)}
      newThread={{
        label: `New thread in ${group.displayName}`,
        onClick: () => props.onNewThread(group, member),
      }}
      onContextMenu={(position) => props.onContextMenu(group, member, position)}
    />
  );
});

export const SidebarMachineFolderHeader = memo(function SidebarMachineFolderHeader(props: {
  machine: SidebarMachine;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (folderKey: string) => void;
  onNewThread: (machine: SidebarMachine) => void;
}) {
  const { machine } = props;
  const folderKey = sidebarMachineFolderKey(machine.environmentId);
  return (
    <SidebarFolderHeader
      rowId={sidebarFolderRowId(folderKey)}
      icon={
        <EnvironmentMachineIcon
          aria-hidden
          kind={machine.machineKind}
          className="size-4 shrink-0 text-sidebar-muted-foreground"
        />
      }
      label={machine.label}
      status={
        machine.disconnected ? (
          <span className="shrink-0 text-xs text-sidebar-muted-foreground">Offline</span>
        ) : null
      }
      collapsed={props.collapsed}
      hiddenThreads={props.hiddenThreads}
      onToggle={() => props.onToggle(folderKey)}
      // An offline machine cannot start a thread until it is back.
      newThread={
        machine.disconnected
          ? null
          : { label: `New thread on ${machine.label}`, onClick: () => props.onNewThread(machine) }
      }
    />
  );
});

/**
 * A sidebar folder. It reads like a shelf header: a trailing count and chevron,
 * with the count and a status dot only while it is closed, so a closed folder
 * still says when a hidden thread needs you.
 */
function SidebarFolderHeader(props: {
  rowId: string;
  /** Set for a folder inside another, which indents under its parent's name. */
  parentRowId?: string | undefined;
  icon: ReactNode;
  label: string;
  status?: ReactNode;
  newThread: { readonly label: string; readonly onClick: () => void } | null;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: () => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const { onContextMenu, newThread } = props;
  const { rowId, parentRowId, collapsed, hiddenThreads } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      className={cn(
        "group/project-folder relative list-none",
        parentRowId ? "mt-0.5" : "mt-2 first:mt-0",
      )}
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        data-sidebar-parent={parentRowId}
        aria-expanded={!collapsed}
        onClick={props.onToggle}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          // Lines the icon up with the parent folder's name.
          parentRowId && "ps-9",
        )}
      >
        {props.icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {props.label}
        </span>
        {props.status}
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {newThread ? (
        // Sits over the count, which hides on hover, and left of the chevron.
        <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={newThread.label}
                  onClick={newThread.onClick}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>{newThread.label}</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
}
