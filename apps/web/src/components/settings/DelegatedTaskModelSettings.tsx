import {
  type DelegatedTaskRole,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import {
  createModelSelection,
  keepAutoAccount,
  withAutoAccount,
  withModelSelectionOptions,
} from "@t3tools/shared/model";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { searchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const ROLES: ReadonlyArray<{ readonly role: DelegatedTaskRole; readonly title: string }> = [
  { role: "implementation", title: "Implementation" },
  { role: "research", title: "Research" },
  { role: "review", title: "Review" },
  { role: "design", title: "Design" },
  { role: "test", title: "Testing" },
  { role: "general", title: "Other tasks" },
];

/** A settings model choice with its effort and Auto account; `selection` null shows `emptyLabel`. */
export function SettingsModelSelectionControl({
  environmentId,
  settings,
  providers,
  readOnly,
  label,
  selection,
  emptyLabel,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly label: string;
  readonly selection: ModelSelection | null;
  readonly emptyLabel?: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const fallbackEntry = entries.find(isProviderInstancePickerReady);
  const shown =
    selection ??
    (fallbackEntry === undefined
      ? null
      : createModelSelection(fallbackEntry.instanceId, fallbackEntry.models[0]?.slug ?? ""));
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
  if (shown === null) {
    return <span className="text-sm text-muted-foreground">No providers available</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <ProviderModelPicker
        environmentId={environmentId}
        disabled={readOnly}
        activeInstanceId={shown.instanceId}
        model={shown.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          settings,
          providers,
          shown.instanceId,
          shown.model,
        )}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        triggerAriaLabel={label}
        {...(selection === null && emptyLabel !== undefined ? { triggerLabel: emptyLabel } : {})}
        onInstanceModelChange={(instanceId, model) =>
          onChange(keepAutoAccount(selection, createModelSelection(instanceId, model)))
        }
        {...(selection === null
          ? {}
          : {
              autoAccount: {
                checked: selection.autoAccount === true,
                onCheckedChange: (checked: boolean) =>
                  onChange(withAutoAccount(selection, checked)),
              },
            })}
      />
      {selection !== null && entry ? (
        <TraitsPicker
          provider={entry.driverKind}
          models={entry.models}
          model={selection.model}
          modelOptions={selection.options ?? []}
          allowPromptInjectedEffort={false}
          planModeEnabled={settings.planModeEnabled}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(options) =>
            onChange(withModelSelectionOptions(selection, options))
          }
        />
      ) : null}
    </div>
  );
}

export function DelegatedTaskModelSettings({
  environmentId,
  settings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const setRole = (role: DelegatedTaskRole, selection: ModelSelection | null) =>
    updateSettings({ delegatedTaskModelSelections: { [role]: selection } });

  return (
    <SettingsSection {...searchableSetting("delegated-task-models")}>
      <SettingsRow
        title="Models by role"
        description="When an agent hands work to a child task without naming a model, the task runs on the model set for its role. Unset roles use the thread's own model."
      />
      {ROLES.map(({ role, title }) => {
        const selection = settings.delegatedTaskModelSelections?.[role] ?? null;
        return (
          <SettingsRow
            key={role}
            title={title}
            resetAction={
              selection !== null && !readOnly ? (
                <SettingResetButton
                  label={`${title.toLowerCase()} model`}
                  tooltip="Use the thread's model"
                  onClick={() => setRole(role, null)}
                />
              ) : null
            }
            control={
              <SettingsModelSelectionControl
                environmentId={environmentId}
                settings={settings}
                providers={providers}
                readOnly={readOnly}
                label={`${title} model`}
                selection={selection}
                emptyLabel="Same as the thread"
                onChange={(next) => setRole(role, next)}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
