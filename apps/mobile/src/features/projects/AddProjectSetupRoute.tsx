import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  AddProjectCloneScreen,
  AddProjectLocalFolderScreen,
  AddProjectNewScreen,
} from "./AddProjectScreen";
import { t } from "../../lib/i18n";

type AddProjectSetupRouteParams = {
  /** The path segment the retired per-step routes used, so their links keep working. */
  readonly mode?: string | string[];
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly repositoryName?: string | string[];
  readonly prompt?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function AddProjectSetupRoute({
  route,
}: StaticScreenProps<AddProjectSetupRouteParams | undefined>) {
  const params = route.params ?? {};
  const mode = firstParam(params.mode);
  if (mode === "local") {
    return (
      <>
        <NativeStackScreenOptions options={{ title: t("Local folder") }} />
        <AddProjectLocalFolderScreen environmentId={params.environmentId} />
      </>
    );
  }
  if (mode === "new") {
    return (
      <>
        <NativeStackScreenOptions options={{ title: t("New project") }} />
        <AddProjectNewScreen environmentId={params.environmentId} />
      </>
    );
  }
  return <AddProjectCloneScreen {...params} />;
}
