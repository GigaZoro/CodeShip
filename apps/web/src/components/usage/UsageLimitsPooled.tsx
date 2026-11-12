import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import {
  type AccountFailoverEntry,
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  type ExternalUsageLink,
  formatDuration,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  limitAccountLocations,
  limitsFreshness,
  paceRemainingPercent,
  poolResetSummary,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AlertTriangleIcon,
  CloudOffIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  TicketIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  PaceIcon,
  ResetCreditDialog,
  barColor,
  usePaceMark,
  resetCreditsSummary,
  useResetCredit,
} from "./UsageLimits";
import { AccountFailoverNotice, LimitsFreshness, useCheckedAgo } from "./UsageLimitsStatus";
import { CodexLimitsSignIn } from "./CodexLimitsSignIn";
import { ProviderHolds } from "./UsageHolds";
import { t, tn } from "~/i18n";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={t("Account {initials}", { initials: accountInitials(email) })}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now, "after");
  const where = limitAccountLocations(account).join(", ");
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  const checkedAgo = useCheckedAgo(account.limits.checkedAt);
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel={t("Toggle account email visibility")}
            revealTooltip={t("Click to reveal email")}
            hideTooltip={t("Click to hide email")}
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label={t("Plan")}>{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? t("Signed in") : t("Via")}>{where}</Row>
        ) : null}
        <Row label={t("Checked")}>
          {formatDayAwareTimestamp(account.limits.checkedAt, timestampFormat, now)}
          {checkedAgo ? ` · ${checkedAgo}` : ""}
        </Row>
        {account.offline ? (
          <span className="flex items-start gap-1.5 text-warning-foreground">
            <CloudOffIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            {t("Not connected, so this is its last reading.")}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label={t("Left")}>{remaining}%</Row>
        {window.resetsAt ? (
          <Row label={t("Resets")}>
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? (
          <Row label={t("Even pace")}>{t("{percent}% left by now", { percent: timeLeft })}</Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label={t("Restores")}>
            {t("+{percent}% of pool", { percent: reset.restoresPercent })}
          </Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders || account.offline}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? t("Using…") : t("Use reset")}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now" | "onRedeem">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);

function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.members.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (available) return;
    handle.close();
    actions.current?.unmount();
  }, [available, handle, actions]);
  return (
    <PopoverPopup side="top" sideOffset={6}>
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={() => {
          handle.close();
          payload.redeem?.setConfirming(true);
        }}
      />
    </PopoverPopup>
  );
}

/**
 * The confirm is a sibling of the popover, not a child: dialogs stack under
 * popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  return account.redeem ? (
    <RedeemableSegment account={account} redeemAt={account.redeem} {...props} />
  ) : (
    <SegmentTriggers account={account} redeem={null} {...props} />
  );
}

function RedeemableSegment({
  redeemAt,
  ...props
}: Omit<Parameters<typeof SegmentTriggers>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <SegmentTriggers redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? t("Using reset credit…") : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function SegmentTriggers({
  account,
  window,
  reset,
  redeem,
  refillPercent,
  color,
  now,
  index,
  showAccountName,
}: SegmentPayload & {
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const payload: SegmentPayload = { account, window, reset, redeem };
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef, paceMark] = usePaceMark(timeLeft);
  const resetsIn = formatResetsIn(window, now, "arrow");
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <>
      <PopoverTrigger
        handle={popover}
        payload={payload}
        openOnHover
        render={
          <button
            ref={segmentRef}
            type="button"
            style={{ gridColumn: index, gridRow: 1, ...paceMark?.gappedTrack }}
            aria-label={[
              t("{name}: {percent}% left", {
                name:
                  account.displayName ??
                  (account.email ? accountInitials(account.email) : account.driver),
                percent: remaining,
              }),
              ...(resetsIn ? [resetsIn] : []),
              ...(timeLeft === null
                ? []
                : [t("{percent}% of the window left", { percent: timeLeft })]),
              ...(credits
                ? [tn(credits, "{count} reset credit banked", "{count} reset credits banked")]
                : []),
              ...(account.offline ? [t("not connected")] : []),
            ].join(", ")}
            className="relative h-5 min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border @2xl/pool:h-8"
          />
        }
      >
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
          {/* Clipped inside the rounded clip so the bar's own corners keep their antialiasing. */}
          <div className="absolute inset-0" style={paceMark?.gap}>
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-md opacity-35"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
            {remaining < 100 && reset && refillPercent > 0 ? (
              <div
                aria-hidden
                className="absolute inset-y-0 right-0 opacity-20"
                style={{
                  width: `${Math.min(100 - remaining, refillPercent)}%`,
                  backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
                }}
              />
            ) : null}
          </div>
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
        {/* One account's bar needs no labels: the headline, reset line, and credits row say it all. */}
        {showAccountName ? (
          <>
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md text-3xs leading-none font-semibold text-foreground/80 tabular-nums @2xl/pool:hidden"
            >
              {index}
            </span>
            <div className="relative hidden h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
              <AccountName
                account={account}
                className="min-w-0 truncate font-medium text-foreground"
              />
              <span className="shrink-0 font-semibold text-foreground tabular-nums">
                {remaining}%
              </span>
              {account.offline ? (
                <CloudOffIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
              ) : null}
              {resetsIn || credits ? (
                <span className="ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-background px-1.5 py-0.5 whitespace-nowrap text-foreground tabular-nums">
                  {resetsIn ?? ""}
                  {credits ? (
                    <>
                      {resetsIn ? (
                        <span aria-hidden className="text-muted-foreground">
                          ·
                        </span>
                      ) : null}
                      <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                        <TicketIcon className="size-3" aria-hidden />
                        {credits}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </PopoverTrigger>
      {showAccountName ? (
        <LegendRow payload={payload} color={color} now={now} index={index} />
      ) : null}
    </>
  );
}

function LegendRow({
  payload,
  color,
  now,
  index,
}: {
  readonly payload: SegmentPayload;
  readonly color: string;
  readonly now: number;
  readonly index: number;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const { account, window } = payload;
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now, "arrow");
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <PopoverTrigger
      handle={popover}
      payload={payload}
      style={{ gridColumn: "1 / -1", gridRow: index + 1 }}
      render={<Button variant="ghost" size="compact" />}
      className="min-w-0 @2xl/pool:hidden"
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-3xs leading-none font-semibold text-foreground/80 tabular-nums">
        <span
          aria-hidden
          className="absolute inset-0 rounded-sm opacity-35"
          style={{ backgroundColor: color }}
        />
        <span className="sr-only">{t("Segment")} </span>
        <span className="relative">{index}</span>
      </span>
      <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
      <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
      {account.offline ? (
        <>
          <CloudOffIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
          <span className="sr-only">{t("not connected")}</span>
        </>
      ) : null}
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        {resetsIn ?? ""}
        {credits ? (
          <>
            {resetsIn ? <span aria-hidden>·</span> : null}
            <span
              aria-hidden
              className="inline-flex items-center gap-0.5 font-semibold text-foreground"
            >
              <TicketIcon className="size-3" aria-hidden />
              {credits}
            </span>
            <span className="sr-only">
              {tn(credits, "{count} reset credit banked", "{count} reset credits banked")}
            </span>
          </>
        ) : null}
      </span>
    </PopoverTrigger>
  );
}

function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              refillPercent={member.refillPercent}
              color={normalizeProviderAccentColor(member.account.accentColor) ?? color}
              now={now}
              index={position + 1}
              showAccountName={pool.columns.length > 1}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function PoolResetLine({ pool, now }: { readonly pool: LimitPoolWindow; readonly now: number }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const summary = poolResetSummary(pool, now);
  if (!summary) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-sm text-foreground tabular-nums">
      <RotateCcwIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {summary.text}
      {summary.resetsAt ? (
        <span className="text-xs text-muted-foreground">
          {formatUpcomingTimestamp(summary.resetsAt, timestampFormat, now)}
        </span>
      ) : null}
    </span>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}) {
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="text-sm text-muted-foreground">{t("left")}</span>
          {pool.pace ? <PaceIcon pace={pool.pace} withLabel /> : null}
        </span>
        <PoolResetLine pool={pool} now={now} />
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
    </div>
  );
}

function AccountResetCredits({
  account,
  redeemAt,
  named,
  now,
}: {
  readonly account: LimitAccount;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly named: boolean;
  readonly now: number;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  const credits = account.limits.resetCredits;
  const count = credits?.availableCount ?? 0;
  // Stay mounted after the last credit is spent so the outcome is still readable.
  if (count === 0 && redeem.status === null && !redeem.busy) return null;
  const expiresIn = credits?.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <TicketIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {named ? <AccountName account={account} className="font-medium text-foreground" /> : null}
      <span className="font-medium text-foreground tabular-nums">
        {tn(count, "{count} reset credit", "{count} reset credits")}
      </span>
      {expiresIn ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {t("next expires in {duration}", { duration: expiresIn })}
        </span>
      ) : null}
      {account.offline && count > 0 ? (
        <span className="text-xs text-warning-foreground">
          {t("Usable once {environment} reconnects", {
            environment: limitAccountLocations(account).join(", "),
          })}
        </span>
      ) : null}
      {redeem.busy || redeem.status ? (
        <span role="status" className="text-xs text-foreground">
          {redeem.busy ? t("Using reset credit…") : redeem.status}
        </span>
      ) : null}
      {count > 0 ? (
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          disabled={redeem.busy || !redeem.canManageProviders || account.offline}
          onClick={() => redeem.setConfirming(true)}
        >
          {redeem.busy ? t("Using…") : t("Use reset")}
        </Button>
      ) : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </div>
  );
}

function PoolResetCredits({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const accounts = pool.accounts.flatMap((account) =>
    account.redeem && account.limits.resetCredits ? [{ account, redeemAt: account.redeem }] : [],
  );
  if (accounts.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 empty:hidden">
      {accounts.map(({ account, redeemAt }) => (
        <AccountResetCredits
          key={account.key}
          account={account}
          redeemAt={redeemAt}
          named={pool.accounts.length > 1}
          now={now}
        />
      ))}
    </div>
  );
}

/** Accounts whose limits another site keeps, so they have no bar here. */
function ExternalUsageAccounts({
  link,
  showEnvironment,
}: {
  readonly link: ExternalUsageLink;
  readonly showEnvironment: boolean;
}) {
  const chatGpt = link.url === CHATGPT_USAGE_URL;
  const canSignIn = link.accounts.some((account) => account.signIns.length > 0);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
            {chatGpt ? <OpenAI className="size-4 shrink-0" aria-hidden="true" /> : null}
            {chatGpt ? t("Limits kept by ChatGPT") : link.label}
          </h3>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            {chatGpt ? t("Open ChatGPT usage") : t("Manage usage")}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        {chatGpt || link.message ? (
          <p className="max-w-2xl text-xs text-muted-foreground">
            {chatGpt
              ? canSignIn
                ? t(
                    "ChatGPT shares an account's limits only with Codex's own login. Read limits once per account on each machine: T3.CodeShip then shows its limits, switches accounts before they run out, and resumes threads when they reset.",
                  )
                : t(
                    "ChatGPT shares an account's limits only with that account's Codex CLI login. Add the login as a Codex provider on a connected machine to see its limits here, or open ChatGPT signed in as the account.",
                  )
              : link.message}
          </p>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-border/60 border-t border-border/60">
        {link.accounts.map((account) => (
          <li
            key={account.key}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-2">
              {account.email ? <AccountChip email={account.email} /> : null}
              <span className="truncate font-medium text-foreground">
                {account.names.join(" / ")}
              </span>
            </span>
            <span className="text-muted-foreground">{account.environments.join(" · ")}</span>
            {account.signIns.length > 0 ? (
              <div className="flex w-full flex-col gap-2 pt-1">
                {account.signIns.map((target) => (
                  <CodexLimitsSignIn
                    key={`${target.environmentId}:${target.instanceId}`}
                    target={target}
                    showEnvironment={showEnvironment}
                  />
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderSection({
  driver,
  pool,
  external,
  now,
  failover,
  showEnvironment,
  environments,
}: {
  readonly environments: ReadonlyMap<EnvironmentId, string>;
  readonly driver: ProviderDriverKind;
  readonly pool: LimitPool | null;
  readonly external: readonly ExternalUsageLink[];
  readonly now: number;
  readonly failover: readonly AccountFailoverEntry[];
  readonly showEnvironment: boolean;
}) {
  const color = barColor(driver);
  const label = providerClients.get(driver)?.label ?? String(driver);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ProviderInstanceIcon
              driverKind={driver}
              displayName={label}
              indicatorBackground="var(--background)"
              className="size-5"
              iconClassName="size-4 text-foreground/80"
            />
            {label}
          </h2>
          {pool ? <LimitsFreshness freshness={limitsFreshness(pool.accounts)} /> : null}
        </div>
        <AccountFailoverNotice
          entries={failover.filter((entry) => entry.driver === driver)}
          now={now}
          showEnvironment={showEnvironment}
        />
        <ProviderHolds driver={driver} environments={environments} now={now} />
      </div>
      {pool
        ? displayLimitWindows(pool).map((window) => {
            const details = driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
            return (
              <PoolWindowCard
                key={`${window.kind}:${window.id}`}
                pool={window}
                color={color}
                now={now}
                label={details?.label}
                description={details?.description}
              />
            );
          })
        : null}
      {pool ? <PoolResetCredits pool={pool} now={now} /> : null}
      {external.map((link) => (
        <ExternalUsageAccounts key={link.url} link={link} showEnvironment={showEnvironment} />
      ))}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  failover = [],
  cursorPrompt,
  emptyMessage = t("No provider on the selected environments reports subscription limits."),
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  /** Account switching per environment and provider, shown under each provider's limits. */
  readonly failover?: readonly AccountFailoverEntry[];
  readonly cursorPrompt?: ReactNode;
  readonly emptyMessage?: string;
}) {
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const environments = new Map(
    [...presentations].map(([id, presentation]) => [id, presentation.entry.target.label]),
  );
  const sections = [
    ...pools.map((pool) => ({ driver: pool.driver, pool })),
    ...[...new Set(externalLinks.map((link) => link.driver))]
      .filter((driver) => !pools.some((pool) => pool.driver === driver))
      .map((driver) => ({ driver, pool: null })),
  ];
  const cursorPromptAt =
    Math.max(
      sections.findIndex((section) => section.driver === "codex"),
      sections.findIndex((section) => section.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : null}
      <SegmentPopoverContext value={segmentPopover}>
        {sections.map((section, index) => (
          <Fragment key={section.driver}>
            {index === cursorPromptAt ? cursorPrompt : null}
            <ProviderSection
              driver={section.driver}
              pool={section.pool}
              external={externalLinks.filter((link) => link.driver === section.driver)}
              now={now}
              failover={failover}
              showEnvironment={presentations.size > 1}
              environments={environments}
            />
          </Fragment>
        ))}
      </SegmentPopoverContext>
      <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
        {({ payload }) =>
          payload ? (
            <ActiveSegmentPopover
              handle={segmentPopover}
              actions={segmentPopoverActions}
              payload={payload}
              pools={pools}
              now={now}
            />
          ) : null
        }
      </Popover>
      {cursorPromptAt === sections.length ? cursorPrompt : null}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
