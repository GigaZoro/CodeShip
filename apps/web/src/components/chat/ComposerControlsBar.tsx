import { t } from "~/i18n";
import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon, ServerIcon } from "lucide-react";
import { ComposerControl } from "./ComposerControl";
import { ComposerModelPicker, type RuntimeModeOption } from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { resolveComposerTraitsInput } from "./composerProviderState";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  ComposerAutoEffortColumn,
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { ComposerRunPermissions } from "./ComposerRunPermissions";
import { type ComposerRunChipSegment, resolveComposerRunChip } from "./composerRunChip";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";

/**
 * The composer footer controls: one run chip that names the model and effort, plus permissions
 * and machine only when they differ from the defaults or run with more reach. Its popover holds
 * model, effort, speed and permissions. Rendered in the expanded footer or the resting host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  workspaceCwd: string | null;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  effortDisplay: EffortDisplay;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  providerUnavailableLabel: string;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  /** What picking Auto runs here; null where Auto is off or cannot run. */
  autoPick: ModelSelection | null;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    showProviderUnavailable,
    providerSetupInstanceId,
    providerUnavailableLabel,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    autoPick,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const runChip = resolveComposerRunChip({
    runtimeMode: compatibleRuntimeMode,
    defaultRuntimeMode,
    nonPrimaryMachineLabel: useNonPrimaryMachineLabel(environmentId),
  });
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  // Auto takes its model and options from Settings, including when the chat still reports an older pick.
  const autoSelection =
    selectedModelSelection.autoAccount === true && multipleModelSelections === null
      ? autoPick
      : null;
  const autoOn = autoSelection !== null;
  const autoProvider = autoSelection
    ? providerInstanceEntries.find((entry) => entry.instanceId === autoSelection.instanceId)
    : undefined;

  const applyThreadModelPick = useApplyThreadModelPick();
  const applyRouteThreadModelPick = useStableCallback(() => applyThreadModelPick(routeThreadRef));
  const traitsInput = resolveComposerTraitsInput({
    provider: autoProvider?.driverKind ?? selectedProvider,
    instanceId: autoSelection?.instanceId ?? selectedInstanceId,
    ...(routeKind === "server"
      ? { threadRef: routeThreadRef, onDraftModelOptionsChange: applyRouteThreadModelPick }
      : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: autoSelection?.model ?? selectedModel,
    models: autoProvider?.models ?? selectedProviderModels,
    modelOptions: autoSelection
      ? autoSelection.options
      : composerModelOptions?.[selectedInstanceId],
    reportedModelSelection: autoOn ? undefined : reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
  });
  const effort = describeComposerEffort(traitsInput, props.effortDisplay, controlSize);
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      workspaceCwd={props.workspaceCwd}
      compact={false}
      isComposerOwned
      // The trigger grows away from this edge when its model or effort label changes.
      popupAlign={composerControlsCollapsed ? "start" : "end"}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      autoPick={autoPick}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        autoSelection?.instanceId ??
        (providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId)
      }
      model={
        autoSelection?.model ??
        (providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback)
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={controlSize}
      triggerClassName={cn(
        "group/model-trigger",
        MODEL_TRIGGER_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      triggerSuffix={
        <>
          {effort.suffix}
          {runChip.segments.map((segment) => (
            <RunChipSegment key={segment.kind} segment={segment} />
          ))}
        </>
      }
      triggerDetail={[effort.detail, runChip.accessibleDetail].filter(Boolean).join(", ")}
      triggerShortcuts="composer.effort composer.mode"
      effortColumn={
        autoOn ? <ComposerAutoEffortColumn /> : <ComposerEffortColumn traits={traitsInput} />
      }
      footer={
        <>
          {autoOn ? null : <ComposerPickerFooter traits={traitsInput} />}
          {compatibleRuntimeModeOptions.length > 0 ? (
            <ComposerRunPermissions
              runtimeMode={compatibleRuntimeMode}
              runtimeModeOptions={compatibleRuntimeModeOptions}
              onRuntimeModeChange={handleRuntimeModeChange}
            />
          ) : null}
        </>
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      {...(showProviderUnavailable ? { triggerLabel: t("Choose model") } : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  // The picker stays beside the warning so a stuck selection can move to a working provider.
  return showProviderUnavailable ? (
    <>
      {composerModelPicker}
      <ComposerControl
        type="button"
        size={composerControlsCollapsed ? "xs" : "sm"}
        disabled={!providerSetupInstanceId}
        onClick={() => {
          if (providerSetupInstanceId) {
            onOpenProviderSetup(providerSetupInstanceId);
          }
        }}
        data-chat-provider-unavailable="true"
        className="shrink-0"
      >
        <CircleAlertIcon className="size-4" />
        {providerUnavailableLabel}
      </ComposerControl>
    </>
  ) : (
    composerModelPicker
  );
}

/** The machine a turn here runs on, when it is not this app's primary machine. */
function useNonPrimaryMachineLabel(environmentId: EnvironmentId): string | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useSidebarMachines();
  if (primaryEnvironmentId === null || environmentId === primaryEnvironmentId) return null;
  return machines.find((machine) => machine.environmentId === environmentId)?.label ?? null;
}

/** A run chip part after model and effort; risky ones carry an icon and the warning color. */
function RunChipSegment({ segment }: { segment: ComposerRunChipSegment }) {
  const Icon = segment.kind === "mode" ? runtimeModeConfig[segment.mode].icon : ServerIcon;
  const label = segment.kind === "mode" ? t(runtimeModeConfig[segment.mode].label) : segment.label;
  return (
    <span
      data-run-chip-segment={segment.kind}
      className={cn(
        "flex min-w-0 shrink items-center gap-1",
        segment.risky ? "font-medium text-warning-foreground" : "text-muted-foreground",
      )}
    >
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        ·
      </span>
      {segment.risky ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-current" />
      ) : null}
      <span data-run-chip-label className="min-w-0 max-w-32 truncate">
        {label}
      </span>
    </span>
  );
}
