import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { t, msg } from "~/i18n";

export function AboutVersionTitle() {
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: {
      target: "version",
      unavailableMessage: msg("Clipboard API is unavailable while copying version."),
      failureMessage: msg("Failed to copy version to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not copy version"),
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{t("Version")}</span>
      <code className="text-2xs font-medium">
        <SharedTooltipTrigger
          render={
            <InlineButton
              tone="muted"
              aria-label={t("Copy version {version}", { version: APP_VERSION })}
              onClick={() => copyToClipboard(APP_VERSION, undefined)}
            >
              {APP_VERSION}
            </InlineButton>
          }
          label={<>{t("Copy version")}</>}
        />
      </code>
    </span>
  );
}
