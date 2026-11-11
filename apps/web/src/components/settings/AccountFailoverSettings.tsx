import type { EnvironmentId, ServerProvider, UnifiedSettings } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { t } from "~/i18n";
import { accountGroups } from "./modelsSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

const providerName = (driver: ServerProvider["driver"]) => PROVIDER_DISPLAY_NAMES[driver] ?? driver;

export function AccountFailoverSettings({
  environmentId,
  settings,
  providers,
  readOnly,
  supportsAutoMode,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  /** Whether Auto mode starts new chats on the first account in this order. */
  readonly supportsAutoMode: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const switching = settings.failoverLimitedThreads;
  // A provider with one account has no order to set.
  const groups = accountGroups(settings.providerInstanceFailoverOrder, providers).filter(
    (accounts) => accounts.length > 1,
  );

  const move = (accounts: ReadonlyArray<ServerProvider>, from: number, to: number) => {
    const next = [...accounts];
    const [account] = next.splice(from, 1);
    next.splice(to, 0, account!);
    const moved = new Set(accounts.map((candidate) => candidate.instanceId));
    // Accounts only other machines have keep their place; the order is shared with them.
    updateSettings({
      providerInstanceFailoverOrder: [
        ...settings.providerInstanceFailoverOrder.filter((instanceId) => !moved.has(instanceId)),
        ...next.map((candidate) => candidate.instanceId),
      ],
    });
  };

  return (
    <SettingsSection {...searchableSetting("account-failover")}>
      {groups.length === 0 ? (
        <SettingsRow
          title={t("Account order")}
          description={t("Add a second account for a provider to choose which one runs first.")}
        />
      ) : (
        groups.map((accounts) => {
          const name = providerName(accounts[0]!.driver);
          return (
            <SettingsRow
              key={accounts[0]!.driver}
              title={t("{provider} account order", { provider: name })}
              description={
                !supportsAutoMode
                  ? t(
                      "A limited thread continues on the highest account in this list that still has usage left.",
                    )
                  : switching
                    ? t(
                        "Accounts are tried from the top, and a limited thread continues on the highest one with usage left.",
                      )
                    : t("New Auto chats start on the top account.")
              }
            >
              <ol className="flex flex-col gap-1 pt-2 pb-2">
                {accounts.map((account, index) => {
                  const accountName = resolveProviderInstanceDisplayName(account);
                  const detail =
                    account.auth.status === "unauthenticated"
                      ? t("Signed out")
                      : (account.auth.email ?? account.auth.label);
                  const first = index === 0;
                  const last = index === accounts.length - 1;
                  // aria-disabled keeps keyboard focus on an arrow whose account just reached an end.
                  return (
                    <li key={account.instanceId} className="flex min-h-9 items-center gap-2">
                      <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <ProviderInstanceIcon
                        driverKind={account.driver}
                        displayName={accountName}
                        accentColor={account.accentColor}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{accountName}</p>
                        {detail ? (
                          <p className="truncate text-xs text-muted-foreground">{detail}</p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={t("Move {account} up", { account: accountName })}
                        disabled={readOnly}
                        aria-disabled={first || undefined}
                        onClick={() => {
                          if (!first) move(accounts, index, index - 1);
                        }}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={t("Move {account} down", { account: accountName })}
                        disabled={readOnly}
                        aria-disabled={last || undefined}
                        onClick={() => {
                          if (!last) move(accounts, index, index + 1);
                        }}
                      >
                        <ArrowDownIcon />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}
