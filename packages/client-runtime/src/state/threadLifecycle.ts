import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingThreadUpdate {
  /** Undefined applies the update to every thread, as a folder rename does. */
  readonly threadId: ThreadId | undefined;
  readonly apply: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  sequence?: number;
}

type SequencedCommand<Input, E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: Input },
  { readonly sequence: number },
  E
>;

/** `C & SequencedCommand` infers the input from the command and still returns it whole. */
type Wrappable<C, Input, E> = C & SequencedCommand<Input, E>;

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const pendingAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<PendingThreadUpdate>>([]).pipe(Atom.keepAlive),
  );
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(sourceSnapshotAtom(environmentId));
      const pending = get(pendingAtom(environmentId));
      if (snapshot === null || pending.length === 0) return snapshot;
      const live = pending.filter(
        (update) => update.sequence === undefined || update.sequence > snapshot.snapshotSequence,
      );
      if (live.length === 0) return snapshot;
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          live.reduce(
            (current, update) =>
              update.threadId === undefined || update.threadId === thread.id
                ? update.apply(current)
                : current,
            thread,
          ),
        ),
      };
    }),
  );

  // Until the durable snapshot catches up, an older pending update can still replace what shows.
  const pendingThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlySet<ThreadId> =>
        new Set(
          get(pendingAtom(environmentId)).flatMap((update) =>
            update.threadId === undefined
              ? (get(sourceSnapshotAtom(environmentId))?.threads.map((thread) => thread.id) ?? [])
              : [update.threadId],
          ),
        ),
    ),
  );

  /** Shows the update until the snapshot reaches the command's sequence; a failure drops it. */
  function track<Input, E, C extends SequencedCommand<Input, E>>(
    command: Wrappable<C, Input, E>,
    threadIdOf: (input: Input) => ThreadId | undefined,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
  ): C {
    return {
      ...command,
      run: (registry, target) =>
        Effect.suspend(() => {
          const now = DateTime.nowUnsafe();
          const pending = pendingAtom(target.environmentId);
          const source = sourceSnapshotAtom(target.environmentId);
          const update: PendingThreadUpdate = {
            threadId: threadIdOf(target.input),
            apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
          };
          const remove = () =>
            registry.update(pending, (current) => current.filter((item) => item !== update));
          // Stays applied after the reply until a snapshot at or past its sequence replaces it.
          const confirm = (sequence: number) => {
            update.sequence = sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= sequence) {
                remove();
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
          };
          registry.update(pending, (current) => [...current, update]);
          return command
            .run(registry, target)
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => (Exit.isSuccess(exit) ? confirm(exit.value.sequence) : remove())),
              ),
            );
        }),
    };
  }

  /** A command on one thread. */
  function wrap<
    Input extends { readonly threadId: ThreadId },
    E,
    C extends SequencedCommand<Input, E>,
  >(
    command: Wrappable<C, Input, E>,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
  ): C {
    return track(command, (input) => input.threadId, apply);
  }

  /** A command that may change any thread of the environment; `apply` leaves the others as they are. */
  function wrapEveryThread<Input, E, C extends SequencedCommand<Input, E>>(
    command: Wrappable<C, Input, E>,
    apply: (thread: OrchestrationV2ThreadShell, input: Input) => OrchestrationV2ThreadShell,
  ): C {
    return track(command, () => undefined, apply);
  }

  return { snapshotAtom, pendingThreadIdsAtom, wrap, wrapEveryThread };
}
