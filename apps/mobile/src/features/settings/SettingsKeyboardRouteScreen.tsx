import { msg, t, type Message } from "../../lib/i18n";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import {
  DEFAULT_COMPOSER_ENTER_BEHAVIOR,
  type ComposerEnterBehavior,
} from "../../lib/composerEnterBehavior";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const SEND_MODIFIER = Platform.OS === "android" ? "Ctrl" : "Command";

const ENTER_BEHAVIOR_OPTIONS: ReadonlyArray<{
  readonly behavior: ComposerEnterBehavior;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    behavior: "send",
    label: msg("Send message"),
    description: msg("Return sends the message. Shift-Return inserts a new line."),
  },
  {
    behavior: "newline",
    label: msg("Insert new line"),
    description: msg("Return inserts a new line. {modifier}-Return sends the message."),
  },
];

export function SettingsKeyboardRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR)
    : null;

  return (
    <SettingsScreen title={t("Keyboard")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("Return key")}>
          {ENTER_BEHAVIOR_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.behavior}
              label={t(option.label)}
              description={t(option.description, { modifier: SEND_MODIFIER })}
              selected={selectedBehavior === option.behavior}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => {
                void savePreferences({ composerEnterBehavior: option.behavior });
              }}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          {t("Applies to the composer when a hardware keyboard is connected.")}
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
