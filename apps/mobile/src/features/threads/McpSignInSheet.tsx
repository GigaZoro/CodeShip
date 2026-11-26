import { t } from "../../lib/i18n";
import type { EnvironmentId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";

import { useRef, useState } from "react";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export interface McpSignInTarget {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly server: string;
}

/**
 * Signs an agent's MCP server in from the notice that says it needs one. The
 * agent keeps the credential; the user approves in a browser, then pastes back
 * the address it lands on, which is often a localhost page on another machine.
 */
export function McpSignInSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly target: McpSignInTarget;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { server } = props.target;
  const start = useAtomCommand(threadEnvironment.mcpSignInStart, {
    label: "start MCP sign-in",
    reportFailure: false,
    reportDefect: false,
  });
  const complete = useAtomCommand(threadEnvironment.mcpSignInComplete, {
    label: "finish MCP sign-in",
    reportFailure: false,
    reportDefect: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A result that lands after the sheet closed must not open a browser or report anything.
  const closed = useRef(false);
  const close = () => {
    closed.current = true;
    props.onClose();
  };

  const failed = (result: AtomCommandResult<unknown, unknown> & { readonly _tag: "Failure" }) => {
    if (isAtomCommandInterrupted(result)) return;
    setError(
      errorDisplayMessage(squashAtomCommandFailure(result), t) ??
        t("The sign-in couldn't continue. Try again."),
    );
  };
  // The command marks the server signed in for the thread, which every notice about it shows.
  const signedIn = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    close();
  };
  const openSignInPage = async () => {
    setBusy(true);
    setError(null);
    let page = url;
    if (page === null) {
      const result = await start({ environmentId: props.environmentId, input: props.target });
      if (closed.current) return;
      if (result._tag === "Failure") {
        setBusy(false);
        failed(result);
        return;
      }
      if (result.value.authorizationUrl === null) {
        setBusy(false);
        signedIn();
        return;
      }
      page = result.value.authorizationUrl;
      setUrl(page);
    }
    setBusy(false);
    if (!(await tryOpenExternalUrl(page, "provider-auth"))) {
      setError(t("Could not open the sign-in page."));
    }
  };
  const finish = async () => {
    const pasted = callbackUrl.trim();
    if (pasted.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await complete({
      environmentId: props.environmentId,
      input: { ...props.target, callbackUrl: pasted },
    });
    if (closed.current) return;
    setBusy(false);
    if (result._tag === "Success") signedIn();
    else failed(result);
  };

  return (
    <Sheet title={t("Sign in to {server}", { server })} onClose={close}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {t(
            "Approve access in your browser. It then opens a page that may not load: copy that page's address and paste it here.",
          )}
        </Text>
        <Button
          label={t("Open sign-in page")}
          icon="globe"
          tone="secondary"
          disabled={busy}
          onPress={() => void openSignInPage()}
          fullWidth
        />
        {url !== null ? (
          <TextInput
            accessibilityLabel={t("Address of the page your browser opened")}
            // oxlint-disable-next-line t3code/no-untranslated-text -- a literal example callback URL
            placeholder="http://127.0.0.1:…/callback?code=…"
            value={callbackUrl}
            onChangeText={setCallbackUrl}
            editable={!busy}
            autoCorrect={false}
            autoCapitalize="none"
            keyboardType="url"
            spellCheck={false}
            returnKeyType="done"
            onSubmitEditing={() => void finish()}
          />
        ) : null}
        {error !== null ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="font-sans text-sm text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        {url !== null ? (
          <Button
            label={t("Finish sign-in")}
            tone="primary"
            loading={busy}
            disabled={busy || callbackUrl.trim().length === 0}
            onPress={() => void finish()}
            fullWidth
          />
        ) : null}
        <Button label={t("Cancel")} tone="secondary" onPress={close} fullWidth />
      </ScrollView>
    </Sheet>
  );
}
