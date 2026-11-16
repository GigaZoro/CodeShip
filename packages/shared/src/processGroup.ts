// @effect-diagnostics nodeBuiltinImport:off -- runs synchronously beside Node's spawn, outside every fiber.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as HostProcess from "./HostProcess.ts";

/** `kill(0)` signals this server's group; `kill(-1)` signals every process the user owns. */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw Object.assign(new Error(`kill ESRCH: not a spawned process group (${pid})`), {
      code: "ESRCH",
    });
  }
  process.kill(-pid, signal);
}

// A pid, group id or session id goes to no new process while one of them has it, so once a detached
// child's group emptied, `kill(-pid)` can reach a group that took the number. A holder keeps it: bash
// leaves a job in its own group inside the child's session, then execs the command under that pid.
// Until the job reads `q` (or EOF on a pipe), group signals and `kill(-pid, 0)` miss it.

/** Lines a holder reads: quit, spare the group at EOF, or end it at EOF. */
export const HOLDER_LINES = { quit: "q\n", spare: "u\n", end: "r\n" } as const;

/** What libuv runs when PATH names no directory: its `_PATH_DEFPATH`. */
const DEFAULT_PATH = "/usr/bin:/bin";

const isRunnable = (file: string) => {
  try {
    if (NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
    NodeFS.accessSync(file, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The path libuv execs for `command` in a child started in `cwd` with `pathVariable` as its PATH:
 * a name with a slash as is; otherwise the first runnable file in PATH, whose relative entries are
 * below the child's working directory. A file found through an empty entry gets `./`, since bash
 * would search PATH for a bare name. macOS's bash 3.2 execs a relative path as an absolute one.
 */
export function resolveExecutable(
  command: string,
  cwd: string,
  pathVariable: string | undefined,
): string | undefined {
  if (command === "") return undefined;
  if (command.includes("/"))
    return isRunnable(NodePath.resolve(cwd, command)) ? command : undefined;
  for (const directory of (pathVariable ?? DEFAULT_PATH).split(":")) {
    const file = directory === "" ? `./${command}` : `${directory}/${command}`;
    if (isRunnable(NodePath.resolve(cwd, file))) return file;
  }
  return undefined;
}

let bash: string | null | undefined;
const findBash = () => {
  if (bash === undefined) {
    const found = isRunnable("/bin/bash")
      ? "/bin/bash"
      : resolveExecutable("bash", process.cwd(), process.env.PATH);
    bash = found === undefined ? null : NodePath.resolve(found);
  }
  return bash;
};

export interface GroupLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  /** The child's environment; without one it inherits this process's, as Node's spawn does. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly shell?: boolean | string | undefined;
}

export type HoldOptions =
  | {
      /** The child's fd the holder reads, which the caller opens as a pipe. */
      readonly fd: number;
      /**
       * At EOF, unless spared, the holder sends the group SIGTERM, then SIGKILL this many seconds
       * later, or SIGKILL at once for 0. Without it, EOF only lets the number go.
       */
      readonly endGroupAfterSeconds?: number | undefined;
    }
  | {
      /**
       * A FIFO the holder makes, unless it exists, and reads, for a group that outlives this
       * process: `isFifoHolderHeld` and `releaseFifoHolder` reach it from any later one.
       */
      readonly fifo: string;
    };

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const holderScript = (options: HoldOptions) => {
  let fd: number;
  let job: string;
  const setup: Array<string> = [];
  if ("fifo" in options) {
    const fifo = quote(options.fifo);
    // Opened before the command starts, and for writing too, so the holder never reads EOF. When
    // no FIFO can be made, its read fails and the command runs unheld.
    setup.push(`{ [ -p ${fifo} ] || command -p mkfifo -m 600 ${fifo}; } && exec 3<>${fifo}`);
    fd = 3;
    job = "read -r -u 3 _";
  } else {
    fd = options.fd;
    const end =
      options.endGroupAfterSeconds === 0
        ? "kill -s KILL -- -$$"
        : `kill -s TERM -- -$$ || exit; sleep ${options.endGroupAfterSeconds}; kill -s KILL -- -$$`;
    job =
      options.endGroupAfterSeconds === undefined
        ? `read -r -u ${fd} _`
        : `r=1; while read -r -u ${fd} m; do case $m in q) exit;; u) r=;; r) r=1;; esac; done; [ -n "$r" ] || exit; ${end}`;
  }
  const otherFds = Array.from({ length: fd - 3 }, (_, index) => ` ${index + 3}<&-`).join("");
  // Only a bare `exec` redirects for good: bash keeps a copy of an fd it redirects for one
  // command, and macOS's bash 3.2 passes that copy on through exec.
  return [
    ...setup,
    "set -m",
    `(exec </dev/null >/dev/null 2>&1${otherFds}; ${job}) &`,
    "set +m",
    `exec ${fd}<&-`,
    'exec -a "$0" "$@"',
  ].join("\n");
};

/**
 * The detached POSIX launch that holds the group of `launch`, with `shell` folded in as Node folds
 * it. Undefined without bash, or when no runnable file answers the command, which then starts as
 * is so that Node reports its error. The caller spawns it detached, without `shell`.
 */
export function holdProcessGroup(
  launch: GroupLaunch,
  options: HoldOptions,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  const holder = findBash();
  if (holder === null) return undefined;
  const [file, args] =
    launch.shell === undefined || launch.shell === false
      ? [launch.command, launch.args]
      : [
          typeof launch.shell === "string" ? launch.shell : "/bin/sh",
          ["-c", [launch.command, ...launch.args].join(" ")],
        ];
  const resolved = resolveExecutable(
    file,
    launch.cwd ?? process.cwd(),
    (launch.env ?? process.env).PATH,
  );
  if (resolved === undefined) return undefined;
  return {
    command: holder,
    // Privileged mode reads no startup file, SHELLOPTS or function from the environment and passes
    // exported functions on unchanged. Like any shell, bash still sets PWD and SHLVL and drops
    // OLDPWD for the command.
    args: ["-p", "-c", holderScript(options), file, resolved, ...args],
  };
}

/** A writer's end of a FIFO hold's FIFO while its holder reads it. */
const openHolderFifo = (fifo: string) => {
  let fd: number;
  try {
    // Without a reader, a non-blocking open for writing fails with ENXIO instead of waiting.
    fd = NodeFS.openSync(fifo, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENXIO" || code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw cause;
  }
  if (NodeFS.fstatSync(fd).isFIFO()) return fd;
  NodeFS.closeSync(fd);
  return undefined;
};

/** Whether the holder of a `fifo` hold still keeps its group's number. */
export function isFifoHolderHeld(fifo: string): boolean {
  const fd = openHolderFifo(fifo);
  if (fd === undefined) return false;
  NodeFS.closeSync(fd);
  return true;
}

/** The holder of a `fifo` hold quits, so the number stays its group's only while that has members. */
export function releaseFifoHolder(fifo: string): void {
  const fd = openHolderFifo(fifo);
  if (fd === undefined) return;
  try {
    NodeFS.writeSync(fd, HOLDER_LINES.quit);
  } catch (cause) {
    // It quit between the open and the write.
    if ((cause as NodeJS.ErrnoException).code !== "EPIPE") throw cause;
  } finally {
    NodeFS.closeSync(fd);
  }
}

export interface OwnedProcessGroup {
  /**
   * Signals the group while a process this server started keeps its number: the leader until its
   * exit event, then its holder. Returns whether it was still ours.
   */
  readonly signal: (signal: NodeJS.Signals) => boolean;
  /** The holder quits, so the number stays ours only while the leader runs. */
  readonly release: () => void;
}

/** The group of a child started detached, through `holdProcessGroup` when `holderFd` is set. */
export function ownProcessGroup(
  child: NodeChildProcess.ChildProcess,
  holderFd: number | undefined,
): OwnedProcessGroup {
  const holder =
    holderFd === undefined ? undefined : (child.stdio[holderFd] as NodeNet.Socket | null);
  let held = Boolean(holder);
  if (holder) {
    const lost = () => {
      held = false;
    };
    holder.on("end", lost).on("close", lost).on("error", lost);
    // Reads only to learn of the holder's end, which must not keep this process alive.
    holder.resume().unref();
  }
  return {
    signal: (signal) => {
      if (!held && (child.exitCode !== null || child.signalCode !== null)) return false;
      signalProcessGroup(child.pid ?? 0, signal);
      return true;
    },
    release: () => {
      held = false;
      holder?.end(HOLDER_LINES.quit);
    },
  };
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const commandText = (command: string, args: ReadonlyArray<string>) =>
  `${command} ${args.join(" ")}`;

/** Errors of a held command name the command it was given, not its holder's launch. */
const reportAs = (heldText: string, text: string) => (error: PlatformError.PlatformError) => {
  const { reason } = error;
  return reason._tag === "BadArgument" || reason.pathOrDescriptor !== heldText
    ? error
    : PlatformError.systemError({
        _tag: reason._tag,
        module: reason.module,
        method: reason.method,
        description: reason.description,
        syscall: reason.syscall,
        pathOrDescriptor: text,
        cause: reason.cause,
      });
};

const spawnHeld = Effect.fnUntraced(function* (
  spawner: Spawner,
  command: ChildProcess.StandardCommand,
) {
  const { options } = command;
  const fds = Object.keys(options.additionalFds ?? {}).map(ChildProcess.parseFdName);
  const fd = 1 + Math.max(2, ...fds.map((fd) => fd ?? 2));
  const held = holdProcessGroup(
    {
      command: command.command,
      args: command.args,
      cwd: options.cwd,
      env: options.extendEnv ? { ...process.env, ...options.env } : options.env,
      shell: options.shell,
    },
    { fd },
  );
  if (held === undefined) return yield* spawner.spawn(command);
  const restore = reportAs(
    commandText(held.command, held.args),
    commandText(command.command, command.args),
  );
  // Added ahead of the spawner's own finalizer, so it runs after every finalizer that may signal.
  let release: Effect.Effect<void> = Effect.void;
  yield* Effect.addFinalizer(() => Effect.suspend(() => release));
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(held.command, held.args, {
        ...options,
        shell: false,
        additionalFds: { ...options.additionalFds, [`fd${fd}`]: { type: "input" } },
      }),
    )
    .pipe(Effect.mapError(restore));
  release = Effect.ignore(Stream.run(Stream.empty, handle.getInputFd(fd)));
  return ChildProcessSpawner.makeHandle({
    pid: handle.pid,
    exitCode: Effect.mapError(handle.exitCode, restore),
    isRunning: Effect.mapError(handle.isRunning, restore),
    kill: (killOptions) => Effect.mapError(handle.kill(killOptions), restore),
    stdin: Sink.mapError(handle.stdin, restore),
    stdout: Stream.mapError(handle.stdout, restore),
    stderr: Stream.mapError(handle.stderr, restore),
    all: Stream.mapError(handle.all, restore),
    getInputFd: (inputFd) => Sink.mapError(handle.getInputFd(inputFd), restore),
    getOutputFd: (outputFd) => Stream.mapError(handle.getOutputFd(outputFd), restore),
    unref: Effect.mapError(handle.unref, restore),
  });
});

/**
 * Effect's Node spawner signals a detached command's group after its leader's exit: as the command
 * fails, when it is killed, and when the scope that started it closes. On POSIX this spawner holds
 * the group of each detached command until that scope's finalizers have run.
 */
export const layerHeldProcessGroups = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    if ((yield* HostProcess.Platform) === "win32") return spawner;
    return ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand" && command.options.detached !== false
        ? spawnHeld(spawner, command)
        : spawner.spawn(command),
    );
  }),
);
