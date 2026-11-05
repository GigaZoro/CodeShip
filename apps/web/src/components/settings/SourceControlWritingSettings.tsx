import { msg, t, type Message } from "~/i18n";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type {
  ProviderInstanceId,
  ServerSettings,
  SourceControlWritingStyleMode,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { AdvancedSettings } from "./AdvancedSettings";
import { searchableSetting } from "./settingsSearch";

const MODE_OPTIONS: Record<
  SourceControlWritingStyleMode,
  { label: Message; description: Message }
> = {
  repo_conventions: {
    label: msg("Repository conventions"),
    description: msg(
      "In each project, matches recent change descriptions and change request titles.",
    ),
  },
  conventional_commits: {
    label: msg("Conventional Commits"),
    description: msg("Use Conventional Commit prefixes and keep change request text concise."),
  },
  custom: {
    label: msg("Custom instructions"),
    description: msg(
      "Use your instructions for change descriptions and change requests in every project.",
    ),
  },
};

/** "models" renders only the writer and review guide model rows, for Providers & models. */
export function SourceControlWritingSettingsSection({
  part = "writing",
}: {
  readonly part?: "writing" | "models";
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const navigate = useNavigate();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const styleFieldMixed = (field: keyof ServerSettings["sourceControlWritingStyle"]) => {
    const first = targets[0];
    return (
      first !== undefined &&
      targets.some(
        (candidate) =>
          candidate.settings.sourceControlWritingStyle[field] !==
          first.settings.sourceControlWritingStyle[field],
      )
    );
  };
  const modeMixed = styleFieldMixed("mode");
  const instructionsMixed = styleFieldMixed("customInstructions");
  const templatesMixed = styleFieldMixed("followChangeRequestTemplates");
  const writingStyleMixed = modeMixed || instructionsMixed;
  const mixedWriterModel = useScopedSettingsMixed(["sourceControlWriterModelSelection"]);
  const mixedReviewGuideModel = useScopedSettingsMixed(["reviewGuideModelSelection"]);
  const mixedReviewGuideInstructions = useScopedSettingsMixed(["reviewGuideInstructions"]);
  const reviewGuideInstructionsEdited = useRef(false);
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const [editingAllInstructions, setEditingAllInstructions] = useState(false);
  const [allInstructions, setAllInstructions] = useState<string | null>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    writingStyleMixed ||
    style.mode !== defaults.mode ||
    style.customInstructions !== defaults.customInstructions;

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const projectEnabledInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const projectEffectiveTextGenerationProviders = textGenerationProviders.filter((provider) =>
    projectEnabledInstanceIds.has(provider.instanceId),
  );
  const defaultModelSelection = resolveAppModelSelectionState(
    settings,
    projectEffectiveTextGenerationProviders,
  );
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const activeSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        settings,
        projectEffectiveTextGenerationProviders,
        target?.projectId ?? null,
      ),
    },
    projectEffectiveTextGenerationProviders,
  );
  const canEnableDedicatedModel = instanceEntries.some(
    (entry) =>
      entry.instanceId === defaultModelSelection.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    projectEffectiveTextGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const writerInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const usesReviewGuideModel = settings.reviewGuideModelSelection !== null;
  const reviewGuideSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveReviewGuideModelSelection(
        settings,
        textGenerationProviders,
        target?.projectId ?? null,
      ),
    },
    textGenerationProviders,
  );
  const reviewGuideModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    reviewGuideSelection.instanceId,
    reviewGuideSelection.model,
  );
  const reviewGuideInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === reviewGuideSelection.instanceId,
  );

  const reviewGuidesShown = settings.reviewGuidesEnabled || mixedReviewGuidesEnabled;

  if (part === "models") {
    return (
      <SettingsSection id="source-control-models" title={t("Source control writing")}>
        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWriterModelSelection"]}
          {...searchableSetting("source-control-writer-model")}
          description={t(
            "Model for source control text and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
          )}
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                {t("Connect an environment to choose its source control writer model.")}
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesDedicatedModel && !canEnableDedicatedModel ? (
                  <span className="text-sm text-muted-foreground">
                    {t("No text generation providers available.")}
                  </span>
                ) : null}
                {usesDedicatedModel && canEnableDedicatedModel ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={activeSelection.instanceId}
                    model={activeSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={t("Source control writer model")}
                    {...(mixedWriterModel ? { triggerLabel: t("Mixed") } : {})}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    getModelDisabledReason={writerModelDisabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = writerModelDisabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: t("Source control writer model not saved"),
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                      });
                    }}
                  />
                ) : null}
                {usesDedicatedModel &&
                canEnableDedicatedModel &&
                !mixedWriterModel &&
                writerInstanceEntry ? (
                  <TraitsPicker
                    provider={writerInstanceEntry.driverKind}
                    models={writerInstanceEntry.models}
                    model={activeSelection.model}
                    modelOptions={activeSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        sourceControlWriterModelSelection: createModelSelection(
                          activeSelection.instanceId,
                          activeSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
                <Switch
                  checked={usesDedicatedModel}
                  disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sourceControlWriterModelSelection: checked
                        ? createModelSelection(
                            defaultModelSelection.instanceId,
                            defaultModelSelection.model,
                            defaultModelSelection.options,
                          )
                        : null,
                    })
                  }
                  aria-label={t("Use a separate source control writer model")}
                />
              </div>
            )
          }
        />
        {reviewGuidesShown ? (
          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideModelSelection"]}
            {...searchableSetting("review-guide-model")}
            description={t(
              "Model that reads a pull request to write its review guide. It reads the change itself over many steps, so a stronger model helps. Off uses the source control writer model.",
            )}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  {t("Connect an environment to choose its review guide model.")}
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(usesReviewGuideModel || mixedReviewGuideModel) && canEnableDedicatedModel ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={reviewGuideSelection.instanceId}
                      model={reviewGuideSelection.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={reviewGuideModelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel={t("Review guide model")}
                      {...(mixedReviewGuideModel ? { triggerLabel: t("Mixed") } : {})}
                      getModelDisabledReason={writerModelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = writerModelDisabledReason(instanceId, model);
                        if (reason) {
                          toastManager.add({
                            type: "error",
                            title: t("Review guide model not saved"),
                            description: reason,
                          });
                          return;
                        }
                        updateSettings({
                          reviewGuideModelSelection: createModelSelection(instanceId, model),
                        });
                      }}
                    />
                  ) : null}
                  {usesReviewGuideModel &&
                  canEnableDedicatedModel &&
                  !mixedReviewGuideModel &&
                  reviewGuideInstanceEntry ? (
                    <TraitsPicker
                      provider={reviewGuideInstanceEntry.driverKind}
                      models={reviewGuideInstanceEntry.models}
                      model={reviewGuideSelection.model}
                      modelOptions={reviewGuideSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        updateSettings({
                          reviewGuideModelSelection: createModelSelection(
                            reviewGuideSelection.instanceId,
                            reviewGuideSelection.model,
                            options,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <Switch
                    mixed={mixedReviewGuideModel}
                    checked={mixedReviewGuideModel ? false : usesReviewGuideModel}
                    disabled={!usesReviewGuideModel && !canEnableDedicatedModel}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        updateSettings({ reviewGuideModelSelection: null });
                        return;
                      }
                      const reason = writerModelDisabledReason(
                        activeSelection.instanceId,
                        activeSelection.model,
                      );
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: t("Review guide model not saved"),
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        reviewGuideModelSelection: createModelSelection(
                          activeSelection.instanceId,
                          activeSelection.model,
                          activeSelection.options,
                        ),
                      });
                    }}
                    aria-label={t("Use a separate review guide model")}
                  />
                </div>
              )
            }
          />
        ) : null}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="source-control-text-generation" title={t("Writing & review")}>
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...searchableSetting("source-control-writing-style")}
        description={t(MODE_OPTIONS[style.mode].description)}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label={t("source control writing style")}
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                sourceControlWritingStyle: {
                  mode: value as SourceControlWritingStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label={t("Source control writing style")}
            >
              <SelectValue>
                {(value: SourceControlWritingStyleMode | null) =>
                  value === null ? t("Mixed") : t(MODE_OPTIONS[value].label)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {t(MODE_OPTIONS[mode].label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {writingStyleMixed ? (
          <div className="mt-3 max-w-2xl space-y-2 pb-3.5">
            {editingAllInstructions ? (
              <>
                <Textarea
                  value={allInstructions ?? ""}
                  onChange={(event) => setAllInstructions(event.target.value)}
                  rows={4}
                  aria-label={t("Custom source control instructions for all selected environments")}
                  placeholder={t("Write the instructions each selected environment should use.")}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={allInstructions === null}
                  onClick={() => {
                    if (allInstructions === null) return;
                    updateSettings({
                      sourceControlWritingStyle: {
                        mode: "custom",
                        customInstructions: allInstructions.trim(),
                      },
                    });
                    setEditingAllInstructions(false);
                  }}
                >
                  {t("Apply instructions to all")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAllInstructions(null);
                  setEditingAllInstructions(true);
                }}
              >
                {t("Write custom instructions for all")}
              </Button>
            )}
          </div>
        ) : style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder={t("Keep titles concise. Use short bullet points in descriptions.")}
              aria-label={t("Custom source control writing instructions")}
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...searchableSetting("review-guides")}
        description={t(
          "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
        )}
        control={
          <Switch
            mixed={mixedReviewGuidesEnabled}
            checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label={t("Review guides")}
          />
        }
      />

      {reviewGuidesShown ? (
        <SettingsRow
          serverScoped
          settingKeys={["reviewGuideInstructions"]}
          {...searchableSetting("review-guide-instructions")}
          description={t(
            "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
          )}
          resetAction={
            mixedReviewGuideInstructions || settings.reviewGuideInstructions !== "" ? (
              <SettingResetButton
                label={t("review guide instructions")}
                onClick={() => updateSettings({ reviewGuideInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${mixedReviewGuideInstructions}:${settings.reviewGuideInstructions}`}
              aria-label={t("Review guide instructions")}
              onChange={() => {
                reviewGuideInstructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={mixedReviewGuideInstructions ? "" : settings.reviewGuideInstructions}
              placeholder={
                mixedReviewGuideInstructions
                  ? t("Mixed. Enter instructions to apply to all selected targets.")
                  : t(
                      "Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences.",
                    )
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  reviewGuideInstructionsEdited.current &&
                  (mixedReviewGuideInstructions || value !== settings.reviewGuideInstructions)
                )
                  updateSettings({ reviewGuideInstructions: value });
                reviewGuideInstructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
      <AdvancedSettings targetIds={[searchableSetting("follow-change-request-templates").id]}>
        <SettingsRow
          serverScoped
          settingKeys={["sourceControlWritingStyle"]}
          mixed={templatesMixed}
          {...searchableSetting("follow-change-request-templates")}
          description={t(
            "Use the repository's template for change request descriptions when available.",
          )}
          resetAction={
            templatesMixed ||
            style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
              <SettingResetButton
                label={t("change request templates")}
                onClick={() =>
                  updateSettings({
                    sourceControlWritingStyle: {
                      followChangeRequestTemplates: defaults.followChangeRequestTemplates,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              mixed={templatesMixed}
              checked={templatesMixed ? false : style.followChangeRequestTemplates}
              onCheckedChange={(checked) =>
                updateSettings({
                  sourceControlWritingStyle: {
                    followChangeRequestTemplates: Boolean(checked),
                  },
                })
              }
              aria-label={t("Follow change request templates")}
            />
          }
        />
      </AdvancedSettings>
    </SettingsSection>
  );
}
