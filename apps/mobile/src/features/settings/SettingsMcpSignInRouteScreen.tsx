import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { msg, t } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const FAILURE_FALLBACK = msg("The provider could not finish the change.");

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly instanceId: string;
  /** The server's name in the provider's configuration. */
  readonly name: string;
  readonly serverLabel: string;
  readonly providerLabel: string;
}>;

const failureMessage = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : t(FAILURE_FALLBACK);
};

/**
 * Signs an MCP server in for one provider account: the browser approves access, and the pasted
 * address finishes it when the provider's redirect cannot reach this phone. The server keeps the
 * sign-in alive while this page is open, so leaving cancels it.
 */
export function SettingsMcpSignInRouteScreen({ route }: Props) {
  const { serverLabel, providerLabel, name } = route.params;
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const instanceId = ProviderInstanceId.make(route.params.instanceId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const signIn = useEnvironmentQuery(
    serverEnvironment.providerMcpSignIn({ environmentId, input: { instanceId, name } }),
  );
  const completeSignIn = useAtomCommand(serverEnvironment.completeProviderMcpSignIn, {
    reportFailure: false,
  });
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const state = signIn.data;

  const submit = async () => {
    const address = callbackUrl.trim();
    if (state === null || address === "") {
      setCallbackError(t("Paste the address from the browser's address bar."));
      return;
    }
    setSubmitting(true);
    setCallbackError(null);
    const result = await completeSignIn({
      environmentId,
      input: { instanceId, flowId: state.flowId, callbackUrl: address },
    });
    setSubmitting(false);
    setCallbackError(failureMessage(result));
  };

  const body = () => {
    if (signIn.error !== null) {
      return (
        <>
          <Text accessibilityRole="alert" className="px-2 text-danger-foreground">
            {signIn.error}
          </Text>
          <Button label={t("Close")} onPress={() => navigation.goBack()} />
        </>
      );
    }
    if (state?.phase === "succeeded") {
      return (
        <>
          <Text accessibilityRole="alert" className="px-2 text-base text-foreground">
            {t("Signed in. New {provider} sessions can use its tools.", {
              provider: providerLabel,
            })}
          </Text>
          <Button label={t("Done")} tone="primary" onPress={() => navigation.goBack()} />
        </>
      );
    }
    if (state === null) {
      return (
        <View className="flex-row items-center gap-2 px-2">
          <AppActivityIndicator colorClassName="accent-foreground-muted" />
          <Text className="text-foreground-muted">{t("Starting the sign-in…")}</Text>
        </View>
      );
    }
    const authorizationUrl = state.authorizationUrl;
    return (
      <>
        {authorizationUrl !== undefined ? (
          <View className="gap-3 px-2">
            <Text className="text-base text-foreground">
              {t(
                "Open the sign-in page and approve access. This page finishes on its own once {provider} gets the response.",
                { provider: providerLabel },
              )}
            </Text>
            <Button
              label={t("Open sign-in page")}
              icon="arrow.up.right"
              tone="primary"
              onPress={() => void Linking.openURL(authorizationUrl).catch(() => undefined)}
            />
          </View>
        ) : null}
        <View className="flex-row items-center gap-2 px-2">
          <AppActivityIndicator colorClassName="accent-foreground-muted" />
          <Text className="text-sm text-foreground-muted">{t("Waiting for approval…")}</Text>
        </View>
        <SettingsSection>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {t("Redirect address")}
            </Text>
            <AppTextInput
              accessibilityLabel={t("Redirect address")}
              value={callbackUrl}
              onChangeText={(value) => {
                setCallbackUrl(value);
                setCallbackError(null);
              }}
              placeholder={"http://localhost:…/callback?code=…"}
              editable={!submitting}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              returnKeyType="done"
              className="min-h-11 rounded-xl px-3 py-2 font-mono text-sm text-foreground"
            />
            <Text className="text-xs text-foreground-muted">
              {t(
                "If the browser shows a connection error after you approve, paste the address from its address bar.",
              )}
            </Text>
            {callbackError !== null ? (
              <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
                {callbackError}
              </Text>
            ) : null}
          </View>
        </SettingsSection>
        <Button
          label={t("Finish sign-in")}
          loading={submitting}
          disabled={callbackUrl.trim() === ""}
          onPress={() => void submit()}
        />
      </>
    );
  };

  return (
    <SettingsScreen title={t("Sign in to {server}", { server: serverLabel })}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          {t("{provider} keeps the sign-in and uses it in new sessions.", {
            provider: providerLabel,
          })}
        </Text>
        {body()}
      </ScrollView>
    </SettingsScreen>
  );
}
