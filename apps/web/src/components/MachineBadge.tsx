import { machineAccent } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { t } from "~/i18n";

/** A machine's initial on its own colour, so machines with the same name and icon look apart. */
export function MachineBadge(props: {
  environmentId: EnvironmentId;
  label: string;
  className?: string;
}) {
  const accent = machineAccent(props.environmentId, props.label);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-3xs leading-none font-semibold text-white",
        props.className,
      )}
      style={{ backgroundColor: accent.color }}
    >
      {accent.initial}
    </span>
  );
}

/** "5m ago" since the machine was last connected, ticking each minute; null when unknown. */
function useLastSeenAge(lastSeenAt: number | null): string | null {
  const nowMinute = useNowMinute();
  if (lastSeenAt === null) return null;
  const nowMs = Math.max(Date.parse(`${nowMinute}:00.000Z`), lastSeenAt);
  return formatRelativeTimeLabel(new Date(lastSeenAt).toISOString(), nowMs);
}

/** "last seen 5m ago", or nothing when this client has not seen the machine connected. */
export function MachineLastSeen(props: { lastSeenAt: number | null; compact?: boolean }) {
  const age = useLastSeenAge(props.lastSeenAt);
  if (age === null) return null;
  return <>{props.compact ? age : t("last seen {time}", { time: age })}</>;
}
