import { Platform } from "react-native";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  THREAD_LIST_V2_ESTIMATED_ROW_HEIGHTS,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAMES,
  THREAD_LIST_V2_SLIM_ROW_CLASS_NAMES,
} from "./thread-list-v2-row-appearance";

export function useThreadListRowContentClassName() {
  return THREAD_LIST_V2_ROW_CONTENT_CLASS_NAMES[useAppearancePreferences().interfaceDensity][
    Platform.OS === "android" ? "android" : "ios"
  ];
}

export function useThreadListSlimRowClassName() {
  return THREAD_LIST_V2_SLIM_ROW_CLASS_NAMES[useAppearancePreferences().interfaceDensity];
}

export function useThreadListEstimatedRowHeight() {
  return THREAD_LIST_V2_ESTIMATED_ROW_HEIGHTS[useAppearancePreferences().interfaceDensity];
}
