import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { Fragment, type ReactNode, useState } from "react";
import {
  groupScheduledTaskItems,
  scheduledTaskGroupAction,
  scheduledTaskGroupPausePlan,
  scheduledTaskLastDayStatsInput,
  scheduledTaskListItemCopies,
  scheduledTaskListItemGroupCopy,
  summarizeScheduledTaskGroup,
  type ScheduledTaskGroupHealth,
  type ScheduledTaskListItem,
} from "@t3tools/client-runtime/scheduled-task-groups";
import type { ScheduledTaskCopy } from "@t3tools/client-runtime/scheduled-task-sharing";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { t, tn, tx } from "~/i18n";
import { cn } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { supportsScheduledTaskGroups, useScheduledTaskStats } from "../../state/scheduledTaskStats";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ScheduledRelativeLabel } from "./ScheduledTasksSettings";

function itemKey(item: ScheduledTaskListItem): string {
  const { environmentId, task } = scheduledTaskListItemGroupCopy(item);
  return item.kind === "shared" ? task.id : `${environmentId}:${task.id}`;
}

/** Whether any listed task has a group, which is what switches the page to its grouped layout. */
export function hasScheduledTaskGroups(items: ReadonlyArray<ScheduledTaskListItem>): boolean {
  return items.some(
    (item) => (scheduledTaskListItemGroupCopy(item).task.group ?? "").trim() !== "",
  );
}

const COLLAPSED_GROUPS_KEY = "t3code:scheduled-tasks:collapsed-groups";
const COLLAPSED_GROUPS_SCHEMA = Schema.Array(Schema.String);
const NO_COLLAPSED_GROUPS: ReadonlyArray<string> = [];

/** Kept apart from labels, so no group name can collide with the tasks without one. */
const storedGroupKey = (key: string | null) => (key === null ? "none" : `group:${key}`);

const groupPausePermissionsAtom = environmentAtomList(
  "web-scheduled-task-group-pause-permissions",
  serverEnvironment.setScheduledTaskGroupPaused.permissionAtom,
);

function useScheduledTaskGroupPause() {
  const [busy, setBusy] = useState(false);
  const setPaused = useAtomCommand(serverEnvironment.setScheduledTaskGroupPaused, {
    label: "scheduled task group paused",
  });
  const failToast = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  const run = async (label: string, targets: ReadonlyArray<ScheduledTaskCopy>, paused: boolean) => {
    if (busy) return;
    const plan = scheduledTaskGroupPausePlan(targets, paused);
    if (plan.length === 0) return;
    const changedIds = new Set(plan.flatMap((entry) => entry.ids));
    const changed = targets.filter(({ task }) => changedIds.has(task.id));
    const shared = changed.filter(({ task }) => task.shared != null).length;
    // Only shared tasks reach beyond this machine, so a group of this machine's own tasks just acts.
    if (shared > 0) {
      const message = [
        paused
          ? tn(
              changed.length,
              'Pause {count} task in "{group}"?',
              'Pause {count} tasks in "{group}"?',
              {
                group: label,
              },
            )
          : tn(
              changed.length,
              'Resume {count} task in "{group}"?',
              'Resume {count} tasks in "{group}"?',
              { group: label },
            ),
        tn(
          shared,
          "{count} of them is shared, so it changes on every machine.",
          "{count} of them are shared, so they change on every machine.",
        ),
      ].join("\n");
      const confirmed =
        (await requestConfirmDialog(message)) ?? window.confirm(message.replace("\n", " "));
      if (!confirmed) return;
    }
    setBusy(true);
    const results = await Promise.all(
      plan.map(async ({ environmentId, ids }) => ({
        result: await setPaused({ environmentId, input: { ids, paused } }),
      })),
    );
    setBusy(false);
    for (const { result } of results) {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          failToast(
            paused ? t("Could not pause group") : t("Could not resume group"),
            String(squashAtomCommandFailure(result)),
          );
        }
        continue;
      }
      for (const refusal of result.value.refused) {
        const name = targets.find(({ task }) => task.id === refusal.id)?.task.title;
        failToast(
          name === undefined ? t("Could not resume task") : t("Could not resume {name}", { name }),
          refusal.message,
        );
      }
    }
  };
  return { busy, run };
}

/** Which groups the user folded on this device. */
function useCollapsedGroups() {
  const [stored, setStored] = useLocalStorage(
    COLLAPSED_GROUPS_KEY,
    NO_COLLAPSED_GROUPS,
    COLLAPSED_GROUPS_SCHEMA,
  );
  const collapsed = new Set(stored);
  const toggle = (key: string | null) => {
    const id = storedGroupKey(key);
    setStored((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };
  return { isCollapsed: (key: string | null) => collapsed.has(storedGroupKey(key)), toggle };
}

function GroupHealth({ health }: { readonly health: ScheduledTaskGroupHealth }) {
  return (
    <span className="whitespace-nowrap">
      {tx("24h: {runs} · {failed} · {limited}", {
        runs: tn(health.runs, "{count} run", "{count} runs"),
        failed: (
          <span className={health.failed > 0 ? "text-warning-foreground" : undefined}>
            {t("{count} failed", { count: health.failed })}
          </span>
        ),
        limited: (
          <span className={health.usageLimited > 0 ? "text-warning-foreground" : undefined}>
            {t("{count} limited", { count: health.usageLimited })}
          </span>
        ),
      })}
    </span>
  );
}

function ScheduledTaskGroupHeader({
  label,
  count,
  anyOn,
  nextRunAt,
  health,
  expanded,
  onToggle,
  action,
}: {
  /** Null for the tasks without a group. */
  readonly label: string | null;
  readonly count: number;
  readonly anyOn: boolean;
  readonly nextRunAt: string | null;
  readonly health: ScheduledTaskGroupHealth | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-muted/30 px-3 py-2 sm:px-4">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-48 flex-1 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground", !expanded && "-rotate-90")}
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {label ?? t("No group")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {tn(count, "{count} task", "{count} tasks")}
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {!anyOn ? (
          <span>{t("Paused")}</span>
        ) : nextRunAt !== null ? (
          <span>
            {tx("Next run {when}", { when: <ScheduledRelativeLabel value={nextRunAt} /> })}
          </span>
        ) : null}
        {health !== null ? <GroupHealth health={health} /> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Tasks under collapsible group headers, in label order, with the tasks without a group last.
 * Shared tasks come before each machine's own, in the order of `items`.
 */
export function ScheduledTaskGroupSections({
  items,
  renderItem,
}: {
  readonly items: ReadonlyArray<ScheduledTaskListItem>;
  readonly renderItem: (item: ScheduledTaskListItem) => ReactNode;
}) {
  const sections = groupScheduledTaskItems(
    items,
    (item) => scheduledTaskListItemGroupCopy(item).task.group,
  );
  const { environments } = useEnvironments();
  const nowMinute = useNowMinute();
  const { isCollapsed, toggle } = useCollapsedGroups();
  const pause = useScheduledTaskGroupPause();

  const itemEnvironmentIds = [
    ...new Set(
      items.flatMap((item) => scheduledTaskListItemCopies(item).map((copy) => copy.environmentId)),
    ),
  ];
  const statsEnvironmentIds = itemEnvironmentIds.filter((id) => {
    const environment = environments.find((entry) => entry.environmentId === id);
    return (
      environment?.connection.phase === "connected" && supportsScheduledTaskGroups(environment)
    );
  });
  const statsResults = useScheduledTaskStats(
    statsEnvironmentIds,
    scheduledTaskLastDayStatsInput(Date.parse(`${nowMinute}:00.000Z`)),
  );
  const stats = new Map(
    statsResults.flatMap(({ environmentId, stats: list }) =>
      (list ?? []).map((entry) => [`${environmentId}\n${entry.id}`, entry] as const),
    ),
  );
  const statsFor = (environmentId: EnvironmentId, taskId: ScheduledTaskId) =>
    stats.get(`${environmentId}\n${taskId}`);

  const permissions = useAtomValue(
    groupPausePermissionsAtom(environmentIdsKey(itemEnvironmentIds)),
  );
  const mayPause = (targets: ReadonlyArray<ScheduledTaskCopy>) =>
    targets.every(({ environmentId }) => permissions[itemEnvironmentIds.indexOf(environmentId)]);

  return (
    <>
      {sections.map((section) => {
        const targets = section.items.map(scheduledTaskListItemGroupCopy);
        const summary = summarizeScheduledTaskGroup(
          section.items.flatMap(scheduledTaskListItemCopies),
          statsFor,
        );
        const groupAction =
          section.key === null ? null : scheduledTaskGroupAction(targets.map(({ task }) => task));
        const label = section.label ?? t("No group");
        const expanded = !isCollapsed(section.key);
        return (
          <div key={section.key ?? "none"}>
            <ScheduledTaskGroupHeader
              label={section.label}
              count={summary.count}
              anyOn={section.items.some((item) =>
                scheduledTaskListItemCopies(item).some(({ task }) => task.enabled),
              )}
              nextRunAt={summary.nextRunAt}
              health={summary.health}
              expanded={expanded}
              onToggle={() => toggle(section.key)}
              action={
                groupAction === null ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pause.busy || !mayPause(targets)}
                    onClick={() => void pause.run(label, targets, groupAction === "pause")}
                  >
                    {groupAction === "pause" ? t("Pause group") : t("Resume group")}
                  </Button>
                )
              }
            />
            {expanded ? (
              <div className="divide-y divide-border/50 border-t border-border/50">
                {section.items.map((item) => (
                  <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
