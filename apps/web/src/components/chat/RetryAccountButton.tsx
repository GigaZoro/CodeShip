import { useState } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { t } from "~/i18n";

/** Ends an account's usage hold so its next turn tries it again. */
export function RetryAccountButton({
  onRetry,
  variant = "ghost",
  resumes = false,
}: {
  readonly onRetry: () => Promise<void>;
  readonly variant?: "ghost" | "outline";
  /** The chat is set to resume, so the server continues it once the account has room. */
  readonly resumes?: boolean;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      variant={variant}
      disabled={pending}
      onClick={() => {
        setPending(true);
        onRetry()
          .then(() =>
            toastManager.add({
              type: "success",
              title: t("Account released"),
              description: resumes
                ? t("The chat continues on it within a minute.")
                : t("Send a message to try the account again."),
            }),
          )
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: t("Could not release the account"),
              description: cause instanceof Error ? cause.message : t("An error occurred."),
            }),
          )
          .finally(() => setPending(false));
      }}
    >
      {pending ? t("Saving...") : t("Try again")}
    </Button>
  );
}
