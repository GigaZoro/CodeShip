import type { EnvironmentId, ProviderInstanceId, ProviderMcpServerName } from "@t3tools/contracts";
import { mcpRedirect } from "@t3tools/shared/mcpAuthCallback";
import { CircleCheckIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { readLocalApi } from "../../localApi";
import { runsOnAnotherComputer } from "../../state/loopbackEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { failureMessage } from "../extensions/commandFailure";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { msg, t } from "~/i18n";

export const FAILURE_FALLBACK = msg("The provider could not finish the change.");

function openInBrowser(url: string) {
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch(() =>
      toastManager.add({
        type: "error",
        title: t("Could not open the sign-in page"),
        description: t("Copy the link from this dialog and open it in your browser."),
      }),
    );
}

/**
 * Signs one MCP server in for one provider account. Mounted only while open: the server keeps the
 * sign-in alive as long as this subscribes.
 *
 * `embedded` leaves out the Cancel, Close and Done buttons, for a host that has its own controls
 * (the guided sign-in walks several of these).
 */
export function McpSignInFlow(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly serverName: ProviderMcpServerName;
  /** The provider account's name, for the messages. */
  readonly providerName: string;
  readonly embedded?: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, instanceId, serverName, providerName, embedded = false } = props;
  const id = useId();
  const signIn = useEnvironmentQuery(
    serverEnvironment.providerMcpSignIn({
      environmentId,
      input: { instanceId, name: serverName },
    }),
  );
  const completeSignIn = useAtomCommand(serverEnvironment.completeProviderMcpSignIn, {
    reportFailure: false,
  });
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const state = signIn.data;

  const complete = async (flowId: string, address: string) => {
    setSubmitting(true);
    setCallbackError(null);
    const result = await completeSignIn({
      environmentId,
      input: { instanceId, flowId, callbackUrl: address },
    });
    setSubmitting(false);
    if (result._tag !== "Success") setCallbackError(failureMessage(result, t(FAILURE_FALLBACK)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!state || !callbackUrl.trim()) {
      setCallbackError(t("Paste the address from the browser's address bar."));
      return;
    }
    void complete(state.flowId, callbackUrl.trim());
  };

  // The browser returns to a loopback address on this computer. For a provider on another
  // computer, only the desktop app can catch it there; the paste field stays as the fallback.
  const receiving = useRef<string | null>(null);
  const openSignInPage = async (authorizationUrl: string, flowId: string) => {
    const desktop = window.desktopBridge;
    if (
      !desktop ||
      !mcpRedirect(authorizationUrl) ||
      !runsOnAnotherComputer(environmentId) ||
      receiving.current === authorizationUrl
    ) {
      openInBrowser(authorizationUrl);
      return;
    }
    receiving.current = authorizationUrl;
    setCallbackError(null);
    let address: string;
    try {
      address = await desktop.receiveMcpAuthCallback(authorizationUrl);
    } catch {
      if (receiving.current === authorizationUrl) {
        receiving.current = null;
        setCallbackError(
          t(
            "Could not finish sign-in on this computer. After you approve, paste the address from the browser's address bar below.",
          ),
        );
      }
      return;
    }
    if (receiving.current !== authorizationUrl) return;
    receiving.current = null;
    await complete(flowId, address);
  };
  const pendingUrl = state?.authorizationUrl;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the desktop callback listener when the authorization URL changes or the dialog unmounts
  useEffect(() => {
    if (!pendingUrl) return;
    return () => {
      if (receiving.current !== pendingUrl) return;
      receiving.current = null;
      void window.desktopBridge?.cancelMcpAuthCallback(pendingUrl).catch(() => undefined);
    };
  }, [pendingUrl]);

  if (signIn.error !== null) {
    return (
      <>
        <DialogPanel>
          <Alert variant="error">
            <AlertDescription>{signIn.error}</AlertDescription>
          </Alert>
        </DialogPanel>
        {embedded ? null : (
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              {t("Close")}
            </Button>
          </DialogFooter>
        )}
      </>
    );
  }
  if (state?.phase === "succeeded") {
    return (
      <>
        <DialogPanel>
          <p className="inline-flex items-center gap-2 text-sm" role="status">
            <CircleCheckIcon className="size-4 text-success-foreground" aria-hidden />
            {t("Signed in. New {provider} sessions can use its tools.", {
              provider: providerName,
            })}
          </p>
        </DialogPanel>
        {embedded ? null : (
          <DialogFooter>
            <Button onClick={props.onClose}>{t("Done")}</Button>
          </DialogFooter>
        )}
      </>
    );
  }
  if (!state) {
    return (
      <DialogPanel>
        <p className="inline-flex items-center gap-2 text-muted-foreground text-sm" role="status">
          <Spinner size="sm" tone="muted" />
          {t("Starting the sign-in…")}
        </p>
      </DialogPanel>
    );
  }
  const authorizationUrl = state.authorizationUrl;
  return (
    <form className="flex min-h-0 flex-col" onSubmit={submit}>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {authorizationUrl ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {t(
                  "Open the sign-in page and approve access. This dialog finishes on its own once {provider} gets the response.",
                  { provider: providerName },
                )}
              </p>
              <Button
                type="button"
                className="self-start"
                onClick={() => void openSignInPage(authorizationUrl, state.flowId)}
              >
                {t("Open sign-in page")}
                <ExternalLinkIcon />
              </Button>
            </div>
          ) : null}
          <p className="inline-flex items-center gap-2 text-muted-foreground text-xs" role="status">
            <Spinner size="sm" tone="muted" />
            {t("Waiting for approval…")}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-callback`}>{t("Redirect address")}</Label>
            <Input
              id={`${id}-callback`}
              spellCheck={false}
              placeholder={"http://localhost:…/callback?code=…"}
              value={callbackUrl}
              disabled={submitting}
              aria-invalid={callbackError !== null}
              aria-describedby={`${id}-callback-hint`}
              onChange={(event) => {
                setCallbackUrl(event.currentTarget.value);
                setCallbackError(null);
              }}
            />
            <p id={`${id}-callback-hint`} className="text-muted-foreground text-xs">
              {t(
                "If the browser shows a connection error after you approve, paste the address from its address bar.",
              )}
            </p>
            {callbackError ? (
              <p role="alert" className="text-destructive-foreground text-xs">
                {callbackError}
              </p>
            ) : null}
          </div>
        </div>
      </DialogPanel>
      <DialogFooter variant={embedded ? "bare" : "default"}>
        {embedded ? null : (
          <Button type="button" variant="outline" disabled={submitting} onClick={props.onClose}>
            {t("Cancel")}
          </Button>
        )}
        <Button type="submit" variant="outline" disabled={submitting || !callbackUrl.trim()}>
          {submitting ? <Spinner /> : null}
          {t("Finish sign-in")}
        </Button>
      </DialogFooter>
    </form>
  );
}
