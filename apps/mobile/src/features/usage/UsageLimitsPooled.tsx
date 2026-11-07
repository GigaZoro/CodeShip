import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  CHATGPT_USAGE_URL,
  collectAccountFailover,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  describeAccountFailover,
  displayLimitWindows,
  type ExternalUsageLink,
  formatResetsIn,
  limitAccountLocations,
  limitsFreshness,
  paceRemainingPercent,
  poolResetSummary,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode, useId, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Defs, Path, Pattern, Rect, Svg } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { environmentPresentations } from "../../state/presentation";
import { relativeTime } from "../../lib/time";
import { ResetCredits } from "./UsageLimitsSection";
import { usageProviderKind, useProviderColors } from "./usageProviders";
import { t, tn, msg, getFormattingLocale } from "../../lib/i18n";

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  grok: "Grok",
  antigravity: "Antigravity",
};
const PACE_LABEL = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
} as const;

function checkedAgo(checkedAt: string, now: number) {
  const ago = relativeTime(checkedAt, now);
  return ago === "<1m" ? t("Checked just now") : t("Checked {time} ago", { time: ago });
}

function timeAgo(checkedAt: string, now: number) {
  const ago = relativeTime(checkedAt, now);
  return ago === "<1m" ? t("just now") : t("{time} ago", { time: ago });
}

function LimitsFreshness({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  const freshness = limitsFreshness(accounts);
  return (
    <View className="items-end">
      {freshness.offline.map((entry) => (
        <View key={entry.label} className="flex-row items-center gap-1">
          <SymbolView name="wifi.slash" size={12} tintColorClassName="accent-warning-foreground" />
          <Text className="text-xs tabular-nums text-warning-foreground">
            {t("{environment} not connected · read {time}", {
              environment: entry.label,
              time: timeAgo(entry.checkedAt, now),
            })}
          </Text>
        </View>
      ))}
      {freshness.checkedAt ? (
        <Text className="text-xs tabular-nums text-foreground-tertiary">
          {checkedAgo(freshness.checkedAt, now)}
        </Text>
      ) : null}
    </View>
  );
}

function ResetLine({ pool, now }: { readonly pool: LimitPoolWindow; readonly now: number }) {
  const summary = poolResetSummary(pool, now);
  if (!summary) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-1.5">
      <SymbolView name="arrow.clockwise" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="text-sm tabular-nums text-foreground">{summary.text}</Text>
      {summary.resetsAt ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          {formatResetTime(summary.resetsAt)}
        </Text>
      ) : null}
    </View>
  );
}

function PoolResetCredits({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const accounts = pool.accounts.filter(
    (account) => account.redeem && (account.limits.resetCredits?.availableCount ?? 0) > 0,
  );
  if (accounts.length === 0) return null;
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      {accounts.map((account) => (
        <View key={account.key} className="gap-2">
          <View className="flex-row items-center gap-2">
            <SymbolView name="ticket" size={14} tintColorClassName="accent-icon" />
            <Text
              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
              numberOfLines={1}
            >
              {pool.accounts.length > 1
                ? t("{account}: reset credits", { account: accountName(account) })
                : t("Reset credits")}
            </Text>
          </View>
          <ResetCredits
            environmentId={account.redeem!.environmentId}
            input={account.redeem!.input}
            credits={account.limits.resetCredits!}
            now={now}
            offline={account.offline}
          />
          {account.offline ? (
            <Text className="text-xs text-warning-foreground">
              {t("Usable once {environment} reconnects", {
                environment: limitAccountLocations(account).join(", "),
              })}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ExternalUsageAccounts({ link }: { readonly link: ExternalUsageLink }) {
  const chatGpt = link.url === CHATGPT_USAGE_URL;
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="gap-1">
        <Text className="text-sm font-t3-medium text-foreground">
          {chatGpt ? t("Limits kept by ChatGPT") : link.label}
        </Text>
        {chatGpt || link.message ? (
          <Text className="text-xs text-foreground-muted">
            {chatGpt
              ? t(
                  "These accounts use your ChatGPT plan, and ChatGPT doesn't share their limits with apps. Open ChatGPT signed in as the account to see them.",
                )
              : link.message}
          </Text>
        ) : null}
      </View>
      {link.accounts.map((account) => (
        <View key={account.key} className="flex-row items-center gap-2">
          {account.email ? <AccountChip email={account.email} /> : null}
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
              {account.names.join(" / ")}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {account.environments.join(" · ")}
            </Text>
          </View>
        </View>
      ))}
      <Pressable
        accessibilityRole="link"
        className="min-h-11 justify-center"
        onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
      >
        <Text className="text-sm font-t3-medium text-primary">
          {chatGpt ? t("Open ChatGPT usage") : t("Manage usage")}
        </Text>
      </Pressable>
    </View>
  );
}

const formatResetTime = (isoDate: string) =>
  new Date(isoDate).toLocaleString(getFormattingLocale(), {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

function segmentAccessibilityLabel(
  index: number,
  account: LimitAccount,
  window: Parameters<typeof remainingPercent>[0],
  extras: ReadonlyArray<string | null>,
) {
  return [
    t("Segment {number}, {name}, {percent}% left", {
      number: index + 1,
      name: accountName(account),
      percent: remainingPercent(window),
    }),
    ...extras,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

function accountName(account: LimitAccount) {
  if (account.displayName) return account.displayName;
  if (!account.email) return DRIVER_LABEL[account.driver] ?? String(account.driver);
  return emailInitials(account.email) || t("Account");
}

function emailInitials(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

function accountHue(email: string) {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

// Same hashed hue as the web account chip, so an account keeps its color across clients.
function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <View
      className="size-5 items-center justify-center rounded-full"
      style={{ backgroundColor: `hsl(${hue}, 45%, 82%)` }}
    >
      <Text className="text-[9px] font-t3-bold" style={{ color: `hsl(${hue}, 45%, 28%)` }}>
        {emailInitials(email)}
      </Text>
    </View>
  );
}

// Same gap-and-tick as the Limits rows: two clipped copies of the segment leave a see-through gap.
function PaceGap({
  timeLeft,
  children,
}: {
  readonly timeLeft: number | null;
  readonly children: ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const tickX =
    timeLeft === null || width < 6
      ? null
      : Math.min(Math.max((width * timeLeft) / 100, 3), width - 3);
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {tickX === null
        ? children
        : (
            [
              [0, tickX - 3],
              [tickX + 3, width],
            ] as const
          ).map(([start, end]) => (
            <View
              key={start}
              className="absolute top-0 bottom-0 overflow-hidden"
              style={{ left: start, width: end - start }}
            >
              <View className="absolute top-0 bottom-0" style={{ left: -start, width }}>
                {children}
              </View>
            </View>
          ))}
      {tickX !== null ? (
        <View
          className="absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-foreground"
          style={{ left: tickX - 1 }}
        />
      ) : null}
    </View>
  );
}

function AccountSegment({
  remaining,
  color,
  refillPercent,
}: {
  readonly remaining: number;
  readonly color: string;
  readonly refillPercent: number;
}) {
  const patternId = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
      {size.width > 0 && size.height > 0 ? (
        // Numeric canvas dimensions clear Android SVG geometry cached before a segment resized.
        <Svg width={size.width} height={size.height} accessible={false}>
          <Defs>
            <Pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse">
              <Path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke={color} strokeWidth={1} opacity={0.22} />
            </Pattern>
          </Defs>
          {refillPercent > 0 ? (
            <Rect
              x={`${100 - Math.min(100 - remaining, refillPercent)}%`}
              width={`${Math.min(100 - remaining, refillPercent)}%`}
              height="100%"
              fill={`url(#${patternId})`}
            />
          ) : null}
          <Rect width={`${remaining}%`} height="100%" fill={color} opacity={0.35} />
        </Svg>
      ) : null}
    </View>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  environmentIds,
  label,
  description,
  wide,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
  readonly label?: string;
  readonly description?: string;
  readonly wide: boolean;
}) {
  const navigation = useNavigation();
  const [barWidth, setBarWidth] = useState(0);
  // Each segment needs room for its account, percent and reset to label itself.
  const segmentWidth = barWidth / Math.max(pool.columns.length, 1);
  const inlineLabels = wide && segmentWidth >= 96;
  const inlineReset = wide && segmentWidth >= 150;
  const inlineName = wide && segmentWidth >= 220;
  const openAccount = (account: LimitAccount) =>
    navigation.navigate("SettingsUsageAccount", {
      accountKey: account.key,
      windowId: pool.id,
      windowKind: pool.kind,
      environmentIds,
      now,
    });
  const summary = (
    <>
      <View className={wide ? "gap-1" : "flex-row items-start justify-between gap-3"}>
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">{label ?? pool.label}</Text>
          <View className="flex-row items-baseline gap-1.5">
            <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
              {pool.remainingPercent}%
            </Text>
            <Text className="text-sm text-foreground-muted">{t("left")}</Text>
          </View>
        </View>
        {pool.pace ? (
          <Text className="text-xs text-foreground-tertiary">{t(PACE_LABEL[pool.pace])}</Text>
        ) : null}
      </View>
      {description ? <Text className="text-xs text-foreground-muted">{description}</Text> : null}
      <ResetLine pool={pool} now={now} />
    </>
  );
  const bar = (
    <View
      className="flex-row gap-1"
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      {pool.columns.map((member, index) => {
        if (!member.window)
          return (
            <View
              key={member.account.key}
              className={wide ? "h-9 min-w-0 flex-1" : "h-7 min-w-0 flex-1"}
            />
          );
        const { account, window } = member;
        const timeLeft = paceRemainingPercent(window, now);
        const credits = account.limits.resetCredits?.availableCount ?? 0;
        const resetsIn = formatResetsIn(window, now, "duration");
        return (
          <Pressable
            key={account.key}
            accessibilityRole="button"
            accessibilityLabel={segmentAccessibilityLabel(index, account, window, [
              timeLeft === null ? null : t("{percent}% of the window left", { percent: timeLeft }),
            ])}
            accessibilityHint={t("Show account details")}
            onPress={() => openAccount(account)}
            className={wide ? "h-9 min-w-0 flex-1 rounded-md" : "h-7 min-w-0 flex-1 rounded-md"}
          >
            <PaceGap timeLeft={timeLeft}>
              <View className="absolute inset-0 rounded-md bg-subtle" />
              <View className="absolute inset-0 overflow-hidden rounded-md">
                <AccountSegment
                  remaining={remainingPercent(window)}
                  color={normalizeProviderAccentColor(account.accentColor) ?? color}
                  refillPercent={window.resetsAt ? member.refillPercent : 0}
                />
              </View>
            </PaceGap>
            {inlineLabels ? (
              <View
                pointerEvents="none"
                className="absolute inset-0 flex-row items-center justify-between gap-2 overflow-hidden rounded-md px-2"
              >
                <View className="min-w-0 shrink flex-row items-center gap-1.5">
                  {account.email ? <AccountChip email={account.email} /> : null}
                  {account.email && !(account.displayName && inlineName) ? null : (
                    <Text
                      numberOfLines={1}
                      className="min-w-0 shrink text-xs font-t3-medium text-foreground"
                    >
                      {accountName(account)}
                    </Text>
                  )}
                  <Text className="text-sm font-t3-bold tabular-nums text-foreground">
                    {remainingPercent(window)}%
                  </Text>
                </View>
                {inlineReset && pool.columns.length > 1 && (resetsIn || credits) ? (
                  <View className="shrink-0 flex-row items-center gap-1 rounded bg-grouped-card/85 px-1.5 py-0.5">
                    {resetsIn ? (
                      <>
                        <SymbolView
                          name="arrow.clockwise"
                          size={11}
                          tintColorClassName="accent-foreground-muted"
                        />
                        <Text className="text-xs tabular-nums text-foreground-muted">
                          {resetsIn}
                        </Text>
                      </>
                    ) : null}
                    {credits ? (
                      <>
                        <SymbolView name="ticket" size={12} tintColorClassName="accent-icon" />
                        <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                          {credits}
                        </Text>
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : (
              <View
                pointerEvents="none"
                className="absolute inset-0 items-center justify-center overflow-hidden rounded-md"
              >
                <Text
                  numberOfLines={1}
                  className="max-w-full shrink text-xs font-t3-medium tabular-nums text-foreground"
                >
                  {index + 1}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
  const legend = (
    <View>
      {pool.columns.map(({ account, window }, index) => {
        if (!window) return null;
        const segmentColor = normalizeProviderAccentColor(account.accentColor) ?? color;
        const credits = account.limits.resetCredits?.availableCount ?? 0;
        const resetsIn = formatResetsIn(window, now);
        const resetsInDuration = formatResetsIn(window, now, "duration");
        return (
          <Pressable
            key={account.key}
            accessibilityRole="button"
            accessibilityLabel={segmentAccessibilityLabel(index, account, window, [
              resetsIn,
              credits
                ? tn(credits, "{count} reset credit banked", "{count} reset credits banked")
                : null,
            ])}
            accessibilityHint={t("Show account details")}
            onPress={() => openAccount(account)}
            className="min-h-[44px] flex-row items-center gap-2 active:opacity-60"
          >
            <View className="relative size-5 items-center justify-center overflow-hidden rounded-md bg-subtle-strong">
              <View
                pointerEvents="none"
                className="absolute inset-0"
                style={{ backgroundColor: segmentColor, opacity: 0.35 }}
              />
              <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                {index + 1}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
            >
              {accountName(account)}
            </Text>
            <Text className="text-sm font-t3-medium tabular-nums text-foreground">
              {remainingPercent(window)}%
            </Text>
            <View className="flex-row items-center gap-1">
              {resetsIn ? (
                <>
                  <SymbolView
                    name="arrow.clockwise"
                    size={12}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <Text className="text-xs tabular-nums text-foreground-muted">
                    {resetsInDuration}
                  </Text>
                </>
              ) : null}
              {credits ? (
                <>
                  {resetsIn ? <Text className="text-xs text-foreground-tertiary">·</Text> : null}
                  <SymbolView name="ticket" size={13} tintColorClassName="accent-icon" />
                  <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                    {credits}
                  </Text>
                </>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
  if (wide) {
    return (
      <View className="flex-row items-center gap-6 rounded-[24px] border-continuous bg-grouped-card p-4">
        <View className="w-44 gap-1">{summary}</View>
        <View className="min-w-0 flex-1 gap-1">
          {bar}
          {inlineLabels ? null : legend}
        </View>
      </View>
    );
  }
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      {summary}
      {bar}
      {legend}
    </View>
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  cursorPrompt,
  wide = false,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly cursorPrompt?: ReactNode;
  readonly wide?: boolean;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const pools = collectLimitPools(collectLimitAccounts(selected), now);
  const failover = collectAccountFailover(selected, now);
  const notices = collectLimitNotices(selected);
  const externalLinks = collectExternalUsageLinks(selected);
  const colors = useProviderColors();
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
    <View className="gap-6">
      {pools.length === 0 &&
      notices.length === 0 &&
      failedLabels.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? t("Select an environment to see limits.")
            : t("No provider on the selected environments reports subscription limits.")}
        </Text>
      ) : null}
      {sections.map(({ driver, pool }, index) => (
        <Fragment key={driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <View className="gap-3">
            <View className="gap-1 px-1">
              <View className="flex-row items-start gap-2">
                <ProviderIcon provider={driver} size={18} />
                <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                  {DRIVER_LABEL[driver] ?? driver}
                </Text>
                {pool ? <LimitsFreshness accounts={pool.accounts} now={now} /> : null}
              </View>
              {failover
                .filter((entry) => entry.driver === driver)
                .map((entry) => (
                  <Text key={entry.environmentId} className="text-xs text-foreground-muted">
                    {selected.size > 1
                      ? t("{environment}: ", { environment: entry.environmentLabel })
                      : null}
                    {describeAccountFailover(entry.status, {
                      accountName: resolveProviderInstanceDisplayName,
                      time: formatResetTime,
                    })}
                  </Text>
                ))}
            </View>
            {pool
              ? displayLimitWindows(pool).map((window) => {
                  const details =
                    driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
                  return (
                    <PoolWindowCard
                      key={`${window.kind}:${window.id}`}
                      pool={window}
                      color={colors[usageProviderKind(driver) ?? "codex"]}
                      now={now}
                      environmentIds={
                        selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds]
                      }
                      label={details?.label}
                      description={details?.description}
                      wide={wide}
                    />
                  );
                })
              : null}
            {pool ? <PoolResetCredits pool={pool} now={now} /> : null}
            {externalLinks
              .filter((link) => link.driver === driver)
              .map((link) => (
                <ExternalUsageAccounts key={link.url} link={link} />
              ))}
          </View>
        </Fragment>
      ))}
      {cursorPromptAt === sections.length ? cursorPrompt : null}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-t3-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-t3-medium text-warning-foreground">
                {t("{accounts} could not refresh limits. Showing the last known values.", {
                  accounts: failedLabels.join(", "),
                })}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
  now: number;
}>;

export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const { accountKey, windowId, windowKind, environmentIds, now } = route.params;
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.driver === account?.driver)
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const window = pool?.members.find((member) => member.account.key === accountKey)?.window;
  const evenPace = window ? paceRemainingPercent(window, now) : null;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <SettingsScreen title={t("Account")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            {t("This account is no longer reporting limits on the selected environments.")}
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ?? DRIVER_LABEL[account.driver] ?? account.driver}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    revealed ? t("Hide account email") : t("Reveal account email")
                  }
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {t("{percent}% left", { percent: remainingPercent(window) })}
              </Text>
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {t("Resets {date}", {
                    date: new Date(window.resetsAt).toLocaleString(getFormattingLocale(), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </Text>
              ) : null}
              {evenPace !== null ? (
                <Text className="text-sm text-foreground-muted">
                  {t("Even pace: {percent}% left by now", { percent: evenPace })}
                </Text>
              ) : null}
              {reset && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  {t("Restores {percent}% of the pool", { percent: reset.restoresPercent })}
                </Text>
              ) : null}
              <Text selectable className="text-sm text-foreground-muted">
                {t("Checked at {time}", {
                  time: new Date(account.limits.checkedAt).toLocaleString(getFormattingLocale(), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </Text>
            </View>
            <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length ? t("Signed in") : t("Source")}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">{t("Reset credits")}</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
