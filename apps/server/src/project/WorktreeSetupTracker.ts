import type {
  ThreadId,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
  WorktreeSetupStageId,
  WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import {
  WORKTREE_SETUP_DETAIL_MAX_LENGTH,
  WORKTREE_SETUP_ERROR_MAX_LENGTH,
  WORKTREE_SETUP_STAGE_ORDER,
  WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** A running worker holds the instance returned by begin. Its idle launch can also be recovered by receipt. */
export interface WorktreeSetupOwner {
  readonly threadId: ThreadId;
  readonly idleCreationSequence?: number;
}

export class WorktreeSetupTracker extends Context.Service<
  WorktreeSetupTracker,
  {
    readonly begin: (input: {
      readonly threadId: ThreadId;
      readonly idleCreationSequence?: number;
      readonly branch: string | null;
      readonly baseRef: string | null;
      readonly stages: ReadonlyArray<WorktreeSetupStageId>;
      readonly fiber: Fiber.Fiber<unknown, unknown> | null;
    }) => Effect.Effect<WorktreeSetupOwner>;
    readonly update: (
      owner: WorktreeSetupOwner | undefined,
      mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
    ) => Effect.Effect<void>;
    readonly stage: (
      owner: WorktreeSetupOwner | undefined,
      stageId: WorktreeSetupStageId,
      patch: Partial<Omit<WorktreeSetupStage, "id">>,
    ) => Effect.Effect<void>;
    readonly stageStatus: (
      owner: WorktreeSetupOwner | undefined,
      stageId: WorktreeSetupStageId,
      status: WorktreeSetupStageStatus,
      detail?: string | null,
    ) => Effect.Effect<void>;
    readonly appendTail: (
      owner: WorktreeSetupOwner | undefined,
      stageId: WorktreeSetupStageId,
      line: string,
    ) => Effect.Effect<void>;
    readonly finish: (
      owner: WorktreeSetupOwner | undefined,
      phase: "done" | "failed" | "cancelled",
      error?: string | null,
    ) => Effect.Effect<WorktreeSetupSnapshot | null>;
    /** Call just before dispatch so late cancellation cannot roll back a started agent's thread. */
    readonly markUncancellable: (owner: WorktreeSetupOwner | undefined) => Effect.Effect<void>;
    readonly reconcileIdle: (
      threadId: ThreadId,
      creationSequence: number,
      phase: "done" | "failed",
      error?: string,
    ) => Effect.Effect<void>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly get: (threadId: ThreadId) => Effect.Effect<WorktreeSetupSnapshot | null>;
    readonly stream: (threadId: ThreadId) => Stream.Stream<WorktreeSetupSnapshot | null>;
  }
>()("t3/project/WorktreeSetupTracker") {}

const TAIL_LINE_LIMIT = 4;

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}\u2026`;
}

const clampDetail = (detail: string | null): string | null =>
  detail === null ? null : clampText(detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH);
const FINISHED_RETENTION = "30 seconds";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedSetup {
  readonly owner: WorktreeSetupOwner;
  readonly snapshot: WorktreeSetupSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
}

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return {
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  };
}

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const setups = new Map<ThreadId, TrackedSetup>();
  const changes = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly snapshot: WorktreeSetupSnapshot | null;
  }>();
  const modify = (
    owner: WorktreeSetupOwner | undefined,
    mutate: (tracked: TrackedSetup) => TrackedSetup,
  ): Effect.Effect<WorktreeSetupSnapshot | null> =>
    Effect.sync(() => {
      if (owner === undefined) return null;
      const existing = setups.get(owner.threadId);
      if (existing?.owner !== owner || existing.snapshot.phase !== "running") return null;
      const changed = mutate(existing);
      const snapshot = { ...changed.snapshot, sequence: existing.snapshot.sequence + 1 };
      setups.set(owner.threadId, { ...changed, snapshot });
      PubSub.publishUnsafe(changes, { threadId: owner.threadId, snapshot });
      return snapshot;
    });

  // A timer may outlive its setup if a new preparation starts during retention.
  const expire = (owner: WorktreeSetupOwner) =>
    Effect.sync(() => {
      if (setups.get(owner.threadId)?.owner !== owner) return;
      setups.delete(owner.threadId);
      PubSub.publishUnsafe(changes, { threadId: owner.threadId, snapshot: null });
    });

  const begin: WorktreeSetupTracker["Service"]["begin"] = Effect.fn("WorktreeSetupTracker.begin")(
    function* (input) {
      const owner: WorktreeSetupOwner = {
        threadId: input.threadId,
        ...(input.idleCreationSequence === undefined
          ? {}
          : { idleCreationSequence: input.idleCreationSequence }),
      };
      const startedAt = yield* nowIso;
      const ordered = WORKTREE_SETUP_STAGE_ORDER.filter((id) => input.stages.includes(id));
      const snapshot: WorktreeSetupSnapshot = {
        threadId: input.threadId,
        phase: "running",
        startedAt,
        endedAt: null,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: null,
        setupScript: null,
        stages: ordered.map(emptyStage),
        error: null,
        sequence: (setups.get(input.threadId)?.snapshot.sequence ?? -1) + 1,
      };
      setups.set(input.threadId, { owner, snapshot, fiber: input.fiber });
      PubSub.publishUnsafe(changes, { threadId: input.threadId, snapshot });
      return owner;
    },
  );

  const update: WorktreeSetupTracker["Service"]["update"] = (owner, mutate) =>
    modify(owner, (tracked) => ({ ...tracked, snapshot: mutate(tracked.snapshot) })).pipe(
      Effect.asVoid,
    );

  const stage: WorktreeSetupTracker["Service"]["stage"] = (owner, stageId, patch) =>
    update(owner, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId
          ? {
              ...entry,
              ...patch,
              ...(patch.detail === undefined ? {} : { detail: clampDetail(patch.detail ?? null) }),
            }
          : entry,
      ),
    }));

  const stageStatus: WorktreeSetupTracker["Service"]["stageStatus"] = (
    owner,
    stageId,
    status,
    detail,
  ) =>
    nowIso.pipe(
      Effect.flatMap((at) =>
        update(owner, (snapshot) => ({
          ...snapshot,
          stages: snapshot.stages.map((entry) => {
            if (entry.id !== stageId) return entry;
            const startedAt = entry.startedAt ?? (status === "pending" ? null : at);
            const endedAt =
              status === "running" || status === "pending" ? null : (entry.endedAt ?? at);
            return {
              ...entry,
              status,
              startedAt,
              endedAt,
              ...(detail === undefined ? {} : { detail: clampDetail(detail ?? null) }),
            };
          }),
        })),
      ),
    );

  const appendTail: WorktreeSetupTracker["Service"]["appendTail"] = (owner, stageId, line) =>
    update(owner, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId
          ? {
              ...entry,
              tail: [...entry.tail, clampText(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)].slice(
                -TAIL_LINE_LIMIT,
              ),
            }
          : entry,
      ),
    }));

  const finish: WorktreeSetupTracker["Service"]["finish"] = Effect.fn(
    "WorktreeSetupTracker.finish",
  )(function* (owner, phase, error) {
    const endedAt = yield* nowIso;
    const snapshot = yield* modify(owner, (tracked) => ({
      ...tracked,
      fiber: null,
      snapshot: {
        ...tracked.snapshot,
        phase,
        endedAt,
        error:
          error === undefined || error === null
            ? null
            : clampText(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
        stages: tracked.snapshot.stages.map((entry) =>
          entry.status === "running"
            ? {
                ...entry,
                status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                endedAt,
              }
            : entry,
        ),
      },
    }));
    if (!snapshot || owner === undefined) return null;
    yield* expire(owner).pipe(Effect.delay(FINISHED_RETENTION), Effect.forkIn(scope));
    return snapshot;
  }, Effect.uninterruptible);

  const markUncancellable: WorktreeSetupTracker["Service"]["markUncancellable"] = (owner) =>
    Effect.sync(() => {
      if (owner === undefined) return;
      const current = setups.get(owner.threadId);
      if (current?.owner === owner && current.fiber !== null)
        setups.set(owner.threadId, { ...current, fiber: null });
    });

  const reconcileIdle: WorktreeSetupTracker["Service"]["reconcileIdle"] = (
    threadId,
    sequence,
    phase,
    error,
  ) =>
    Effect.suspend(() => {
      const owner = setups.get(threadId)?.owner;
      return owner?.idleCreationSequence === sequence
        ? finish(owner, phase, error).pipe(Effect.asVoid)
        : Effect.void;
    });

  const cancel: WorktreeSetupTracker["Service"]["cancel"] = Effect.fn(
    "WorktreeSetupTracker.cancel",
  )(function* (threadId) {
    const tracked = setups.get(threadId);
    if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) {
      return false;
    }
    yield* Fiber.interrupt(tracked.fiber);
    return true;
  });

  const get: WorktreeSetupTracker["Service"]["get"] = (threadId) =>
    Effect.sync(() => setups.get(threadId)?.snapshot ?? null);

  // One-slot sliding mailboxes bound slow WebSockets to the newest setup snapshot.
  const stream: WorktreeSetupTracker["Service"]["stream"] = (threadId) =>
    Stream.callback<WorktreeSetupSnapshot | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* get(threadId);
          // The initial snapshot already includes queued changes; drop them to avoid stale replay.
          let lastSequence = initial?.sequence ?? -1;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId !== threadId) return;
                if (change.snapshot !== null && change.snapshot.sequence <= lastSequence) return;
                lastSequence = change.snapshot?.sequence ?? -1;
                Queue.offerUnsafe(mailbox, change.snapshot);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return WorktreeSetupTracker.of({
    begin,
    update,
    stage,
    stageStatus,
    appendTail,
    finish,
    markUncancellable,
    reconcileIdle,
    cancel,
    get,
    stream,
  });
});

export const layer = Layer.effect(WorktreeSetupTracker, make);
