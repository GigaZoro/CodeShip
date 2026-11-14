import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
      run: async (registry, target) => {
        const now = DateTime.nowUnsafe();
        const pending = pendingAtom(target.environmentId);
        const source = sourceSnapshotAtom(target.environmentId);
        const update: PendingThreadUpdate = {
          threadId: threadIdOf(target.input),
          apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
        };
        const remove = () =>
          registry.update(pending, (current) => current.filter((item) => item !== update));
        registry.update(pending, (current) => [...current, update]);
        let confirmed = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            update.sequence = result.value.sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= result.value.sequence) {
                remove();
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
            confirmed = true;
          }
          return result;
        } finally {
          if (!confirmed) remove();
        }
      },
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

  return { snapshotAtom, wrap, wrapEveryThread };
}
