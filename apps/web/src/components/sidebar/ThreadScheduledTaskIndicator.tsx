import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scheduledTasksForThread } from "@t3tools/client-runtime/scheduled-task-pins";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { CalendarClockIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { ScheduledTaskScheduleLine } from "../settings/ScheduledTasksSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Rows without a task keep the same empty array, so a task update re-renders only its own rows.
const threadScheduledTasksAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previous: ReadonlyArray<ScheduledTask> = [];
  return Atom.make((get) => {
    const tasks =
      AsyncResult.getOrElse(
        get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
        () => null,
      )?.tasks ?? [];
    const next = scheduledTasksForThread(tasks, threadId);
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web:thread-scheduled-tasks:${key}`));
});

/** Marks a thread a scheduled task keeps running in, and opens that task. */
export const ThreadScheduledTaskIndicator = memo(function ThreadScheduledTaskIndicator(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const tasks = useAtomValue(
    threadScheduledTasksAtom(JSON.stringify([props.environmentId, props.threadId])),
  );
  const first = tasks[0];
  if (first === undefined) return null;
  const openTask = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void navigate({
      to: "/scheduled-tasks",
      search: { environmentId: props.environmentId, taskId: first.id },
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open scheduled task ${first.title}`}
            data-testid={`sidebar-scheduled-indicator-${props.threadId}`}
            onClick={openTask}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {tasks.map((task) => (
          <div key={task.id}>
            <p className="font-medium">{task.title}</p>
            <p className="text-muted-foreground">
              <ScheduledTaskScheduleLine task={task} />
            </p>
          </div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
});
