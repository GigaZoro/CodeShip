import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  WifiOffIcon,
} from "lucide-react";
import {
  machineAvailabilityLabel,
  machineShowsLastKnownState,
  type MachineAvailability,
} from "@t3tools/client-runtime/connection";

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
  offline: WifiOffIcon,
} as const;

type ThreadRowStatusIconName = keyof typeof THREAD_ROW_STATUS_ICONS;

export type ThreadRowStatus =
  | {
      readonly label: string;
      readonly icon: ThreadRowStatusIconName;
      readonly unseen?: undefined;
      readonly className: string;
      /** Set when the machine is unreachable and the status is only what was last seen. */
      readonly lastKnown?: { readonly label: string } | undefined;
    }
  /** A finished turn the user has not opened yet: shown as a dot, not a pill. */
  | {
      readonly label: string;
      readonly icon?: undefined;
      readonly unseen: true;
      readonly className: string;
      readonly lastKnown?: undefined;
    };

/** The short status a thread row shows in place of its age, or null when it has none. */
export function resolveThreadRowStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly goalActive: boolean;
  readonly isWoke: boolean;
  readonly isUnread: boolean;
  /** The thread's machine; while it is unreachable, a live status shows as last known. */
  readonly machine?: MachineAvailability | undefined;
}): ThreadRowStatus | null {
  const status = resolveLiveThreadRowStatus(input);
  if (
    status?.icon === undefined ||
    input.machine === undefined ||
    !machineShowsLastKnownState(input.machine) ||
    !LIVE_ICONS.has(status.icon)
  ) {
    return status;
  }
  const machineLabel = machineAvailabilityLabel(input.machine);
  return {
    label: t("{machine} · {status}", { machine: machineLabel, status: status.label }),
    icon: "offline",
    className: "text-muted-foreground",
    lastKnown: {
      label: t("{machine}, last known status: {status}", {
        machine: machineLabel,
        status: status.label,
      }),
    },
  };
}

// Statuses that change while the machine runs; an unreachable machine can only report the last one.
const LIVE_ICONS: ReadonlySet<ThreadRowStatusIconName> = new Set([
  "working",
  "waiting",
  "input",
  "request",
  "approval",
]);

function resolveLiveThreadRowStatus(input: {
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
      {status.lastKnown ? (
        <>
          <span aria-hidden>{status.label}</span>
          <span className="sr-only">{status.lastKnown.label}</span>
        </>
      ) : (
        status.label
      )}
    </>
  );
}
