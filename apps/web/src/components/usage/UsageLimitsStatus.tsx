import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  type AccountFailoverEntry,
  describeAccountFailover,
  type limitsFreshness,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeftIcon, CloudOffIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { formatChatTimestampTooltip, formatUpcomingTimestamp } from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { t } from "~/i18n";

/** Relabels only when the minute or hour changes, not on a ticking clock. */
export function useCheckedAgo(checkedAt: string): string | null {
  const relative = useRelativeTimeState(checkedAt);
  if (relative.status !== "relative") return null;
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function LimitsCheckedAt({ checkedAt }: { readonly checkedAt: string }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const relative = useRelativeTimeState(checkedAt);
  if (relative.status !== "relative") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time dateTime={checkedAt} className="text-xs text-muted-foreground tabular-nums" />
        }
      >
        {relative.suffix
          ? t("Checked {time} ago", { time: relative.value })
          : t("Checked just now")}
      </TooltipTrigger>
      <TooltipPopup>
        {t("Checked at {time}", { time: formatChatTimestampTooltip(checkedAt, timestampFormat) })}
      </TooltipPopup>
    </Tooltip>
  );
}

function OfflineReading({
  label,
  checkedAt,
}: {
  readonly label: string;
  readonly checkedAt: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const ago = useCheckedAgo(checkedAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={checkedAt}
            className="inline-flex items-center gap-1.5 text-xs text-warning-foreground tabular-nums"
          />
        }
      >
        <CloudOffIcon aria-hidden className="size-3.5 shrink-0" />
        {ago
          ? t("{environment} not connected · read {time}", { environment: label, time: ago })
          : t("{environment} not connected", { environment: label })}
      </TooltipTrigger>
      <TooltipPopup>
        {t(
          "{environment} isn't connected, so its limits are from {time}. They update when it reconnects.",
          {
            environment: label,
            time: formatChatTimestampTooltip(checkedAt, timestampFormat),
          },
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

/** When the shown limits were read, naming each machine that cannot refresh its own right now. */
export function LimitsFreshness({
  freshness,
}: {
  readonly freshness: ReturnType<typeof limitsFreshness>;
}) {
  if (freshness.checkedAt === null && freshness.offline.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {freshness.offline.map((entry) => (
        <OfflineReading key={entry.label} label={entry.label} checkedAt={entry.checkedAt} />
      ))}
      {freshness.checkedAt ? <LimitsCheckedAt checkedAt={freshness.checkedAt} /> : null}
    </span>
  );
}

export function AccountFailoverNotice({
  entries,
  now,
  showEnvironment,
}: {
  readonly entries: readonly AccountFailoverEntry[];
  readonly now: number;
  readonly showEnvironment: boolean;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {entries.map((entry) => (
        <p
          key={entry.environmentId}
          className="flex items-start gap-2 text-xs text-muted-foreground"
        >
          <ArrowRightLeftIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {showEnvironment ? (
              <span className="font-medium text-foreground">
                {t("{environment}: ", { environment: entry.environmentLabel })}
              </span>
            ) : null}
            {describeAccountFailover(entry.status, {
              accountName: resolveProviderInstanceDisplayName,
              time: (isoDate) => formatUpcomingTimestamp(isoDate, timestampFormat, now),
            })}{" "}
            <InlineButton
              render={
                <Link
                  to="/settings/threads"
                  search={{ machine: entry.environmentId }}
                  hash="usage-limit-recovery"
                />
              }
            >
              {entry.status.kind === "off" ? t("Turn on in Settings") : t("Account order")}
            </InlineButton>
          </span>
        </p>
      ))}
    </div>
  );
}
