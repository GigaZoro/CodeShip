import { Link } from "@tanstack/react-router";
import { FINDING_TEXT } from "@t3tools/client-runtime/monitoring-text";
import { WrenchIcon } from "lucide-react";

import type { MonitoringFixChat } from "../../state/monitoring";
import { Button, InlineButton } from "../ui/button";
import { t } from "~/i18n";

/** Starts a chat that traces a weak point to its root cause and fixes it. */
export function MonitoringFixChatButton({ fixChat }: { readonly fixChat: MonitoringFixChat }) {
  if (!fixChat.available) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={fixChat.pending}
      // Every weak point has this button, so its name says which one it fixes.
      aria-label={
        fixChat.pending
          ? undefined
          : t("Fix root cause: {weakPoint}", { weakPoint: t(FINDING_TEXT[fixChat.code].title) })
      }
      onClick={fixChat.start}
    >
      <WrenchIcon aria-hidden />
      {fixChat.pending ? t("Starting chat…") : t("Fix root cause")}
    </Button>
  );
}

/** Why the last start failed, or a link to the chat if opening it fails. */
export function MonitoringFixChatStatus({ fixChat }: { readonly fixChat: MonitoringFixChat }) {
  return (
    <>
      {fixChat.failure === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {fixChat.failure}
        </p>
      )}
      {fixChat.started === null ? null : (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          {t("A chat is fixing this weak point.")}
          <InlineButton
            tone="muted"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: fixChat.started.environmentId,
                  threadId: fixChat.started.threadId,
                }}
              />
            }
          >
            {t("Open that chat")}
          </InlineButton>
        </p>
      )}
    </>
  );
}
