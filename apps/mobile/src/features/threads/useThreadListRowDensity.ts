import { Platform } from "react-native";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const ROW_DENSITY = {
  comfortable: {
    ios: "min-h-[44px] px-5 py-2.5",
    android: "min-h-[48px] px-3 py-2.5",
    slim: "py-2",
    estimatedHeight: 72,
  },
  compact: {
    ios: "min-h-[44px] px-5 py-1.5",
    android: "min-h-[48px] px-3 py-1.5",
    slim: "py-1",
    estimatedHeight: 64,
  },
};

export function useThreadListRowContentClassName() {
  return ROW_DENSITY[useAppearancePreferences().interfaceDensity][
    Platform.OS === "android" ? "android" : "ios"
  ];
}

export function useThreadListSlimRowClassName() {
  return ROW_DENSITY[useAppearancePreferences().interfaceDensity].slim;
}

export function useThreadListEstimatedRowHeight() {
  return ROW_DENSITY[useAppearancePreferences().interfaceDensity].estimatedHeight;
}
