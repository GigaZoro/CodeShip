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
import {
  THREAD_STATUS_DISPLAY,
  type ThreadStatus,
  type ThreadStatusDisplayKey,
  type ThreadStatusTone,
} from "@t3tools/client-runtime/state/thread-status";

import { t } from "~/i18n";
export const THREAD_ROW_STATUS_ICONS = {
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

/** Row text colour for each status tone; the pill and mobile keep their own palettes. */
export const THREAD_ROW_TONE_CLASS: Record<ThreadStatusTone, string> = {
  attention: "text-warning-foreground",
  question: "text-indigo-600 dark:text-indigo-300",
  guest: "text-guest-foreground",
  active: "text-info-foreground",
  muted: "text-muted-foreground",
  error: "text-error-foreground",
  success: "text-success-foreground",
  plan: "text-violet-600 dark:text-violet-300",
};

function rowStatus(key: ThreadStatusDisplayKey, icon: ThreadRowStatusIconName): ThreadRowStatus {
  const display = THREAD_STATUS_DISPLAY[key];
  return { label: t(display.label), icon, className: THREAD_ROW_TONE_CLASS[display.tone] };
}

/** The short status a thread row shows in place of its age, or null when it has none. */
export function resolveThreadRowStatus(input: {
  readonly status: ThreadStatus;
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
  readonly status: ThreadStatus;
  readonly goalActive: boolean;
  readonly isWoke: boolean;
  readonly isUnread: boolean;
}): ThreadRowStatus | null {
  switch (input.status) {
    case "working":
      return rowStatus(input.goalActive ? "goal" : "working", "working");
    case "waiting":
      return rowStatus("waiting", "waiting");
    case "approval":
      return rowStatus("approval", "approval");
    case "input":
      return rowStatus("input", "input");
    case "request":
      return rowStatus("request", "request");
    case "limited":
      return rowStatus("limited", "failed");
    case "failed":
      return rowStatus("failed", "failed");
  }
  if (input.isWoke) return rowStatus("woke", "woke");
  if (input.isUnread) {
    return {
      label: t("Finished, not yet opened"),
      className: THREAD_ROW_TONE_CLASS[THREAD_STATUS_DISPLAY.done.tone],
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
