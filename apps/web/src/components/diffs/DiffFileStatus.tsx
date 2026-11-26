import { t } from "~/i18n";

import { InfoIcon, RotateCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function DiffFileStatus({
  error,
  truncated,
  retry,
}: {
  error?: boolean | undefined;
  truncated?: boolean | undefined;
  retry: () => void;
}) {
  if (!error && !truncated) return null;
  return (
    <SharedTooltipTrigger
      render={
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={error ? t("Retry loading diff") : t("Partial diff preview")}
          onClick={(event) => {
            event.stopPropagation();
            if (error) retry();
          }}
        />
      }
      label={
        error
          ? t("Retry loading diff")
          : t("This file is too large to show in full. Counts include all changes.")
      }
    >
      {error ? <RotateCwIcon className="size-3" /> : <InfoIcon className="size-3" />}
    </SharedTooltipTrigger>
  );
}
