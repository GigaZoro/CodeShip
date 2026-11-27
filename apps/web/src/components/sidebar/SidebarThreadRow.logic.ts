import {
  pickRowMarker,
  type RowMarkerKind,
  type RowMarkerSelection,
  type ThreadStatus,
} from "@t3tools/client-runtime/state/thread-status";
import type { SidebarGrouping } from "@t3tools/contracts/settings";

import type { ThreadRowStatus } from "./threadRowStatus";

export type { RowMarkerKind };

interface SidebarThreadRowMarkerState {
  readonly status: ThreadStatus;
  readonly hasPr: boolean;
  readonly machineUnreachable: boolean;
  readonly hasUnsentDraft: boolean;
  readonly hasQueuedMessages: boolean;
  readonly hasRunningTerminal: boolean;
  readonly hasScheduledTask: boolean;
  readonly showPin: boolean;
  readonly hasMachineBadge: boolean;
  readonly hasProject: boolean;
  readonly hasTags: boolean;
  readonly hasColor: boolean;
  readonly hasNotificationPreference: boolean;
  readonly hasProvider: boolean;
}

/**
 * Derives the single resting marker for a sidebar row and the priority-ordered
 * overflow markers for its hover card.
 */
export function resolveSidebarRowMarkers(
  state: SidebarThreadRowMarkerState,
  grouping: SidebarGrouping,
): RowMarkerSelection {
  return pickRowMarker(
    {
      needsYou:
        state.status === "approval" || state.status === "input" || state.status === "request",
      failed: state.status === "failed" || state.status === "limited",
      pr: state.hasPr,
      machineOffline: state.machineUnreachable,
      draft: state.hasUnsentDraft,
      queued: state.hasQueuedMessages,
      terminal: state.hasRunningTerminal,
      scheduled: state.hasScheduledTask,
      pinned: state.showPin,
      machine: state.hasMachineBadge,
      project: state.hasProject,
      tags: state.hasTags,
      color: state.hasColor,
      notifications: state.hasNotificationPreference,
      provider: state.hasProvider,
    },
    grouping,
  );
}

/**
 * True when the row's status slot already expresses `primary`, so the row
 * should not render a second copy of it.
 */
export function statusCoversRowMarker(
  primary: RowMarkerKind | null,
  topStatus: ThreadRowStatus | null,
  showsStatusSlot: boolean,
): boolean {
  if (primary === null || !showsStatusSlot || topStatus === null) return false;
  if (primary === "needsYou" || primary === "failed") return true;
  return primary === "machineOffline" && topStatus.lastKnown !== undefined;
}
