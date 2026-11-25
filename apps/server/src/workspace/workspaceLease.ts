// @effect-diagnostics nodeBuiltinImport:off -- Process admission shares the host filesystem identity across service layers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export class WorkspaceLeasePathError extends Data.TaggedError("WorkspaceLeasePathError")<{
  readonly cwd: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not resolve workspace for exclusive access: ${this.cwd}`;
  }
}

const pathKey = (path: string, windows: boolean) =>
  windows ? NodePath.win32.toNamespacedPath(NodePath.win32.normalize(path)).toLowerCase() : path;

// Native realpath expands Windows 8.3 names and requires the entry to exist.
export const existingWorkspacePath = (target: string) =>
  Effect.tryPromise(() => NodeFSP.realpath(target));

export const resolveWorkspacePath = (cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      // A follow-up can arrive before Git recreates the checkout or any of its missing parents.
      const absolute = NodePath.resolve(cwd);
      let ancestor = absolute;
      for (;;) {
        try {
          return NodePath.join(
            await NodeFSP.realpath(ancestor),
            NodePath.relative(ancestor, absolute),
          );
        } catch (error) {
          const parent = NodePath.dirname(ancestor);
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT" ||
            parent === ancestor
          )
            throw error;
          // A dangling link is an existing path whose future target cannot be established.
          const entry = await NodeFSP.lstat(ancestor).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
            return null;
          });
          if (entry)
            return NodePath.join(
              await NodeFSP.realpath(ancestor),
              NodePath.relative(ancestor, absolute),
            );
          ancestor = parent;
        }
      }
    },
    catch: (cause) => new WorkspaceLeasePathError({ cwd, cause }),
  });

export const withWorkspaceLease = Effect.fn("WorkspaceLease.withWorkspaceLease")(function* <
  A,
  E,
  R,
>(cwd: string, effect: Effect.Effect<A, E, R>) {
  const key = pathKey(yield* resolveWorkspacePath(cwd), yield* HostProcess.isWindows);
  const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
  leases.set(key, lease);
  lease.users++;
  return yield* lease.semaphore.withPermit(effect).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        lease.users--;
        if (lease.users === 0) leases.delete(key);
      }),
    ),
  );
});

type StartPaths = ReadonlyArray<string | null>;
interface Release {
  readonly root: string;
  readonly done: Deferred.Deferred<void>;
  hold: string | null;
  removing: boolean;
}
const starts = new Set<{ paths: StartPaths }>();
const releases = new Set<Release>();
const canonicalPaths = Effect.fn("WorkspaceLease.canonicalPaths")(function* (paths: StartPaths) {
  const isWindows = yield* HostProcess.isWindows;
  return yield* Effect.promise(() =>
    Promise.all(
      [...new Set(paths)].map(async (value) => {
        if (!value || !NodePath.isAbsolute(value)) return null;
        try {
          const real = await NodeFSP.realpath(value);
          return pathKey(real, isWindows);
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
const conflicts = (root: string, paths: StartPaths) =>
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
  while (releases.size) {
    const resolved = yield* canonicalPaths(paths);
    const overlapping = [...releases].filter((release) => conflicts(release.root, resolved));
    const removing = overlapping.find((release) => release.removing);
    if (removing) {
      yield* Deferred.await(removing.done);
      continue;
    }
    for (const release of overlapping)
      release.hold = "a workspace process started during inspection";
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
  const release: Release = {
    root,
    done: Deferred.makeUnsafe<void>(),
    removing: false,
    hold: null,
  };
  const existing = yield* Effect.acquireRelease(
    Effect.sync(() => {
      releases.add(release);
      return [...starts];
    }),
    () =>
      Effect.sync(() => {
        releases.delete(release);
        Deferred.doneUnsafe(release.done, Effect.void);
      }),
  );
  for (const start of existing) {
    if (conflicts(release.root, yield* canonicalPaths(start.paths))) {
      release.hold = "a workspace process is starting";
      break;
    }
  }
  return Effect.sync(() => {
    if (release.hold === null) release.removing = true;
    return release.hold;
  });
});
