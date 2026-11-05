import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Shows that the thread is in plan mode and lets the user switch it back to the default mode. */
export function ComposerPlanModeChip(props: { readonly onLeave: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1" data-chat-composer-plan-mode="true">
      <Badge variant="info" size="control">
        Plan mode
      </Badge>
      <Button type="button" size="xs" variant="ghost" onClick={props.onLeave}>
        Leave
      </Button>
    </div>
  );
}
