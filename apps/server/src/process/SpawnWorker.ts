// @effect-diagnostics nodeBuiltinImport:off - worker threads and Node streams implement the platform spawner boundary.
import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { supportsEnvChdir } from "@t3tools/shared/envTrampoline";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type WindowsProcessTreeRoot,
  windowsStopTreeArgs,
} from "@t3tools/shared/windowsProcessTreeScript";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";

// Windows runs CreateProcess synchronously on the calling thread, and antivirus or a busy disk can
// hold it for seconds; Linux's spawn waits for chdir and the PATH search, which a hung mount
// stalls. Workers own the children, so only the worker waits.
const MAX_WORKERS = 4;
const MAX_IDLE_WORKERS = 1;

type ToWorker =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: NodeChildProcess.SpawnOptions;
    }
  | { readonly type: "write"; readonly id: number; readonly fd: number; readonly data: Uint8Array }
  | { readonly type: "end"; readonly id: number; readonly fd: number }
  | { readonly type: "flow"; readonly id: number; readonly fd: number; readonly paused: boolean }
  | { readonly type: "destroy"; readonly id: number; readonly fd: number }
  | { readonly type: "kill"; readonly id: number; readonly signal: NodeJS.Signals | number };

interface SerializedError {
  readonly message: string;
  readonly [key: string]: unknown;
}

type FromWorker =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly pid: number | undefined;
      /** Wall-clock milliseconds around the worker's own spawn() call, which creates the process. */
      readonly createdFrom: number;
      readonly createdTo: number;
    }
  | { readonly type: "error"; readonly id: number; readonly error: SerializedError }
  | { readonly type: "data"; readonly id: number; readonly fd: number; readonly data: Uint8Array }
  | {
      readonly type: "written";
      readonly id: number;
      readonly fd: number;
      readonly error?: SerializedError;
    }
  | { readonly type: "eof"; readonly id: number; readonly fd: number }
  | { readonly type: "finished"; readonly id: number; readonly fd: number }
  | {
      readonly type: "stream-error";
      readonly id: number;
      readonly fd: number;
      readonly error: SerializedError;
    }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly endedAt: number;
    }
  | { readonly type: "close"; readonly id: number };

// Windows makes a child's stdio pipes inheritable for the length of its CreateProcess, so a child
// another worker launches meanwhile inherits them and holds the first child's output open. Every
// pool's workers take this lock around spawn(); it holds the owning worker's threadId.
const windowsSpawnLock = new Int32Array(new SharedArrayBuffer(4));

// Inline source runs from bundles, asar archives and single-executable builds without module files.
const workerSource = `
const { parentPort, threadId, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { lock } = workerData;
const locked = (launch) => {
  if (lock === undefined) return launch();
  // Wait on the owner compareExchange saw: an unlock after it changes the value, so no wakeup is lost.
  for (let owner; (owner = Atomics.compareExchange(lock, 0, 0, threadId)) !== 0; ) Atomics.wait(lock, 0, owner);
  try {
    return launch();
  } finally {
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0, 1);
  }
};
const children = new Map();
const post = (message, transfer) => parentPort.postMessage(message, transfer);
const serialize = (error) => {
  const out = { message: String(error && error.message) };
  for (const key of ["code", "errno", "syscall", "path", "spawnargs"]) {
    if (error && error[key] !== undefined) out[key] = error[key];
  }
  return out;
};
parentPort.on("message", (request) => {
  const { id } = request;
  if (request.type === "spawn") {
    let launch;
    try {
      launch = locked(() => {
        // Waiting for the lock must not widen the creation window used to identify the child.
        const createdFrom = Date.now();
        const child = spawn(request.command, request.args, request.options);
        return { child, createdFrom, createdTo: Date.now() };
      });
    } catch (error) {
      // The caller hears this as a failed launch, which ends with a close like any other.
      post({ type: "error", id, error: serialize(error) });
      post({ type: "close", id });
      return;
    }
    const { child, createdFrom, createdTo } = launch;
    children.set(id, child);
    child.on("spawn", () => post({ type: "spawn", id, pid: child.pid, createdFrom, createdTo }));
    child.on("error", (error) => post({ type: "error", id, error: serialize(error) }));
    child.on("exit", (code, signal) => post({ type: "exit", id, code, signal, endedAt: Date.now() }));
    // Output can still arrive after exit; close follows the last of it.
    child.on("close", () => {
      children.delete(id);
      post({ type: "close", id });
    });
    child.stdio?.forEach((stream, fd) => {
      if (!stream) return;
      stream.on("error", (error) => post({ type: "stream-error", id, fd, error: serialize(error) }));
      if (fd === 0) return;
      // Cloning a Buffer copies its whole backing store; copy the bytes once and transfer them.
      stream.on("data", (chunk) => {
        const data = new Uint8Array(chunk);
        post({ type: "data", id, fd, data }, [data.buffer]);
      });
      stream.on("end", () => post({ type: "eof", id, fd }));
    });
    return;
  }
  const child = children.get(id);
  if (child === undefined) {
    if (request.type === "write") post({ type: "written", id, fd: request.fd, error: { message: "write after exit", code: "EPIPE" } });
    if (request.type === "end") post({ type: "finished", id, fd: request.fd });
    return;
  }
  const stream = child.stdio?.[request.fd];
  switch (request.type) {
    case "write":
      if (!stream || stream.destroyed) {
        post({ type: "written", id, fd: request.fd, error: { message: "write after end", code: "EPIPE" } });
        return;
      }
      try {
        stream.write(request.data, (error) => post({ type: "written", id, fd: request.fd, error: error ? serialize(error) : undefined }));
      } catch (error) {
        post({ type: "written", id, fd: request.fd, error: serialize(error) });
      }
      return;
    case "end":
      if (!stream || stream.destroyed || stream.writableFinished) post({ type: "finished", id, fd: request.fd });
      else stream.end(() => post({ type: "finished", id, fd: request.fd }));
      return;
    case "flow":
      if (request.paused) stream?.pause();
      else stream?.resume();
      return;
    case "destroy":
      stream?.destroy();
      return;
    case "kill":
      try {
        child.kill(request.signal);
      } catch {}
      return;
  }
});
`;

const toError = (serialized: SerializedError) =>
  Object.assign(new Error(serialized.message), serialized);

const toBuffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

const brokenPipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

/** As a Node pipe at EOF: read(0) ends an empty stream even while a 'readable' listener holds it. */
const endOutput = (stream: NodeStream.Readable) => {
  stream.push(null);
  stream.read(0);
};

/** What Node's spawn reports for its kill on abort. */
const abortError = (cause: unknown) =>
  Object.assign(new Error("The operation was aborted", { cause }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });

class WorkerChild
  extends NodeEvents.EventEmitter
  implements NodeChildProcessSpawner.SpawnedChildProcess
{
  pid: number | undefined;
  treeRoot: WindowsProcessTreeRoot | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin: NodeStream.Writable | null = null;
  stdout: NodeStream.Readable | null = null;
  stderr: NodeStream.Readable | null = null;
  readonly stdio: Array<NodeStream.Readable | NodeStream.Writable | null | undefined> = [];
  referenced = true;
  killed = false;
  spawned = false;
  exited = false;
  stopTreeOnKill = false;
  isTreeStop = false;
  #stopTreeRequested = false;
  #treeStopping: { close?: () => void } | undefined;
  readonly #writes = new Map<number, Array<(error?: Error | null) => void>>();
  readonly #finals = new Map<number, (error?: Error | null) => void>();
  readonly #paused = new Set<number>();
  #abandoned = false;
  #abortListener: Disposable | undefined;
  #launched = false;
  /** An abort that came before the launch was sent; its kill follows the send. */
  #abortedEarly = false;
  /** An abort whose kill went out before the start was reported; Node reports it after the start. */
  #abortedBeforeStart: { readonly reason: unknown } | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #killSignal: NodeJS.Signals | number;
  // Once the launch is sent, the kill goes out before abort() returns, as with Node's own spawn.
  // Until the start is reported it acts as an abort that came before Node's spawn: the start is
  // reported first, or a failed launch alone, as the worker cannot know the outcome sooner.
  readonly #abort = () => {
    if (!this.#launched) {
      this.#abortedEarly = true;
      return;
    }
    const reason = this.#signal?.reason;
    if (!this.kill(this.#killSignal)) return;
    if (this.spawned) this.emit("error", abortError(reason));
    else this.#abortedBeforeStart = { reason };
  };
  // Node's flushStdio: once a child exits, its output flows, unless a 'readable' listener holds it.
  readonly #flushOutput = () => {
    for (const stream of this.#outputs()) {
      if (stream.readable) stream.resume();
    }
  };

  readonly worker: SpawnWorker;
  readonly id: number;

  constructor(
    worker: SpawnWorker,
    id: number,
    stdio: ReadonlyArray<unknown>,
    signal: AbortSignal | undefined,
    killSignal: NodeJS.Signals | number,
  ) {
    super();
    this.worker = worker;
    this.id = id;
    this.#signal = signal;
    this.#killSignal = killSignal;
    stdio.forEach((option, fd) => {
      if (option !== "pipe" && option !== "overlapped") return;
      const stream = this.#relay(fd);
      this.stdio[fd] = stream;
      if (fd === 0) this.stdin = stream as NodeStream.Writable;
      else if (fd === 1) this.stdout = stream as NodeStream.Readable;
      else if (fd === 2) this.stderr = stream as NodeStream.Readable;
    });
    // An AbortSignal cannot cross to the worker, so this thread kills on abort as Node's spawn
    // does. Its state is read only here, before the launch is sent, so nothing after the send can
    // throw; the listener runs even when another one stops the event.
    if (signal?.aborted) this.#abortedEarly = true;
    else if (signal !== undefined)
      this.#abortListener = NodeEvents.EventEmitter.addAbortListener(signal, this.#abort);
  }

  /** The launch was sent, so an abort can reach the worker; one that came first kills on the next tick, as Node's does. */
  launched(): void {
    this.#launched = true;
    if (this.#abortedEarly) process.nextTick(this.#abort);
  }

  started(): void {
    this.emit("spawn");
    const aborted = this.#abortedBeforeStart;
    this.#abortedBeforeStart = undefined;
    if (aborted !== undefined) this.emit("error", abortError(aborted.reason));
  }

  /** Node reports a failed launch's errno as its exit code, and it was killed by nothing. */
  failed(error: Error): void {
    this.exited = true;
    this.killed = false;
    this.#abortedBeforeStart = undefined;
    this.exitCode = "errno" in error && typeof error.errno === "number" ? error.errno : null;
    this.emit("error", error);
    process.nextTick(this.#flushOutput);
  }

  /** Nothing more comes for this child; Node reports its close once every output has ended. */
  closed(): void {
    if (this.#treeStopping !== undefined) {
      this.#treeStopping.close = () => this.#emitClose();
      return;
    }
    this.#emitClose();
  }

  #emitClose(): void {
    // Only 'end' and 'close' listeners, so an error after this close stays the caller's, as in Node.
    const open = this.#outputs().filter((stream) => !stream.readableEnded && !stream.destroyed);
    let remaining = open.length + 1;
    const settle = () => {
      remaining--;
      if (remaining === 0) this.emit("close", this.exitCode, this.signalCode);
    };
    for (const stream of open) {
      const done = () => {
        stream.off("end", done).off("close", done);
        settle();
      };
      stream.on("end", done).on("close", done);
    }
    settle();
  }

  #outputs(): Array<NodeStream.Readable> {
    return this.stdio.filter((stream) => stream instanceof NodeStream.Readable);
  }

  #detachSignal(): void {
    this.#abortListener?.[Symbol.dispose]();
    this.#abortListener = undefined;
  }

  #relay(fd: number): NodeStream.Readable | NodeStream.Writable {
    const read = () => {
      if (this.#paused.delete(fd))
        this.worker.post({ type: "flow", id: this.id, fd, paused: false });
    };
    const write = (
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) => {
      if (this.#unreachable()) {
        callback(brokenPipe());
        return;
      }
      const pending = this.#writes.get(fd) ?? [];
      pending.push(callback);
      this.#writes.set(fd, pending);
      const data = new Uint8Array(chunk);
      this.worker.post({ type: "write", id: this.id, fd, data }, [data.buffer]);
    };
    const final = (callback: (error?: Error | null) => void) => {
      if (this.#unreachable()) {
        callback(brokenPipe());
        return;
      }
      this.#finals.set(fd, callback);
      this.worker.post({ type: "end", id: this.id, fd });
    };
    // A caller that destroys its end closes the child pipe, as it would with a real pipe. After the
    // exit too: a descendant can hold the pipe open, and the child closes only once it is shut.
    const destroy = (error: Error | null, callback: (error?: Error | null) => void) => {
      if (!this.#abandoned) this.worker.post({ type: "destroy", id: this.id, fd });
      callback(error);
    };
    if (fd === 0) return new NodeStream.Writable({ write, final, destroy });
    if (fd <= 2) return new NodeStream.Readable({ read, destroy });
    return new NodeStream.Duplex({ read, write, final, destroy, allowHalfOpen: true });
  }

  /** No reply for this child can arrive, so a request sent now would never settle. */
  #unreachable(): boolean {
    return this.#abandoned || this.worker.closed;
  }

  onData(fd: number, data: Uint8Array): void {
    const stream = this.stdio[fd];
    if (!stream || !("push" in stream)) return;
    if (!stream.push(toBuffer(data)) && !this.#paused.has(fd)) {
      this.#paused.add(fd);
      this.worker.post({ type: "flow", id: this.id, fd, paused: true });
    }
  }

  onEof(fd: number): void {
    const stream = this.stdio[fd];
    if (stream && "push" in stream) endOutput(stream);
  }

  onFinished(fd: number): void {
    const callback = this.#finals.get(fd);
    this.#finals.delete(fd);
    callback?.();
  }

  onWritten(fd: number, error: SerializedError | undefined): void {
    const callback = this.#writes.get(fd)?.shift();
    callback?.(error === undefined ? null : toError(error));
  }

  onStreamError(fd: number, error: SerializedError): void {
    this.stdio[fd]?.destroy(toError(error));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    // A closed launcher drops the request, so nothing would be signalled.
    if (this.exited || this.#unreachable()) return false;
    this.killed = true;
    this.worker.post({ type: "kill", id: this.id, signal });
    if (this.stopTreeOnKill && signal !== 0) this.#stopTreeRequested = true;
    return true;
  }

  ref(): void {
    this.referenced = true;
    this.worker.syncRef();
  }

  unref(): void {
    this.referenced = false;
    this.worker.syncRef();
  }

  exit(code: number | null, signal: NodeJS.Signals | null, endedAt?: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.#detachSignal();
    // Node destroys stdin on exit; the Effect sink may already have removed its error listener.
    this.stdin?.on("error", () => {});
    this.stdin?.destroy();
    const root = this.treeRoot;
    if (root !== undefined && endedAt !== undefined) {
      // After the native exit the walk may stop descendants, but must never reopen the leader.
      const ended = { ...root, ended: endedAt };
      this.treeRoot = ended;
      if (this.#stopTreeRequested) {
        const stopping: { close?: () => void } = {};
        this.#treeStopping = stopping;
        this.worker.pool.killTree(ended, () => {
          this.#treeStopping = undefined;
          this.emit("exit", code, signal);
          stopping.close?.();
        });
        process.nextTick(this.#flushOutput);
        return;
      }
    }
    this.emit("exit", code, signal);
    process.nextTick(this.#flushOutput);
  }

  /** Nothing more reaches this child's process: end output so readers finish, and fail waiting writes. */
  abandon(): void {
    // First, so a write or end that a failure callback below makes is refused, not lost.
    this.#abandoned = true;
    // A launch that failed never exits, and a long-lived signal would keep this child.
    this.#detachSignal();
    // Not destroy(error): Effect leaves an unread stderr's pipe without an error listener.
    for (const stream of this.stdio) {
      if (stream && "push" in stream && !stream.readableEnded) endOutput(stream);
      else if (stream && !("push" in stream)) stream.destroy();
    }
    const waiting = [...[...this.#writes.values()].flat(), ...this.#finals.values()];
    this.#writes.clear();
    this.#finals.clear();
    for (const callback of waiting) callback(brokenPipe());
  }
}

class SpawnWorker {
  readonly worker: NodeWorkerThreads.Worker;
  readonly children = new Map<number, WorkerChild>();
  readonly pool: SpawnWorkerPool;
  // Node sets worker.threadId to -1 after exit, but the lock still holds its original id.
  readonly threadId: number;
  #failure: Error | undefined;
  /** Launches being sent or not yet answered; the worker is inside CreateProcess for one of them. */
  launching = 0;
  closed = false;

  constructor(pool: SpawnWorkerPool) {
    this.pool = pool;
    this.worker = new NodeWorkerThreads.Worker(workerSource, {
      eval: true,
      workerData: { lock: pool.platform === "win32" ? windowsSpawnLock : undefined },
    });
    this.threadId = this.worker.threadId;
    this.worker.on("message", (message: FromWorker) => this.onMessage(message));
    this.worker.on("error", (error) => {
      this.#failure = error;
    });
    // Node emits exit last, after any spawn or exit messages that carry a child's identity.
    this.worker.on("exit", () =>
      this.fail(this.#failure ?? new Error("The process launcher thread exited.")),
    );
    this.worker.unref();
  }

  post(message: ToWorker, transfer?: ReadonlyArray<ArrayBuffer>): void {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  spawn(
    id: number,
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ): WorkerChild {
    // Counted before any caller getter runs, so none can close this launcher under the launch. The
    // launch is sent last and the child registered after it, so a call that throws starts nothing.
    this.launching++;
    let child: WorkerChild | undefined;
    try {
      const io = options.stdio;
      const stdio =
        typeof io === "string" || io === undefined
          ? [io ?? "pipe", io ?? "pipe", io ?? "pipe"]
          : io;
      const { signal, ...rest } = options;
      const launch: ToWorker = {
        type: "spawn",
        id,
        command,
        args: [...args],
        options: {
          ...rest,
          cwd: rest.cwd instanceof URL ? NodeURL.fileURLToPath(rest.cwd) : rest.cwd,
          stdio,
          // A worker's process.env is a copy from when it started; children get the server's current one.
          env: rest.env ?? { ...process.env },
        },
      };
      child = new WorkerChild(this, id, stdio, signal, rest.killSignal ?? "SIGTERM");
      this.post(launch);
    } catch (error) {
      this.launching--;
      child?.abandon();
      this.syncRef();
      this.pool.release(this);
      throw error;
    }
    child.launched();
    this.children.set(id, child);
    this.syncRef();
    return child;
  }

  syncRef(): void {
    if (this.closed) return;
    const referenced =
      this.launching > 0 || [...this.children.values()].some((child) => child.referenced);
    if (referenced) this.worker.ref();
    else this.worker.unref();
  }

  onMessage(message: FromWorker): void {
    const child = this.children.get(message.id);
    if (child === undefined) return;
    switch (message.type) {
      case "spawn":
        this.launching--;
        // An unref() made while the launch was in flight takes effect now.
        this.syncRef();
        child.spawned = true;
        child.pid = message.pid;
        if (message.pid !== undefined) {
          const created = { from: message.createdFrom, to: message.createdTo };
          child.treeRoot = { pid: message.pid, since: created.from, created, ended: "running" };
        }
        child.started();
        break;
      case "error":
        if (child.spawned) {
          child.emit("error", toError(message.error));
          break;
        }
        this.launching--;
        this.syncRef();
        // Node reports a failed launch before it fails the writes waiting on the child, and its
        // close after both; the worker's close releases the child.
        child.failed(toError(message.error));
        child.abandon();
        break;
      case "data":
        child.onData(message.fd, message.data);
        break;
      case "written":
        child.onWritten(message.fd, message.error);
        break;
      case "eof":
        child.onEof(message.fd);
        break;
      case "finished":
        child.onFinished(message.fd);
        break;
      case "stream-error":
        child.onStreamError(message.fd, message.error);
        break;
      case "exit":
        child.exit(message.code, message.signal, message.endedAt);
        break;
      case "close":
        child.closed();
        this.release(child);
        break;
    }
  }

  release(child: WorkerChild): void {
    this.children.delete(child.id);
    // Replies to requests it sent meanwhile would find no child.
    child.abandon();
    this.syncRef();
    this.pool.release(this);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.close();
    for (const child of this.children.values()) {
      // Nothing more comes from the worker, so each child ends here with the close it would send.
      const end = () => {
        child.abandon();
        child.closed();
      };
      if (child.exited) {
        end();
        continue;
      }
      if (!child.spawned) {
        child.failed(error);
        end();
        continue;
      }
      // The worker owned the only handle, so try to end the whole tree before reporting the exit.
      const finish = () => {
        child.exit(null, "SIGKILL");
        end();
      };
      if (child.treeRoot === undefined || child.isTreeStop) finish();
      else this.pool.killTree(child.treeRoot, finish);
    }
    this.children.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool.workers.delete(this);
    void this.worker.terminate().then(() => {
      // The thread may have died holding the lock, or between its unlock and notify, or after
      // a notify woke it: free the lock and wake every waiter so none sleeps on a free lock.
      Atomics.compareExchange(windowsSpawnLock, 0, this.threadId, 0);
      Atomics.notify(windowsSpawnLock, 0);
    });
  }
}

class SpawnWorkerPool {
  readonly workers = new Set<SpawnWorker>();
  readonly platform: NodeJS.Platform;
  readonly #runFork: (effect: Effect.Effect<void>) => unknown;
  #nextId = 0;
  #closed = false;

  constructor(
    platform: NodeJS.Platform,
    runFork: (effect: Effect.Effect<void>) => unknown = Effect.runFork,
  ) {
    this.platform = platform;
    this.#runFork = runFork;
  }

  /** A tree stop failed, so processes it was ending may still run. */
  report(error: Error): void {
    this.#runFork(Effect.logError("Could not end a child process tree", error));
  }

  readonly spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    const workers = [...this.workers];
    // A worker inside CreateProcess cannot start another launch until it returns.
    const worker =
      workers.find((candidate) => candidate.launching === 0) ??
      (workers.length < MAX_WORKERS
        ? this.#add()
        : workers.reduce((best, candidate) =>
            candidate.launching < best.launching ? candidate : best,
          ));
    return worker.spawn(++this.#nextId, command, args, options);
  };

  killTree(root: WindowsProcessTreeRoot, done: () => void): void {
    if (this.platform !== "win32") {
      try {
        process.kill(root.pid, "SIGKILL");
      } catch {}
      done();
      return;
    }
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    // Once the leader's handle is gone, only the walk may signal processes.
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(deadline);
      if (failure !== undefined) {
        this.report(new Error(`Could not stop the process tree of ${root.pid}: ${failure}`));
      }
      done();
    };
    if (root.created === "unknown") {
      finish("Process creation time is unavailable");
      return;
    }
    let stop: WorkerChild;
    try {
      stop = this.spawn(windowsPowerShellPath(process.env), windowsStopTreeArgs(root), {
        stdio: "ignore",
        windowsHide: true,
      });
      stop.isTreeStop = true;
    } catch (error) {
      // Starting a launcher thread throws when the system refuses one.
      finish(error instanceof Error ? error.message : String(error));
      return;
    }
    // @effect-diagnostics-next-line globalTimers:off -- the pool has no Effect scope and the cleanup deadline must not keep Node alive.
    deadline = NodeTimers.setTimeout(() => {
      stop.kill("SIGKILL");
      stop.unref();
      finish("PowerShell did not finish within 30 s");
    }, 30_000).unref();
    stop
      .on("error", (error: Error) => finish(error.message))
      .on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        finish(code === 0 ? undefined : `PowerShell exited ${code ?? signal}`),
      );
  }

  #add(): SpawnWorker {
    const worker = new SpawnWorker(this);
    this.workers.add(worker);
    return worker;
  }

  release(worker: SpawnWorker): void {
    if (worker.children.size > 0 || worker.launching > 0) return;
    const idle = [...this.workers].filter(
      (candidate) => candidate.children.size === 0 && candidate.launching === 0,
    );
    if (this.#closed || idle.length > MAX_IDLE_WORKERS) worker.close();
  }

  /**
   * Keeps no idle launcher from now on. A launcher with children ends after its last one closes,
   * so a child whose scope outlives the pool can still be written to, stopped and seen to exit.
   */
  close(): void {
    this.#closed = true;
    for (const worker of this.workers) this.release(worker);
  }
}

let sharedPool: SpawnWorkerPool | undefined;

/** A piped `child_process.spawn` for Windows launches outside Effect's spawner. */
export const spawnPiped = (
  command: string,
  args: ReadonlyArray<string>,
  options: Omit<NodeChildProcess.SpawnOptions, "stdio"> & {
    /** Disable this when the caller owns tree cleanup for every exit. */
    readonly stopTreeOnKill?: boolean;
  },
) => {
  const { stopTreeOnKill = true, ...spawnOptions } = options;
  const child = (sharedPool ??= new SpawnWorkerPool("win32")).spawn(command, args, {
    ...spawnOptions,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stopTreeOnKill = stopTreeOnKill && HostProcess.Platform.defaultValue() === "win32";
  return child as WorkerChild & {
    readonly stdin: NodeStream.Writable;
    readonly stdout: NodeStream.Readable;
    readonly stderr: NodeStream.Readable;
  };
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new SpawnWorkerPool(platform, runFork)),
      (pool) => Effect.sync(() => pool.close()),
    );
    return NodeChildProcessSpawner.layerWithSpawn(pool.spawn);
  }),
);

/** Workers on Windows, and on Linux where `NonBlockingSpawner` has no GNU `env -C` to use. */
export const layerServer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform === "win32") return layer;
    if (platform === "linux" && !(yield* Effect.promise(supportsEnvChdir))) return layer;
    return NodeChildProcessSpawner.layer;
  }),
);

/** @internal Exported for tests. */
export const __testing = { SpawnWorkerPool };
