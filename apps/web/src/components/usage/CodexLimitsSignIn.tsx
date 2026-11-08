import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { LimitsSignInTarget } from "@t3tools/shared/usageLimits";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { t } from "~/i18n";

const LIMITS_METHOD_ID = "codex-limits";
const commandOptions = { reportFailure: false, reportDefect: false };

/** Uses the tab reserved during the click when there is one; browsers block a later open. */
async function openSignInPage(url: string, tab: Window | null) {
  try {
    if (tab) tab.location.href = url;
    else await ensureLocalApi().shell.openExternal(url);
    return true;
  } catch {
    tab?.close();
    return false;
  }
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
  const reservedTab = useRef<Window | null>(null);
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

  const openFailed = (opened: boolean) => {
    if (!opened)
      setError(t("Could not open the sign-in page. Copy the link and open it in your browser."));
  };

  const waitingUrl = auth?.phase === "waiting" ? url : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the browser once the server hands over the sign-in URL
  useEffect(() => {
    if (!waitingUrl || openedUrl.current === waitingUrl) return;
    openedUrl.current = waitingUrl;
    const tab = reservedTab.current;
    reservedTab.current = null;
    void openSignInPage(waitingUrl, tab).then((opened) => {
      if (!opened)
        setError(t("Could not open the sign-in page. Copy the link and open it in your browser."));
    });
  }, [waitingUrl]);

  async function begin() {
    if (!window.desktopBridge) {
      const tab = window.open("", "_blank");
      if (tab) tab.opener = null;
      reservedTab.current = tab;
    }
    openedUrl.current = null;
    setStarted(true);
    const begun = await run(() =>
      start({
        environmentId: target.environmentId,
        input: { ...input, methodId: LIMITS_METHOD_ID },
      }),
    );
    if (!begun) {
      reservedTab.current?.close();
      reservedTab.current = null;
    }
  }

  const label = showEnvironment
    ? t("Read limits on {environment}", { environment: target.environmentLabel })
    : t("Read limits");

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <span role="status" className="text-xs text-muted-foreground">
              {auth?.phase === "verifying"
                ? t("Checking your account…")
                : auth?.phase === "waiting"
                  ? t("Finish signing in in your browser.")
                  : t("Starting sign-in…")}
            </span>
            {url ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void openSignInPage(url, null).then(openFailed)}
              >
                {t("Open browser")}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={pending || !auth?.flowId}
              onClick={() =>
                void run(() =>
                  cancel({
                    environmentId: target.environmentId,
                    input: { ...input, flowId: auth!.flowId! },
                  }),
                )
              }
            >
              {t("Cancel")}
            </Button>
          </>
        ) : (
          <Button size="xs" variant="outline" disabled={pending} onClick={() => void begin()}>
            {label}
          </Button>
        )}
        {auth?.phase === "succeeded" ? (
          <span role="status" className="text-xs text-muted-foreground">
            {t("Signed in. Reading this account's limits…")}
          </span>
        ) : null}
      </div>
      {active && url && interaction?.type === "browser" && interaction.acceptsCallback ? (
        <form
          className="grid gap-1.5 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            if (!auth?.flowId || !callback.trim()) return;
            void run(() =>
              complete({
                environmentId: target.environmentId,
                input: { ...input, flowId: auth.flowId!, callbackUrl: callback },
              }),
            ).then((sent) => {
              if (sent) setCallback("");
            });
          }}
        >
          <label className="grid gap-1 text-muted-foreground">
            {t("If the final localhost page does not load, paste its full URL here.")}
            <Input
              size="sm"
              type="url"
              autoComplete="off"
              value={callback}
              disabled={pending}
              maxLength={16_384}
              onChange={(event) => setCallback(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="xs"
            variant="outline"
            className="w-fit"
            disabled={pending || !callback.trim()}
          >
            {t("Continue")}
          </Button>
        </form>
      ) : null}
      {((auth?.phase === "failed" ? auth.message : null) ?? error ?? query.error) ? (
        <p role="alert" className="text-xs text-destructive-foreground [overflow-wrap:anywhere]">
          {(auth?.phase === "failed" ? auth.message : null) ?? error ?? query.error}
        </p>
      ) : null}
    </div>
  );
}
