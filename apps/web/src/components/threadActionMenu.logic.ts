import { t, msg } from "~/i18n";
import type { ThreadPreferenceMenuId } from "@t3tools/client-runtime/thread-preferences";

import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { ThreadFolderEntry } from "@t3tools/client-runtime/thread-folders";

export const THREAD_FOLDER_SET_PREFIX = "folder:set:";
export const THREAD_FOLDER_NEW_ID = "folder:new";
export const THREAD_FOLDER_REMOVE_ID = "folder:remove";

export type ThreadFolderMenuAction =
  | typeof THREAD_FOLDER_NEW_ID
  | typeof THREAD_FOLDER_REMOVE_ID
  | `${typeof THREAD_FOLDER_SET_PREFIX}${string}`;

export function isThreadFolderMenuAction(action: string): action is ThreadFolderMenuAction {
  return (
    action === THREAD_FOLDER_NEW_ID ||
    action === THREAD_FOLDER_REMOVE_ID ||
    action.startsWith(THREAD_FOLDER_SET_PREFIX)
  );
}

export type ThreadTagMenuAction = "tag:new" | `tag:add:${string}` | `tag:remove:${string}`;

export function buildThreadTagsMenuItem(state: {
  readonly entries: readonly { readonly tag: string; readonly checked: boolean }[];
  readonly canEdit: boolean;
}): ContextMenuItem<"tags" | ThreadTagMenuAction> {
  return {
    id: "tags",
    label: t("Tags"),
    disabled: !state.canEdit,
    children: [
      ...state.entries.map(({ tag, checked }) => ({
        id: `tag:${checked ? "remove" : "add"}:${tag}` as const,
        label: tag,
        checked,
      })),
      { id: "tag:new", label: t("Add tag…"), separatorBefore: state.entries.length > 0 },
    ],
  };
}

export type ThreadActionMenuId =
  | "tags"
  | ThreadTagMenuAction
  | "find"
  | "open-in-side-panel"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "final-review"
  | "final-review:on"
  | "final-review:off"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "later"
  | "later:back"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "folder"
  | ThreadFolderMenuAction
  | ThreadPreferenceMenuId
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "export-markdown"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(
  options: {
    readonly hasPath: boolean;
    readonly hasBranch: boolean;
    readonly hasProject: boolean;
  },
  resolve: typeof t = t,
): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: resolve(msg("Copy")),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [
              {
                id: "copy-path" as const,
                label: resolve(msg("Path")),
                icon: "folder",
              },
            ]
          : []),
        ...(options.hasBranch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch")),
                icon: "git-branch",
              },
            ]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: resolve(msg("Project settings")),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: resolve(msg("Discard draft")),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  /** Settle, snooze and their undo stay available until the host denies the operate scope. */
  readonly canTriage?: boolean;
  readonly canFind?: boolean;
  readonly canOpenInSidePanel?: boolean;
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  /** The thread's own choice, else the environment default. */
  readonly finalReviewEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  /** Whether the thread waits on the user now, was put off with "Decide later", or neither. */
  readonly needsYou?: "now" | "later" | null;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  /** The server marks unread against the latest run's completion, so in-flight runs cannot be. */
  readonly hasCompletedRun: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly finalReview: boolean;
    readonly snooze: boolean;
    readonly later?: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** Absent where the server cannot file chats in sidebar folders. */
  readonly folders?: ThreadFolderMenuState | null;
  readonly tags?: Parameters<typeof buildThreadTagsMenuItem>[0];
  readonly preferenceItems?: ReadonlyArray<ContextMenuItem<ThreadPreferenceMenuId>>;
}

export interface ThreadFolderMenuState {
  readonly entries: ReadonlyArray<ThreadFolderEntry>;
  readonly canCreate?: boolean;
  /** The folder every chosen thread shares, if any. */
  readonly currentKey: string | null;
  readonly inFolder: boolean;
}

export function buildThreadFolderMenuItem(
  folders: ThreadFolderMenuState,
): ContextMenuItem<"folder" | ThreadFolderMenuAction> {
  return {
    id: "folder",
    label: t("Move to folder"),
    icon: "folder",
    children: [
      ...folders.entries.map((entry) => ({
        id: `${THREAD_FOLDER_SET_PREFIX}${entry.name}` as const,
        label: entry.name,
        checked: entry.key === folders.currentKey,
        disabled: entry.key === folders.currentKey,
      })),
      ...(folders.canCreate === false
        ? []
        : [
            {
              id: THREAD_FOLDER_NEW_ID as ThreadFolderMenuAction,
              label: t("New folder…"),
              separatorBefore: folders.entries.length > 0,
            },
          ]),
      ...(folders.inFolder
        ? [
            {
              id: THREAD_FOLDER_REMOVE_ID as ThreadFolderMenuAction,
              label: t("Remove from folder"),
            },
          ]
        : []),
    ],
  };
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "open-in-side-panel",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "notifications",
    "color",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
    "export-markdown",
  ].includes(action);
}

export function isThreadTriageAction(action: string): boolean {
  return (
    action === "settle" ||
    action === "unsettle" ||
    action === "snooze" ||
    action === "unsnooze" ||
    action.startsWith("snooze:")
  );
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
  resolve: typeof t = t,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: t("Find in thread"), icon: "text-search" }]
      : []),
    ...(state.canOpenInSidePanel
      ? [{ id: "open-in-side-panel" as const, label: t("Open in side panel") }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: resolve(msg("New thread on {branch}"), { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: resolve(msg("Unpin thread")), icon: "pin-off" }
            : { id: "pin" as const, label: resolve(msg("Pin thread")), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: resolve(msg("Un-settle thread")),
                icon: "circle-check",
              }
            : { id: "settle" as const, label: resolve(msg("Settle thread")), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" }
            : {
                id: "snooze" as const,
                label: resolve(msg("Snooze")),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: resolve(msg("Custom…")),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(state.supports.later && state.needsYou
      ? [
          state.needsYou === "later"
            ? { id: "later:back" as const, label: t("Move back to Needs you"), icon: "history" }
            : { id: "later" as const, label: t("Decide later"), icon: "clock" },
        ]
      : []),
    {
      id: "rename",
      label: t("Rename thread"),
      icon: "pencil",
      disabled: state.canRename === false,
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? resolve(msg("Regenerating…"))
              : resolve(msg("Regenerate title")),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.hasCompletedRun && !state.isRunning
      ? [{ id: "mark-unread" as const, label: resolve(msg("Mark unread")), icon: "mail-open" }]
      : []),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: resolve(msg("Share with guest")), icon: "user-plus" }]
      : []),
    ...(state.folders ? [buildThreadFolderMenuItem(state.folders)] : []),
    ...(state.tags ? [buildThreadTagsMenuItem(state.tags)] : []),
    ...(state.preferenceItems ?? []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? resolve(msg("Show all projects"))
              : resolve(msg("Filter by {project}"), { project: state.projectFilter.label }),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: resolve(msg("Turn into project")),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: resolve(msg("Auto-settle behavior")),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: resolve(msg("Follow settings")),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: resolve(msg("Never")),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(state.supports.finalReview
      ? [
          {
            id: "final-review" as const,
            label: t("Final review"),
            icon: "circle-check",
            children: [
              { id: "final-review:on" as const, label: t("On"), checked: state.finalReviewEnabled },
              {
                id: "final-review:off" as const,
                label: t("Off"),
                checked: !state.finalReviewEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: resolve(msg("Copy")),
      icon: "copy",
      separatorBefore: true,
      children: [
        {
          id: "copy-path",
          label: resolve(msg("Path")),
          icon: "folder",
        },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch")),
                icon: "git-branch",
              },
            ]
          : []),
        {
          id: "copy-thread",
          label: resolve(msg("Thread")),
          icon: "message-square",
        },
        { id: "copy-thread-id", label: resolve(msg("Thread ID")), icon: "hash" },
      ],
    },
    { id: "export-markdown", label: t("Export as Markdown"), icon: "download" },
    { id: "project-settings", label: t("Project settings"), icon: "settings" },
    {
      id: "archive",
      label: resolve(msg("Archive thread")),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: resolve(msg("Delete")),
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id) &&
        !(state.canTriage === true && isThreadTriageAction(item.id))
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
