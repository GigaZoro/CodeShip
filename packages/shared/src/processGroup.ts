// @effect-diagnostics nodeBuiltinImport:off -- runs synchronously beside Node's spawn, outside every fiber.
import * as Context from "effect/Context";
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
// starts a job in a group of its own inside the child's session, outside the command's descendants,
// then execs the command under that pid. Until the job reads `q` (or EOF on a pipe), signals miss it.

/** Lines a holder reads: quit, spare the group at EOF, or end it at EOF. */
export const HOLDER_LINES = { quit: "q\n", spare: "u\n", end: "r\n" } as const;

/** How the exec behind Node's spawn finds a file: libuv's own search on macOS, libc's execvp on Linux. */
interface ExecRules {
  /** The PATH searched when the child's environment has none. */
  readonly defaultPath: string;
  /** Whether a file execve refuses with ENOEXEC runs as `/bin/sh file args`, as glibc's execvp does. */
  readonly shellFallback: boolean;
}

const SHELL = "/bin/sh";

let execRules: ExecRules | undefined;
const hostExecRules = (): ExecRules => {
  if (execRules === undefined) {
    const platform = HostProcess.Platform.defaultValue();
    const report = platform === "linux" ? process.report.getReport() : undefined;
    const glibc =
      (report as { readonly header?: { readonly glibcVersionRuntime?: string } } | undefined)
        ?.header?.glibcVersionRuntime !== undefined;
    execRules =
      platform === "darwin"
        ? { defaultPath: "/usr/bin:/bin", shellFallback: false }
        : glibc
          ? { defaultPath: "/bin:/usr/bin", shellFallback: true }
          : { defaultPath: "/usr/local/bin:/bin:/usr/bin", shellFallback: false };
  }
  return execRules;
};

const isRunnable = (file: string) => {
  try {
    if (NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
    NodeFS.accessSync(file, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// ELF, Mach-O in both byte orders and widths, and universal Mach-O.
const BINARY_MAGIC = ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe"];

const fileHead = (file: string) => {
  const head = Buffer.alloc(256);
  const fd = NodeFS.openSync(file, "r");
  try {
    return head.subarray(0, NodeFS.readSync(fd, head, 0, head.length, 0));
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * What execve does with `file` in a child started in `cwd`: runs it; fails with ENOENT for a
 * missing script interpreter or EACCES, where Node's PATH search goes on; or fails with ENOEXEC,
 * where it stops, and Node reports that unless libc runs the file with /bin/sh.
 */
const execOutcome = (file: string, cwd: string): "runs" | "next" | "stops" => {
  if (!isRunnable(file)) return "next";
  let head: Buffer;
  try {
    head = fileHead(file);
  } catch {
    return "next";
  }
  if (head.subarray(0, 2).toString("latin1") === "#!") {
    const interpreter = /^[ \t]*([^ \t\n]*)/.exec(head.subarray(2).toString("latin1"))?.[1] ?? "";
    if (interpreter === "") return "stops";
    return isRunnable(NodePath.resolve(cwd, interpreter)) ? "runs" : "next";
  }
  return BINARY_MAGIC.includes(head.subarray(0, 4).toString("hex")) ? "runs" : "stops";
};

/**
 * The file where the PATH search of Node's spawn stops for `command` in a child started in `cwd`:
 * one that execve runs or refuses with ENOEXEC. `tried` is the path libc tries; `file` reaches the
 * same file from bash, which would search PATH for a bare name.
 */
const searchPath = (
  command: string,
  cwd: string,
  pathVariable: string | undefined,
  defaultPath: string,
) => {
  const attempt = (tried: string, file: string) => {
    const outcome = execOutcome(NodePath.resolve(cwd, file), cwd);
    return outcome === "next" ? undefined : { tried, file, runs: outcome === "runs" };
  };
  if (command.includes("/")) return attempt(command, command);
  for (const directory of (pathVariable ?? defaultPath).split(":")) {
    const found =
      directory === ""
        ? attempt(command, `./${command}`)
        : attempt(`${directory}/${command}`, `${directory}/${command}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** `exec -a argv0 path ...leading` runs what Node's spawn runs for a command, before its arguments. */
type Exec = readonly [argv0: string, path: string, ...leading: Array<string>];

/** What Node's spawn execs for `command`; undefined when that fails, for Node to report unheld. */
const execOf = (command: string, cwd: string, pathVariable: string | undefined) => {
  if (command === "") return undefined;
  const rules = hostExecRules();
  const found = searchPath(command, cwd, pathVariable, rules.defaultPath);
  if (found === undefined) return undefined;
  if (found.runs) return [command, found.file] satisfies Exec;
  return rules.shellFallback && isRunnable(SHELL)
    ? ([SHELL, SHELL, found.tried] satisfies Exec)
    : undefined;
};

let bash: string | null | undefined;
const findBash = () => {
  if (bash === undefined) {
    const found = isRunnable("/bin/bash")
      ? { file: "/bin/bash", runs: true }
      : searchPath("bash", process.cwd(), process.env.PATH, hostExecRules().defaultPath);
    bash = found?.runs === true ? NodePath.resolve(found.file) : null;
  }
  return bash;
};

// Inits that reap every orphan they adopt. A holder outlives its command, so under any other, such
// as a Node server that is a container's pid 1, each would stay a zombie: those groups run unheld.
const REAPING_INITS = new Set([
  "systemd",
  "init",
  "tini",
  "docker-init",
  "dumb-init",
  "catatonit",
  "s6-svscan",
  "runit",
  "openrc-init",
]);

/** Whether this host reaps an orphaned holder: launchd does, and on Linux a known init. */
export function reapsOrphans(
  platform: NodeJS.Platform,
  pid: number,
  initName: () => string | undefined,
): boolean {
  if (platform === "darwin") return true;
  return platform === "linux" && pid !== 1 && REAPING_INITS.has(initName() ?? "");
}

const readInitName = () => {
  try {
    return NodeFS.readFileSync("/proc/1/comm", "utf8").trim();
  } catch {
    return undefined;
  }
};

let orphansReaped: boolean | undefined;

export interface GroupLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  /** The child's environment; without one it inherits this process's, as Node's spawn does. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly shell?: boolean | string | undefined;
}

export type HoldOptions = {
  /** The child's fd the holder reads, above every fd the command is given. */
  readonly fd: number;
} & (
  | {
      /**
       * At EOF on `fd`, a pipe the caller opens, unless spared, the holder sends the group SIGTERM,
       * then SIGKILL this many seconds later, or SIGKILL at once for 0. Without it, EOF only lets
       * the number go.
       */
      readonly endGroupAfterSeconds?: number | undefined;
    }
  | {
      /**
       * A FIFO the holder makes, unless it exists, and opens as `fd`, for a group that outlives
       * this process: `isFifoHolderHeld` and `releaseFifoHolder` reach it from any later one.
       */
      readonly fifo: string;
    }
);

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const holderScript = (options: HoldOptions, env: NodeJS.ProcessEnv) => {
  const { fd } = options;
  let job: string;
  const setup: Array<string> = [];
  if ("fifo" in options) {
    const fifo = quote(options.fifo);
    // Opened before the command starts, and for writing too, so the holder never reads EOF. When
    // no FIFO can be made, its read fails and the command runs unheld.
    setup.push(`{ [ -p ${fifo} ] || command -p mkfifo -m 600 ${fifo}; } && exec ${fd}<>${fifo}`);
    job = `read -r -u ${fd} _`;
  } else {
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
  // macOS starts its protected /bin/bash without these, which the command still gets from Node.
  const dyld = Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && /^DYLD_\w+$/.test(name) ? [`export ${name}=${quote(value)}`] : [],
  );
  // Only a bare `exec` redirects for good: bash keeps a copy of an fd it redirects for one
  // command, and macOS's bash 3.2 passes that copy on through exec. Job control gives the
  // subshell a group, which its job keeps once the subshell exits and leaves it to init.
  return [
    ...setup,
    "set -m",
    `( (exec </dev/null >/dev/null 2>&1${otherFds}; ${job}) & )`,
    "set +m",
    `exec ${fd}<&-`,
    ...dyld,
    'exec -a "$0" "$@"',
  ].join("\n");
};

/**
 * The detached POSIX launch that holds the group of `launch`, with `shell` folded in as Node folds
 * it. Undefined without bash, where a holder that quits would stay a zombie, or when exec fails for
 * the command, which then starts as is so that Node reports its error. The caller spawns it
 * detached, without `shell`.
 */
export function holdProcessGroup(
  launch: GroupLaunch,
  options: HoldOptions,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  const holder = findBash();
  orphansReaped ??= reapsOrphans(HostProcess.Platform.defaultValue(), process.pid, readInitName);
  if (holder === null || !orphansReaped) return undefined;
  const [file, args] =
    launch.shell === undefined || launch.shell === false
      ? [launch.command, launch.args]
      : [
          typeof launch.shell === "string" ? launch.shell : SHELL,
          ["-c", [launch.command, ...launch.args].join(" ")],
        ];
  const env = launch.env ?? process.env;
  const exec = execOf(file, launch.cwd ?? process.cwd(), env.PATH);
  if (exec === undefined) return undefined;
  return {
    command: holder,
    // Privileged mode reads no startup file, SHELLOPTS or function from the environment and passes
    // exported functions on unchanged. Like any shell, bash still sets PWD and SHLVL and drops
    // OLDPWD for the command.
    args: ["-p", "-c", holderScript(options, env), ...exec, ...args],
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

/**
 * A FIFO through which `layerHeldProcessGroups` holds the groups it spawns, so that each number
 * stays held after this process ends, until `releaseFifoHolder`, as well as through the scope.
 */
export const HoldThroughFifo = Context.Reference<string | undefined>(
  "@t3tools/shared/processGroup/HoldThroughFifo",
  { defaultValue: () => undefined },
);

const releaseFifo = (fifo: string) =>
  Effect.try(() => releaseFifoHolder(fifo)).pipe(Effect.ignore({ log: true }));

const spawnHeld = Effect.fnUntraced(function* (
  spawner: Spawner,
  command: ChildProcess.StandardCommand,
) {
  const { options } = command;
  const fds = Object.keys(options.additionalFds ?? {}).map(ChildProcess.parseFdName);
  const fd = 1 + Math.max(2, ...fds.map((fd) => fd ?? 2));
  const fifo = yield* HoldThroughFifo;
  const held = holdProcessGroup(
    {
      command: command.command,
      args: command.args,
      cwd: options.cwd,
      env: options.extendEnv ? { ...process.env, ...options.env } : options.env,
      shell: options.shell,
    },
    fifo === undefined ? { fd } : { fd, fifo },
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
        additionalFds:
          fifo === undefined
            ? { ...options.additionalFds, [`fd${fd}`]: { type: "input" } }
            : options.additionalFds,
      }),
    )
    .pipe(Effect.mapError(restore));
  release =
    fifo === undefined
      ? Effect.ignore(Stream.run(Stream.empty, handle.getInputFd(fd)))
      : releaseFifo(fifo);
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
 * Effect's Node spawner signals a detached command's group after its leader's exit. On POSIX this
 * spawner holds each detached command's group until its scope's finalizers have run, and with
 * `HoldThroughFifo` past this process's end. A pipeline is not held, nor the failing exit of a
 * command left running, unreferenced, past them.
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
