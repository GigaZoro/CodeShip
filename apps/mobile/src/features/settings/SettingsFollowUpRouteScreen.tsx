import { msg, t, type Message } from "../../lib/i18n";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  managedSettingReason,
  planMobileScopedSettingsPatch,
  planMobileScopedSettingsClear,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { DEFAULT_FOLLOW_UP_BEHAVIOR, type FollowUpBehavior } from "../../lib/followUpBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

const FOLLOW_UP_OPTIONS: ReadonlyArray<{
  readonly behavior: FollowUpBehavior;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    behavior: "queue",
    label: msg("Queue"),
    description: msg("Your message waits and runs after the current turn finishes."),
  },
  {
    behavior: "steer",
    label: msg("Steer"),
    description: msg("Your message reaches the agent right away, changing what it is working on."),
  },
];

export function SettingsFollowUpRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : null;

  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const [pending, setPending] = useState(false);
  const writeInFlight = useRef(false);
  const writeSettings = useSettingsWriter();
  const managed = managedSettingReason(targets, "skillAvailability");
  const skillAvailability = uniformMobileSetting(targets, "skillAvailability");
  const skillsDisabled =
    pending ||
    managed !== undefined ||
    targets.length === 0 ||
    targets.some((target) => !writable.has(target.environment.environmentId));
  const hasSkillOverride = targets.some((target) => target.sources.skillAvailability === "project");
  const saveSkillAvailability = (patch: ServerSettingsPatch | null) => {
    if (
      skillsDisabled ||
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes =
      patch === null
        ? planMobileScopedSettingsClear(targets, ["skillAvailability"])
        : planMobileScopedSettingsPatch(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPending(true);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      setPending(false);
    });
  };

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection title={t("While the agent is running")}>
        {FOLLOW_UP_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.behavior}
            label={t(option.label)}
            description={t(option.description)}
            selected={selectedBehavior === option.behavior}
            separated={index > 0}
            disabled={!preferencesReady}
            onPress={() => savePreferences({ followUpBehavior: option.behavior })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Long-press the send button to use the other option for a single message. With a hardware keyboard, hold Command while sending.",
        )}
      </Text>
      <SettingsSection
        title={t("Skill availability")}
        trailing={
          (
            projectSelected
              ? hasSkillOverride
              : targets.some(
                  (target) =>
                    target.settings.skillAvailability !== DEFAULT_SERVER_SETTINGS.skillAvailability,
                )
          ) ? (
            <Button
              label={projectSelected ? t("Use defaults") : t("Reset")}
              accessibilityHint={
                projectSelected
                  ? t("Use environment skill availability for this project")
                  : t("Reset skill availability to By provider")
              }
              tone="text"
              disabled={skillsDisabled}
              onPress={() =>
                saveSkillAvailability(
                  projectSelected
                    ? null
                    : { skillAvailability: DEFAULT_SERVER_SETTINGS.skillAvailability },
                )
              }
            />
          ) : undefined
        }
        footer={
          managed ??
          (targets.length === 0
            ? t("Select a connected environment or project using the filter above.")
            : projectSelected
              ? `${selectedProject?.label ?? t("Project")} · ${hasSkillOverride ? t("Project override") : t("Inherited from environment")}`
              : t("Applies to the selected environments."))
        }
      >
        <SettingsChoiceRow
          label={t("By provider")}
          description={t("Use skills available to the selected provider.")}
          selected={skillAvailability === "provider"}
          disabled={skillsDisabled}
          onPress={() => saveSkillAvailability({ skillAvailability: "provider" })}
        />
        <SettingsChoiceRow
          label={t("Shared across models")}
          description={t("Use skills from all enabled providers on the same environment.")}
          selected={skillAvailability === "shared"}
          separated
          disabled={skillsDisabled}
          onPress={() => saveSkillAvailability({ skillAvailability: "shared" })}
        />
      </SettingsSection>
      {targets.length > 0 && skillAvailability === null ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {t("Selected scopes have different values.")}
        </Text>
      ) : null}
      <Text className="px-2 text-sm text-foreground-muted">
        {t("Skills requiring tools the selected model cannot use may not work.")}
      </Text>
    </ScrollView>
  );

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      {Platform.OS === "android" ? (
        <SettingsScreen title={t("Chat")} trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        <View collapsable={false} className="flex-1 bg-sheet">
          {content}
        </View>
      )}
    </>
  );
}
