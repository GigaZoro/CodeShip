import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { t } from "~/i18n";

export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <SharedTooltipTrigger
        render={
          <InlineButton
            disabled={disabled}
            aria-label={t("Send {signal}", { signal: "SIGINT" })}
            tone="muted"
            onClick={() => onSignal("SIGINT")}
          >
            {"INT"}
          </InlineButton>
        }
        label={<>{t("Send {value}", { value: "SIGINT" })}</>}
      />
      <SharedTooltipTrigger
        render={
          <InlineButton
            disabled={disabled}
            aria-label={t("Send {signal}", { signal: "SIGKILL" })}
            tone="destructive"
            onClick={() => onSignal("SIGKILL")}
          >
            {"KILL"}
          </InlineButton>
        }
        label={<>{t("Send {value}", { value: "SIGKILL" })}</>}
      />
    </div>
  );
}
