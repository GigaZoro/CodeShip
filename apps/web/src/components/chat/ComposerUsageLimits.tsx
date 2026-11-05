import { t, tn, tx } from "~/i18n";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ServerProvider, UsageLimitsReport } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel={t("Toggle account label visibility")}
          revealTooltip={t("Click to reveal account")}
          hideTooltip={t("Click to hide account")}
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    tn(report.accounts.length, "{count} account", "{count} accounts")
  );
  return {
    id,
    variant: "info",
    icon: <GaugeIcon />,
    title: t("Usage limits"),
    description: summary,
    dismissLabel: t("Dismiss usage limits"),
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

/** Names which account ran out once the provider has several, since the default one is unnamed. */
function LimitedAccountName({
  account,
  hasOtherAccounts,
}: {
  readonly account: ServerProvider;
  readonly hasOtherAccounts: boolean;
}) {
  const name = resolveProviderInstanceDisplayName(account);
  if (!hasOtherAccounts) return name;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  if (name.toLowerCase() !== driver.toLowerCase()) return `${driver} · ${name}`;
  const email = account.auth.email;
  if (!email) return name;
  return (
    <>
      {`${driver} · `}
      <RedactedSensitiveText
        value={email}
        ariaLabel={t("Toggle account email visibility")}
        revealTooltip={t("Click to reveal account")}
        hideTooltip={t("Click to hide account")}
        className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
      />
    </>
  );
}

export function modelFallbackBannerItem({
  fallbackModelName,
  limitedAccount,
  hasOtherAccounts,
  defaultModelName,
  resetsAt,
  timestampFormat,
  onUseDefault,
  onDismiss,
}: {
  readonly fallbackModelName: string;
  readonly limitedAccount: ServerProvider;
  readonly hasOtherAccounts: boolean;
  readonly defaultModelName: string;
  readonly resetsAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onUseDefault: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: t("Using {model}", { model: fallbackModelName }),
    description: (
      <>
        {resetsAt
          ? tx("{account} is out of usage · resets {time}", {
              account: (
                <LimitedAccountName account={limitedAccount} hasOtherAccounts={hasOtherAccounts} />
              ),
              time: formatUpcomingTimestamp(resetsAt, timestampFormat),
            })
          : tx("{account} is out of usage", {
              account: (
                <LimitedAccountName account={limitedAccount} hasOtherAccounts={hasOtherAccounts} />
              ),
            })}
      </>
    ),
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        {t("Use {model}", { model: defaultModelName })}
      </Button>
    ),
    dismissLabel: t("Dismiss fallback model notice"),
    onDismiss,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  accentColor={account.accentColor}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {externalUsage ? (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start"
                  onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                >
                  {t("Manage usage")}
                </Button>
              ) : null}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}
