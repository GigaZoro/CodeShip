// @effect-diagnostics-next-line nodeBuiltinImport:off -- A stopped worker's trees end from its exit listener, outside every fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeWorkerThreads from "node:worker_threads";

import { flattenCommand } from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { HOLDER_LINES, holdProcessGroup } from "@t3tools/shared/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { WINDOWS_STOP_TREE_ARGS, windowsStopTreeArgs } from "@t3tools/shared/windowsProcessTree";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const STOP_TREE_TIMEOUT_MS = 30_000;

// Spawning blocks the calling thread until the child exists, for seconds when CreateProcessW is slow
// on a loaded Windows machine. Children start on this worker and their stdio is relayed, so a slow
// start stalls only the worker. Inline source also runs in bundles and single-executable builds.
const workerSource = `
const { parentPort } = require("node:worker_threads");
const { spawn, execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const GRACE_MS = 1000;
const POLL_MS = 10;
const HIGH_WATER_BYTES = 1 << 20;
const HOLDER_LINES = ${JSON.stringify(HOLDER_LINES)};
const STOP_TREE_ARGS = ${JSON.stringify(WINDOWS_STOP_TREE_ARGS)};
const STOP_TREE_TIMEOUT_MS = ${STOP_TREE_TIMEOUT_MS};
const children = new Map();
const post = (message, transfer) => parentPort.postMessage(message, transfer);
const describe = (error) => ({
  message: String(error && error.message !== undefined ? error.message : error),
  code: error && error.code,
  errno: error && error.errno,
  syscall: error && error.syscall,
  path: error && error.path,
});
const reply = (id, seq, error) => {
  if (seq === undefined) return;
  post({ type: "done", id, seq, error: error === undefined || error === null ? undefined : describe(error) });
};
const released = () => new Error("The child process handle was released");
// A released entry stays until its exit and output have been relayed, so an unreferenced child's
// output still reaches a reader after its scope closed, and until its last termination finished.
// Nothing signals its group after that, so its holder quits and lets the number go.
const retire = (entry) => {
  if (!entry.released || entry.exit === null || entry.open.size > 0 || entry.terminating > 0) return;
  if (children.delete(entry.id) && entry.held) entry.holder.end(HOLDER_LINES.quit);
};

const nap = new Int32Array(new SharedArrayBuffer(4));
// Until Node reports the leader's exit it is unreaped, and its pid still names the group. After
// that only a holder (holdProcessGroup) keeps the number from an unrelated group.
const isAlive = (entry) => {
  if (entry.exit === null) return true;
  if (!entry.held) return false;
  try {
    process.kill(-entry.child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Windows has no process groups, and taskkill finds descendants only through a running leader, so
// this walks the tree in PowerShell (windowsProcessTree.ts), also after the leader exited.
const stopTree = ({ pid, since, spawnedAt }, done) => {
  const call = " " + [pid, since, since, spawnedAt].join(" ");
  const args = STOP_TREE_ARGS.map((arg, index) => (index === STOP_TREE_ARGS.length - 1 ? arg + call : arg));
  const failed = (why) => done(new Error("Could not stop the process tree of " + pid + ": " + why));
  try {
    execFile("powershell.exe", args, { windowsHide: true, timeout: STOP_TREE_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return done(undefined);
      failed(
        error.killed
          ? "PowerShell did not finish in time"
          : typeof error.code === "number"
            ? "PowerShell exited " + error.code + ": " + String(stderr).trim()
            : error.message,
      );
    });
  } catch (error) {
    // Spawn errors such as ENOMEM throw rather than reach the callback.
    failed(error.message);
  }
};
const signalGroup = (entry, signal, done) => {
  const fallback = () =>
    done(entry.child.kill(signal) ? undefined : new Error("Failed to kill child process"));
  if (process.platform === "win32") {
    return stopTree(entry.root, (error) => (error !== undefined && entry.exit === null ? fallback() : done(error)));
  }
  if (!entry.detached) return entry.exit === null ? fallback() : done(undefined);
  if (entry.exit !== null && !entry.held) return done(undefined);
  try {
    process.kill(-entry.child.pid, signal);
  } catch (error) {
    // Once the leader exited, ESRCH or EPERM (no member could take it; see signalProcessGroup) means
    // nothing of ours is left to signal.
    if (entry.exit !== null && (error.code === "ESRCH" || error.code === "EPERM")) return done(undefined);
    return fallback();
  }
  done(undefined);
};
const awaitGroup = (entry, timeoutMs, done) => {
  const deadline = performance.now() + timeoutMs;
  let timer;
  const poll = () => {
    clearTimeout(timer);
    if (performance.now() >= deadline || !isAlive(entry)) {
      entry.child.off("exit", poll);
      done();
      return;
    }
    timer = setTimeout(poll, POLL_MS);
  };
  entry.child.on("exit", poll);
  poll();
};
const whenExited = (entry, done) => {
  if (entry.exit !== null) done();
  else entry.child.once("exit", () => done());
};
const terminate = (entry, signal, forceKillAfterMs, done) => {
  entry.terminating += 1;
  const settle = (error) => {
    entry.terminating -= 1;
    retire(entry);
    done(error);
  };
  signalGroup(entry, signal, (error) => {
    if (error !== undefined) return settle(error);
    const finish = () => whenExited(entry, () => settle(undefined));
    if (forceKillAfterMs === undefined) return awaitGroup(entry, GRACE_MS, finish);
    awaitGroup(entry, forceKillAfterMs, () => {
      if (!isAlive(entry)) return finish();
      signalGroup(entry, "SIGKILL", (error) =>
        error !== undefined ? settle(error) : awaitGroup(entry, GRACE_MS, finish),
      );
    });
  });
};

const relayOutput = (entry, fd) => {
  const stream = entry.child.stdio[fd];
  if (!stream) {
    entry.open.delete(fd);
    post({ type: "end", id: entry.id, fd });
    return;
  }
  const output = { stream, unacked: 0, paused: false };
  entry.outputs.set(fd, output);
  stream.on("data", (chunk) => {
    if (entry.discarding) return;
    const copy = new Uint8Array(chunk);
    output.unacked += copy.byteLength;
    post({ type: "data", id: entry.id, fd, chunk: copy }, [copy.buffer]);
    if (!output.paused && output.unacked >= HIGH_WATER_BYTES) {
      output.paused = true;
      stream.pause();
    }
  });
  const close = (message) => {
    if (!entry.open.delete(fd)) return;
    post(message);
    retire(entry);
  };
  stream.on("end", () => close({ type: "end", id: entry.id, fd }));
  stream.on("error", (error) => close({ type: "streamError", id: entry.id, fd, error: describe(error) }));
};

const start = ({ id, command, args, options, holderFd, outputs, inputs, encoding, killSignal, forceKillAfterMs, stallMs }) => {
  if (stallMs > 0) Atomics.wait(nap, 0, 0, stallMs);
  let child;
  // The system's clock, which a Windows tree walk compares with process creation times.
  const since = Date.now();
  try {
    child = spawn(command, args, options);
  } catch (error) {
    post({ type: "spawnFailed", id, error: describe(error) });
    return;
  }
  const holder = holderFd === undefined ? null : child.stdio[holderFd];
  const entry = {
    id,
    child,
    root: { pid: child.pid, since, spawnedAt: Date.now() },
    holder,
    held: holder !== null,
    exit: null,
    started: false,
    released: false,
    terminating: 0,
    discarding: false,
    detached: options.detached,
    encoding,
    killSignal,
    forceKillAfterMs,
    outputs: new Map(),
    open: new Set(outputs),
  };
  children.set(id, entry);
  if (entry.held) {
    // The parent ends a stopped worker's referenced children itself once their holder is gone.
    const lost = () => {
      if (!entry.held) return;
      entry.held = false;
      if (children.has(id)) post({ type: "unheld", id });
    };
    // Read only to learn of the holder's end.
    holder.on("end", lost).on("close", lost).on("error", lost).resume();
  }
  child.on("error", (error) => {
    // Later errors are failed kills, which signalGroup reports through child.kill's result.
    if (entry.started) return;
    entry.started = true;
    children.delete(id);
    post({ type: "spawnFailed", id, error: describe(error) });
  });
  child.on("spawn", () => {
    entry.started = true;
    post({ type: "spawned", id, root: entry.root });
  });
  child.on("exit", (code, signal) => {
    entry.exit = { code, signal };
    post({ type: "exit", id, code, signal });
    // A Windows tree walk starts PowerShell, too slow for every failed command; see leftBehind.
    if (code !== 0 && code !== null && entry.held) {
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // The group is already gone.
      }
    }
    retire(entry);
  });
  for (const fd of outputs) relayOutput(entry, fd);
  for (const fd of inputs) {
    // Write and end callbacks report these errors; without a listener they would end the worker.
    if (child.stdio[fd]) child.stdio[fd].on("error", () => {});
  }
};

// Nothing reads a referenced child's output once its scope closed, so it is discarded and cannot
// block the child's exit.
const discard = (entry) => {
  entry.discarding = true;
  for (const output of entry.outputs.values()) {
    output.paused = false;
    output.stream.resume();
  }
};
// Whether to end what a leader that exited may have left running. A Windows tree walk starts
// PowerShell, too slow for every command, so it runs only for a cancelled command or one whose
// output pipe is still open, as when what the leader left running holds it.
const leftBehind = (entry, referenced, interrupted) => {
  if (process.platform === "win32") return referenced && (interrupted || entry.open.size > 0);
  const failed = entry.exit.code !== 0 && entry.exit.code !== null;
  return entry.held && (failed || referenced);
};
const release = (entry, { id, seq, referenced, interrupted, signal, forceKillAfterMs }) => {
  entry.released = true;
  if (referenced) discard(entry);
  const finish = (error) => {
    retire(entry);
    reply(id, seq, error);
  };
  if (entry.exit !== null) {
    return leftBehind(entry, referenced, interrupted)
      ? terminate(entry, signal, forceKillAfterMs, finish)
      : finish(undefined);
  }
  if (!referenced) return finish(undefined);
  terminate(entry, signal, forceKillAfterMs, finish);
};

// One start per turn, so the poll between turns relays the exits and output of running children.
// A turn first answers the syncs sent before the previous turn ended: the poll since then delivered
// every exit that came before them. A sync waits for the start in progress, not the queued ones.
const queued = new Map();
const syncs = [];
let lastTurnEnd = 0n;
let turnScheduled = false;
const scheduleTurn = () => {
  if (turnScheduled) return;
  turnScheduled = true;
  setImmediate(turn);
};
const turn = () => {
  turnScheduled = false;
  while (syncs.length > 0 && syncs[0].sentAt <= lastTurnEnd) post({ type: "synced", seq: syncs.shift().seq });
  const [next] = queued.values();
  if (next !== undefined) {
    queued.delete(next.id);
    start(next);
  }
  lastTurnEnd = process.hrtime.bigint();
  if (queued.size > 0 || syncs.length > 0) scheduleTurn();
};

parentPort.on("message", (message) => {
  if (message.type === "spawn") {
    queued.set(message.id, message);
    return scheduleTurn();
  }
  if (message.type === "sync") {
    syncs.push(message);
    return scheduleTurn();
  }
  // The worker that ran these children stopped.
  if (message.type === "killTree") return stopTree(message.root, (error) => reply(undefined, message.seq, error));
  if (message.type === "abandon" && queued.delete(message.id)) return;
  const { id, seq } = message;
  const entry = children.get(id);
  if (entry === undefined) {
    if (seq !== undefined) reply(id, seq, message.type === "release" ? undefined : released());
    return;
  }
  switch (message.type) {
    case "ack": {
      const output = entry.outputs.get(message.fd);
      if (output === undefined) return;
      output.unacked -= message.bytes;
      if (output.paused && output.unacked < HIGH_WATER_BYTES / 2) {
        output.paused = false;
        output.stream.resume();
      }
      return;
    }
    case "write": {
      const stream = entry.child.stdio[message.fd];
      if (!stream) return reply(id, seq, undefined);
      const last = message.chunks.length - 1;
      message.chunks.forEach((chunk, index) =>
        stream.write(chunk, entry.encoding, index === last ? (error) => reply(id, seq, error) : undefined),
      );
      return;
    }
    case "end": {
      const stream = entry.child.stdio[message.fd];
      if (!stream || stream.closed) return reply(id, seq, undefined);
      stream.end((error) => reply(id, seq, error));
      return;
    }
    case "terminate":
      return terminate(entry, message.signal, message.forceKillAfterMs, (error) => reply(id, seq, error));
    case "release":
      return release(entry, message);
    // At its pipe's end, as when this worker stops, a holder ends a referenced child's group.
    case "ref":
      if (entry.held) entry.holder.write(message.referenced ? HOLDER_LINES.end : HOLDER_LINES.spare);
      return;
    // The caller was interrupted before it learned that this child started; it ends as on release.
    case "abandon":
      return release(entry, {
        id,
        seq: undefined,
        referenced: true,
        interrupted: true,
        signal: entry.killSignal,
        forceKillAfterMs: entry.forceKillAfterMs,
      });
  }
});
`;

interface WorkerError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
}

type WorkerEvent =
  | { readonly type: "spawned"; readonly id: number; readonly root: StartedChild }
  | { readonly type: "spawnFailed"; readonly id: number; readonly error: WorkerError }
  | { readonly type: "data"; readonly id: number; readonly fd: number; readonly chunk: Uint8Array }
  | { readonly type: "end"; readonly id: number; readonly fd: number }
  | {
      readonly type: "streamError";
      readonly id: number;
      readonly fd: number;
      readonly error: WorkerError;
    }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: string | null;
    }
  | { readonly type: "unheld"; readonly id: number }
  | {
      readonly type: "done";
      readonly id: number;
      readonly seq: number;
      readonly error: WorkerError | undefined;
    }
  | { readonly type: "synced"; readonly seq: number };

type ExitStatus = readonly [code: number | null, signal: string | null];
type OutputQueue = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done>;
type StdioOption = "pipe" | "inherit" | "ignore" | "overlapped";

interface Connection {
  readonly worker: NodeWorkerThreads.Worker;
  readonly children: Map<number, RemoteChild>;
  readonly replies: Map<number, PendingReply>;
  readonly syncs: Map<number, () => void>;
  held: number;
  stopped: Error | undefined;
}

interface PendingReply {
  readonly method: string;
  readonly command: ChildProcess.StandardCommand;
  readonly resume: (error: PlatformError.PlatformError | undefined) => void;
}

// How to end a child with its descendants: its process group on POSIX when detached, its process
// tree through a walk of Win32_Process on Windows, otherwise only the child.
type Kills = "group" | "tree" | "leader";

/** Times are the system clock's, read in the worker just before and after the start. */
interface StartedChild {
  readonly pid: number;
  readonly since: number;
  readonly spawnedAt: number;
}

interface RemoteChild {
  readonly id: number;
  readonly connection: Connection;
  readonly command: ChildProcess.StandardCommand;
  readonly kills: Kills;
  // A holder keeps the group's number past the leader's exit and ends the group if the worker stops,
  // until the worker reports that it ended.
  held: boolean;
  // Logs through the spawning fiber's logger a failure no fiber awaits, as after its worker stopped.
  readonly report: (error: PlatformError.PlatformError) => void;
  readonly exit: Deferred.Deferred<ExitStatus, PlatformError.PlatformError>;
  readonly outputs: ReadonlyMap<number, OutputQueue>;
  readonly open: Set<number>;
  starting: ((outcome: StartedChild | PlatformError.PlatformError) => void) | undefined;
  root: StartedChild | undefined;
  referenced: boolean;
  holdsWorker: boolean;
  released: boolean;
}

interface ResolvedAdditionalFd {
  readonly fd: number;
  readonly config: ChildProcess.AdditionalFdConfig;
}

const systemErrorTags: Partial<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ENOTDIR: "BadResource",
  ELOOP: "BadResource",
  EBUSY: "Busy",
};

// The same errors NodeChildProcessSpawner reports, so callers classify both spawners alike.
const toPlatformError = (
  method: string,
  error: NodeJS.ErrnoException,
  command: ChildProcess.StandardCommand,
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: systemErrorTags[error.code ?? ""] ?? "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: `${command.command} ${command.args.join(" ")}`,
    syscall: error.syscall,
    cause: error,
  });

const fromWorkerError = (error: WorkerError): NodeJS.ErrnoException =>
  Object.assign(new Error(error.message), {
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
  });

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const fdLabel = (fd: number) =>
  fd === 0 ? "stdin" : fd === 1 ? "stdout" : fd === 2 ? "stderr" : ChildProcess.fdName(fd);

const isPipe = (option: StdioOption | undefined) => option === "pipe" || option === "overlapped";

const forceKillMillis = (input: Duration.Input | undefined) =>
  input === undefined ? undefined : Duration.toMillis(input);

const resolveStdinOption = (options: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
  const defaultConfig: ChildProcess.StdinConfig = {
    stream: "pipe",
    encoding: "utf-8",
    endOnDone: true,
  };
  if (options.stdin === undefined) return defaultConfig;
  if (typeof options.stdin === "string" || Stream.isStream(options.stdin)) {
    return { ...defaultConfig, stream: options.stdin };
  }
  return {
    stream: options.stdin.stream,
    encoding: options.stdin.encoding ?? defaultConfig.encoding,
    endOnDone: options.stdin.endOnDone ?? defaultConfig.endOnDone,
  };
};

const resolveOutputOption = (
  option: ChildProcess.CommandOptions["stdout"],
): ChildProcess.CommandOutput => {
  if (option === undefined) return "pipe";
  if (typeof option === "string" || Sink.isSink(option)) return option;
  return option.stream ?? "pipe";
};

const resolveAdditionalFds = (
  options: ChildProcess.CommandOptions,
): ReadonlyArray<ResolvedAdditionalFd> => {
  const result: Array<ResolvedAdditionalFd> = [];
  for (const [name, config] of Object.entries(options.additionalFds ?? {})) {
    const fd = ChildProcess.parseFdName(name);
    if (fd !== undefined) result.push({ fd, config });
  }
  return result.toSorted((a, b) => a.fd - b.fd);
};

const buildStdioArray = (
  stdin: ChildProcess.CommandInput,
  stdout: ChildProcess.CommandOutput,
  stderr: ChildProcess.CommandOutput,
  additionalFds: ReadonlyArray<ResolvedAdditionalFd>,
): Array<StdioOption> => {
  const stdio: Array<StdioOption> = [
    Stream.isStream(stdin) ? "pipe" : stdin,
    Sink.isSink(stdout) ? "pipe" : stdout,
    Sink.isSink(stderr) ? "pipe" : stderr,
  ];
  const maxFd = additionalFds.reduce((max, { fd }) => Math.max(max, fd), 2);
  for (let fd = 3; fd <= maxFd; fd++) stdio[fd] = "ignore";
  for (const { fd } of additionalFds) stdio[fd] = "pipe";
  return stdio;
};

const getSourceStream = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  from: ChildProcess.PipeFromOption | undefined,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const option = from ?? "stdout";
  if (option === "stdout") return handle.stdout;
  if (option === "stderr") return handle.stderr;
  if (option === "all") return handle.all;
  const fd = ChildProcess.parseFdName(option);
  return fd === undefined ? handle.stdout : handle.getOutputFd(fd);
};

// One worker per process, started on first use. Handles may outlive the layer that spawned them,
// as the processes themselves do, and deadlines settle against this worker.
let current: Connection | undefined;
let nextId = 0;
let nextSeq = 0;
let startStallMs = 0;
let workerStartsFail = false;

// An idle worker must not keep the process alive; a referenced child or a pending request does.
const hold = (connection: Connection) => {
  if (connection.held++ === 0) connection.worker.ref();
};
const unhold = (connection: Connection) => {
  if (--connection.held === 0) connection.worker.unref();
};

const post = (connection: Connection, message: object) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
  connection.worker.postMessage(message);
};

const retire = (child: RemoteChild) => {
  if (child.released && Deferred.isDoneUnsafe(child.exit) && child.open.size === 0) {
    child.connection.children.delete(child.id);
  }
};

const sigkill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It is already gone.
  }
};

interface Orphan {
  readonly child: RemoteChild;
  readonly root: StartedChild;
}

// Only for when no worker can start, as starting PowerShell blocks this thread. A stopped worker
// relays no exits, so a leader's pid alone may name an unrelated process by now.
const stopTreeHere = ({ child, root }: Orphan) => {
  const args = windowsStopTreeArgs({
    pid: root.pid,
    since: root.since,
    created: { from: root.since, to: root.spawnedAt },
  });
  const failed = (why: string) => {
    const cause = new Error(`Could not stop the process tree of ${root.pid}: ${why}`);
    child.report(toPlatformError("kill", cause, child.command));
  };
  try {
    NodeChildProcess.execFile(
      "powershell.exe",
      args,
      { windowsHide: true, timeout: STOP_TREE_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error === null) return;
        failed(
          error.killed
            ? "PowerShell did not finish in time"
            : typeof error.code === "number"
              ? `PowerShell exited ${error.code}: ${String(stderr).trim()}`
              : error.message,
        );
      },
    );
  } catch (cause) {
    // Spawn errors such as ENOMEM throw rather than reach the callback, here inside the worker's
    // exit listener, which must still end the stopped worker's other children.
    failed(toError(cause).message);
  }
};

const killTrees = (trees: ReadonlyArray<Orphan>) => {
  let connection: Connection;
  try {
    connection = connect();
  } catch {
    for (const orphan of trees) stopTreeHere(orphan);
    return;
  }
  for (const { child, root } of trees) {
    const seq = nextSeq++;
    connection.replies.set(seq, {
      method: "kill",
      command: child.command,
      resume: (error) => {
        if (error !== undefined) child.report(error);
      },
    });
    hold(connection);
    post(connection, { type: "killTree", root, seq });
  }
};

// Nothing supervises the children of a stopped worker, so the referenced ones end with it, with
// the descendants that outlived their leader. Unreferenced ones may outlive it.
const killOrphans = (children: Iterable<RemoteChild>) => {
  const trees: Array<Orphan> = [];
  for (const child of children) {
    const root = child.root;
    // A held group ends through its holder, which reads EOF once the stopped worker's pipes closed.
    if (!child.referenced || root === undefined || child.held) continue;
    if (child.kills === "tree") {
      trees.push({ child, root });
      continue;
    }
    // The worker relays every exit it ran a callback for, so an unrelayed leader is unreaped unless
    // the worker stopped between libuv's reap and that callback.
    if (!Deferred.isDoneUnsafe(child.exit)) sigkill(child.kills === "group" ? -root.pid : root.pid);
  }
  if (trees.length > 0) killTrees(trees);
};

const stop = (connection: Connection, cause: Error) => {
  if (connection.stopped !== undefined) return;
  connection.stopped = cause;
  if (current === connection) current = undefined;
  for (const resume of connection.syncs.values()) resume();
  connection.syncs.clear();
  for (const reply of connection.replies.values()) {
    reply.resume(toPlatformError(reply.method, cause, reply.command));
  }
  connection.replies.clear();
  killOrphans(connection.children.values());
  for (const child of connection.children.values()) {
    const error = toPlatformError("worker", cause, child.command);
    child.starting?.(error);
    for (const queue of child.outputs.values()) Queue.failCauseUnsafe(queue, Cause.fail(error));
    Deferred.doneUnsafe(child.exit, Exit.fail(error));
  }
  connection.children.clear();
};

const receive = (connection: Connection, event: WorkerEvent) => {
  if (event.type === "synced") {
    const resume = connection.syncs.get(event.seq);
    if (resume === undefined) return;
    connection.syncs.delete(event.seq);
    unhold(connection);
    resume();
    return;
  }
  // A reply can follow the exit that retired its child.
  if (event.type === "done") {
    const reply = connection.replies.get(event.seq);
    if (reply === undefined) return;
    connection.replies.delete(event.seq);
    unhold(connection);
    reply.resume(
      event.error === undefined
        ? undefined
        : toPlatformError(reply.method, fromWorkerError(event.error), reply.command),
    );
    return;
  }
  const child = connection.children.get(event.id);
  if (child === undefined) return;
  switch (event.type) {
    case "spawned":
      child.starting?.(event.root);
      return;
    case "spawnFailed":
      child.starting?.(toPlatformError("spawn", fromWorkerError(event.error), child.command));
      return;
    case "data": {
      const queue = child.outputs.get(event.fd);
      if (queue !== undefined) Queue.offerUnsafe(queue, event.chunk);
      return;
    }
    case "end": {
      const queue = child.outputs.get(event.fd);
      if (queue !== undefined) Queue.endUnsafe(queue);
      child.open.delete(event.fd);
      retire(child);
      return;
    }
    case "streamError": {
      const queue = child.outputs.get(event.fd);
      const method = `fromReadable(${fdLabel(event.fd)})`;
      const error = toPlatformError(method, fromWorkerError(event.error), child.command);
      if (queue !== undefined) Queue.failCauseUnsafe(queue, Cause.fail(error));
      child.open.delete(event.fd);
      retire(child);
      return;
    }
    case "exit":
      Deferred.doneUnsafe(child.exit, Exit.succeed([event.code, event.signal] as const));
      if (child.holdsWorker) {
        child.holdsWorker = false;
        unhold(connection);
      }
      retire(child);
      return;
    case "unheld":
      child.held = false;
      return;
  }
};

const connect = (): Connection => {
  if (current !== undefined) return current;
  if (workerStartsFail) throw new Error("The process spawner worker could not start");
  const worker = new NodeWorkerThreads.Worker(workerSource, {
    eval: true,
    env: NodeWorkerThreads.SHARE_ENV,
  });
  worker.unref();
  const connection: Connection = {
    worker,
    children: new Map(),
    replies: new Map(),
    syncs: new Map(),
    held: 0,
    stopped: undefined,
  };
  worker.on("message", (event: WorkerEvent) => receive(connection, event));
  worker.on("error", (cause) => stop(connection, cause));
  worker.on("exit", (code) =>
    stop(connection, new Error(`The process spawner worker exited with code ${code}`)),
  );
  current = connection;
  return connection;
};

/**
 * Waits until the worker has relayed the exits and output of children that ended before this call,
 * which it holds back while it starts a process. That start delays it; the starts queued behind it
 * do not. Returns at once when no child runs on the worker.
 */
export const settle: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const connection = current;
  if (connection === undefined || connection.children.size === 0) {
    resume(Effect.void);
    return;
  }
  const seq = nextSeq++;
  connection.syncs.set(seq, () => resume(Effect.void));
  hold(connection);
  // hrtime is one clock for every thread of the process, so the worker can order it with its turns.
  post(connection, { type: "sync", seq, sentAt: process.hrtime.bigint() });
  return Effect.sync(() => {
    if (connection.syncs.delete(seq)) unhold(connection);
  });
});

const request = (child: RemoteChild, method: string, message: object) =>
  Effect.callback<void, PlatformError.PlatformError>((resume) => {
    const connection = child.connection;
    if (connection.stopped !== undefined) {
      resume(Effect.fail(toPlatformError(method, connection.stopped, child.command)));
      return;
    }
    const seq = nextSeq++;
    connection.replies.set(seq, {
      method,
      command: child.command,
      resume: (error) => resume(error === undefined ? Effect.void : Effect.fail(error)),
    });
    hold(connection);
    post(connection, { ...message, id: child.id, seq });
    return Effect.sync(() => {
      if (connection.replies.delete(seq)) unhold(connection);
    });
  });

const launch = (
  command: ChildProcess.StandardCommand,
  message: object,
  outputs: ReadonlyMap<number, OutputQueue>,
  kills: Kills,
  held: boolean,
  report: RemoteChild["report"],
) =>
  Effect.callback<RemoteChild, PlatformError.PlatformError>((resume) => {
    let connection: Connection;
    try {
      connection = connect();
    } catch (cause) {
      resume(Effect.fail(toPlatformError("spawn", toError(cause), command)));
      return;
    }
    const id = nextId++;
    const child: RemoteChild = {
      id,
      connection,
      command,
      kills,
      held,
      report,
      exit: Deferred.makeUnsafe(),
      outputs,
      open: new Set(outputs.keys()),
      starting: undefined,
      root: undefined,
      referenced: true,
      holdsWorker: false,
      released: false,
    };
    child.starting = (outcome) => {
      child.starting = undefined;
      unhold(connection);
      if (!("pid" in outcome)) {
        connection.children.delete(id);
        resume(Effect.fail(outcome));
        return;
      }
      child.root = outcome;
      if (!Deferred.isDoneUnsafe(child.exit)) {
        child.holdsWorker = true;
        hold(connection);
      }
      resume(Effect.succeed(child));
    };
    connection.children.set(id, child);
    hold(connection);
    post(connection, {
      ...message,
      type: "spawn",
      id,
      stallMs: startStallMs,
    });
    return Effect.sync(() => {
      if (child.starting === undefined) return;
      child.starting = undefined;
      unhold(connection);
      connection.children.delete(id);
      post(connection, { type: "abandon", id });
    });
  });

// A released child stays registered until its exit and output arrived, so an unreferenced one can
// still be killed and read.
const forget = (child: RemoteChild) => {
  if (child.holdsWorker) {
    child.holdsWorker = false;
    unhold(child.connection);
  }
  child.released = true;
  retire(child);
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;

  // Each spawn already sits inside the caller's git or process span.
  const spawnStandard = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const options = command.options;
    const stdinConfig = resolveStdinOption(options);
    const stdout = resolveOutputOption(options.stdout);
    const stderr = resolveOutputOption(options.stderr);
    const additionalFds = resolveAdditionalFds(options);
    const stdio = buildStdioArray(stdinConfig.stream, stdout, stderr, additionalFds);
    const outputFds = [
      1,
      2,
      ...additionalFds.flatMap((entry) => (entry.config.type === "output" ? [entry.fd] : [])),
    ].filter((fd) => isPipe(stdio[fd]));
    const inputFds = [
      0,
      ...additionalFds.flatMap((entry) => (entry.config.type === "input" ? [entry.fd] : [])),
    ].filter((fd) => isPipe(stdio[fd]));
    const cwd =
      options.cwd === undefined
        ? undefined
        : yield* fs.access(options.cwd).pipe(Effect.as(path.resolve(options.cwd)));
    const detached = options.detached ?? platform !== "win32";
    const env = options.extendEnv ? { ...process.env, ...options.env } : options.env;
    const holderFd = stdio.length;
    const held =
      platform === "win32" || !detached
        ? undefined
        : holdProcessGroup(
            { command: command.command, args: command.args, cwd, env, shell: options.shell },
            { fd: holderFd, endGroupAfterSeconds: 0 },
          );
    const killSignal = options.killSignal ?? "SIGTERM";
    const forceKillAfterMs = forceKillMillis(options.forceKillAfter);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const report = (error: PlatformError.PlatformError) => {
      runFork(Effect.logError("Could not end a child process tree", error));
    };
    const outputs = new Map<number, OutputQueue>();
    for (const fd of outputFds) {
      outputs.set(
        fd,
        yield* Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
      );
    }

    const child = yield* Effect.acquireRelease(
      launch(
        command,
        {
          command: held?.command ?? command.command,
          args: held?.args ?? command.args,
          options: {
            cwd,
            env,
            stdio: held === undefined ? stdio : [...stdio, "pipe"],
            detached,
            shell: held === undefined ? options.shell : undefined,
            windowsHide: options.windowsHide ?? !detached,
          },
          holderFd: held === undefined ? undefined : holderFd,
          outputs: outputFds,
          inputs: inputFds,
          encoding: stdinConfig.encoding,
          killSignal,
          forceKillAfterMs,
        },
        outputs,
        platform === "win32" ? "tree" : detached ? "group" : "leader",
        held !== undefined,
        report,
      ),
      (child, exit) =>
        // A stopped worker's children were ended by killOrphans, which reports its own failures.
        (child.connection.stopped === undefined
          ? request(child, "release", {
              type: "release",
              referenced: child.referenced,
              interrupted: Exit.hasInterrupts(exit),
              signal: killSignal,
              forceKillAfterMs,
            }).pipe(Effect.ignore({ log: "Error" }))
          : Effect.void
        ).pipe(Effect.ensuring(Effect.sync(() => forget(child)))),
      // A command cancelled while its start waits behind others stops waiting; the worker drops it.
      { interruptible: true },
    );

    const inputSink = (
      fd: number,
      endOnDone: boolean,
    ): Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> => {
      if (!inputFds.includes(fd)) return Sink.drain;
      const method = `fromWritable(${fdLabel(fd)})`;
      const write = Sink.forEachArray((chunks: Arr.NonEmptyReadonlyArray<Uint8Array>) =>
        request(child, method, { type: "write", fd, chunks }),
      );
      return endOnDone
        ? write.pipe(Sink.mapEffect(() => request(child, method, { type: "end", fd })))
        : write;
    };
    const outputStream = (fd: number): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
      const queue = outputs.get(fd);
      if (queue === undefined) return Stream.empty;
      return Stream.fromQueue(queue).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            if (child.connection.children.has(child.id)) {
              post(child.connection, { type: "ack", id: child.id, fd, bytes: chunk.byteLength });
            }
          }),
        ),
      );
    };

    const stdin = inputSink(0, stdinConfig.endOnDone ?? true);
    if (Stream.isStream(stdinConfig.stream)) {
      yield* Effect.forkScoped(Stream.run(stdinConfig.stream, stdin));
    }
    const stdoutStream = Sink.isSink(stdout)
      ? Stream.transduce(outputStream(1), stdout)
      : outputStream(1);
    const stderrStream = Sink.isSink(stderr)
      ? Stream.transduce(outputStream(2), stderr)
      : outputStream(2);

    const inputSinks = new Map<
      number,
      Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>
    >();
    const outputStreams = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>();
    for (const { fd, config } of additionalFds) {
      if (config.type === "input") {
        const sink = inputSink(fd, true);
        if (config.stream !== undefined) yield* Effect.forkScoped(Stream.run(config.stream, sink));
        inputSinks.set(fd, sink);
      } else {
        const stream = outputStream(fd);
        outputStreams.set(
          fd,
          config.sink === undefined ? stream : Stream.transduce(stream, config.sink),
        );
      }
    }

    const setReferenced = (referenced: boolean) => {
      child.referenced = referenced;
      if (child.held && child.connection.children.has(child.id)) {
        post(child.connection, { type: "ref", id: child.id, referenced });
      }
    };
    const reref = Effect.sync(() => {
      if (child.referenced) return;
      setReferenced(true);
      if (!Deferred.isDoneUnsafe(child.exit) && child.connection.stopped === undefined) {
        child.holdsWorker = true;
        hold(child.connection);
      }
    });

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(child.root?.pid ?? 0),
      exitCode: Effect.flatMap(Deferred.await(child.exit), ([code, signal]) =>
        code !== null
          ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
          : Effect.fail(
              toPlatformError(
                "exitCode",
                new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                command,
              ),
            ),
      ),
      isRunning: Effect.map(Deferred.isDone(child.exit), (done) => !done),
      kill: (killOptions) =>
        request(child, "kill", {
          type: "terminate",
          signal: killOptions?.killSignal ?? "SIGTERM",
          forceKillAfterMs: forceKillMillis(killOptions?.forceKillAfter),
        }).pipe(Effect.andThen(Deferred.await(child.exit)), Effect.asVoid),
      unref: Effect.sync(() => {
        if (child.referenced) {
          setReferenced(false);
          if (child.holdsWorker) {
            child.holdsWorker = false;
            unhold(child.connection);
          }
        }
        return reref;
      }),
      stdin,
      stdout: stdoutStream,
      stderr: stderrStream,
      all: Stream.merge(stdoutStream, stderrStream),
      getInputFd: (fd) => inputSinks.get(fd) ?? Sink.drain,
      getOutputFd: (fd) => outputStreams.get(fd) ?? Stream.empty,
    });
  });

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  > = Effect.fnUntraced(function* (command) {
    if (command._tag === "StandardCommand") return yield* spawnStandard(command);
    const { commands, pipeOptions } = flattenCommand(command);
    const [root, ...pipeline] = commands;
    const first = yield* spawnStandard(root);
    const handles = [first];
    let last = first;
    for (const [index, next] of pipeline.entries()) {
      const source = getSourceStream(last, pipeOptions[index]?.from);
      const fd = ChildProcess.parseFdName(pipeOptions[index]?.to ?? "stdin");
      last = yield* spawnStandard(
        fd === undefined
          ? ChildProcess.make(next.command, next.args, {
              ...next.options,
              stdin: { ...resolveStdinOption(next.options), stream: source },
            })
          : ChildProcess.make(next.command, next.args, {
              ...next.options,
              additionalFds: {
                ...next.options.additionalFds,
                [ChildProcess.fdName(fd) as `fd${number}`]: {
                  type: "input" as const,
                  stream: source,
                },
              },
            }),
      );
      handles.push(last);
    }
    return ChildProcessSpawner.makeHandle({
      pid: last.pid,
      exitCode: last.exitCode,
      isRunning: last.isRunning,
      kill: (options) =>
        Effect.forEach(handles.toReversed(), (handle) => Effect.ignore(handle.kill(options)), {
          discard: true,
        }),
      unref: Effect.gen(function* () {
        const rerefs: Array<Effect.Effect<void, PlatformError.PlatformError>> = [];
        for (const handle of handles) rerefs.push(yield* handle.unref);
        return Effect.forEach(rerefs.toReversed(), (reref) => reref, { discard: true });
      }),
      stdin: first.stdin,
      stdout: last.stdout,
      stderr: last.stderr,
      all: last.all,
      getInputFd: last.getInputFd,
      getOutputFd: last.getOutputFd,
    });
  });

  return ChildProcessSpawner.make(spawnCommand);
});

/** @internal Exported for tests. */
export const __testing = {
  /** Within the scope, the worker blocks this long before each start, as a slow CreateProcessW does. */
  slowStarts: (ms: number) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        startStallMs = ms;
      }),
      () =>
        Effect.sync(() => {
          startStallMs = 0;
        }),
    ),
  /** Within the scope, starting a worker fails, as when its thread cannot be created. */
  failWorkerStarts: Effect.acquireRelease(
    Effect.sync(() => {
      workerStartsFail = true;
    }),
    () =>
      Effect.sync(() => {
        workerStartsFail = false;
      }),
  ),
  /** Ends the worker the way a crash does; the next spawn starts a new one. */
  stopWorker: Effect.promise(async () => {
    await current?.worker.terminate();
  }),
};

export const layer: Layer.Layer<
  ChildProcessSpawner.ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make);
