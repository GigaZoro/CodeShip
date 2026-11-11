import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DelegatedTaskRole,
  type EnvironmentId,
  type ModelSelection,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import {
  autoModeModelFor,
  autoModePick,
  resolveAutoModelSelection,
  supportsAutoCoordinator,
} from "@t3tools/shared/serverSettings";
import { createModelSelection } from "@t3tools/shared/model";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { createContext, use, useRef, type ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import {
  EMPTY_SERVER_PROVIDERS,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ModelSelectionControl } from "./ModelSelectionControl";
import { ModelSubRow } from "./ModelSubRow";
import { accountGroups } from "./modelsSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { msg, t, type Message } from "~/i18n";

const DELEGATED_ROLES: ReadonlyArray<{
  readonly role: DelegatedTaskRole;
  readonly title: Message;
}> = [
  { role: "implementation", title: msg("Implementation") },
  { role: "research", title: msg("Research") },
  { role: "review", title: msg("Review") },
  { role: "design", title: msg("Design") },
  { role: "test", title: msg("Testing") },
  { role: "general", title: msg("Other tasks") },
];

const AUTO_MODE_OFF = "off";

const providerName = (driver: ProviderDriverKind) => PROVIDER_DISPLAY_NAMES[driver] ?? driver;

interface MachineModels {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly supportsAccountFailover: boolean;
  readonly supportsAutoMode: boolean;
  readonly supportsFinalReview: boolean;
  readonly supportsDelegatedTaskModels: boolean;
}

/** The one machine whose providers and accounts the machine-wide model rows use; null spans several. */
const MachineModelsContext = createContext<MachineModels | null>(null);

function useCapability(
  environmentId: EnvironmentId,
  key: "usageLimitAccountFailover" | "autoMode" | "finalReview" | "delegatedTaskModels",
) {
  return useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities[key] === true,
  );
}

function ConnectedMachineModels({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(providersIgnoringCheckedAtAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const value: MachineModels = {
    environmentId,
    settings,
    providers,
    readOnly: !canWriteSettings,
    supportsAccountFailover: useCapability(environmentId, "usageLimitAccountFailover"),
    supportsAutoMode: useCapability(environmentId, "autoMode"),
    supportsFinalReview: useCapability(environmentId, "finalReview"),
    supportsDelegatedTaskModels: useCapability(environmentId, "delegatedTaskModels"),
  };
  return <MachineModelsContext value={value}>{children}</MachineModelsContext>;
}

export function MachineModelsProvider({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly children: ReactNode;
}) {
  if (environmentId === null) {
    return <MachineModelsContext value={null}>{children}</MachineModelsContext>;
  }
  return (
    <ConnectedMachineModels key={environmentId} environmentId={environmentId}>
      {children}
    </ConnectedMachineModels>
  );
}

/** A machine-wide model choice with its effort, or Auto; `selection` null shows `emptyLabel`. */
function MachineModelControl({
  machine,
  providers: providersOverride,
  label,
  selection,
  emptyLabel,
  autoModeModel = false,
  onChange,
}: {
  readonly machine: MachineModels;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly label: string;
  readonly selection: ModelSelection | null;
  readonly emptyLabel?: string;
  /** Picks a provider's Auto model: no Auto option, and no account, since Auto picks that. */
  readonly autoModeModel?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { settings } = machine;
  const providers = providersOverride ?? machine.providers;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const entries = autoModeModel
    ? instanceEntries.map((entry) => ({
        ...entry,
        displayName: providerName(entry.driverKind),
        accentColor: undefined,
      }))
    : instanceEntries;
  const fallbackEntry = entries.find(isProviderInstancePickerReady);
  const autoPick = autoModeModel
    ? null
    : autoModePick({ settings, accounts: providers, lockedDriver: null });
  const resolved =
    selection &&
    resolveAutoModelSelection({ selection, settings, accounts: providers, started: false });
  const shown =
    resolved ??
    (fallbackEntry === undefined
      ? null
      : createModelSelection(fallbackEntry.instanceId, fallbackEntry.models[0]?.slug ?? ""));
  if (shown === null) {
    return <span className="text-sm text-muted-foreground">{t("No providers available")}</span>;
  }
  return (
    <ModelSelectionControl
      environmentId={machine.environmentId}
      disabled={machine.readOnly}
      label={label}
      shown={shown}
      entries={entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        shown.instanceId,
        shown.model,
      )}
      showEffort={selection !== null}
      {...(selection === null && emptyLabel !== undefined ? { triggerLabel: emptyLabel } : {})}
      {...(autoModeModel
        ? {}
        : {
            auto: { pick: autoPick, checked: selection?.autoAccount === true && autoPick !== null },
          })}
      onChange={onChange}
    />
  );
}

/** Auto mode: the primary provider, and the coordinator model each provider runs. */
export function AutoModeModelRow() {
  const machine = use(MachineModelsContext);
  const updateSettings = useUpdateEnvironmentSettings(machine?.environmentId ?? null);
  if (!machine || !machine.supportsAccountFailover || !machine.supportsAutoMode) return null;
  const { settings, providers, readOnly } = machine;
  const groups = accountGroups(settings.providerInstanceFailoverOrder, providers);
  const autoProviders = groups.map((accounts) => accounts[0]!.driver);
  const autoProvider = settings.autoModeProvider;

  return (
    <SettingsRow
      {...searchableSetting("auto-mode")}
      description={
        settings.failoverLimitedThreads
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
    >
      {groups.map((accounts) => {
        const driver = accounts[0]!.driver;
        const name = providerName(driver);
        const autoModel = autoModeModelFor(settings, driver);
        // Auto's model belongs to the provider, so the picker lists one usable account's models.
        const modelAccount =
          accounts.find(
            (account) => account.status === "ready" && account.auth.status !== "unauthenticated",
          ) ?? accounts[0]!;
        const stored = settings.autoModeModels[driver];
        return (
          <ModelSubRow
            key={driver}
            title={t("{provider} coordinator", { provider: name })}
            description={
              supportsAutoCoordinator(driver)
                ? t(
                    "Auto's coordinator: it does small requests itself, chooses models from either provider for larger work, and checks the result.",
                  )
                : t("Auto runs this model.")
            }
            reset={
              stored !== undefined && !readOnly ? (
                <SettingResetButton
                  label={t("{provider} coordinator model", { provider: name })}
                  tooltip={t("Use the default model")}
                  onClick={() => updateSettings({ autoModeModels: { [driver]: null } })}
                />
              ) : null
            }
            control={
              <MachineModelControl
                machine={machine}
                providers={[modelAccount]}
                label={t("{provider} coordinator model", { provider: name })}
                selection={
                  autoModel &&
                  createModelSelection(modelAccount.instanceId, autoModel.model, autoModel.options)
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
            }
          />
        );
      })}
    </SettingsRow>
  );
}

/** Final review: whether new threads are reviewed, the reviewers' models, and their brief. */
export function FinalReviewModelRow() {
  const machine = use(MachineModelsContext);
  const updateSettings = useUpdateEnvironmentSettings(machine?.environmentId ?? null);
  const instructionsEdited = useRef(false);
  if (!machine || !machine.supportsFinalReview) return null;
  const { settings, providers, readOnly } = machine;
  const reviewers = settings.finalReviewModelSelections;
  const setReviewers = (next: ReadonlyArray<ModelSelection>) =>
    updateSettings({ finalReviewModelSelections: next });
  const firstReady = providerInstanceEntriesFor(providers, settings, null).find(
    isProviderInstancePickerReady,
  );

  return (
    <SettingsRow
      {...searchableSetting("final-review")}
      description={t(
        "After a request you send changes files, each reviewer checks those changes as a read-only task, and the thread's agent fixes what it confirms. Reviews use turns on the reviewers' accounts. Turn it on or off for one thread from its menu.",
      )}
      control={
        <Switch
          aria-label={t("Review new threads")}
          checked={settings.finalReviewByDefault}
          disabled={readOnly}
          onCheckedChange={(checked) => updateSettings({ finalReviewByDefault: checked })}
        />
      }
    >
      <ModelSubRow
        title={t("Reviewers")}
        description={
          reviewers.length === 0
            ? t(
                "Add at least one reviewer. Reviewers on different providers catch different issues.",
              )
            : t("Each reviews the same changes on its own.")
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || firstReady === undefined}
            onClick={() => {
              if (firstReady === undefined) return;
              setReviewers([
                ...reviewers,
                createModelSelection(firstReady.instanceId, firstReady.models[0]?.slug ?? ""),
              ]);
            }}
          >
            <PlusIcon />
            {t("Add reviewer")}
          </Button>
        }
      />
      {reviewers.map((reviewer, index) => (
        <ModelSubRow
          // Reviewers have no id of their own, and the same model may be listed twice.
          // oxlint-disable-next-line react/no-array-index-key -- a reviewer is its position in the list
          key={index}
          title={t("Reviewer {number}", { number: index + 1 })}
          control={
            <div className="flex min-w-0 items-center justify-end gap-1.5">
              <MachineModelControl
                machine={machine}
                label={t("Reviewer {number} model", { number: index + 1 })}
                selection={reviewer}
                onChange={(next) =>
                  setReviewers(reviewers.map((current, at) => (at === index ? next : current)))
                }
              />
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={t("Remove reviewer {number}", { number: index + 1 })}
                disabled={readOnly}
                onClick={() => setReviewers(reviewers.filter((_, at) => at !== index))}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        />
      ))}
      <ModelSubRow
        title={t("Review instructions")}
        description={t(
          "Added to every reviewer's brief, such as project rules, checklists, or the checks to run.",
        )}
      >
        <div className="mt-3 max-w-2xl">
          <Textarea
            key={settings.finalReviewInstructions}
            aria-label={t("Review instructions")}
            rows={4}
            disabled={readOnly}
            defaultValue={settings.finalReviewInstructions}
            placeholder={t(
              "Check tenant and permission boundaries. Run the focused tests for changed services.",
            )}
            onChange={() => {
              instructionsEdited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (instructionsEdited.current && value !== settings.finalReviewInstructions)
                updateSettings({ finalReviewInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </div>
      </ModelSubRow>
    </SettingsRow>
  );
}

/** Delegated tasks: the model each role runs when an agent hands off work without naming one. */
export function DelegatedTaskModelRow() {
  const machine = use(MachineModelsContext);
  const updateSettings = useUpdateEnvironmentSettings(machine?.environmentId ?? null);
  if (!machine || !machine.supportsDelegatedTaskModels) return null;
  const { settings, readOnly } = machine;
  const setRole = (role: DelegatedTaskRole, selection: ModelSelection | null) =>
    updateSettings({ delegatedTaskModelSelections: { [role]: selection } });

  return (
    <SettingsRow
      {...searchableSetting("delegated-task-models")}
      description={t(
        "When an agent hands work to a child task without naming a model, the task runs on the model set for its role. Unset roles use the thread's own model.",
      )}
    >
      {DELEGATED_ROLES.map(({ role, title }) => {
        const selection = settings.delegatedTaskModelSelections?.[role] ?? null;
        return (
          <ModelSubRow
            key={role}
            title={t(title)}
            reset={
              selection !== null && !readOnly ? (
                <SettingResetButton
                  label={t("{role} model", { role: t(title).toLowerCase() })}
                  tooltip={t("Use the thread's model")}
                  onClick={() => setRole(role, null)}
                />
              ) : null
            }
            control={
              <MachineModelControl
                machine={machine}
                label={t("{role} model", { role: t(title) })}
                selection={selection}
                emptyLabel={t("Same as the thread")}
                onChange={(next) => setRole(role, next)}
              />
            }
          />
        );
      })}
    </SettingsRow>
  );
}
