import { msg, t, type Message } from "../../lib/i18n";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  NewThreadSettingsSection,
  ThreadGroupingSettingsSection,
  WorkingSectionSettings,
  ScheduledTaskPlacementSettings,
} from "./ThreadSettingsSections";

const GROUPING_OPTIONS: ReadonlyArray<{
  readonly mode: SidebarProjectGroupingMode;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    mode: "repository",
    label: msg("Same repository"),
    description: msg("The same repository on any machine or path is one project."),
  },
  {
    mode: "repository_path",
    label: msg("Same repository and path"),
    description: msg("Keep monorepo paths separate."),
  },
  {
    mode: "separate",
    label: msg("Keep separate"),
    description: msg("Show every workspace as its own project."),
  },
];

export function SettingsProjectGroupingRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedMode = AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value).sidebarProjectGroupingMode
    : null;
  const groupedByMachine =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.threadListGroupByMachine === true;

  return (
    <SettingsScreen title={t("General")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title={t("Combine matching projects")}
          footer={
            groupedByMachine
              ? t(
                  "Machine folders still list a project under each machine it is on. This decides how it shows in filters and the project picker.",
                )
              : undefined
          }
        >
          {GROUPING_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.mode}
              label={t(option.label)}
              description={t(option.description)}
              selected={selectedMode === option.mode}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences(mobileProjectGroupingModePatch(option.mode))}
            />
          ))}
        </SettingsSection>
        <ThreadGroupingSettingsSection />
        <WorkingSectionSettings />
        <ScheduledTaskPlacementSettings />
        <NewThreadSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}
