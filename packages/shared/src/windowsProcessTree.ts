// @effect-diagnostics globalDate:off globalDateInEffect:off - The walk compares times with process creation times, which the system clock stamps.
/**
 * Ends a process and what it started on Windows, also after the process exited. Windows has no
 * process groups, and `taskkill /T` finds descendants only through a running leader, so what a
 * leader left running outlives it. This walks `Win32_Process` by `ParentProcessId`, which outlives
 * the parent, in PowerShell.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  stopTreeArgs,
  stopTreeCall,
  type WindowsProcessTreeRoot,
  windowsTreeRootFromNow,
} from "./windowsProcessTreeScript.ts";
export { type WindowsProcessTreeRoot, windowsStopTreeArgs } from "./windowsProcessTreeScript.ts";

const STOP_TIMEOUT = Duration.seconds(30);
/** How long a walk that saw a running root gone waits for its spawner to report the exit. */
const EXIT_REPORT_TIMEOUT = Duration.seconds(5);
const OUTPUT_TAIL_CHARS = 4_096;

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

const tailOf = <E>(output: Stream.Stream<Uint8Array, E>) =>
  output.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (tail, chunk: string) => (tail + chunk).slice(-OUTPUT_TAIL_CHARS),
    ),
  );

/**
 * What walks of one tree learned: as `<pid>,<ticks>`, what they found but did not end, and when the
 * first that saw a running root gone saw it so.
 */
interface WalkNotes {
  readonly left: Set<string>;
  goneAt: number | undefined;
}

/**
 * Runs on the spawner beneath `endingWindowsTrees`, so a stop never stops a tree of its own. The walk
 * also ends what `notes` says earlier walks left, and adds to them each line as it reads it, so a walk
 * cut short still passes on what it said.
 */
const walkWindowsTree = Effect.fn("WindowsProcessTree.stop")(
  function* (root: WindowsProcessTreeRoot, call: ReadonlyArray<string | number>, notes: WalkNotes) {
    const spawner = withoutWindowsTreeEnding(yield* ChildProcessSpawner.ChildProcessSpawner);
    const carried = [...notes.left].join(",");
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "powershell.exe",
        stopTreeArgs(carried === "" ? call : [...call, "-left", carried]),
        { stdin: "ignore" },
      ),
    );
    const said = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          const unended = /^left (\d+) (\d+)$/.exec(line.trim());
          const gone = /^ended (\d+)$/.exec(line.trim());
          if (unended !== null) notes.left.add(`${unended[1]},${unended[2]}`);
          if (gone !== null) notes.goneAt ??= Number(gone[1]);
        }),
      ),
    );
    const [, stderr, exitCode] = yield* Effect.all([said, tailOf(handle.stderr), handle.exitCode], {
      concurrency: "unbounded",
    });
    if (exitCode !== 0) {
      return yield* stopFailed(root, "Unknown", `PowerShell exited ${exitCode}: ${stderr.trim()}`);
    }
  },
  (effect, root) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: STOP_TIMEOUT,
        orElse: () =>
          Effect.fail(stopFailed(root, "TimedOut", "PowerShell did not finish within 30 s")),
      }),
    ),
);

const stopWindowsProcessTree = (
  root: WindowsProcessTreeRoot,
  notes: WalkNotes = { left: new Set(), goneAt: undefined },
) => walkWindowsTree(root, stopTreeCall(root), notes);

/**
 * Whether a handle's exit report says the process exited. A spawner fails `exitCode` with method
 * `exitCode` for an exit by a signal; another failure, such as a lost worker's, says nothing of it.
 */
const reportsExit = (exit: Exit.Exit<unknown, PlatformError.PlatformError>) =>
  Exit.isSuccess(exit) ||
  Exit.findErrorOption(exit).pipe(Option.exists((error) => error.reason.method === "exitCode"));

/**
 * Pairs a spawn's handle with a stop of its tree, shared while it runs and once it succeeded; a stop
 * after a failed one also ends what that one left. Later stops count the root's children only from
 * before the earlier of its reported exit and when a walk saw it gone; a walk that sees it gone waits
 * for that report, up to EXIT_REPORT_TIMEOUT, and walks again.
 */
export const withWindowsTreeStop = <
  A extends Pick<ChildProcessSpawner.ChildProcessHandle, "pid" | "exitCode" | "isRunning">,
  E,
  R,
>(
  spawn: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const rootOf = windowsTreeRootFromNow();
    return Effect.flatMap(spawn, (handle) =>
      Effect.gen(function* () {
        const root = rootOf(handle.pid);
        const notes: WalkNotes = { left: new Set(), goneAt: undefined };
        let ended: number | undefined;
        const noteEnd = Effect.flatMap(Effect.exit(handle.exitCode), (exit) =>
          Effect.sync(() => {
            if (reportsExit(exit)) ended ??= Date.now();
          }),
        );
        const stopEnded = noteEnd.pipe(
          Effect.timeoutOption(EXIT_REPORT_TIMEOUT),
          Effect.flatMap(() => {
            const at = Math.min(ended ?? Infinity, notes.goneAt ?? Infinity);
            return stopWindowsProcessTree(at === Infinity ? root : { ...root, ended: at }, notes);
          }),
        );
        const stopRunning = Effect.flatMap(
          Effect.exit(walkWindowsTree(root, [...stopTreeCall(root), "-running"], notes)),
          (walked) => {
            if (notes.goneAt === undefined) return walked;
            return Exit.isSuccess(walked)
              ? stopEnded
              : Effect.andThen(Effect.ignore(stopEnded, { log: "Error" }), walked);
          },
        );
        const stopTree = yield* Effect.cachedWithTTL(
          Effect.flatMap(handle.isRunning, (running) => (running ? stopRunning : stopEnded)),
          (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        );
        yield* Effect.forkDetach(noteEnd, { startImmediately: true });
        return { handle, stopTree };
      }),
    );
  });

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
 * When `endingWindowsTrees` stops a tree, which starts PowerShell. `always`: on a kill or the scope's
 * close, for an agent's CLI. `leftBehind`: on a kill, a close while it runs or by interruption, or a
 * close with a begun read of its output unended, as when a leftover holds that pipe; a command that
 * exits and closes its output costs no walk.
 */
export type WindowsTreeEnding = "always" | "leftBehind";

/**
 * Ends spawned processes with their trees on Windows, also after they exited, as a process group
 * does on POSIX, when `ending` says to. Wrapping a wrapped spawner replaces its policy, so one
 * process never costs two walks. An unreferenced process outlives its scope. A pipeline fails: its
 * handle reports only the last process, so what an earlier one left running would survive.
 */
export const endingWindowsTrees = (
  spawner: Spawner,
  platform: NodeJS.Platform,
  ending: WindowsTreeEnding = "always",
): Spawner => {
  if (platform !== "win32") return spawner;
  const inner = withoutWindowsTreeEnding(spawner);
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
      const spawned = yield* withWindowsTreeStop(inner.spawn(command));
      const { handle } = spawned;
      let referenced = true;
      let unendedReads = 0;
      const stopTree = spawned.stopTree.pipe(
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
      return ChildProcessSpawner.makeHandle({
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
    }),
  );
  beneath.set(wrapped, inner);
  return wrapped;
};
