import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { resolveThreadTaskList } from "./threadTaskList";
import { msg, t } from "~/i18n";

const STEP_ICON = {
  completed: { Icon: CircleCheckIcon, className: "text-success-foreground", label: msg("Done") },
  running: { Icon: CircleDotIcon, className: "text-info-foreground", label: msg("In progress") },
  pending: { Icon: CircleIcon, className: "text-muted-foreground/70", label: msg("To do") },
} as const;

/** The agent's to-do list for its latest run, kept current as it works. Hidden without one. */
export function ThreadTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const structure = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const tasks = structure === null ? null : resolveThreadTaskList(structure.projection);
  const listRef = useRef<HTMLOListElement | null>(null);
  const runningStepId = tasks?.steps.find((step) => step.status === "running")?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the step in progress visible inside the list's own scroll area as the agent advances
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || runningStepId === null) return;
    const step = list.querySelector<HTMLElement>(`[data-task-step="${CSS.escape(runningStepId)}"]`);
    if (step === null) return;
    // Scrolls only the list, never the card or the page around it.
    if (step.offsetTop < list.scrollTop) list.scrollTop = step.offsetTop;
    else if (step.offsetTop + step.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = step.offsetTop + step.offsetHeight - list.clientHeight;
    }
  }, [runningStepId]);
  if (tasks === null) return null;
  return (
    <ThreadDetailsSection
      // It comes and goes with each run, so it scrolls rather than changing the card's density.
      data-thread-details-flexible
      headingId="thread-details-tasks-heading"
      title={t("Tasks")}
      actions={
        <span className="text-2xs tabular-nums text-muted-foreground">
          {t("{completed} of {total} done", {
            completed: tasks.completed,
            total: tasks.steps.length,
          })}
        </span>
      }
    >
      <ol
        ref={listRef}
        className="relative m-0 flex max-h-80 list-none flex-col gap-1 overflow-y-auto px-2.5 py-0.5"
      >
        {tasks.steps.map((step) => {
          const { Icon, className, label } = STEP_ICON[step.status];
          return (
            <li
              key={step.id}
              data-task-step={step.id}
              className="flex min-w-0 items-start gap-2.5 text-sm leading-5"
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
              <span className="sr-only">{t(label)}: </span>
              <span
                className={cn(
                  "min-w-0 flex-1 [overflow-wrap:anywhere]",
                  step.status === "completed"
                    ? "text-muted-foreground line-through decoration-muted-foreground/50"
                    : step.status === "running"
                      ? "font-medium text-foreground"
                      : "text-foreground/80",
                )}
              >
                {step.text}
              </span>
            </li>
          );
        })}
      </ol>
    </ThreadDetailsSection>
  );
}
