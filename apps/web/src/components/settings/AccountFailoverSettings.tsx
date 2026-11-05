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
  supportsAutoCoordinator,
} from "@t3tools/shared/serverSettings";
import { createModelSelection } from "@t3tools/shared/model";
import { groupBy } from "effect/Array";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { t } from "~/i18n";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  /** Older servers drop `autoModeProvider` and `autoModeModels`. */
  readonly supportsAutoMode: boolean;
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
        title={t("Switch accounts at usage limits")}
        description={t(
          "When an account hits its usage limit, the thread continues on the first signed-in subscription account of the same provider that still has usage left. API-key and Bedrock accounts are never used. Some providers' terms forbid using extra accounts to get around limits.",
        )}
        control={
          <Switch
            aria-label={t("Switch accounts at usage limits")}
            checked={switching}
            disabled={readOnly}
            onCheckedChange={(checked) => updateSettings({ failoverLimitedThreads: checked })}
          />
        }
      />
      {supportsAutoMode ? (
        <SettingsRow
          title={t("Auto mode")}
          description={
            switching
              ? t(
                  "Pick a primary provider to enable Auto mode. Auto starts new chats on that provider's first account with usage left and runs its coordinator model, set below. Pick Auto in the model picker to use it.",
                )
              : t(
                  "Pick a primary provider to enable Auto mode. Auto starts new chats on that provider's first account and runs its coordinator model, set below. Pick Auto in the model picker to use it.",
                )
          }
          control={
            <Select
              value={autoProvider ?? AUTO_MODE_OFF}
              disabled={readOnly}
              onValueChange={(value) => {
                const driver = autoProviders.find((candidate) => candidate === value) ?? null;
                if (value === AUTO_MODE_OFF || driver !== null)
                  updateSettings({ autoModeProvider: driver });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-44"
                aria-label={t("Auto mode primary provider")}
              >
                <SelectValue>
                  {autoProvider === null ? t("Off") : providerName(autoProvider)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={AUTO_MODE_OFF}>
                  {t("Off")}
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
      {groups.length === 0 ? (
        <SettingsRow
          title={t("Account order")}
          description={t("Add a second account for a provider to choose which one runs first.")}
        />
      ) : (
        groups.map((accounts) => {
          const driver = accounts[0]!.driver;
          const name = providerName(driver);
          const autoModel = autoModeModelFor(settings, driver);
          // Auto's model belongs to the provider, so the picker lists one usable account's models.
          const modelAccount =
            accounts.find(
              (account) => account.status === "ready" && account.auth.status !== "unauthenticated",
            ) ?? accounts[0]!;
          const storedAutoModel = settings.autoModeModels[driver];
          const runsModel = supportsAutoCoordinator(driver)
            ? t(
                "Auto's coordinator: it does small requests itself, hands routine work to cheaper {provider} models, and checks the result.",
                { provider: name },
              )
            : t("Auto runs this model.");
          return (
            <SettingsRow
              key={driver}
              title={supportsAutoMode ? name : t("{provider} account order", { provider: name })}
              description={
                !supportsAutoMode
                  ? t(
                      "A limited thread continues on the highest account in this list that still has usage left.",
                    )
                  : accounts.length === 1
                    ? t("{runsModel} Add a second account to switch accounts at usage limits.", {
                        runsModel,
                      })
                    : switching
                      ? t(
                          "{runsModel} Accounts are tried from the top, and a limited thread continues on the highest one with usage left.",
                          { runsModel },
                        )
                      : t("{runsModel} New Auto chats start on the top account.", { runsModel })
              }
              resetAction={
                supportsAutoMode && storedAutoModel !== undefined && !readOnly ? (
                  <SettingResetButton
                    label={t("{provider} coordinator model", { provider: name })}
                    tooltip={t("Use the default model")}
                    onClick={() => updateSettings({ autoModeModels: { [driver]: null } })}
                  />
                ) : null
              }
              control={
                supportsAutoMode ? (
                  <SettingsModelSelectionControl
                    environmentId={environmentId}
                    settings={settings}
                    providers={[modelAccount]}
                    readOnly={readOnly}
                    label={t("{provider} coordinator model", { provider: name })}
                    selection={
                      autoModel &&
                      createModelSelection(
                        modelAccount.instanceId,
                        autoModel.model,
                        autoModel.options,
                      )
                    }
                    emptyLabel={t("Choose a model")}
                    autoModeModel
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
              ) : null}
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}
