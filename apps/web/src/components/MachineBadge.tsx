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

/** "last seen 5m ago", ticking each minute, or nothing when this client has not seen it connected. */
export function MachineLastSeen(props: { lastSeenAt: number | null }) {
  const nowMinute = useNowMinute();
  if (props.lastSeenAt === null) return null;
  const nowMs = Math.max(Date.parse(`${nowMinute}:00.000Z`), props.lastSeenAt);
  return (
    <>
      {t("last seen {time}", {
        time: formatRelativeTimeLabel(new Date(props.lastSeenAt).toISOString(), nowMs),
      })}
    </>
  );
}
