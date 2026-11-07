import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  type SidebarProjectSortOrder,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

export * from "./project-grouping.logic";

export function useMobileProjectGroupingSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value)
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS;
}

export function useMobileProjectSortOrder(): SidebarProjectSortOrder {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return (
    (AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.projectSortOrder
      : undefined) ?? DEFAULT_SIDEBAR_PROJECT_SORT_ORDER
  );
}
