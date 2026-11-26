import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { t } from "../../lib/i18n";
import { AppSettingsSection } from "./SettingsAboutSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={t("About")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
