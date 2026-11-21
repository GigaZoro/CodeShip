// @effect-diagnostics nodeBuiltinImport:off -- runs synchronously beside Node's spawn, outside every fiber.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";

import * as HostProcess from "./HostProcess.ts";

const noGroup = (detail: string, cause?: unknown) =>
  Object.assign(new Error(`kill ESRCH: ${detail}`, { cause }), { code: "ESRCH" });

/**
 * `kill(0)` signals this server's group; `kill(-1)` signals every process the user owns. EPERM
 * means no member could take the signal: on macOS each one exited and awaits its reaping, and
 * elsewhere each belongs to another user. Either way no process of ours is left in it.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw noGroup(`not a spawned process group (${pid})`);
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EPERM") throw cause;
    throw noGroup(`no process of ours left in group ${pid}`, cause);
  }
}

// A pid, group id or session id goes to no new process while one of them has it, so once a detached
// child's group emptied, `kill(-pid)` can reach a group that took the number. A holder keeps it: bash
// starts a job in a group of its own inside the child's session, outside the command's descendants,
// then execs the command under that pid. Until the job reads `q` (or EOF on a pipe), signals miss it.

/** Lines a holder reads: quit, spare the group at EOF, end it at EOF, or (a FIFO's) end it now. */
export const HOLDER_LINES = { quit: "q\n", spare: "u\n", end: "r\n", stop: "k\n" } as const;

/** How long a group that `stopFifoHolderGroup` sent SIGTERM has to end before SIGKILL. */
const FIFO_HOLDER_STOP_SECONDS = 2;

const SHELL = "/bin/sh";

let defaultPath: string | undefined;
/** The PATH searched when the child's environment has none: libuv's own on macOS, libc's on Linux. */
const hostDefaultPath = () =>
  (defaultPath ??=
    HostProcess.Platform.defaultValue() === "darwin"
      ? "/usr/bin:/bin"
      : HostProcess.LinuxLibc.defaultValue() === "gnu"
        ? "/bin:/usr/bin"
        : "/usr/local/bin:/bin:/usr/bin");

/** A child's path to `file` from `cwd`, left for the kernel to resolve: `a/missing/..` is no `a`. */
const inCwd = (cwd: string, file: string) => (file.startsWith("/") ? file : `${cwd}/${file}`);

const isRunnable = (file: string) => {
  try {
    if (NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
    NodeFS.accessSync(file, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The ELF class and machine of the little-endian Linux hosts' own programs. */
const ELF_MACHINES: Partial<
  Record<NodeJS.Architecture, readonly [elfClass: 1 | 2, machine: number]>
> = { x64: [2, 62], arm64: [2, 183], arm: [1, 40] };
/** The Mach-O CPU type of the macOS hosts' own programs. */
const MACH_O_CPU_TYPES: Partial<Record<NodeJS.Architecture, number>> = {
  x64: 0x0100_0007,
  arm64: 0x0100_000c,
};
const PT_INTERP = 3;
const MH_EXECUTE = 2;
const LC_UNIXTHREAD = 0x5;
const LC_LOAD_DYLINKER = 0xe;
const LC_SEGMENT_64 = 0x19;
const LC_MAIN = 0x8000_0028;
const DYLD = "/usr/lib/dyld";
// Far above any program's; a larger table or universal binary starts unheld.
const MAX_LOAD_COMMANDS_SIZE = 1 << 20;
const MAX_FAT_ARCHS = 32;

const readAt = (fd: number, position: number, length: number) => {
  const bytes = Buffer.alloc(length);
  return bytes.subarray(0, NodeFS.readSync(fd, bytes, 0, length, position));
};

/**
 * What execve does: runs the file, or fails with ENOENT or EACCES, where the PATH search of
 * Node's spawn goes on. Undefined where that is not certain.
 */
type ExecOutcome = "runs" | "next" | undefined;

/** An executable or position-independent program the kernel of this host loads. */
const isHostElf = (head: Buffer) => {
  const host = ELF_MACHINES[HostProcess.Architecture.defaultValue()];
  const type = head.readUInt16LE(16);
  return (
    host !== undefined &&
    head.readUInt32BE(0) === 0x7f45_4c46 &&
    head[4] === host[0] &&
    head[5] === 1 &&
    (type === 2 || type === 3) &&
    head.readUInt16LE(18) === host[1]
  );
};

/** A host ELF's program headers, whole, as the kernel reads them before it commits to the exec. */
const programHeaders = (fd: number, head: Buffer) => {
  if (!isHostElf(head)) return undefined;
  const wide = head[4] === 2;
  const word = (bytes: Buffer, at: number) =>
    wide ? Number(bytes.readBigUInt64LE(at)) : bytes.readUInt32LE(at);
  const entrySize = wide ? 56 : 32;
  const size = entrySize * head.readUInt16LE(wide ? 56 : 44);
  // The kernel refuses other entry sizes and no entries, and more than a page on some hosts.
  if (head.readUInt16LE(wide ? 54 : 42) !== entrySize || size === 0 || size > 4096) {
    return undefined;
  }
  const entries = readAt(fd, word(head, wide ? 32 : 28), size);
  return entries.length === size ? { entries, entrySize, wide, word } : undefined;
};

/** A program of this host runs while the loader it names can; execve fails as that one would. */
const elfOutcome = (fd: number, head: Buffer, cwd: string): ExecOutcome => {
  const program = programHeaders(fd, head);
  if (program === undefined) return undefined;
  const { entries, entrySize, wide, word } = program;
  for (let at = 0; at < entries.length; at += entrySize) {
    if (entries.readUInt32LE(at) !== PT_INTERP) continue;
    const length = word(entries, at + (wide ? 32 : 16));
    if (length < 2 || length > 4096) return undefined;
    const name = readAt(fd, word(entries, at + (wide ? 8 : 4)), length);
    if (name.length !== length || name[length - 1] !== 0) return undefined;
    const loader = inCwd(cwd, name.toString("latin1", 0, name.indexOf(0)));
    if (!isRunnable(loader)) return "next";
    const loaderFd = NodeFS.openSync(loader, "r");
    try {
      return programHeaders(loaderFd, readAt(loaderFd, 0, 64)) === undefined ? undefined : "runs";
    } finally {
      NodeFS.closeSync(loaderFd);
    }
  }
  return "runs";
};

/**
 * A whole program for this host's CPU, `size` bytes at `offset`, started by dyld: a load command or
 * segment that its file cannot hold makes execve fail.
 */
const isMachOProgram = (fd: number, cpu: number, offset: number, size: number) => {
  const header = readAt(fd, offset, 32);
  if (
    header.length !== 32 ||
    header.readUInt32BE(0) !== 0xcffa_edfe ||
    header.readUInt32LE(4) !== cpu ||
    header.readUInt32LE(12) !== MH_EXECUTE
  ) {
    return false;
  }
  const count = header.readUInt32LE(16);
  const commandsSize = header.readUInt32LE(20);
  if (commandsSize > MAX_LOAD_COMMANDS_SIZE || 32 + commandsSize > size) return false;
  const commands = readAt(fd, offset + 32, commandsSize);
  if (commands.length !== commandsSize) return false;
  let dylinker: string | undefined;
  let entry = false;
  for (let index = 0, at = 0; index < count; index++) {
    if (at + 8 > commandsSize) return false;
    const command = commands.readUInt32LE(at);
    const commandSize = commands.readUInt32LE(at + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || at + commandSize > commandsSize) return false;
    if (command === LC_SEGMENT_64) {
      if (commandSize < 72) return false;
      const end = commands.readBigUInt64LE(at + 40) + commands.readBigUInt64LE(at + 48);
      if (end > BigInt(size)) return false;
    } else if (command === LC_LOAD_DYLINKER) {
      const nameAt = commandSize < 16 ? commandSize : commands.readUInt32LE(at + 8);
      const name = commands.subarray(at + nameAt, at + commandSize);
      if (nameAt < 12 || name.indexOf(0) === -1) return false;
      dylinker = name.toString("latin1", 0, name.indexOf(0));
    } else if (command === LC_MAIN || command === LC_UNIXTHREAD) {
      entry = true;
    }
    at += commandSize;
  }
  return entry && dylinker === DYLD;
};

/** A program for this host's CPU, alone or as every such slice of a universal binary. */
const machOOutcome = (fd: number, head: Buffer): ExecOutcome => {
  const cpu = MACH_O_CPU_TYPES[HostProcess.Architecture.defaultValue()];
  if (cpu === undefined) return undefined;
  const fileSize = NodeFS.fstatSync(fd).size;
  if (head.readUInt32BE(0) !== 0xcafe_babe) {
    return isMachOProgram(fd, cpu, 0, fileSize) ? "runs" : undefined;
  }
  const count = head.readUInt32BE(4);
  if (count === 0 || count > MAX_FAT_ARCHS) return undefined;
  const slices = readAt(fd, 8, count * 20);
  if (slices.length !== count * 20) return undefined;
  let found = false;
  for (let at = 0; at < slices.length; at += 20) {
    if (slices.readUInt32BE(at) !== cpu) continue;
    const offset = slices.readUInt32BE(at + 8);
    const size = slices.readUInt32BE(at + 12);
    if (offset + size > fileSize || !isMachOProgram(fd, cpu, offset, size)) return undefined;
    found = true;
  }
  return found ? "runs" : undefined;
};

const HEAD_SIZE = 256;

/**
 * What execve does with `file` in a child started in `cwd`. Not certain for a file this process
 * cannot read, a format or architecture the kernel does not load itself, which a handler of the
 * host may still run, or a file execve refuses with ENOEXEC, which ends the search and which glibc
 * runs with /bin/sh.
 */
const execOutcome = (file: string, cwd: string, interpreter = false): ExecOutcome => {
  if (!isRunnable(file)) return "next";
  try {
    const fd = NodeFS.openSync(file, "r");
    try {
      const head = readAt(fd, 0, HEAD_SIZE);
      const shebang = /^#![ \t]*([^ \t\n\0]*)/.exec(head.toString("latin1"));
      if (shebang !== null) {
        const named = shebang[1] ?? "";
        const cut = head.length === HEAD_SIZE && shebang[0].length === HEAD_SIZE;
        // Linux runs a script as an interpreter, macOS does not. The kernel refuses a cut name.
        if (interpreter || named === "" || cut) return undefined;
        return execOutcome(inCwd(cwd, named), cwd, true);
      }
      return HostProcess.Platform.defaultValue() === "darwin"
        ? machOOutcome(fd, head)
        : elfOutcome(fd, head, cwd);
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

/**
 * The file that Node's spawn runs for `command` in a child started in `cwd`, as bash reaches it,
 * since bash would search PATH for a bare name. Undefined when its search ends otherwise.
 */
const searchPath = (
  command: string,
  cwd: string,
  pathVariable: string | undefined,
  defaultPath: string,
) => {
  const files = command.includes("/")
    ? [command]
    : (pathVariable ?? defaultPath)
        .split(":")
        .map((directory) => (directory === "" ? `./${command}` : `${directory}/${command}`));
  for (const file of files) {
    const outcome = execOutcome(inCwd(cwd, file), cwd);
    if (outcome !== "next") return outcome === "runs" ? file : undefined;
  }
  return undefined;
};

/** `exec -a argv0 path` runs what Node's spawn runs for a command. */
type Exec = readonly [argv0: string, path: string];

/** What Node's spawn execs for `command`, or undefined for Node to start it as is, unheld. */
const execOf = (command: string, cwd: string, pathVariable: string | undefined) => {
  if (command === "") return undefined;
  const file = searchPath(command, cwd, pathVariable, hostDefaultPath());
  return file === undefined ? undefined : ([command, file] satisfies Exec);
};

let bash: string | null | undefined;
const findBash = () => {
  if (bash === undefined) {
    const found = isRunnable("/bin/bash")
      ? "/bin/bash"
      : searchPath("bash", process.cwd(), process.env.PATH, hostDefaultPath());
    bash = found === undefined ? null : inCwd(process.cwd(), found);
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

/** A hold through a FIFO, for a group that outlives this process. */
export interface FifoHold {
  /**
   * A FIFO the holder makes, unless it exists, and opens as `fd`: `isFifoHolderHeld`,
   * `releaseFifoHolder` and `stopFifoHolderGroup` reach it from any later process. Where it cannot,
   * the holder reads `fd` as given, and without one, the group runs unheld.
   */
  readonly fifo: string;
  /**
   * A file that must exist once the FIFO is open, or the launch exits before its command runs. A
   * process that removes it and then finds no reader on the FIFO knows the command will not run.
   */
  readonly claim?: string | undefined;
}

export type HoldOptions = {
  /** The child's fd the holder reads, above every fd the command is given. */
  readonly fd: number;
  /**
   * A child's fd above `fd` that only the holder keeps once the command runs, so its reader sees
   * EOF when the holder quits or never started.
   */
  readonly beacon?: number | undefined;
} & (
  | {
      /**
       * At EOF on `fd`, a pipe the caller opens, unless spared, the holder sends the group SIGTERM,
       * then SIGKILL this many seconds later, or SIGKILL at once for 0. Without it, EOF only lets
       * the number go.
       */
      readonly endGroupAfterSeconds?: number | undefined;
    }
  | FifoHold
);

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// Bash sets, changes or drops each of these on its way to the command. An assignment on the exec
// line gives each back as the command was given it.
const RESTORED_NAMES = new Set([
  "BASH",
  "BASHPID",
  "BASH_ARGV0",
  "BASH_COMMAND",
  "BASH_EXECUTION_STRING",
  "BASH_MONOSECONDS",
  "BASH_SUBSHELL",
  "BASH_VERSION",
  "COMP_WORDBREAKS",
  "EPOCHREALTIME",
  "EPOCHSECONDS",
  "HISTCMD",
  "IFS",
  "LINENO",
  "OLDPWD",
  "OPTERR",
  "OPTIND",
  "PS1",
  "PS2",
  "PS4",
  "PWD",
  "RANDOM",
  "SRANDOM",
  "_",
]);
// Read-only in bash, or reported on its stderr when invalid: a command given one runs unheld.
const UNRESTORABLE_NAMES = [
  "BASHOPTS",
  "BASH_COMPAT",
  "BASH_VERSINFO",
  "BASH_XTRACEFD",
  "PPID",
  "SHELLOPTS",
];
/** The SHLVL values bash passes on as given; it rewrites any other. */
const isKeptShellLevel = (level: string) => /^(0|[1-9]\d{0,2})$/.test(level) && level !== "999";

const quietLocales = new Map<string, boolean>();
/** Whether `holder` starts without a warning that it cannot set `LC_ALL`, as glibc's bash 5 gives. */
const startsQuietlyWith = (holder: string, locale: string, localePath: string | undefined) => {
  const key = `${localePath ?? ""}\0${locale}`;
  let quiet = quietLocales.get(key);
  if (quiet === undefined) {
    const probe = NodeChildProcess.spawnSync(holder, ["-p", "-c", ":"], {
      env: localePath === undefined ? { LC_ALL: locale } : { LC_ALL: locale, LOCPATH: localePath },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5_000,
    });
    quiet = probe.status === 0 && probe.stderr.length === 0;
    if (quietLocales.size >= 64) quietLocales.clear();
    quietLocales.set(key, quiet);
  }
  return quiet;
};

/** What gives the command back the variables bash changes, or undefined where nothing can. */
const restoredNames = (holder: string, env: NodeJS.ProcessEnv) => {
  if (UNRESTORABLE_NAMES.some((name) => env[name] !== undefined)) return undefined;
  if (env.SHLVL !== undefined && !isKeptShellLevel(env.SHLVL)) return undefined;
  if (env.LC_ALL && !startsQuietlyWith(holder, env.LC_ALL, env.LOCPATH)) return undefined;
  // macOS starts its protected /bin/bash without DYLD_ variables, which the command still gets.
  const assignments = Object.entries(env)
    .flatMap(([name, value]) =>
      value !== undefined && (RESTORED_NAMES.has(name) || /^DYLD_\w+$/.test(name))
        ? [`${name}=${quote(value)} `]
        : [],
    )
    .join("");
  return { assignments, unsetPwd: env.PWD === undefined };
};

/** Sends the holder's group SIGTERM, then SIGKILL `seconds` later, or SIGKILL at once for 0. */
const endGroupAfter = (seconds: number) =>
  seconds === 0
    ? "kill -s KILL -- -$$"
    : `kill -s TERM -- -$$ || exit; command -p sleep ${seconds}; kill -s KILL -- -$$`;

const holderScript = (
  options: HoldOptions,
  restore: { readonly assignments: string; readonly unsetPwd: boolean },
) => {
  const { fd, beacon } = options;
  let job: string;
  const setup: Array<string> = [];
  if ("fifo" in options) {
    const fifo = quote(options.fifo);
    // Opened before the command starts, and for writing too, so the holder never reads EOF. When
    // no FIFO can be made, the holder reads `fd` as the caller gave it, if it gave one, and the
    // command's stderr gets no word of it.
    setup.push(
      `{ [ -p ${fifo} ] || command -p mkfifo -m 600 ${fifo} 2>/dev/null; } && exec ${fd}<>${fifo}`,
    );
    // Checked after the open: a `stopFifoHolderGroup` sent after the claim went reaches this
    // reader, and one that found no reader came before this check.
    if (options.claim !== undefined) setup.push(`[ -e ${quote(options.claim)} ] || exit`);
    job = `while read -r -u ${fd} m; do case $m in q) exit;; k) ${endGroupAfter(FIFO_HOLDER_STOP_SECONDS)}; exit;; esac; done`;
  } else {
    job =
      options.endGroupAfterSeconds === undefined
        ? `read -r -u ${fd} _`
        : `r=1; while read -r -u ${fd} m; do case $m in q) exit;; u) r=;; r) r=1;; esac; done; [ -n "$r" ] || exit; ${endGroupAfter(options.endGroupAfterSeconds)}`;
  }
  const otherFds = Array.from({ length: fd - 3 }, (_, index) => ` ${index + 3}<&-`).join("");
  // Only a bare `exec` redirects for good: bash keeps a copy of an fd it redirects for one
  // command, and macOS's bash 3.2 passes that copy on through exec. Job control gives the
  // subshell a group, which its job keeps once the subshell exits and leaves it to init. The
  // command's TMOUT would end its `read` early.
  return [
    ...setup,
    "set -m",
    `( (exec </dev/null >/dev/null 2>&1${otherFds}; unset TMOUT; ${job}) & )`,
    "set +m",
    `exec ${fd}<&-${beacon === undefined ? "" : ` ${beacon}>&-`}`,
    ...(restore.unsetPwd ? ["unset PWD"] : []),
    `${restore.assignments}exec -a "$0" "$@"`,
  ].join("\n");
};

/**
 * The detached POSIX launch that holds the group of `launch`, with `shell` folded in as Node folds
 * it. Undefined without bash, where a holder that quits would stay a zombie, where bash cannot pass
 * the environment on as given, or unless exec certainly runs the command, which then starts as is,
 * for Node to run it or report its error. The caller spawns it detached, without `shell`.
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
  const restore = restoredNames(holder, env);
  if (restore === undefined) return undefined;
  return {
    command: holder,
    // Privileged mode reads no startup file, SHELLOPTS or function from the environment and passes
    // exported functions on unchanged. The command gets every variable as given, except that an
    // absent SHLVL reaches it as 0.
    args: ["-p", "-c", holderScript(options, restore), ...exec, ...args],
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

/** Whether the holder of a `fifo` hold was there to read `line`. */
const tellFifoHolder = (fifo: string, line: string) => {
  const fd = openHolderFifo(fifo);
  if (fd === undefined) return false;
  try {
    NodeFS.writeSync(fd, line);
    return true;
  } catch (cause) {
    // It quit between the open and the write.
    if ((cause as NodeJS.ErrnoException).code !== "EPIPE") throw cause;
    return false;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** The holder of a `fifo` hold quits, so the number stays its group's only while that has members. */
export function releaseFifoHolder(fifo: string): void {
  tellFifoHolder(fifo, HOLDER_LINES.quit);
}

/**
 * The holder of a `fifo` hold, which keeps the number throughout, ends its group as
 * `FIFO_HOLDER_STOP_SECONDS` says and quits. Returns whether a holder was there to do it.
 */
export function stopFifoHolderGroup(fifo: string): boolean {
  return tellFifoHolder(fifo, HOLDER_LINES.stop);
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
 * A FIFO hold through which `layerHeldProcessGroups` holds the groups it spawns, so that each number
 * stays held after this process ends, until `releaseFifoHolder`, as well as through the scope.
 */
export const HoldThroughFifo = Context.Reference<FifoHold | undefined>(
  "@t3tools/shared/processGroup/HoldThroughFifo",
  { defaultValue: () => undefined },
);

const releaseFifo = (fifo: string) =>
  Effect.try(() => releaseFifoHolder(fifo)).pipe(Effect.ignore({ log: true }));

/** The handles `layerHeldProcessGroups` returns, and whether each one's holder still keeps its number. */
const heldGroups = new WeakMap<ChildProcessSpawner.ChildProcessHandle, { held: boolean }>();

/**
 * Signals the group of a command spawned detached while its number is still ours: its holder keeps
 * it, or its leader has not exited. Returns whether a group of ours got the signal.
 */
export const signalSpawnedGroup = Effect.fn("processGroup.signalSpawnedGroup")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  signal: NodeJS.Signals,
) {
  if (heldGroups.get(handle)?.held !== true && !(yield* handle.isRunning)) return false;
  return yield* Effect.try({
    try: () => signalProcessGroup(handle.pid, signal),
    catch: (cause) => {
      const code = (cause as NodeJS.ErrnoException).code;
      return PlatformError.systemError({
        _tag: code === "ESRCH" ? "NotFound" : "Unknown",
        module: "ChildProcess",
        method: "kill",
        pathOrDescriptor: handle.pid,
        description: `Failed to send ${signal} to process group ${handle.pid}`,
        cause,
      });
    },
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(false),
    ),
  );
});

const spawnHeld = Effect.fnUntraced(function* (
  spawner: Spawner,
  command: ChildProcess.StandardCommand,
) {
  const { options } = command;
  const fds = Object.keys(options.additionalFds ?? {}).map(ChildProcess.parseFdName);
  const fd = 1 + Math.max(2, ...fds.map((fd) => fd ?? 2));
  const beacon = fd + 1;
  const fifo = yield* HoldThroughFifo;
  const held = holdProcessGroup(
    {
      command: command.command,
      args: command.args,
      cwd: options.cwd,
      env: options.extendEnv ? { ...process.env, ...options.env } : options.env,
      shell: options.shell,
    },
    fifo === undefined ? { fd, beacon } : { fd, beacon, ...fifo },
  );
  if (held === undefined) return yield* spawner.spawn(command);
  const restore = reportAs(
    commandText(held.command, held.args),
    commandText(command.command, command.args),
  );
  // Added ahead of the spawner's own finalizer, so it runs after every finalizer that may signal.
  const hold = { held: false };
  let release: Effect.Effect<void> = Effect.void;
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      hold.held = false;
      return release;
    }),
  );
  // The pipe holds the group where no FIFO can be made. A spawn whose child started always installs
  // its release, which an interrupt before the spawner returned would skip.
  const handle = yield* Effect.uninterruptible(
    spawner
      .spawn(
        ChildProcess.make(held.command, held.args, {
          ...options,
          shell: false,
          additionalFds: {
            ...options.additionalFds,
            [`fd${fd}`]: { type: "input" },
            [`fd${beacon}`]: { type: "output" },
          },
        }),
      )
      .pipe(
        Effect.tap((handle) =>
          Effect.sync(() => {
            const endPipe = Effect.ignore(Stream.run(Stream.empty, handle.getInputFd(fd)));
            release =
              fifo === undefined ? endPipe : Effect.andThen(releaseFifo(fifo.fifo), endPipe);
            hold.held = true;
          }),
        ),
      ),
  ).pipe(Effect.mapError(restore));
  // Once bash runs the command only the holder keeps the beacon, so its end means the number is
  // free to go: the holder quit, was killed, or never started.
  yield* Effect.ignore(Stream.runDrain(handle.getOutputFd(beacon))).pipe(
    Effect.andThen(
      Effect.sync(() => {
        hold.held = false;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const heldHandle = ChildProcessSpawner.makeHandle({
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
  heldGroups.set(heldHandle, hold);
  return heldHandle;
});

/**
 * Effect's Node spawner signals a detached command's group after its leader's exit. On POSIX this
 * spawner holds each detached command's group until its scope's finalizers have run, and with
 * `HoldThroughFifo`, where its FIFO can be made, past this process's end. A pipeline is not held,
 * nor the failing exit of a command left running, unreferenced, past them.
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
