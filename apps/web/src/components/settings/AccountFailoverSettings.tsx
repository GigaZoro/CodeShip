import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  autoModeModelFor,
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import { createModelSelection } from "@t3tools/shared/model";
import { groupBy } from "effect/Array";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsModelSelectionControl } from "./DelegatedTaskModelSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_MODE_OFF = "off";

const providerName = (driver: ProviderDriverKind) => PROVIDER_DISPLAY_NAMES[driver] ?? driver;

/** Drivers that switch accounts at limits, each with its enabled accounts in the order tried. */
function accountGroups(
  order: ServerSettings["providerInstanceFailoverOrder"],
  providers: ReadonlyArray<ServerProvider>,
) {
  const accountsByDriver = groupBy(
    providers.filter((provider) => provider.enabled && supportsAccountFailover(provider.driver)),
    (provider) => provider.driver,
  );
  return Object.values(accountsByDriver).map((accounts) =>
    orderProviderInstancesForFailover(order, accounts),
  );
}

export function AccountFailoverSettings({
  environmentId,
  settings,
  providers,
  readOnly,
  supportsAutoMode,
  supportsMcpSignInSharing,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  /** Older servers drop `autoModeProvider` and `autoModeModels`. */
  readonly supportsAutoMode: boolean;
  /** Older servers drop `shareMcpSignIns`. */
  readonly supportsMcpSignInSharing: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const switching = settings.failoverLimitedThreads;
  // Without Auto, a provider with one account has no order to set.
  const groups = accountGroups(settings.providerInstanceFailoverOrder, providers).filter(
    (accounts) => supportsAutoMode || accounts.length > 1,
  );
  const autoProviders = groups.map((accounts) => accounts[0]!.driver);
  const autoProvider = settings.autoModeProvider;

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
        description="When an account hits its usage limit, the thread continues on the first signed-in subscription account of the same provider that still has usage left. API-key and Bedrock accounts are never used. Some providers' terms forbid using extra accounts to get around limits."
        control={
          <Switch
            aria-label="Switch accounts at usage limits"
            checked={switching}
            disabled={readOnly}
            onCheckedChange={(checked) => updateSettings({ failoverLimitedThreads: checked })}
          />
        }
      />
      {supportsAutoMode ? (
        <SettingsRow
          title="Auto mode"
          description={
            switching
              ? "Pick a primary provider to enable Auto mode. Auto starts new chats on that provider's first account with usage left and runs its Auto model, set below. Pick Auto in the model picker to use it."
              : "Pick a primary provider to enable Auto mode. It needs Switch accounts at usage limits on."
          }
          control={
            <Select
              value={autoProvider ?? AUTO_MODE_OFF}
              disabled={readOnly || !switching}
              onValueChange={(value) => {
                const driver = autoProviders.find((candidate) => candidate === value) ?? null;
                if (value === AUTO_MODE_OFF || driver !== null)
                  updateSettings({ autoModeProvider: driver });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-44"
                aria-label="Auto mode primary provider"
              >
                <SelectValue>
                  {autoProvider === null ? "Off" : providerName(autoProvider)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={AUTO_MODE_OFF}>
                  Off
                </SelectItem>
                {autoProviders.map((driver) => (
                  <SelectItem key={driver} hideIndicator value={driver}>
                    {providerName(driver)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {supportsMcpSignInSharing ? (
        <SettingsRow
          title="Share MCP sign-ins"
          description="Accounts of the same provider on this machine use one sign-in per MCP server, so signing in or out on one account does it on all of them. Off, each added Claude and Codex account signs in on its own."
          control={
            <Switch
              aria-label="Share MCP sign-ins"
              checked={settings.shareMcpSignIns}
              disabled={readOnly}
              onCheckedChange={(checked) => updateSettings({ shareMcpSignIns: checked })}
            />
          }
        />
      ) : null}
      {groups.length === 0 ? (
        <SettingsRow
          title="Account order"
          description="Add a second account for a provider to choose which one runs first."
        />
      ) : (
        groups.map((accounts) => {
          const driver = accounts[0]!.driver;
          const name = providerName(driver);
          const autoModel = autoModeModelFor(settings, driver);
          const storedAutoModel = settings.autoModeModels[driver];
          return (
            <SettingsRow
              key={driver}
              title={supportsAutoMode ? name : `${name} account order`}
              description={
                !supportsAutoMode
                  ? "A limited thread continues on the highest account in this list that still has usage left."
                  : accounts.length > 1
                    ? "Auto runs this model on whichever account takes the turn. Accounts are tried from the top, and a limited thread continues on the highest one with usage left."
                    : "Auto runs this model. Add a second account to switch accounts at usage limits."
              }
              resetAction={
                supportsAutoMode && storedAutoModel !== undefined && !readOnly ? (
                  <SettingResetButton
                    label={`${name} Auto model`}
                    tooltip="Use the default model"
                    onClick={() => updateSettings({ autoModeModels: { [driver]: null } })}
                  />
                ) : null
              }
              control={
                supportsAutoMode ? (
                  <SettingsModelSelectionControl
                    environmentId={environmentId}
                    settings={settings}
                    providers={accounts}
                    readOnly={readOnly || !switching}
                    label={`${name} Auto model`}
                    selection={
                      autoModel &&
                      createModelSelection(
                        accounts[0]!.instanceId,
                        autoModel.model,
                        autoModel.options,
                      )
                    }
                    emptyLabel="Choose a model"
                    offerAuto={false}
                    onChange={(selection) =>
                      updateSettings({
                        autoModeModels: {
                          [driver]: {
                            model: selection.model,
                            ...(selection.options?.length ? { options: selection.options } : {}),
                          },
                        },
                      })
                    }
                  />
                ) : null
              }
            >
              {accounts.length > 1 ? (
                <ol className="flex flex-col gap-1 pt-2 pb-2">
                  {accounts.map((account, index) => {
                    const accountName = resolveProviderInstanceDisplayName(account);
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
                          aria-label={`Move ${accountName} up`}
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
                          aria-label={`Move ${accountName} down`}
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
              ) : null}
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}
