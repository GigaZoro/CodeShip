import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";

const THREAD_ROW_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

export interface ThreadRowStatus {
  readonly label: string;
  readonly icon: keyof typeof THREAD_ROW_STATUS_ICONS;
  readonly className: string;
}

/** The short status a thread row shows in place of its age, or null when it has none. */
export function resolveThreadRowStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly goalActive: boolean;
  readonly isWoke: boolean;
  readonly isUnread: boolean;
}): ThreadRowStatus | null {
  switch (input.status) {
    case "working":
      return {
        label: input.goalActive ? "Goal" : "Working",
        icon: "working",
        className: "text-info-foreground",
      };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return {
        label: "Input",
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "request":
      return { label: "Request", icon: "request", className: "text-guest-foreground" };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning-foreground" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error-foreground" };
  }
  if (input.isWoke) {
    return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
  }
  if (input.isUnread) {
    return { label: "Done", icon: "done", className: "text-success-foreground" };
  }
  return null;
}

export function ThreadRowStatusIcon(props: { icon: ThreadRowStatus["icon"]; className: string }) {
  const Icon = THREAD_ROW_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}
