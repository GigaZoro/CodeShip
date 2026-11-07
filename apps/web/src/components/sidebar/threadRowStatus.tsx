import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";

import { t } from "~/i18n";
const THREAD_ROW_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  woke: AlarmClockIcon,
} as const;

type ThreadRowStatusIconName = keyof typeof THREAD_ROW_STATUS_ICONS;

export type ThreadRowStatus =
  | {
      readonly label: string;
      readonly icon: ThreadRowStatusIconName;
      readonly unseen?: undefined;
      readonly className: string;
    }
  /** A finished turn the user has not opened yet: shown as a dot, not a pill. */
  | {
      readonly label: string;
      readonly icon?: undefined;
      readonly unseen: true;
      readonly className: string;
    };

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
        label: input.goalActive ? t("Goal") : t("Working"),
        icon: "working",
        className: "text-info-foreground",
      };
    case "waiting":
      return { label: t("Waiting"), icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: t("Approval"), icon: "approval", className: "text-warning-foreground" };
    case "input":
      return {
        label: t("Question"),
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "request":
      return { label: t("Request"), icon: "request", className: "text-guest-foreground" };
    case "limited":
      return { label: t("Limited"), icon: "failed", className: "text-warning-foreground" };
    case "failed":
      return { label: t("Failed"), icon: "failed", className: "text-error-foreground" };
  }
  if (input.isWoke) {
    return { label: t("Woke"), icon: "woke", className: "text-warning-foreground" };
  }
  if (input.isUnread) {
    return {
      label: t("Finished, not yet opened"),
      className: "text-success-foreground",
      unseen: true,
    };
  }
  return null;
}

function ThreadRowStatusIcon(props: { icon: ThreadRowStatusIconName; className: string }) {
  const Icon = THREAD_ROW_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

/** The status's icon and label, or a small dot for a completion the user has not seen. */
export function ThreadRowStatusContent(props: { status: ThreadRowStatus; iconClassName: string }) {
  const { status } = props;
  if (status.unseen) {
    return <span role="img" aria-label={status.label} className="size-2 rounded-full bg-current" />;
  }
  return (
    <>
      <ThreadRowStatusIcon icon={status.icon} className={props.iconClassName} />
      {status.label}
    </>
  );
}
