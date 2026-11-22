import { t } from "~/i18n";
import { Button } from "../ui/button";

/** A removed focused button would leave focus on the page body, so it moves to the nearest landmark. */
function keepFocusOnRemoval(button: HTMLButtonElement | null) {
  if (!button) return;
  return () => {
    if (document.activeElement !== button) return;
    const heading = button.closest("section")?.querySelector<HTMLElement>("h2[tabindex]");
    (heading ?? button.closest<HTMLElement>("[data-workspace-area]"))?.focus();
  };
}

/**
 * Usage's Retry. A disabled button drops keyboard focus, so a pending retry only marks it
 * aria-disabled; when success removes it, focus goes to its section heading or the Usage region.
 */
export function UsageRetryButton({
  pending,
  onRetry,
}: {
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      ref={keepFocusOnRemoval}
      aria-disabled={pending}
      onClick={() => {
        if (!pending) onRetry();
      }}
    >
      {t("Retry")}
    </Button>
  );
}
