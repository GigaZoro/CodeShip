import type {
  EnvironmentId,
  SourceControlAppAccess,
  SourceControlAppAccessInput,
} from "@t3tools/contracts";
import { appSignInTargetForRemote } from "@t3tools/client-runtime/source-control-clients";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Alert, Linking } from "react-native";
import { t } from "../../lib/i18n";

/**
 * After a clone, suggests installing the forge app on the repository's owner when the server is
 * signed in with it but the app does not reach the repository.
 */
export async function suggestAppAccessForRemote(
  check: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: SourceControlAppAccessInput;
  }) => Promise<AtomCommandResult<SourceControlAppAccess, unknown>>,
  environmentId: EnvironmentId,
  remoteUrl: string,
): Promise<void> {
  const target = appSignInTargetForRemote(remoteUrl);
  if (target === null) return;
  const result = await check({ environmentId, input: target.input });
  if (result._tag !== "Success" || result.value.status !== "not-covered") return;
  const owner = target.input.repository.split("/")[0] ?? target.input.repository;
  Alert.alert(
    t("Give {app} access to {owner}", { app: target.appSignIn.appName, owner }),
    t(
      "It isn't installed there, so GitHub requests for {repository} use your own login and its lower rate limit.",
      { repository: target.input.repository },
    ),
    [
      { text: t("Not now"), style: "cancel" },
      {
        text: t("Install"),
        onPress: () => void Linking.openURL(target.appSignIn.installUrl).catch(() => undefined),
      },
    ],
  );
}
