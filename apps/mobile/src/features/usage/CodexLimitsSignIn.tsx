import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { LimitsSignInTarget } from "@t3tools/shared/usageLimits";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { t } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const LIMITS_METHOD_ID = "codex-limits";
const commandOptions = { reportFailure: false, reportDefect: false };

function ActionButton({
  label,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center active:opacity-60 disabled:opacity-50"
    >
      <Text className="text-sm font-t3-medium text-primary">{label}</Text>
    </Pressable>
  );
}

/**
 * Signs a ChatGPT-connected account in to Codex's own login on one environment, kept there only so
 * that environment reads the account's limits. The row leaves the list once its limits arrive.
 */
export function CodexLimitsSignIn({
  target,
  showEnvironment,
}: {
  readonly target: LimitsSignInTarget;
  readonly showEnvironment: boolean;
}) {
  const input = { instanceId: target.instanceId, purpose: "limits" as const };
  const [started, setStarted] = useState(false);
  const query = useEnvironmentQuery(
    started
      ? serverEnvironment.providerAuthState({ environmentId: target.environmentId, input })
      : null,
  );
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [callback, setCallback] = useState("");
  const openedUrl = useRef<string | null>(null);

  const auth = query.data;
  const interaction = auth?.interaction;
  const url =
    interaction?.type === "browser" ? interaction.url : (auth?.authorizationUrl ?? undefined);
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    setPending(true);
    setError(null);
    const succeeded = await command().then(
      (result) => {
        if (result._tag === "Success") return true;
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : t("Provider sign-in failed. Try again."),
          );
        }
        return false;
      },
      () => {
        setError(t("Provider sign-in failed. Try again."));
        return false;
      },
    );
    setPending(false);
    return succeeded;
  }

  function openBrowser(next: string) {
    openedUrl.current = next;
    Linking.openURL(next).catch(() =>
      setError(t("Could not open the sign-in page. Copy the link and open it in your browser.")),
    );
  }

  const waitingUrl = auth?.phase === "waiting" ? url : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the browser once the server hands over the sign-in URL
  useEffect(() => {
    if (!waitingUrl || openedUrl.current === waitingUrl) return;
    openedUrl.current = waitingUrl;
    Linking.openURL(waitingUrl).catch(() =>
      setError(t("Could not open the sign-in page. Copy the link and open it in your browser.")),
    );
  }, [waitingUrl]);

  async function begin() {
    openedUrl.current = null;
    setStarted(true);
    await run(() =>
      start({
        environmentId: target.environmentId,
        input: { ...input, methodId: LIMITS_METHOD_ID },
      }),
    );
  }

  const label = showEnvironment
    ? t("Read limits on {environment}", { environment: target.environmentLabel })
    : t("Read limits");
  const message = (auth?.phase === "failed" ? auth.message : null) ?? error ?? query.error;

  return (
    <View className="min-w-0 gap-1.5">
      {active ? (
        <>
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            {auth?.phase === "verifying"
              ? t("Checking your account…")
              : auth?.phase === "waiting"
                ? t("Finish signing in in your browser.")
                : t("Starting sign-in…")}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-4">
            {url ? (
              <ActionButton label={t("Open browser")} onPress={() => openBrowser(url)} />
            ) : null}
            <ActionButton
              label={t("Cancel")}
              disabled={pending || !auth?.flowId}
              onPress={() =>
                void run(() =>
                  cancel({
                    environmentId: target.environmentId,
                    input: { ...input, flowId: auth!.flowId! },
                  }),
                )
              }
            />
          </View>
        </>
      ) : (
        <ActionButton label={label} disabled={pending} onPress={() => void begin()} />
      )}
      {auth?.phase === "succeeded" ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {t("Signed in. Reading this account's limits…")}
        </Text>
      ) : null}
      {active && url && interaction?.type === "browser" && interaction.acceptsCallback ? (
        <View className="gap-1.5">
          <Text className="text-xs text-foreground-muted">
            {t("If the final localhost page does not load, paste its full URL here.")}
          </Text>
          <TextInput
            accessibilityLabel={t(
              "If the final localhost page does not load, paste its full URL here.",
            )}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!pending}
            maxLength={16_384}
            value={callback}
            onChangeText={setCallback}
          />
          <ActionButton
            label={t("Continue")}
            disabled={pending || !callback.trim() || !auth?.flowId}
            onPress={() =>
              void run(() =>
                complete({
                  environmentId: target.environmentId,
                  input: { ...input, flowId: auth.flowId!, callbackUrl: callback },
                }),
              ).then((sent) => {
                if (sent) setCallback("");
              })
            }
          />
        </View>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
