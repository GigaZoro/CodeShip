import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { attachWindowsJob, windowsJobOf, type WindowsJob } from "./windowsJob.ts";
import { owningWindowsJobs } from "./windowsJobSpawner.ts";

/** Process ids are diagnostic only; stopping requires retained OS membership. */
export interface WindowsProcessTreeRoot {
  readonly pid: number;
  readonly job?: WindowsJob;
}

/** Runs a spawn and pairs its handle with the root a stop of its tree needs. */
export const withWindowsTreeRoot = <A extends { readonly pid: number }, E, R>(
  spawn: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly handle: A; readonly root: WindowsProcessTreeRoot }, E, R> =>
  Effect.suspend(() => {
    return Effect.map(spawn, (handle) => {
      const job = windowsJobOf(handle);
      return { handle, root: { pid: handle.pid, ...(job === undefined ? {} : { job }) } };
    });
  });

/** Share successful cleanup, but retry a failed stop while retaining the same job ownership. */
export const withWindowsTreeStop = Effect.fn("WindowsProcessTree.withStop")(function* <
  A extends { readonly pid: number },
  E,
  R,
>(spawn: Effect.Effect<A, E, R>) {
  const { handle, root } = yield* withWindowsTreeRoot(spawn);
  const stopTree = yield* Effect.cachedWithTTL(stopWindowsProcessTree(root), (exit) =>
    Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  );
  return { handle, root, stopTree };
});

const STOP_TIMEOUT = Duration.seconds(30);
const STDERR_TAIL_CHARS = 4_096;

const stopFailed = (root: WindowsProcessTreeRoot, tag: PlatformError.SystemErrorTag, why: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "ChildProcess",
    method: "kill",
    pathOrDescriptor: root.pid,
    description: `Could not stop the process tree of ${root.pid}: ${why}`,
  });

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const beneath = new WeakMap<Spawner, Spawner>();

/** The spawner beneath `endingWindowsTrees`, for code that stops its processes' trees itself. */
export const withoutWindowsTreeEnding = (spawner: Spawner): Spawner =>
  beneath.get(spawner) ?? spawner;

/** Runs on the spawner beneath `endingWindowsTrees`, so a stop never stops a tree of its own. */
export const stopWindowsProcessTree = Effect.fn("WindowsProcessTree.stop")(
  function* (root: WindowsProcessTreeRoot) {
    const spawner = withoutWindowsTreeEnding(yield* ChildProcessSpawner.ChildProcessSpawner);
    // Without a published child, host exit closes its last job handle and ends any suspended child.
    if (root.job?.hostExited && root.job.child === undefined) return;
    if (root.job?.child === undefined)
      return yield* stopFailed(
        root,
        "BadResource",
        "No published child identity proves Windows job ownership",
      );
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        root.job.host,
        ["stop", root.job.name, String(root.job.child.pid), String(root.job.child.created)],
        {
          stdin: "ignore",
          stdout: "ignore",
        },
      ),
    );
    const [stderr, exitCode] = yield* Effect.all(
      [
        handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, chunk: string) => (tail + chunk).slice(-STDERR_TAIL_CHARS),
          ),
        ),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* stopFailed(root, "Unknown", `Stop helper exited ${exitCode}: ${stderr.trim()}`);
    }
  },
  (effect, root) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: STOP_TIMEOUT,
        orElse: () =>
          Effect.fail(stopFailed(root, "TimedOut", "The stop helper did not finish within 30 s")),
      }),
    ),
);

/**
 * A function that starts a stop of a tree at once, for a Node callback such as a child's `exit`, and
 * returns its completion, which never rejects: a failure is logged. The stop outlives the caller's
 * scope, so code that ends with the server awaits it.
 */
export const windowsTreeStopper = Effect.map(
  Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
  (context) => {
    const runPromise = Effect.runPromiseWith(context);
    return (root: WindowsProcessTreeRoot): Promise<void> =>
      runPromise(stopWindowsProcessTree(root).pipe(Effect.ignoreCause({ log: "Error" })));
  },
);

/**
 * When `endingWindowsTrees` stops a tree, through its retained job. `always`: on a kill or the scope's
 * close, for an agent's CLI. `leftBehind`: on a kill, a close while it runs or by interruption, or a
 * close with a begun read of its output unended, as when a leftover holds that pipe; a command that
 * exits and closes its output needs no stop helper.
 */
export type WindowsTreeEnding = "always" | "leftBehind";

/**
 * Ends spawned processes with their trees on Windows, also after they exited, as a process group
 * does on POSIX, when `ending` says to. Wrapping a wrapped spawner replaces its policy, so one
 * process never starts two stop helpers. An unreferenced process outlives its scope. A pipeline fails: its
 * handle reports only the last process, so what an earlier one left running would survive.
 */
export const endingWindowsTrees = (
  spawner: Spawner,
  platform: NodeJS.Platform,
  ending: WindowsTreeEnding = "always",
): Spawner => {
  if (platform !== "win32") return spawner;
  const inner = withoutWindowsTreeEnding(spawner);
  const owner = owningWindowsJobs(inner, platform);
  const wrapped = ChildProcessSpawner.make(
    Effect.fnUntraced(function* (command) {
      if (command._tag === "PipedCommand") {
        return yield* PlatformError.badArgument({
          module: "ChildProcess",
          method: "spawn",
          description:
            "endingWindowsTrees ends one process's tree; spawn a pipeline's stages one by one",
        });
      }
      const {
        handle,
        root,
        stopTree: stopOwnedTree,
      } = yield* withWindowsTreeStop(owner.spawn(command));
      let referenced = true;
      let unendedReads = 0;
      const stopTree = stopOwnedTree.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, inner),
      );
      // The leader ends first, so its exit is known before the inner spawner's release looks.
      const kill = (options?: ChildProcess.KillOptions) =>
        Effect.exit(handle.kill(options)).pipe(
          Effect.flatMap((killed) => Effect.andThen(stopTree, killed)),
        );
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          if (!referenced) return;
          if (yield* handle.isRunning) return yield* kill();
          if (ending === "always" || Exit.hasInterrupts(exit) || unendedReads > 0) {
            yield* stopTree;
          }
        }).pipe(Effect.ignore({ log: "Error" })),
      );
      const read = <E>(output: Stream.Stream<Uint8Array, E>) =>
        Stream.suspend(() => {
          unendedReads++;
          return Stream.onEnd(
            output,
            Effect.sync(() => {
              unendedReads--;
            }),
          );
        });
      const wrappedHandle = ChildProcessSpawner.makeHandle({
        ...handle,
        stdout: read(handle.stdout),
        stderr: read(handle.stderr),
        all: read(handle.all),
        getOutputFd: (fd) => read(handle.getOutputFd(fd)),
        kill,
        unref: handle.unref.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              referenced = false;
            }),
          ),
          Effect.map((reref) =>
            reref.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  referenced = true;
                }),
              ),
            ),
          ),
        ),
      });
      if (root.job !== undefined) attachWindowsJob(wrappedHandle, root.job);
      return wrappedHandle;
    }),
  );
  beneath.set(wrapped, inner);
  return wrapped;
};
