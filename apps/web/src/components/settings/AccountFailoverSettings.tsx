import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import { groupBy } from "effect/Array";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Drivers with two or more enabled accounts, each listed in the order failover tries them. */
function failoverGroups(
  order: ServerSettings["providerInstanceFailoverOrder"],
  providers: ReadonlyArray<ServerProvider>,
) {
  const accountsByDriver = groupBy(
    providers.filter((provider) => provider.enabled && supportsAccountFailover(provider.driver)),
    (provider) => provider.driver,
  );
  return Object.values(accountsByDriver)
    .filter((accounts) => accounts.length > 1)
    .map((accounts) => orderProviderInstancesForFailover(order, accounts));
}

export function AccountFailoverSettings({
  environmentId,
  settings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: Pick<
    ServerSettings,
    "failoverLimitedThreads" | "providerInstanceFailoverOrder"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const groups = failoverGroups(settings.providerInstanceFailoverOrder, providers);

  const move = (accounts: ReadonlyArray<ServerProvider>, from: number, to: number) => {
    const next = [...accounts];
    const [account] = next.splice(from, 1);
    next.splice(to, 0, account!);
    const moved = new Set(accounts.map((candidate) => candidate.instanceId));
    const known = new Set(providers.map((candidate) => candidate.instanceId));
    updateSettings({
      providerInstanceFailoverOrder: [
        ...settings.providerInstanceFailoverOrder.filter(
          (instanceId) => !moved.has(instanceId) && known.has(instanceId),
        ),
        ...next.map((candidate) => candidate.instanceId),
      ],
    });
  };

  return (
    <SettingsSection {...searchableSetting("account-failover")}>
      <SettingsRow
        title="Switch accounts at usage limits"
        description="When an account hits its usage limit, the thread continues on the first signed-in account of the same provider that still has usage left. Some providers' terms forbid using extra accounts to get around limits."
        control={
          <Switch
            aria-label="Switch accounts at usage limits"
            checked={settings.failoverLimitedThreads}
            disabled={readOnly}
            onCheckedChange={(checked) => updateSettings({ failoverLimitedThreads: checked })}
          />
        }
      />
      {groups.length === 0 ? (
        <SettingsRow
          title="Account order"
          description="Add a second account for a provider to choose which one runs first."
        />
      ) : (
        groups.map((accounts) => {
          const driver = accounts[0]!.driver;
          const providerName = PROVIDER_DISPLAY_NAMES[driver] ?? driver;
          return (
            <SettingsRow
              key={driver}
              title={`${providerName} account order`}
              description="Top runs first. A limited thread moves down the list."
            >
              <ol className="flex flex-col gap-1 pt-2 pb-2">
                {accounts.map((account, index) => {
                  const name = resolveProviderInstanceDisplayName(account);
                  const detail =
                    account.auth.status === "unauthenticated"
                      ? "Signed out"
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
                        displayName={name}
                        accentColor={account.accentColor}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{name}</p>
                        {detail ? (
                          <p className="truncate text-xs text-muted-foreground">{detail}</p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={`Move ${name} up`}
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
                        aria-label={`Move ${name} down`}
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
