import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarGroupBy } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const groupBy: SidebarGroupBy = loaded
    ? (preferencesResult.value.threadListGroupBy ?? "none")
    : "none";
  const folderExpanded = loaded ? preferencesResult.value.threadListFolderExpanded : undefined;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const setGroupBy = (value: SidebarGroupBy) => {
    if (!loaded) return;
    savePreferences({ threadListGroupBy: value });
  };
  // A folder's default depends on its kind, so the caller passes it.
  const toggleFolder = (key: string, expandedByDefault: boolean) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListFolderExpanded: {
          ...current.threadListFolderExpanded,
          [key]: !(current.threadListFolderExpanded?.[key] ?? expandedByDefault),
        },
      }),
    });
  };

  return {
    loaded,
    groupBy,
    folderExpanded,
    setGroupBy,
    toggleFolder,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
