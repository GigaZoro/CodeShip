import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  type AccountFailoverEntry,
  describeAccountFailover,
  type limitsFreshness,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeftIcon, CloudOffIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import {
  formatRelativeElapsed,
  relativeTimeElapsedMs,
  formatChatTimestampTooltip,
  formatUpcomingTimestamp,
} from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { t } from "~/i18n";

function checkedRelative(checkedAt: string, now: number) {
  const elapsed = relativeTimeElapsedMs(checkedAt, now);
  return elapsed === null ? null : formatRelativeElapsed(elapsed);
}

export function formatCheckedAgo(checkedAt: string, now: number): string | null {
  const relative = checkedRelative(checkedAt, now);
  if (!relative) return null;
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function LimitsCheckedAt({ checkedAt, now }: { readonly checkedAt: string; readonly now: number }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const relative = checkedRelative(checkedAt, now);
  if (!relative) return null;
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
  now,
}: {
  readonly label: string;
  readonly checkedAt: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const ago = formatCheckedAgo(checkedAt, now);
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
  now,
}: {
  readonly now: number;
  readonly freshness: ReturnType<typeof limitsFreshness>;
}) {
  if (freshness.checkedAt === null && freshness.offline.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {freshness.offline.map((entry) => (
        <OfflineReading
          key={entry.label}
          label={entry.label}
          checkedAt={entry.checkedAt}
          now={now}
        />
      ))}
      {freshness.checkedAt ? <LimitsCheckedAt checkedAt={freshness.checkedAt} now={now} /> : null}
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
                  to={entry.status.kind === "off" ? "/settings/threads" : "/settings/providers"}
                  search={{ machine: entry.environmentId }}
                  hash={entry.status.kind === "off" ? "usage-limit-recovery" : "account-failover"}
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
