import {
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementOptions,
} from "@t3tools/client-runtime/scheduled-task-pins";
import type { ScheduledTask, ScheduledTaskPlacement } from "@t3tools/contracts";

import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";

export function ScheduledTaskPlacementRadioGroup(props: {
  readonly task: ScheduledTask;
  readonly onChange: (placement: ScheduledTaskPlacement) => void;
}) {
  return (
    <MenuRadioGroup
      value={resolveScheduledTaskPlacement(props.task)}
      onValueChange={(value) => props.onChange(value as ScheduledTaskPlacement)}
    >
      {scheduledTaskPlacementOptions().map((option) => (
        <MenuRadioItem key={option.value} value={option.value}>
          {option.label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
