import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { managedRuntimeModeDenial } from "@t3tools/shared/managedPolicyMessages";
import { createModelSelection, withModelSelectionOptions } from "@t3tools/shared/model";
import { autoModePick, resolveAutoModelSelection } from "@t3tools/shared/serverSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "../../hooks/useSettings";
import {
  defaultModelSelectionsAreMixed,
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useInheritedDefaultModelSelection } from "../../state/inheritedDefaultModel";
import { firstManagedDenial } from "../../state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { ScheduledTasksOwnModelRow } from "./ScheduledTasksOwnModelRow";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { t } from "~/i18n";

const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

/** "models" holds the new-thread model rows for Providers & models; "general" keeps permissions and workspace. */
export function ProjectDefaultsSettings({
  category,
}: {
  category: ProjectSettingsCategory | "models";
}) {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const clientSettings = useClientSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
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
  const storedAuto = storedSelection?.autoAccount === true && autoPick !== null;
  // An Auto pick shows the model and account Auto starts threads on.
  const resolveAuto = (stored: ModelSelection) =>
    resolveAutoModelSelection({ selection: stored, settings, accounts: providers, started: false });
  const selection = storedSelection
    ? resolveEffectiveDefaultModelSelection(settings, providers, resolveAuto(storedSelection))
    : null;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = defaultModelSelectionsAreMixed(
    clientSettings,
    targets.map((candidate) => ({
      projectId: candidate.projectId,
      settings: candidate.settings,
      providers: providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS,
    })),
  );
  const automaticModel =
    targets.length > 0 &&
    targets.every((candidate) => candidate.settings.defaultModelSelection === null);
  const mixedFallback = useScopedSettingsMixed(["fallbackModelSelection"]);
  const mixedLastModel = useScopedSettingsMixed(["newThreadsUseLastModel"]);
  const mixedTaskModel = useScopedSettingsMixed(["scheduledTaskModelSelection"]);
  const storedTaskModel = settings.scheduledTaskModelSelection;
  const taskModelAuto = storedTaskModel?.autoAccount === true && autoPick !== null;
  // Empty follows the new-thread model, so it shows that model.
  const taskSelection = storedTaskModel ? resolveAuto(storedTaskModel) : selection;
  const taskEntry = entries.find((entry) => entry.instanceId === taskSelection?.instanceId);
  const taskModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    taskSelection?.instanceId,
    taskSelection?.model,
  );
  const storedFallback = settings.fallbackModelSelection;
  const fallbackAuto = storedFallback?.autoAccount === true && autoPick !== null;
  const fallbackSelection = storedFallback ? resolveAuto(storedFallback) : selection;
  const fallbackEntry = entries.find((entry) => entry.instanceId === fallbackSelection?.instanceId);
  const fallbackModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    fallbackSelection?.instanceId,
    fallbackSelection?.model,
  );
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedAgentCredits = useScopedSettingsMixed(["removeAgentCreditsOnMerge"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const effortDisabledReason = selection
    ? modelDisabledReason(selection.instanceId, selection.model)
    : null;

  const saveModel =
    (failureTitle: string, save: (value: ModelSelection | null) => void) =>
    (value: ModelSelection | null) => {
      const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
      if (reason) {
        toastManager.add({ type: "error", title: failureTitle, description: reason });
        return;
      }
      save(value);
    };
  const setModel = saveModel(t("Default model not saved"), (value) =>
    updateSettings({ defaultModelSelection: value }),
  );
  const setFallbackModel = saveModel(t("Fallback model not saved"), (value) =>
    updateSettings({ fallbackModelSelection: value }),
  );
  const setTaskModel = saveModel(t("Scheduled tasks model not saved"), (value) =>
    updateSettings({ scheduledTaskModelSelection: value }),
  );
  const everyEnvironmentSupports = (capability: "lastPickedModel" | "scheduledTaskDefaultModel") =>
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities[capability] === true,
    );

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title={t("Model")}
      description={
        isProjectScope
          ? t("Model for new threads in this project.")
          : !unavailable && modelSource !== "project" && automaticModel
            ? inheritedSelection === null
              ? t(
                  "Default model for new threads, selected automatically. Projects can override it.",
                )
              : t(
                  "Default model for new threads, following the default saved on another machine. Projects can override it.",
                )
            : t("Default model for new threads. Projects can override it.")
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
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel
                ? { triggerLabel: automaticModel ? t("Automatic (mixed)") : t("Mixed") }
                : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
              auto={{
                pick: autoPick,
                checked: !mixedModel && storedAuto,
                // Each machine starts Auto threads on its own primary provider and account.
                onSelect: () => {
                  if (autoPick) setModel(autoPick);
                },
              }}
            />
            {!mixedModel && activeEntry && !effortDisabledReason && !storedAuto ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(withModelSelectionOptions(selection, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {mixedModel ? t("Mixed") : t("No providers available")}
          </span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title={t("Workspace")}
      description={
        isProjectScope
          ? t("Where new threads in this project start.")
          : t("Where new threads start. Projects and their t3.json can override it.")
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label={t("default workspace")}
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (effective?.defaultThreadEnvMode ?? null)}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("Default workspace")}>
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? resolveEnvModeLabel(value)
                  : unavailable
                    ? t("Unavailable")
                    : t("Mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
            <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  const lastModelRow =
    !isProjectScope && everyEnvironmentSupports("lastPickedModel") ? (
      <SettingsRow
        serverScoped
        settingKeys={["newThreadsUseLastModel"]}
        mixed={mixedLastModel}
        {...searchableSetting("last-picked-model")}
        description={t(
          "New threads start on the model you last picked on this device, Auto included. Until you pick one, they use the model above. Scheduled tasks are not affected.",
        )}
        resetAction={
          settings.newThreadsUseLastModel ? (
            <SettingResetButton
              label={t("last picked model")}
              tooltip={t("Start new threads on the model above")}
              onClick={() => updateSettings({ newThreadsUseLastModel: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label={t("Use last picked model")}
            mixed={mixedLastModel}
            checked={mixedLastModel ? false : settings.newThreadsUseLastModel}
            onCheckedChange={(enabled) => updateSettings({ newThreadsUseLastModel: enabled })}
          />
        }
      />
    ) : null;

  const taskModelRows =
    !isProjectScope && everyEnvironmentSupports("scheduledTaskDefaultModel") ? (
      <>
        <SettingsRow
          serverScoped
          settingKeys={["scheduledTaskModelSelection"]}
          mixed={mixedTaskModel}
          {...searchableSetting("scheduled-task-model")}
          description={t(
            "Runs scheduled tasks that use the default model. Same as new threads follows the model above, including project overrides.",
          )}
          resetAction={
            storedTaskModel !== null ? (
              <SettingResetButton
                label={t("scheduled tasks model")}
                tooltip={t("Same as new threads")}
                onClick={() => setTaskModel(null)}
              />
            ) : null
          }
          control={
            taskSelection && entries.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={representative?.environmentId ?? null}
                  activeInstanceId={taskSelection.instanceId}
                  model={taskSelection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={taskModelOptions}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel={t("Scheduled tasks model")}
                  {...(mixedTaskModel
                    ? { triggerLabel: t("Mixed") }
                    : storedTaskModel === null
                      ? { triggerLabel: t("Same as new threads") }
                      : {})}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) =>
                    setTaskModel(createModelSelection(instanceId, model))
                  }
                  auto={{
                    pick: autoPick,
                    checked: !mixedTaskModel && taskModelAuto,
                    onSelect: () => {
                      if (autoPick) setTaskModel(autoPick);
                    },
                  }}
                />
                {!mixedTaskModel && storedTaskModel !== null && taskEntry && !taskModelAuto ? (
                  <TraitsPicker
                    provider={taskEntry.driverKind}
                    models={taskEntry.models}
                    model={taskSelection.model}
                    modelOptions={taskSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      setTaskModel(withModelSelectionOptions(taskSelection, options))
                    }
                  />
                ) : null}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">
                {mixedTaskModel ? t("Mixed") : t("No providers available")}
              </span>
            )
          }
        />
        <ScheduledTasksOwnModelRow />
      </>
    ) : null;

  const fallbackRow = !isProjectScope ? (
    <SettingsRow
      serverScoped
      settingKeys={["fallbackModelSelection"]}
      mixed={mixedFallback}
      {...searchableSetting("fallback-model")}
      description={t("Used for new threads when the default model's provider is out of usage.")}
      resetAction={
        mixedFallback || settings.fallbackModelSelection !== null ? (
          <SettingResetButton
            label={t("fallback model")}
            onClick={() => updateSettings({ fallbackModelSelection: null })}
          />
        ) : null
      }
      control={
        fallbackSelection ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={fallbackSelection.instanceId}
              model={fallbackSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={fallbackModelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={t("Fallback model")}
              {...(mixedFallback
                ? { triggerLabel: t("Mixed") }
                : settings.fallbackModelSelection === null
                  ? { triggerLabel: t("None") }
                  : {})}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setFallbackModel(createModelSelection(instanceId, model))
              }
              auto={{
                pick: autoPick,
                checked: !mixedFallback && fallbackAuto,
                onSelect: () => {
                  if (autoPick) setFallbackModel(autoPick);
                },
              }}
            />
            {storedFallback !== null && fallbackEntry && !mixedFallback && !fallbackAuto ? (
              <TraitsPicker
                provider={fallbackEntry.driverKind}
                models={fallbackEntry.models}
                model={fallbackSelection.model}
                modelOptions={fallbackSelection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    fallbackModelSelection: createModelSelection(
                      fallbackSelection.instanceId,
                      fallbackSelection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t("No providers available")}</span>
        )
      }
    />
  ) : null;

  if (category === "models") {
    return (
      <SettingsSection id="new-thread-models" title={t("New threads")}>
        {modelRow}
        {lastModelRow}
        {fallbackRow}
        {taskModelRows}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id={category === "source-control" ? "source-control-defaults" : "project-defaults"}
      title={category === "source-control" ? t("Repositories") : t("New threads")}
    >
      {category === "project" ? (
        <>
          {modelRow}
          {lastModelRow}
          {fallbackRow}
          {workspaceRow}
        </>
      ) : category === "general" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? t("Permissions for new threads in this project.")
                : t("Default permissions for new threads. Projects can override them.")
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label={t("default permissions")}
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("Default permissions")}>
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? t("Mixed")
                      : t(runtimeModeConfig[settings.defaultRuntimeMode].label)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    const managedReason = firstManagedDenial(
                      connectedEnvironments.map(
                        (environment) => environment.serverConfig?.managedPolicy,
                      ),
                      (policy) => managedRuntimeModeDenial(policy, mode),
                    );
                    return (
                      <SelectItem
                        key={mode}
                        value={mode}
                        disabled={managedReason !== undefined}
                        className="min-w-64"
                      >
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {t(option.label)}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {managedReason ?? t(option.description)}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {workspaceRow}
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title={t("Automatically pull")}
            description={
              isProjectScope
                ? t(
                    "Keeps this project's default branch current when the checkout has no local changes or commits.",
                  )
                : t(
                    "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
                  )
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label={t("default automatic pull")}
                  tooltip={t("Reset automatic pull to off")}
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={t("Default automatic pull")}
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["removeAgentCreditsOnMerge"]}
            mixed={mixedAgentCredits}
            {...searchableSetting("remove-agent-credits-on-merge")}
            description={t(
              "Remove recognized agent credit lines from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
            )}
            resetAction={
              settings.removeAgentCreditsOnMerge ? (
                <SettingResetButton
                  label={t("agent credit removal")}
                  tooltip={t("Keep agent credits")}
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={t("Remove agent credits when merging")}
                mixed={mixedAgentCredits}
                checked={mixedAgentCredits ? false : settings.removeAgentCreditsOnMerge}
                onCheckedChange={(enabled) =>
                  updateSettings({ removeAgentCreditsOnMerge: enabled })
                }
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? t("Pull requests in this project start with this method.")
                : t(
                    "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
                  )
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label={t("default merge method")}
                  tooltip={t("Reset to last selected")}
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("Default pull request merge method")}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? t(PULL_REQUEST_MERGE_METHOD_LABELS[value])
                        : value === "last"
                          ? t("Last selected")
                          : t("Mixed")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">{t("Last selected")}</SelectItem>
                  <SelectItem value="merge">{t(PULL_REQUEST_MERGE_METHOD_LABELS.merge)}</SelectItem>
                  <SelectItem value="squash">
                    {t(PULL_REQUEST_MERGE_METHOD_LABELS.squash)}
                  </SelectItem>
                  <SelectItem value="rebase">
                    {t(PULL_REQUEST_MERGE_METHOD_LABELS.rebase)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

export function WorktreeSubmodulesRow() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeSubmodules"]}
      mixed={mixedSubmodules}
      {...searchableSetting("worktree-submodules")}
      description={
        isProjectScope
          ? t("How new worktrees in this project populate git submodules.")
          : t(
              "How new worktrees populate git submodules. Projects and their t3.json can override it.",
            )
      }
      resetAction={
        !isProjectScope && settings.worktreeSubmodules !== null ? (
          <SettingResetButton
            label={t("worktree submodules")}
            onClick={() => updateSettings({ worktreeSubmodules: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
          onValueChange={(value) => {
            if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("Worktree submodules")}>
            <SelectValue>
              {(value: string | null) =>
                isWorktreeSubmodules(value)
                  ? t(WORKTREE_SUBMODULES_LABELS[value])
                  : unavailable
                    ? t("Unavailable")
                    : t("Mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(WORKTREE_SUBMODULES_LABELS[option])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
