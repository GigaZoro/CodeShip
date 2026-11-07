import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { type AccountFailoverEntry, describeAccountFailover } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeftIcon } from "lucide-react";

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

export function LimitsCheckedAt({ checkedAt }: { readonly checkedAt: string }) {
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
                  to="/settings/providers"
                  search={{ machine: entry.environmentId }}
                  hash="account-failover"
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
