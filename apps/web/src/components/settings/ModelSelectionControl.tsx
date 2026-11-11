import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection, withModelSelectionOptions } from "@t3tools/shared/model";

import type { getCustomModelOptionsByInstance } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

/**
 * A settings row's model picker with its effort picker. `shown` is what the picker displays;
 * `triggerLabel` replaces the model name while the row inherits another role's model.
 */
export function ModelSelectionControl({
  environmentId,
  label,
  shown,
  entries,
  modelOptionsByInstance,
  triggerLabel,
  disabled = false,
  showEffort,
  auto,
  disabledReason,
  failureTitle,
  onOpenProviderSetup,
  onChange,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly shown: ModelSelection;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly triggerLabel?: string;
  readonly disabled?: boolean;
  /** Shows the effort picker, for a model this row stores itself. */
  readonly showEffort: boolean;
  /** Offers Auto in the picker; `checked` marks the shown selection as Auto. */
  readonly auto?: { readonly pick: ModelSelection | null; readonly checked: boolean };
  /** Why a model cannot be saved here; a refused pick shows it as `failureTitle`'s toast. */
  readonly disabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly failureTitle?: string;
  readonly onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const entry = entries.find((candidate) => candidate.instanceId === shown.instanceId);
  const save = (next: ModelSelection) => {
    const reason = disabledReason?.(next.instanceId, next.model) ?? null;
    if (reason !== null) {
      toastManager.add({
        type: "error",
        title: failureTitle ?? label,
        description: reason,
      });
      return;
    }
    onChange(next);
  };
  const effortAvailable =
    showEffort &&
    entry !== undefined &&
    auto?.checked !== true &&
    (disabledReason?.(shown.instanceId, shown.model) ?? null) === null;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <ProviderModelPicker
        environmentId={environmentId}
        disabled={disabled}
        activeInstanceId={shown.instanceId}
        model={shown.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        triggerAriaLabel={label}
        {...(triggerLabel !== undefined ? { triggerLabel } : {})}
        {...(disabledReason ? { getModelDisabledReason: disabledReason } : {})}
        {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
        onInstanceModelChange={(instanceId, model) => save(createModelSelection(instanceId, model))}
        {...(auto
          ? {
              auto: {
                pick: auto.pick,
                checked: auto.checked,
                onSelect: () => {
                  if (auto.pick) save(auto.pick);
                },
              },
            }
          : {})}
      />
      {effortAvailable ? (
        <TraitsPicker
          provider={entry.driverKind}
          models={entry.models}
          model={shown.model}
          modelOptions={shown.options ?? []}
          allowPromptInjectedEffort={false}
          disabled={disabled}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(options) => save(withModelSelectionOptions(shown, options))}
        />
      ) : null}
    </div>
  );
}
