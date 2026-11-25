// @effect-diagnostics nodeBuiltinImport:off -- Process admission shares the host filesystem identity across service layers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Kept apart from withWorkspaceLease because that lease is non-reentrant and
// restores call Git work that leases the project root.
interface Reservation {
  readonly cwd: string;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "restore" || b.kind === "restore") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
const canonicalize = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalize(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    canonicalize(fileSystem, path, cwd).pipe(
      Effect.flatMap((canonical) => {
        const reservation: Reservation = { cwd: canonical, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = withReservation("restore");

/** Waits out overlapping restores; turn startups never wait on each other. */
export const withTurnStartReservation = withReservation("turn-start");

type StartPaths = ReadonlyArray<string | null>;
interface RemovalObserver {
  readonly root: string;
  readonly done: Deferred.Deferred<void>;
  hold: string | null;
  removing: boolean;
}
const starts = new Set<{ paths: StartPaths }>();
const observers = new Set<RemovalObserver>();
const canonicalPaths = Effect.fn("WorkspaceLease.canonicalPaths")(function* (paths: StartPaths) {
  const isWindows = yield* HostProcess.isWindows;
  return yield* Effect.promise(() =>
    Promise.all(
      [...new Set(paths)].map(async (value) => {
        if (!value || !NodePath.isAbsolute(value)) return null;
        try {
          const real = await NodeFSP.realpath(value);
          return isWindows
            ? NodePath.win32.toNamespacedPath(NodePath.win32.normalize(real)).toLowerCase()
            : real;
        } catch {
          return null;
        }
      }),
    ),
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => [null]),
  );
});
const overlapsRoot = (root: string, paths: StartPaths) =>
  paths.length === 0 ||
  paths.some((cwd) => cwd === null || cwd === root || cwd.startsWith(root + NodePath.sep));

export const admitWorkspaceProcess = Effect.fn("WorkspaceLease.admitProcess")(function* (
  paths: StartPaths,
) {
  const start = { paths };
  // Install cleanup before publishing admission; cancellation while waiting has nothing to undo.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      starts.delete(start);
    }),
  );
  while (observers.size) {
    const resolved = yield* canonicalPaths(paths);
    const overlapping = [...observers].filter((observer) => overlapsRoot(observer.root, resolved));
    const removing = overlapping.find((observer) => observer.removing);
    if (removing) {
      yield* Deferred.await(removing.done);
      continue;
    }
    for (const observer of overlapping)
      observer.hold = "a workspace process started during inspection";
    break;
  }
  // No yield between the final conflict check and registration.
  starts.add(start);
});

export const withWorkspaceProcessStart = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  paths: StartPaths,
) => Effect.scoped(admitWorkspaceProcess(paths).pipe(Effect.andThen(effect)));

export const observeWorkspaceStarts = Effect.fn("WorkspaceLease.observeStarts")(function* (
  canonicalRoot: string,
) {
  const [root] = yield* canonicalPaths([canonicalRoot]);
  if (!root) return Effect.succeed("cannot resolve checkout for process admission");
  const observer: RemovalObserver = {
    root,
    done: Deferred.makeUnsafe<void>(),
    removing: false,
    hold: null,
  };
  const existing = yield* Effect.acquireRelease(
    Effect.sync(() => {
      observers.add(observer);
      return [...starts];
    }),
    () =>
      Effect.sync(() => {
        observers.delete(observer);
        Deferred.doneUnsafe(observer.done, Effect.void);
      }),
  );
  for (const start of existing) {
    if (overlapsRoot(observer.root, yield* canonicalPaths(start.paths))) {
      observer.hold = "a workspace process is starting";
      break;
    }
  }
  return Effect.sync(() => {
    if (observer.hold === null) observer.removing = true;
    return observer.hold;
  });
});
