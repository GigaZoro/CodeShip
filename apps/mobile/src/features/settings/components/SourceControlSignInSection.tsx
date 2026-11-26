import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { t } from "../../../lib/i18n";
import type { SourceControlSignInPrompt } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import * as Cause from "effect/Cause";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";

import * as Dialog from "../../../components/ui/Dialog";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? (errorDisplayMessage(error) ?? error.message) : String(error);
};

const openUrl = (url: string) => void tryOpenExternalUrl(url, "provider-auth");

/** Signs an environment in through a forge's own app, such as T3 Code for GitHub. */
export function AppSignInRow(props: {
  readonly environment: SettingsTarget;
  readonly label: string;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly disabled: boolean;
}) {
  const { environment, definition, appSignIn } = props;
  const environmentId = environment.environmentId;
  const host = appSignIn.hosts[0] ?? "";
  const { signIns } = readHostCredentialSettings(
    environment.serverConfig.settings,
    definition.kind,
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  // The attempt a pending `wait` belongs to; a cancel or a newer attempt makes its outcome stale.
  const attempt = useRef<SourceControlSignInPrompt | null>(null);
  const input = { provider: definition.kind, host };
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${appSignIn.appName}`,
  });
  const [pending, setPending] = useState<SourceControlSignInPrompt | "starting" | null>(null);

  const showCode = (prompt: SourceControlSignInPrompt) => {
    void Clipboard.setStringAsync(prompt.userCode).catch(() => undefined);
    Dialog.alert(
      prompt.userCode,
      t(
        "Enter this code on {host}, then approve {app}. It is copied. The server finishes signing in even if you leave the app.",
        { host: "GitHub", app: appSignIn.appName },
      ),
      [
        {
          text: t("Cancel"),
          style: "cancel",
          onPress: () => {
            attempt.current = null;
            setPending(null);
            void cancel({ environmentId, input });
          },
        },
        {
          text: t("Open {host}", { host: "GitHub" }),
          onPress: () => openUrl(prompt.verificationUri),
        },
      ],
    );
  };

  const signIn = async () => {
    setPending("starting");
    const started = await start({ environmentId, input });
    if (started._tag !== "Success") {
      setPending(null);
      Dialog.alert(t("Could not start the sign-in"), failureMessage(started.cause));
      return;
    }
    const prompt = started.value;
    attempt.current = prompt;
    setPending(prompt);
    showCode(prompt);
    const finished = await wait({ environmentId, input });
    if (attempt.current !== prompt) return;
    attempt.current = null;
    setPending(null);
    if (finished._tag !== "Success") {
      Dialog.alert(t("Sign-in did not finish"), failureMessage(finished.cause));
    }
  };

  const signOut = () =>
    void updateSettings({
      environmentId,
      // Send the whole map; other hosts' redaction markers preserve their sessions.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { signIns: { ...signIns, [host]: "" } } },
        },
      },
    });

  const onPress = () => {
    if (signedIn) {
      Dialog.alert(
        appSignIn.appName,
        t(
          "Signed in. {host} requests use the app's higher rate limit, in repositories where the app is installed.",
          { host: "GitHub" },
        ),
        [
          { text: t("Install on an organization"), onPress: () => openUrl(appSignIn.installUrl) },
          { text: t("Sign out"), style: "destructive", onPress: signOut },
          { text: t("Cancel"), style: "cancel" },
        ],
      );
    } else if (pending !== null && pending !== "starting") {
      showCode(pending);
    } else if (pending === null) {
      void signIn();
    }
  };

  return (
    <SettingsRow
      icon="person.crop.circle"
      label={props.label}
      value={
        signedIn
          ? t("Signed in")
          : pending === "starting"
            ? t("Starting…")
            : pending !== null
              ? t("Enter {code}", { code: pending.userCode })
              : t("Sign in")
      }
      disabled={props.disabled}
      onPress={onPress}
    />
  );
}
