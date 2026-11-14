// @effect-diagnostics globalDate:off globalTimers:off - Plain executor for React and native clients, outside an Effect runtime.

import {
  compareScheduledTaskSharedRevisions,
  defaultScheduledTaskMachineOrder,
  scheduledTaskSharedProjectKey,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskApplySharedInput,
  type ScheduledTaskId,
  type ScheduledTaskListResult,
  type ScheduledTaskProjectMachineOrder,
  type ScheduledTaskRunRecord,
  type ScheduledTaskSharedCopy,
  type ScheduledTaskSharedDeletion,
  type ScheduledTaskSharedProject,
  type ScheduledTaskSharedRevision,
  type ScheduledTaskSharedRunOn,
} from "@t3tools/contracts";

const SHARED_SYNC_RETRY_AFTER_MS = 5 * 60_000;

export interface SharedScheduledTaskSnapshot {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly sharedDeletions: ReadonlyArray<ScheduledTaskSharedDeletion>;
  readonly projectMachineOrders?: ReadonlyArray<ScheduledTaskProjectMachineOrder>;
  readonly peerLinks?: {
    readonly enabled: boolean;
    readonly links: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly expiresAt: string;
    }>;
  };
}

export function sharedScheduledTaskSnapshot(
  environmentId: EnvironmentId,
  list: ScheduledTaskListResult,
): SharedScheduledTaskSnapshot {
  return {
    environmentId,
    tasks: list.tasks,
    sharedDeletions: list.sharedDeletions ?? [],
    projectMachineOrders: list.projectMachineOrders ?? [],
    ...(list.peerLinks ? { peerLinks: list.peerLinks } : {}),
  };
}

/**
 * The project a shared task refers to on every machine. Null while the project's repository
 * identity has not loaded: the server resolves it on save, so no stored order is read for it.
 */
export function sharedProjectReference(input: {
  readonly editedShared: ScheduledTask["shared"] | undefined;
  readonly editedProjectId: string | undefined;
  readonly project:
    | {
        readonly id: string;
        readonly title: string;
        readonly isScratch?: boolean | undefined;
        readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
      }
    | undefined;
}): ScheduledTaskSharedProject | null {
  const { editedShared, editedProjectId, project } = input;
  if (editedShared && project !== undefined && editedProjectId === project.id) {
    return editedShared.project;
  }
  if (project?.isScratch) return { type: "none" };
  const canonicalKey = project?.repositoryIdentity?.canonicalKey;
  return project && canonicalKey
    ? { type: "repository", canonicalKey, title: project.title }
    : null;
}

export interface SharedScheduledTaskOp {
  readonly environmentId: EnvironmentId;
  /** The task id, or `order:<projectKey>` for a project machine order. */
  readonly subject: string;
  readonly input: ScheduledTaskApplySharedInput;
  readonly key: string;
}

export type SharedScheduledTaskApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

function sharedCopyOf(task: ScheduledTask): ScheduledTaskSharedCopy | null {
  if (!task.shared) return null;
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    schedule: task.schedule,
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: task.modelSelection,
    followsDefaultModel: task.followsDefaultModel === true,
    // Sent whenever the source lists them: a copy without one makes the receiver keep its own.
    ...(task.catchUpMissedRun === undefined ? {} : { catchUpMissedRun: task.catchUpMissedRun }),
    ...(task.runCondition === undefined ? {} : { runCondition: task.runCondition }),
    ...(task.delegateProviders === undefined ? {} : { delegateProviders: task.delegateProviders }),
    ...(task.maxLiveRuns === undefined ? {} : { maxLiveRuns: task.maxLiveRuns }),
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    createdBy: task.createdBy,
    creationSource: task.creationSource,
    createdAt: task.createdAt,
    shared: task.shared,
    // Absent from a server without prompt files, so the receiving machine keeps its own.
    ...(task.promptFile === undefined ? {} : { promptFile: task.promptFile?.path ?? null }),
    // Omitted for a server without groups, so the receiving machine keeps its own.
    ...(task.group === undefined
      ? {}
      : { group: task.group, pausedWithGroup: task.pausedWithGroup === true }),
    ...(task.changedBy === undefined ? {} : { changedBy: task.changedBy }),
  };
}

type Candidate =
  | { readonly kind: "copy"; readonly copy: ScheduledTaskSharedCopy }
  | { readonly kind: "deletion"; readonly deletion: ScheduledTaskSharedDeletion };

function candidateRevision(candidate: Candidate): ScheduledTaskSharedRevision {
  return candidate.kind === "copy" ? candidate.copy.shared.revision : candidate.deletion.revision;
}

function newest(
  revisions: ReadonlyArray<ScheduledTaskSharedRevision>,
): ScheduledTaskSharedRevision | null {
  let best: ScheduledTaskSharedRevision | null = null;
  for (const revision of revisions) {
    if (best === null || compareScheduledTaskSharedRevisions(revision, best) > 0) best = revision;
  }
  return best;
}

export function planSharedScheduledTaskSync(
  snapshots: ReadonlyArray<SharedScheduledTaskSnapshot>,
): ReadonlyArray<SharedScheduledTaskOp> {
  if (snapshots.length < 2) return [];

  const winners = new Map<ScheduledTaskId, Candidate>();
  const consider = (id: ScheduledTaskId, candidate: Candidate) => {
    const current = winners.get(id);
    if (current === undefined) {
      winners.set(id, candidate);
      return;
    }
    const order = compareScheduledTaskSharedRevisions(
      candidateRevision(candidate),
      candidateRevision(current),
    );
    if (order > 0 || (order === 0 && candidate.kind === "deletion")) winners.set(id, candidate);
  };
  for (const snapshot of snapshots) {
    for (const task of snapshot.tasks) {
      const copy = sharedCopyOf(task);
      if (copy) consider(task.id, { kind: "copy", copy });
    }
    for (const deletion of snapshot.sharedDeletions) {
      consider(deletion.id, { kind: "deletion", deletion });
    }
  }

  const ops: SharedScheduledTaskOp[] = [];
  for (const [taskId, winner] of winners) {
    const winnerRevision = candidateRevision(winner);
    for (const snapshot of snapshots) {
      const local = snapshot.tasks.find((task) => task.id === taskId);
      if (local && !local.shared) continue;
      const localRevision = newest([
        ...(local?.shared ? [local.shared.revision] : []),
        ...snapshot.sharedDeletions.filter((entry) => entry.id === taskId).map((e) => e.revision),
      ]);
      const behind =
        localRevision === null ||
        compareScheduledTaskSharedRevisions(localRevision, winnerRevision) < 0;
      let input: ScheduledTaskApplySharedInput | null = null;
      if (winner.kind === "deletion") {
        if (behind) input = { type: "delete", deletion: winner.deletion };
      } else {
        const excluded = winner.copy.shared.excludedEnvironmentIds.includes(snapshot.environmentId);
        if (excluded ? local !== undefined : behind) input = { type: "upsert", task: winner.copy };
      }
      if (input === null) continue;
      ops.push({
        environmentId: snapshot.environmentId,
        subject: taskId,
        input,
        key: `${snapshot.environmentId}:${taskId}:${winnerRevision.at}:${winnerRevision.environmentId}`,
      });
    }
  }
  planProjectMachineOrders(snapshots, ops);
  return ops;
}

export function projectMachineOrderSubject(projectKey: string) {
  return `order:${projectKey}`;
}

function planProjectMachineOrders(
  snapshots: ReadonlyArray<SharedScheduledTaskSnapshot>,
  ops: SharedScheduledTaskOp[],
) {
  const winners = new Map<string, ScheduledTaskProjectMachineOrder>();
  for (const snapshot of snapshots) {
    for (const order of snapshot.projectMachineOrders ?? []) {
      const key = scheduledTaskSharedProjectKey(order.project);
      const current = winners.get(key);
      if (!current || compareScheduledTaskSharedRevisions(order.revision, current.revision) > 0) {
        winners.set(key, order);
      }
    }
  }
  for (const [projectKey, winner] of winners) {
    for (const snapshot of snapshots) {
      const own = (snapshot.projectMachineOrders ?? []).find(
        (order) => scheduledTaskSharedProjectKey(order.project) === projectKey,
      );
      if (own && compareScheduledTaskSharedRevisions(own.revision, winner.revision) >= 0) continue;
      const holdsTask = snapshot.tasks.some(
        (task) =>
          task.shared != null && scheduledTaskSharedProjectKey(task.shared.project) === projectKey,
      );
      if (!own && !holdsTask) continue;
      ops.push({
        environmentId: snapshot.environmentId,
        subject: projectMachineOrderSubject(projectKey),
        input: { type: "projectMachineOrder", order: winner },
        key: `${snapshot.environmentId}:order:${projectKey}:${winner.revision.at}:${winner.revision.environmentId}`,
      });
    }
  }
}

export interface SharedScheduledTaskSyncFailure {
  readonly environmentId: EnvironmentId;
  readonly subject: string;
  readonly key: string;
  readonly error: string;
  readonly at: number;
}

export interface SharedScheduledTaskSync {
  readonly update: (snapshots: ReadonlyArray<SharedScheduledTaskSnapshot>) => void;
  readonly failures: () => ReadonlyMap<string, SharedScheduledTaskSyncFailure>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

export function sharedSyncFailureKey(environmentId: EnvironmentId, subject: string) {
  return `${environmentId}:${subject}`;
}

export function createSharedScheduledTaskSync(options: {
  readonly apply: (op: SharedScheduledTaskOp) => Promise<SharedScheduledTaskApplyResult>;
  readonly retryAfterMs?: number;
}): SharedScheduledTaskSync {
  const retryAfterMs = options.retryAfterMs ?? SHARED_SYNC_RETRY_AFTER_MS;
  const inFlight = new Set<string>();
  // An op that succeeded yet is still planned (stale, local) must not repeat on every list update.
  const applied = new Map<string, number>();
  let failures: ReadonlyMap<string, SharedScheduledTaskSyncFailure> = new Map();
  const listeners = new Set<() => void>();
  let latest: ReadonlyArray<SharedScheduledTaskSnapshot> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const setFailures = (next: Map<string, SharedScheduledTaskSyncFailure>) => {
    failures = next;
    for (const listener of listeners) listener();
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (disposed || failures.size === 0) return;
    let due = Infinity;
    for (const failure of failures.values()) due = Math.min(due, failure.at + retryAfterMs);
    timer = setTimeout(
      () => {
        timer = null;
        run();
      },
      Math.max(0, due - Date.now()),
    );
  };

  const run = () => {
    if (disposed) return;
    const ops = planSharedScheduledTaskSync(latest);
    const planned = new Set(ops.map((op) => op.key));
    for (const key of applied.keys()) if (!planned.has(key)) applied.delete(key);
    const stale = [...failures].filter(([, failure]) => !planned.has(failure.key));
    if (stale.length > 0) {
      const kept = new Map(failures);
      for (const [key] of stale) kept.delete(key);
      setFailures(kept);
    }
    for (const op of ops) {
      const failureKey = sharedSyncFailureKey(op.environmentId, op.subject);
      const failed = failures.get(failureKey);
      if (inFlight.has(op.key)) continue;
      const appliedAt = applied.get(op.key);
      if (appliedAt !== undefined && Date.now() - appliedAt < retryAfterMs) continue;
      if (failed && failed.key === op.key && Date.now() - failed.at < retryAfterMs) continue;
      inFlight.add(op.key);
      void options.apply(op).then(
        (result) => settle(op, failureKey, result),
        (cause: unknown) =>
          settle(op, failureKey, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
      );
    }
    schedule();
  };

  const settle = (
    op: SharedScheduledTaskOp,
    failureKey: string,
    result: SharedScheduledTaskApplyResult,
  ) => {
    inFlight.delete(op.key);
    if (disposed) return;
    const next = new Map(failures);
    if (result.ok) {
      applied.set(op.key, Date.now());
      next.delete(failureKey);
    } else {
      next.set(failureKey, {
        environmentId: op.environmentId,
        subject: op.subject,
        key: op.key,
        error: result.error,
        at: Date.now(),
      });
    }
    setFailures(next);
    schedule();
  };

  return {
    update: (snapshots) => {
      latest = snapshots;
      run();
    },
    failures: () => failures,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}

/** The `shared` field of an upsert: omitted where the server lacks sharing or the task never was. */
export function sharedUpsertField(options: {
  readonly supported: boolean;
  readonly shared: boolean;
  readonly wasShared: boolean;
  readonly excludedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly runOn?: ScheduledTaskSharedRunOn;
  readonly machineOrder?: ReadonlyArray<EnvironmentId>;
}): {
  readonly shared?: {
    readonly excludedEnvironmentIds: ReadonlyArray<EnvironmentId>;
    readonly runOn?: ScheduledTaskSharedRunOn;
    readonly machineOrder?: ReadonlyArray<EnvironmentId>;
  } | null;
} {
  if (!options.supported) return {};
  if (options.shared) {
    return {
      shared: {
        excludedEnvironmentIds: options.excludedEnvironmentIds,
        ...(options.runOn ? { runOn: options.runOn } : {}),
        ...(options.runOn === "one" && options.machineOrder
          ? { machineOrder: options.machineOrder }
          : {}),
      },
    };
  }
  return options.wasShared ? { shared: null } : {};
}

/** The newest stored order for a project across the lists of every loaded environment. */
export function newestProjectMachineOrder(
  lists: ReadonlyArray<{
    readonly projectMachineOrders?: ReadonlyArray<ScheduledTaskProjectMachineOrder>;
  }>,
  project: ScheduledTaskSharedProject,
): ScheduledTaskProjectMachineOrder | null {
  const key = scheduledTaskSharedProjectKey(project);
  let best: ScheduledTaskProjectMachineOrder | null = null;
  for (const list of lists) {
    for (const order of list.projectMachineOrders ?? []) {
      if (scheduledTaskSharedProjectKey(order.project) !== key) continue;
      if (!best || compareScheduledTaskSharedRevisions(order.revision, best.revision) > 0) {
        best = order;
      }
    }
  }
  return best;
}

/** The order the servers run in: the stored order, then the machines it leaves out, as the servers place them. */
export function seedMachineOrder(
  stored: ScheduledTaskProjectMachineOrder | null,
  sharingEnvironmentIds: ReadonlyArray<EnvironmentId>,
  selectedEnvironmentId: EnvironmentId,
): ReadonlyArray<EnvironmentId> {
  const order = stored?.order ?? [];
  return [
    ...order,
    ...defaultScheduledTaskMachineOrder([selectedEnvironmentId, ...sharingEnvironmentIds]).filter(
      (id) => !order.includes(id),
    ),
  ];
}

/** Keeps exclusions of machines that are not listed (not connected right now). */
export function toggleSharedExclusion(
  excluded: ReadonlyArray<EnvironmentId>,
  environmentId: EnvironmentId,
  included: boolean,
): ReadonlyArray<EnvironmentId> {
  const without = excluded.filter((id) => id !== environmentId);
  return included ? without : [...without, environmentId];
}

/** The listed machines in the project's order; machines the order lacks come after it. */
export function visibleMachineOrder(
  order: ReadonlyArray<EnvironmentId>,
  listed: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  const ranked = order.filter((id) => listed.includes(id));
  return [...ranked, ...listed.filter((id) => !ranked.includes(id))];
}

export function moveMachine(
  order: ReadonlyArray<EnvironmentId>,
  environmentId: EnvironmentId,
  delta: -1 | 1,
): ReadonlyArray<EnvironmentId> {
  const from = order.indexOf(environmentId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, environmentId);
  return next;
}

/** Saves the edited list without losing the position of machines that are not connected now. */
export function mergeMachineOrder(
  visible: ReadonlyArray<EnvironmentId>,
  stored: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  return [...visible, ...stored.filter((id) => !visible.includes(id))];
}

export interface OneMachineLinkWarning {
  readonly kind: "checkerLinksOff" | "noLink" | "expired" | "targetLinksOff";
  /** The machine that has to ask. */
  readonly checker: EnvironmentId;
  /** The machine ahead of it in the order. */
  readonly target: EnvironmentId;
}

/** The machines that hold a one-machine task: the order minus exclusions, then machines in neither. */
export function effectiveOneMachineOrder(
  order: ReadonlyArray<EnvironmentId>,
  excluded: ReadonlyArray<EnvironmentId>,
  machineIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  const ranked = order.filter((id) => machineIds.includes(id) && !excluded.includes(id));
  return [...ranked, ...machineIds.filter((id) => !ranked.includes(id) && !excluded.includes(id))];
}

/** Links a fallback machine needs to check the machines ahead of it. Unloaded lists give no warning. */
export function oneMachineLinkWarnings(
  snapshots: ReadonlyArray<SharedScheduledTaskSnapshot>,
  order: ReadonlyArray<EnvironmentId>,
  now: number,
): ReadonlyArray<OneMachineLinkWarning> {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.environmentId, snapshot.peerLinks]));
  const warnings: OneMachineLinkWarning[] = [];
  for (const [rank, checker] of order.entries()) {
    const own = byId.get(checker);
    for (const target of order.slice(0, rank)) {
      if (own) {
        const link = own.links.find((entry) => entry.environmentId === target);
        if (!own.enabled) warnings.push({ kind: "checkerLinksOff", checker, target });
        else if (!link) warnings.push({ kind: "noLink", checker, target });
        else if (Date.parse(link.expiresAt) <= now) {
          warnings.push({ kind: "expired", checker, target });
        }
      }
      if (own && byId.get(target)?.enabled === false) {
        warnings.push({ kind: "targetLinksOff", checker, target });
      }
    }
  }
  return warnings;
}

export function describeOneMachineLinkWarning(
  warning: OneMachineLinkWarning,
  labelOf: (environmentId: EnvironmentId) => string,
): string {
  const checker = labelOf(warning.checker);
  const target = labelOf(warning.target);
  switch (warning.kind) {
    case "checkerLinksOff":
      return `Linked environments is off on ${checker}, so it can't check ${target}.`;
    case "noLink":
      return `${checker} has no link to ${target}. Link it in Settings → Machines & access on ${checker}.`;
    case "expired":
      return `${checker}'s link to ${target} has expired.`;
    case "targetLinksOff":
      return `Linked environments is off on ${target}, so ${checker} can't ask it.`;
  }
}

export interface ScheduledTaskCopy {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

export interface SharedScheduledTaskGroup {
  /** The copy with the newest revision: the definition every machine settles on. */
  readonly primary: ScheduledTaskCopy;
  /** Every loaded copy, in the order of the lists. */
  readonly copies: ReadonlyArray<ScheduledTaskCopy>;
}

/**
 * A shared task keeps its id on every machine, so it is listed once with each machine's copy.
 * Each machine keeps its other tasks, including one that only shares a shared task's id.
 */
export function groupSharedScheduledTasks(
  lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<ScheduledTask>;
  }>,
): {
  readonly shared: ReadonlyArray<SharedScheduledTaskGroup>;
  readonly local: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<ScheduledTask>;
  }>;
} {
  const groups = new Map<
    ScheduledTaskId,
    {
      primary: ScheduledTaskCopy;
      revision: ScheduledTaskSharedRevision;
      copies: ScheduledTaskCopy[];
    }
  >();
  const local = lists.map(({ environmentId, tasks }) => ({
    environmentId,
    tasks: tasks.filter((task) => {
      if (!task.shared) return true;
      const copy = { environmentId, task };
      const group = groups.get(task.id);
      if (group === undefined) {
        groups.set(task.id, { primary: copy, revision: task.shared.revision, copies: [copy] });
      } else {
        group.copies.push(copy);
        if (compareScheduledTaskSharedRevisions(task.shared.revision, group.revision) > 0) {
          group.primary = copy;
          group.revision = task.shared.revision;
        }
      }
      return false;
    }),
  }));
  return {
    shared: [...groups.values()].map(({ primary, copies }) => ({ primary, copies })),
    local,
  };
}

export interface ScheduledTaskRunOnMachine {
  readonly environmentId: EnvironmentId;
  readonly run: ScheduledTaskRunRecord;
}

/**
 * Every machine's runs of one shared task, newest first. A skip that names the machine that
 * settled the occurrence is left out when that machine's own record of it is listed.
 */
export function mergeScheduledTaskRuns(
  lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly runs: ReadonlyArray<ScheduledTaskRunRecord>;
  }>,
): ReadonlyArray<ScheduledTaskRunOnMachine> {
  const occurrenceKey = (environmentId: EnvironmentId, scheduledFor: string) =>
    `${environmentId}|${Date.parse(scheduledFor)}`;
  // A machine that ran the occurrence, whose check found no work for it, or whose own runs filled
  // its live-run limit settled it. A record naming another machine never stands in for one, so two
  // machines that each skipped for the other's runs both stay listed.
  const settled = new Set(
    lists.flatMap(({ environmentId, runs }) =>
      runs.flatMap((run) =>
        (run.outcome !== "skipped" ||
          run.skipReason === "no_work" ||
          run.skipReason === "live_run_limit") &&
        run.ranOn === null &&
        run.scheduledFor !== null
          ? [occurrenceKey(environmentId, run.scheduledFor)]
          : [],
      ),
    ),
  );
  return lists
    .flatMap(({ environmentId, runs }) =>
      runs.flatMap((run) =>
        run.ranOn !== null &&
        run.scheduledFor !== null &&
        settled.has(occurrenceKey(run.ranOn, run.scheduledFor))
          ? []
          : [{ environmentId, run }],
      ),
    )
    .sort((left, right) => Date.parse(right.run.startedAt) - Date.parse(left.run.startedAt));
}
