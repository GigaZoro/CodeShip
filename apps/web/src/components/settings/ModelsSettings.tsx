import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  autoModePick,
  resolveAutoModelSelection,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";

import { useClientSettings } from "../../hooks/useSettings";
import {
  defaultModelSelectionsAreMixed,
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useInheritedDefaultModelSelection } from "../../state/inheritedDefaultModel";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Switch } from "../ui/switch";
import { AdvancedSettings } from "./AdvancedSettings";
import {
  AutoModeModelRow,
  DelegatedTaskModelRow,
  FinalReviewModelRow,
  MachineModelsProvider,
} from "./MachineModelRows";
import { ModelSelectionControl } from "./ModelSelectionControl";
import { ModelSubRow } from "./ModelSubRow";
import {
  reviewGuideModelInheritance,
  scheduledTaskModelInheritance,
  sourceControlWriterModelInheritance,
} from "./modelsSettings.logic";
import { ScheduledTasksOwnModelRow } from "./ScheduledTasksOwnModelRow";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { ThreadTitleInstructionsSettings } from "./ThreadTitleInstructionsSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { t } from "~/i18n";

function useProviderSetupLink(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  return environmentId === null
    ? undefined
    : (instanceId: ProviderInstanceId) => {
        void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
      };
}

function useEveryEnvironmentSupports(capability: "lastPickedModel" | "scheduledTaskDefaultModel") {
  const { connectedEnvironments } = useSettingsScope();
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities[capability] === true,
    )
  );
}

/** What the default, scheduled tasks, and fallback rows share: the scope's providers and Auto pick. */
function useDefaultModelState() {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const clientSettings = useClientSettings();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const inheritedSelection = useInheritedDefaultModelSelection(
    target?.environmentId ?? null,
    target?.projectId ?? null,
  );
  const storedSelection =
    settings.defaultModelSelection === null && inheritedSelection === null
      ? resolveProjectDefaultProviderModelSelection(providers, settings, target?.projectId ?? null)
      : resolveDefaultProviderModelSelection(
          providers,
          settings.defaultModelSelection ?? inheritedSelection,
        );
  const autoPick = autoModePick({ settings, accounts: providers, lockedDriver: null });
  // An Auto pick shows the model and account Auto starts threads on.
  const resolveAuto = (stored: ModelSelection) =>
    resolveAutoModelSelection({ selection: stored, settings, accounts: providers, started: false });
  const selection = storedSelection
    ? resolveEffectiveDefaultModelSelection(settings, providers, resolveAuto(storedSelection))
    : null;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  return {
    settings,
    clientSettings,
    targets,
    providersByEnvironment,
    connectedEnvironments,
    representative,
    providers,
    inheritedSelection,
    storedSelection,
    autoPick,
    resolveAuto,
    selection,
    entries,
    modelDisabledReason,
    isProjectScope: scope.kind === "project" || scope.kind === "checkout",
    projectId: target?.projectId ?? null,
  };
}

/** The model new threads start on, with the last-picked and fallback choices folded in. */
export function DefaultModelRow() {
  const state = useDefaultModelState();
  const {
    settings,
    selection,
    entries,
    providers,
    autoPick,
    resolveAuto,
    isProjectScope,
    modelDisabledReason,
    representative,
  } = state;
  const updateSettings = useUpdateScopedSettings();
  const openProviderSetup = useProviderSetupLink(representative?.environmentId ?? null);
  const mixedModel = defaultModelSelectionsAreMixed(
    state.clientSettings,
    state.targets.map((candidate) => ({
      projectId: candidate.projectId,
      settings: candidate.settings,
      providers:
        state.providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS,
    })),
  );
  const automaticModel =
    state.targets.length > 0 &&
    state.targets.every((candidate) => candidate.settings.defaultModelSelection === null);
  const mixedFallback = useScopedSettingsMixed(["fallbackModelSelection"]);
  const mixedLastModel = useScopedSettingsMixed(["newThreadsUseLastModel"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const supportsLastPicked = useEveryEnvironmentSupports("lastPickedModel");
  const unavailable = state.connectedEnvironments.length === 0;
  const storedAuto = state.storedSelection?.autoAccount === true && autoPick !== null;
  const effortDisabledReason = selection
    ? modelDisabledReason(selection.instanceId, selection.model)
    : null;
  const storedFallback = settings.fallbackModelSelection;
  const fallbackAuto = storedFallback?.autoAccount === true && autoPick !== null;
  const fallbackSelection = storedFallback ? resolveAuto(storedFallback) : selection;
  const setModel = (value: ModelSelection | null) =>
    updateSettings({ defaultModelSelection: value });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection", "fallbackModelSelection", "newThreadsUseLastModel"]}
      mixed={mixedModel}
      {...searchableSetting("default-model")}
      description={
        isProjectScope
          ? t("Model for new threads in this project.")
          : !unavailable && modelSource !== "project" && automaticModel
            ? state.inheritedSelection === null
              ? t("Model for new threads, selected automatically. Projects can override it.")
              : t(
                  "Model for new threads, following the default saved on another machine. Projects can override it.",
                )
            : t("Model for new threads. Projects can override it.")
      }
      status={
        mixedModel
          ? automaticModel
            ? t(
                "Automatic defaults differ. Select one environment or choose a shared model to edit effort.",
              )
            : t("Defaults differ. Select one environment or choose a shared model to edit effort.")
          : effortDisabledReason
      }
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label={t("default model")} onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && entries.length > 0 ? (
          <ModelSelectionControl
            environmentId={representative?.environmentId ?? null}
            label={t("Default model")}
            shown={selection}
            entries={entries}
            modelOptionsByInstance={getCustomModelOptionsByInstance(
              settings,
              providers,
              selection.instanceId,
              selection.model,
            )}
            {...(mixedModel
              ? { triggerLabel: automaticModel ? t("Automatic (mixed)") : t("Mixed") }
              : {})}
            showEffort={!mixedModel && !effortDisabledReason}
            auto={{ pick: autoPick, checked: !mixedModel && storedAuto }}
            disabledReason={modelDisabledReason}
            failureTitle={t("Default model not saved")}
            {...(openProviderSetup ? { onOpenProviderSetup: openProviderSetup } : {})}
            onChange={setModel}
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            {mixedModel ? t("Mixed") : t("No providers available")}
          </span>
        )
      }
    >
      {!isProjectScope && supportsLastPicked ? (
        <ModelSubRow
          id={searchableSetting("last-picked-model").id}
          title={t("Use the last picked model")}
          description={t(
            "New threads start on the model you last picked on this device, Auto included. Until you pick one, they use the model above. Scheduled tasks are not affected.",
          )}
          control={
            <Switch
              aria-label={t("Use last picked model")}
              mixed={mixedLastModel}
              checked={mixedLastModel ? false : settings.newThreadsUseLastModel}
              onCheckedChange={(enabled) => updateSettings({ newThreadsUseLastModel: enabled })}
            />
          }
        />
      ) : null}
      {!isProjectScope ? (
        <ModelSubRow
          id={searchableSetting("fallback-model").id}
          title={t("Fallback model")}
          description={t("Used for new threads when the default model's provider is out of usage.")}
          reset={
            mixedFallback || storedFallback !== null ? (
              <SettingResetButton
                label={t("fallback model")}
                onClick={() => updateSettings({ fallbackModelSelection: null })}
              />
            ) : null
          }
          control={
            fallbackSelection && entries.length > 0 ? (
              <ModelSelectionControl
                environmentId={representative?.environmentId ?? null}
                label={t("Fallback model")}
                shown={fallbackSelection}
                entries={entries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  fallbackSelection.instanceId,
                  fallbackSelection.model,
                )}
                {...(mixedFallback
                  ? { triggerLabel: t("Mixed") }
                  : storedFallback === null
                    ? { triggerLabel: t("None") }
                    : {})}
                showEffort={storedFallback !== null && !mixedFallback}
                auto={{ pick: autoPick, checked: !mixedFallback && fallbackAuto }}
                disabledReason={modelDisabledReason}
                failureTitle={t("Fallback model not saved")}
                onChange={(next) => updateSettings({ fallbackModelSelection: next })}
              />
            ) : (
              <span className="text-sm text-muted-foreground">{t("No providers available")}</span>
            )
          }
        />
      ) : null}
    </SettingsRow>
  );
}

/** The model scheduled tasks run, which follows the default until one is picked. */
function ScheduledTaskModelRow() {
  const state = useDefaultModelState();
  const { settings, selection, entries, providers, autoPick, resolveAuto } = state;
  const updateSettings = useUpdateScopedSettings();
  const mixedTaskModel = useScopedSettingsMixed(["scheduledTaskModelSelection"]);
  const supported = useEveryEnvironmentSupports("scheduledTaskDefaultModel");
  if (state.isProjectScope || !supported) return null;
  const stored = settings.scheduledTaskModelSelection;
  const inheritance = scheduledTaskModelInheritance(settings);
  const taskAuto = stored?.autoAccount === true && autoPick !== null;
  // Empty follows the new-thread model, so it shows that model.
  const shown = stored ? resolveAuto(stored) : selection;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["scheduledTaskModelSelection"]}
        mixed={mixedTaskModel}
        {...searchableSetting("scheduled-task-model")}
        description={t(
          "Runs scheduled tasks that use the default model. Same as default follows the model for new threads, including project overrides.",
        )}
        resetAction={
          stored !== null ? (
            <SettingResetButton
              label={t("scheduled tasks model")}
              tooltip={t("Same as default")}
              onClick={() => updateSettings({ scheduledTaskModelSelection: null })}
            />
          ) : null
        }
        control={
          shown && entries.length > 0 ? (
            <ModelSelectionControl
              environmentId={state.representative?.environmentId ?? null}
              label={t("Scheduled tasks model")}
              shown={shown}
              entries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                shown.instanceId,
                shown.model,
              )}
              {...(mixedTaskModel
                ? { triggerLabel: t("Mixed") }
                : inheritance
                  ? { triggerLabel: t(inheritance.label) }
                  : {})}
              showEffort={stored !== null && !mixedTaskModel}
              auto={{ pick: autoPick, checked: !mixedTaskModel && taskAuto }}
              disabledReason={state.modelDisabledReason}
              failureTitle={t("Scheduled tasks model not saved")}
              onChange={(next) => updateSettings({ scheduledTaskModelSelection: next })}
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {mixedTaskModel ? t("Mixed") : t("No providers available")}
            </span>
          )
        }
      />
      <ScheduledTasksOwnModelRow />
    </>
  );
}

/** The text generation providers of the scope's single environment, shared by the three writing rows. */
function useTextGenerationState() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const projectId = target?.projectId ?? null;
  const entries = providerInstanceEntriesFor(textGenerationProviders, settings, projectId);
  const enabledInstanceIds = new Set(
    entries.filter((entry) => entry.enabled && entry.isAvailable).map((entry) => entry.instanceId),
  );
  return {
    settings,
    updateSettings,
    environmentId,
    hasServerTargets: connectedEnvironments.length > 0,
    projectId,
    textGenerationProviders,
    // A project's disabled instances cannot run its text generation.
    projectEffectiveProviders: textGenerationProviders.filter((provider) =>
      enabledInstanceIds.has(provider.instanceId),
    ),
    entries,
    hasTextGenerationProvider: enabledInstanceIds.size > 0,
    disabledReason: useScopedModelDisabledReason(settings, entries),
  };
}

type TextGenerationState = ReturnType<typeof useTextGenerationState>;

function TextGenerationModelControl({
  state,
  label,
  failureTitle,
  shown,
  providers,
  triggerLabel,
  showEffort,
  unavailableMessage,
  onChange,
}: {
  readonly state: TextGenerationState;
  readonly label: string;
  readonly failureTitle: string;
  readonly shown: ModelSelection;
  readonly providers: TextGenerationState["textGenerationProviders"];
  readonly triggerLabel: string | undefined;
  readonly showEffort: boolean;
  readonly unavailableMessage: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const openProviderSetup = useProviderSetupLink(state.environmentId);
  if (!state.hasServerTargets) {
    return <span className="text-sm text-muted-foreground">{unavailableMessage}</span>;
  }
  if (!state.hasTextGenerationProvider) {
    return (
      <span className="text-sm text-muted-foreground">
        {t("No text generation providers available.")}
      </span>
    );
  }
  return (
    <ModelSelectionControl
      environmentId={state.environmentId}
      label={label}
      shown={shown}
      entries={state.entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        state.settings,
        providers,
        shown.instanceId,
        shown.model,
      )}
      {...(triggerLabel !== undefined ? { triggerLabel } : {})}
      showEffort={showEffort}
      disabledReason={state.disabledReason}
      failureTitle={failureTitle}
      {...(openProviderSetup ? { onOpenProviderSetup: openProviderSetup } : {})}
      onChange={onChange}
    />
  );
}

/** Thread titles and other background text, which every writing role falls back to. */
function TitlesModelRow() {
  const state = useTextGenerationState();
  const { settings, updateSettings, textGenerationProviders } = state;
  const mixed = useScopedSettingsMixed(["textGenerationModelSelection"]);
  const shown = resolveAppModelSelectionState(settings, textGenerationProviders);
  const dirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["textGenerationModelSelection"]}
      {...searchableSetting("text-generation-model")}
      description={t(
        "Thread titles and other generated text on connected devices with this provider. Commit and pull request writing and review guides follow it until they pick their own.",
      )}
      resetAction={
        state.hasServerTargets && dirty ? (
          <SettingResetButton
            label={t("titles and background text model")}
            onClick={() =>
              updateSettings({
                textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        <TextGenerationModelControl
          state={state}
          label={t("Titles and background text model")}
          failureTitle={t("Titles and background text model not saved")}
          shown={shown}
          providers={textGenerationProviders}
          triggerLabel={mixed ? t("Mixed") : undefined}
          showEffort={!mixed}
          unavailableMessage={t("Connect an environment to choose its titles model.")}
          onChange={(next) =>
            updateSettings({
              textGenerationModelSelection: resolveAppModelSelectionState(
                { ...settings, textGenerationModelSelection: next },
                textGenerationProviders,
              ),
            })
          }
        />
      }
    />
  );
}

/** The model that writes commit messages, pull request text, and branch or bookmark names. */
function SourceControlWriterModelRow() {
  const state = useTextGenerationState();
  const { settings, updateSettings, projectEffectiveProviders, projectId } = state;
  const mixed = useScopedSettingsMixed(["sourceControlWriterModelSelection"]);
  const inheritance = sourceControlWriterModelInheritance(settings);
  const { scope } = useSettingsScope();
  // In a project the row's own reset only drops the override, which brings back the machine's model.
  const followsTitlesHere =
    (scope.kind === "project" || scope.kind === "checkout") && !mixed && inheritance === null;
  const shown = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        settings,
        projectEffectiveProviders,
        projectId,
      ),
    },
    projectEffectiveProviders,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["sourceControlWriterModelSelection"]}
      mixed={mixed}
      {...searchableSetting("source-control-writer-model")}
      description={t(
        "Writes commit messages, pull request titles and descriptions, and branch or bookmark names.",
      )}
      resetAction={
        mixed || settings.sourceControlWriterModelSelection !== null ? (
          <SettingResetButton
            label={t("commit and pull request writing model")}
            tooltip={t("Same as titles")}
            onClick={() => updateSettings({ sourceControlWriterModelSelection: null })}
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-1">
          {followsTitlesHere ? (
            <SettingResetButton
              label={t("commit and pull request writing model")}
              tooltip={t("Same as titles")}
              onClick={() => updateSettings({ sourceControlWriterModelSelection: null })}
            />
          ) : null}
          <TextGenerationModelControl
            state={state}
            label={t("Commit and pull request writing model")}
            failureTitle={t("Commit and pull request writing model not saved")}
            shown={shown}
            providers={projectEffectiveProviders}
            triggerLabel={mixed ? t("Mixed") : inheritance ? t(inheritance.label) : undefined}
            showEffort={inheritance === null && !mixed}
            unavailableMessage={t("Connect an environment to choose its writing model.")}
            onChange={(next) => updateSettings({ sourceControlWriterModelSelection: next })}
          />
        </div>
      }
    />
  );
}

/** The model that reads a pull request to write its review guide. */
function ReviewGuideModelRow() {
  const state = useTextGenerationState();
  const { settings, updateSettings, textGenerationProviders, projectId } = state;
  const mixed = useScopedSettingsMixed(["reviewGuideModelSelection"]);
  const mixedEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const inheritance = reviewGuideModelInheritance(settings);
  const { scope } = useSettingsScope();
  // In a project the row's own reset only drops the override, which brings back the machine's model.
  const followsWritingHere =
    (scope.kind === "project" || scope.kind === "checkout") && !mixed && inheritance === null;
  const shown = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveReviewGuideModelSelection(
        settings,
        textGenerationProviders,
        projectId,
      ),
    },
    textGenerationProviders,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["reviewGuideModelSelection"]}
      mixed={mixed}
      {...searchableSetting("review-guide-model")}
      description={t(
        "Reads a pull request over many steps to write its review guide, so a stronger model helps.",
      )}
      status={
        !settings.reviewGuidesEnabled && !mixedEnabled
          ? t("Review guides are off. Turn them on in Source control & worktrees.")
          : undefined
      }
      resetAction={
        mixed || settings.reviewGuideModelSelection !== null ? (
          <SettingResetButton
            label={t("review guide model")}
            tooltip={t("Same as writing")}
            onClick={() => updateSettings({ reviewGuideModelSelection: null })}
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-1">
          {followsWritingHere ? (
            <SettingResetButton
              label={t("review guide model")}
              tooltip={t("Same as writing")}
              onClick={() => updateSettings({ reviewGuideModelSelection: null })}
            />
          ) : null}
          <TextGenerationModelControl
            state={state}
            label={t("Review guide model")}
            failureTitle={t("Review guide model not saved")}
            shown={shown}
            providers={textGenerationProviders}
            triggerLabel={mixed ? t("Mixed") : inheritance ? t(inheritance.label) : undefined}
            showEffort={inheritance === null && !mixed}
            unavailableMessage={t("Connect an environment to choose its review guide model.")}
            onChange={(next) => updateSettings({ reviewGuideModelSelection: next })}
          />
        </div>
      }
    />
  );
}

/**
 * Every model role in one list, in the order a thread meets them. `machineEnvironmentId` is the one
 * machine whose providers and accounts the machine-wide rows use; null leaves those rows out.
 */
export function ModelsSettingsSection({
  machineEnvironmentId,
}: {
  readonly machineEnvironmentId: EnvironmentId | null;
}) {
  return (
    <MachineModelsProvider environmentId={machineEnvironmentId}>
      <SettingsSection id="models" title={t("Models")}>
        <DefaultModelRow />
        <ScheduledTaskModelRow />
        <AutoModeModelRow />
        <TitlesModelRow />
        <SourceControlWriterModelRow />
        <ReviewGuideModelRow />
        <FinalReviewModelRow />
        <DelegatedTaskModelRow />
        <AdvancedSettings targetIds={[searchableSetting("thread-title-instructions").id]}>
          <ThreadTitleInstructionsSettings />
        </AdvancedSettings>
      </SettingsSection>
    </MachineModelsProvider>
  );
}
