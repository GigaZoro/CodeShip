import { t } from "~/i18n";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Shows that the thread is in plan mode and lets the user switch it back to the default mode. */
export function ComposerPlanModeChip(props: {
  readonly onLeave?: (() => Promise<void>) | undefined;
}) {
  const [leaving, setLeaving] = useState(false);
  const { onLeave } = props;
  const leave = (action: () => Promise<void>) => {
    setLeaving(true);
    void action().finally(() => setLeaving(false));
  };
  return (
    <div className="flex shrink-0 items-center gap-1" data-chat-composer-plan-mode="true">
      <Badge variant="info" size="control">
        {t("Plan mode")}
      </Badge>
      {onLeave ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={t("Leave plan mode")}
          disabled={leaving}
          onClick={() => leave(onLeave)}
        >
          {t("Leave")}
        </Button>
      ) : null}
    </div>
  );
}
