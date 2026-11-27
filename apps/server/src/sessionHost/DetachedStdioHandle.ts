// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- IPC socket bridge between server providers and the detached session host broker.
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  encodeBrokerMessage,
  parseBrokerServerMessage,
  type BrokerClientMessage,
  type BrokerServerMessage,
} from "./protocol.ts";

const DETACH_ACK_TIMEOUT_MS = 500;
/**
 * A frame reaches the projection through the Codex client, the adapter and the run's ingestion,
 * and a planned shutdown stops those after it detaches. The replay point for the next server is
 * the newest frame received this long before the detach, so frames that may still have been in
 * flight are sent again rather than lost; the adopting adapter ignores what it already has.
 */
export const DETACH_REPLAY_OVERLAP_MS = 5_000;
const ATTACH_TIMEOUT_MS = 10_000;

export interface DetachedAttachedInfo {
  readonly sessionHostId: string;
  readonly brokerPid: number;
  readonly brokerIdentity: string | null;
  readonly childPid: number | null;
  readonly latestSeq: number;
  readonly oldestSeq: number;
  readonly droppedFrames: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DetachedStdioHandleOptions {
  readonly sessionHostId: string;
  readonly socketPath: string;
  readonly authToken: string;
  readonly initialAfterSeq?: number;
  readonly onAckSeq?: (seq: number) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  /** Keep stdout until releaseOutput: an adopted turn must be registered before its frames run. */
  readonly holdOutput?: boolean;
  /** Monotonic milliseconds; tests replace it. */
  readonly now?: () => number;
}

type PendingClientAction =
  | { readonly kind: "message"; readonly message: BrokerClientMessage }
  | { readonly kind: "detach" }
  | { readonly kind: "terminate"; readonly signal?: NodeJS.Signals };

export class DetachedStdioHandle {
  readonly sessionHostId: string;
  readonly socketPath: string;
  readonly authToken: string;

  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly stdin: NodeStream.Writable;
  readonly events = new NodeEvents.EventEmitter();

  private socket: NodeNet.Socket | null = null;
  private attachedInfo: DetachedAttachedInfo | null = null;
  private lastAckedSeqValue: number;
  private detachingForUpdateFlag = false;
  private detachedFlag = false;
  private killedFlag = false;
  private exitedFlag = false;
  private exitCodeValue: number | null = null;
  private signalCodeValue: NodeJS.Signals | null = null;
  private pendingActions: Array<PendingClientAction> = [];
  private heldOutput: Array<string> | null;
  private readonly now: () => number;
  private readonly recentFrames: Array<{ readonly seq: number; readonly receivedAt: number }> = [];
  private settledSeqValue: number;

  private readonly onAckSeq: ((seq: number) => void) | undefined;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly onExit:
    | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;

  private readonly attachedPromise: Promise<DetachedAttachedInfo>;
  private resolveAttached!: (info: DetachedAttachedInfo) => void;
  private rejectAttached!: (error: Error) => void;
  private attachedSettled = false;

  private readonly replayCompletePromise: Promise<number>;
  private resolveReplayComplete!: (latestSeq: number) => void;
  private rejectReplayComplete!: (error: Error) => void;
  private replaySettled = false;

  private readonly exitPromise: Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  private resolveExit!: (result: {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void;

  private detachResolver: ((seq: number) => void) | null = null;

  constructor(options: DetachedStdioHandleOptions) {
    this.sessionHostId = options.sessionHostId;
    this.socketPath = options.socketPath;
    this.authToken = options.authToken;
    this.lastAckedSeqValue = options.initialAfterSeq ?? 0;
    this.settledSeqValue = this.lastAckedSeqValue;
    this.heldOutput = options.holdOutput === true ? [] : null;
    this.now = options.now ?? (() => performance.now());
    this.onAckSeq = options.onAckSeq;
    this.onStderr = options.onStderr;
    this.onExit = options.onExit;

    this.attachedPromise = new Promise<DetachedAttachedInfo>((resolve, reject) => {
      this.resolveAttached = resolve;
      this.rejectAttached = reject;
    });
    // Prevent unhandled rejections if callers only listen on events or streams.
    this.attachedPromise.catch(() => {});

    this.replayCompletePromise = new Promise<number>((resolve, reject) => {
      this.resolveReplayComplete = resolve;
      this.rejectReplayComplete = reject;
    });
    this.replayCompletePromise.catch(() => {});

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.stdin = new NodeStream.Writable({
      write: (chunk: Buffer | string, encoding: BufferEncoding, callback) => {
        if (this.detachingForUpdateFlag || this.exitedFlag) {
          callback();
          return;
        }
        if (typeof chunk === "string") {
          this.sendOrQueue({ type: "stdin", data: chunk, encoding: "utf8" });
        } else if (encoding === ("buffer" as BufferEncoding) || Buffer.isBuffer(chunk)) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          this.sendOrQueue({
            type: "stdin",
            data: buf.toString("base64"),
            encoding: "base64",
          });
        } else {
          this.sendOrQueue({ type: "stdin", data: String(chunk), encoding: "utf8" });
        }
        callback();
      },
      final: (callback) => {
        if (!this.detachingForUpdateFlag && !this.exitedFlag) {
          this.sendOrQueue({ type: "stdin_end" });
        }
        callback();
      },
    });
  }

  static createPending(options: DetachedStdioHandleOptions): DetachedStdioHandle {
    return new DetachedStdioHandle(options);
  }

  static async connect(options: DetachedStdioHandleOptions): Promise<DetachedStdioHandle> {
    const handle = new DetachedStdioHandle(options);
    await handle.connectSocket(options.initialAfterSeq ?? 0);
    return handle;
  }

  get lastAckedSeq(): number {
    return this.lastAckedSeqValue;
  }

  get detachingForUpdate(): boolean {
    return this.detachingForUpdateFlag;
  }

  get detached(): boolean {
    return this.detachedFlag;
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.signalCodeValue;
  }

  get killed(): boolean {
    return this.killedFlag;
  }

  get info(): DetachedAttachedInfo | null {
    return this.attachedInfo;
  }

  waitForAttached(): Promise<DetachedAttachedInfo> {
    return this.attachedPromise;
  }

  waitForReplayComplete(): Promise<number> {
    return this.replayCompletePromise;
  }

  waitForExit(): Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }> {
    return this.exitPromise;
  }

  /** The replay point for the server after a planned update; see DETACH_REPLAY_OVERLAP_MS. */
  replayPointForUpdate(): number {
    this.settleFrames();
    return this.settledSeqValue;
  }

  releaseOutput(): void {
    const held = this.heldOutput;
    if (held === null) return;
    this.heldOutput = null;
    for (const chunk of held) this.writeStdout(chunk);
    if (this.exitedFlag && !this.stdout.writableEnded) this.stdout.end();
  }

  private writeStdout(chunk: string): void {
    if (this.heldOutput !== null) {
      this.heldOutput.push(chunk);
      return;
    }
    if (!this.stdout.writableEnded) {
      this.stdout.write(chunk, "utf8");
    }
  }

  private settleFrames(): void {
    const settledBefore = this.now() - DETACH_REPLAY_OVERLAP_MS;
    while (this.recentFrames.length > 0 && this.recentFrames[0]!.receivedAt <= settledBefore) {
      this.settledSeqValue = this.recentFrames.shift()!.seq;
    }
  }

  markDetachingForUpdate(): void {
    this.detachingForUpdateFlag = true;
  }

  writeStdin(data: string): void {
    if (this.detachingForUpdateFlag || this.exitedFlag) return;
    this.sendOrQueue({ type: "stdin", data, encoding: "utf8" });
  }

  writeStdinBytes(bytes: Uint8Array): void {
    if (this.detachingForUpdateFlag || this.exitedFlag) return;
    this.sendOrQueue({
      type: "stdin",
      data: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    });
  }

  endStdin(): void {
    if (this.detachingForUpdateFlag || this.exitedFlag) return;
    this.sendOrQueue({ type: "stdin_end" });
  }

  sendSignal(signal: NodeJS.Signals): void {
    if (this.detachingForUpdateFlag || this.exitedFlag) return;
    this.sendOrQueue({ type: "signal", signal });
  }

  async connectSocket(afterSeq: number = this.lastAckedSeqValue): Promise<DetachedAttachedInfo> {
    const socket = await new Promise<NodeNet.Socket>((resolve, reject) => {
      const conn = NodeNet.createConnection(this.socketPath);
      const onError = (error: Error) => {
        conn.removeListener("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      conn.once("error", onError);
      conn.once("connect", onConnect);
    });
    return this.bindSocket(socket, afterSeq);
  }

  bindSocket(
    socket: NodeNet.Socket,
    afterSeq: number = this.lastAckedSeqValue,
  ): Promise<DetachedAttachedInfo> {
    this.socket = socket;
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    let buffer = "";

    const attachTimer = setTimeout(() => {
      if (!this.attachedSettled) {
        const error = new Error(
          `Timed out attaching to detached session host ${this.sessionHostId}.`,
        );
        this.failStartup(error);
        socket.destroy();
      }
    }, ATTACH_TIMEOUT_MS);
    attachTimer.unref();

    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const parsed = parseBrokerServerMessage(line);
          if (parsed !== undefined) {
            this.handleServerMessage(parsed, attachTimer);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("error", (error) => {
      clearTimeout(attachTimer);
      if (!this.attachedSettled) {
        this.failStartup(error);
      } else if (!this.detachingForUpdateFlag && !this.exitedFlag) {
        this.events.emit("error", error);
      }
    });

    socket.on("close", () => {
      clearTimeout(attachTimer);
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.detachResolver !== null) {
        const resolve = this.detachResolver;
        this.detachResolver = null;
        this.finishDetached();
        resolve(this.lastAckedSeqValue);
        return;
      }
      if (this.detachingForUpdateFlag) {
        this.finishDetached();
        return;
      }
      if (!this.attachedSettled) {
        this.failStartup(
          new Error(`Session host ${this.sessionHostId} closed before attach completed.`),
        );
        return;
      }
      if (!this.exitedFlag) {
        this.recordExit(null, null);
      }
    });

    socket.write(
      encodeBrokerMessage({
        type: "attach",
        afterSeq,
        authToken: this.authToken,
      }),
    );

    return this.attachedPromise;
  }

  failStartup(error: Error): void {
    if (!this.attachedSettled) {
      this.attachedSettled = true;
      this.rejectAttached(error);
    }
    if (!this.replaySettled) {
      this.replaySettled = true;
      this.rejectReplayComplete(error);
    }
    if (!this.detachingForUpdateFlag && !this.exitedFlag) {
      if (this.events.listenerCount("error") > 0) {
        this.events.emit("error", error);
      }
      this.recordExit(1, null);
    }
  }

  async detach(): Promise<number> {
    this.detachingForUpdateFlag = true;
    if (this.detachedFlag) return this.lastAckedSeqValue;

    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      this.pendingActions.push({ kind: "detach" });
      this.finishDetached();
      return this.lastAckedSeqValue;
    }

    return await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        if (this.detachResolver !== null) {
          this.detachResolver = null;
          try {
            socket.destroy();
          } catch {
            // Ignore teardown errors.
          }
          this.finishDetached();
          resolve(this.lastAckedSeqValue);
        }
      }, DETACH_ACK_TIMEOUT_MS);
      timer.unref();

      this.detachResolver = (seq) => {
        clearTimeout(timer);
        resolve(seq);
      };

      try {
        socket.write(encodeBrokerMessage({ type: "detach" }));
      } catch {
        clearTimeout(timer);
        this.detachResolver = null;
        this.finishDetached();
        resolve(this.lastAckedSeqValue);
      }
    });
  }

  async terminate(signal?: NodeJS.Signals): Promise<void> {
    if (this.detachingForUpdateFlag) {
      await this.detach();
      return;
    }
    this.killedFlag = true;
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      this.pendingActions.push({ kind: "terminate", ...(signal !== undefined ? { signal } : {}) });
      return;
    }
    try {
      socket.write(
        encodeBrokerMessage({
          type: "terminate",
          ...(signal !== undefined ? { signal } : {}),
        }),
      );
    } catch {
      // Ignore write failures if already closing.
    }
  }

  asChildProcessHandle(): ChildProcessSpawner.ChildProcessHandle {
    const handle = this;
    const makeStreamFromPassThrough = (
      source: NodeStream.PassThrough,
    ): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
      Stream.callback<Uint8Array, PlatformError.PlatformError>((queue) =>
        Effect.gen(function* () {
          const onData = (chunk: Buffer | string) => {
            const bytes =
              typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk);
            Queue.offerUnsafe(queue, bytes);
          };
          const onEnd = () => {
            Queue.endUnsafe(queue);
          };
          const onError = (cause: Error) => {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "ChildProcess",
                  method: "stream",
                  description: cause.message,
                  cause,
                }),
              ),
            );
          };
          source.on("data", onData);
          source.once("end", onEnd);
          source.once("close", onEnd);
          source.once("error", onError);
          if (source.readableEnded) {
            Queue.endUnsafe(queue);
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              source.off("data", onData);
              source.off("end", onEnd);
              source.off("close", onEnd);
              source.off("error", onError);
            }),
          );
        }),
      );

    const stdoutStream = makeStreamFromPassThrough(handle.stdout);
    const stderrStream = makeStreamFromPassThrough(handle.stderr);
    const allStream = Stream.merge(stdoutStream, stderrStream);

    const stdinSink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.forEach<
      Uint8Array,
      void,
      PlatformError.PlatformError,
      never
    >((chunk) =>
      Effect.sync(() => {
        handle.writeStdinBytes(chunk);
      }),
    );

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(
        handle.attachedInfo?.childPid ?? handle.attachedInfo?.brokerPid ?? 0,
      ),
      stdout: stdoutStream,
      stderr: stderrStream,
      all: allStream,
      stdin: stdinSink,
      exitCode: Effect.promise(() =>
        handle.waitForExit().then((result) => ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
      ),
      isRunning: Effect.sync(() => !handle.exitedFlag && !handle.detachedFlag),
      kill: (options) =>
        Effect.promise(async () => {
          if (handle.detachingForUpdateFlag) {
            await handle.detach();
            return;
          }
          const signal =
            options?.killSignal !== undefined ? (options.killSignal as NodeJS.Signals) : "SIGTERM";
          await handle.terminate(signal);
        }),
      getInputFd: () => stdinSink,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }

  private sendOrQueue(message: BrokerClientMessage): void {
    const socket = this.socket;
    if (socket !== null && !socket.destroyed && socket.writable && this.attachedInfo !== null) {
      try {
        socket.write(encodeBrokerMessage(message));
      } catch {
        // Disconnect will be surfaced via socket close.
      }
      return;
    }
    this.pendingActions.push({ kind: "message", message });
  }

  private flushPendingActions(): void {
    const actions = this.pendingActions;
    this.pendingActions = [];
    for (const action of actions) {
      if (action.kind === "detach") {
        void this.detach();
        return;
      }
      if (action.kind === "terminate") {
        void this.terminate(action.signal);
        return;
      }
      if (this.socket !== null && !this.socket.destroyed && this.socket.writable) {
        try {
          this.socket.write(encodeBrokerMessage(action.message));
        } catch {
          return;
        }
      }
    }
  }

  private handleServerMessage(
    message: BrokerServerMessage,
    attachTimer: ReturnType<typeof setTimeout>,
  ): void {
    switch (message.type) {
      case "attached": {
        clearTimeout(attachTimer);
        const info: DetachedAttachedInfo = {
          sessionHostId: message.sessionHostId,
          brokerPid: message.brokerPid,
          brokerIdentity: message.brokerIdentity,
          childPid: message.childPid,
          latestSeq: message.latestSeq,
          oldestSeq: message.oldestSeq,
          droppedFrames: message.droppedFrames,
          exited: message.exited,
          exitCode: message.exitCode,
          signal: message.signal,
        };
        this.attachedInfo = info;
        if (!this.attachedSettled) {
          this.attachedSettled = true;
          this.resolveAttached(info);
        }
        this.events.emit("attached", info);
        if (this.detachingForUpdateFlag) {
          void this.detach();
        } else {
          this.flushPendingActions();
        }
        break;
      }
      case "frame": {
        if (message.seq > this.lastAckedSeqValue) {
          this.lastAckedSeqValue = message.seq;
          this.recentFrames.push({ seq: message.seq, receivedAt: this.now() });
          this.settleFrames();
          this.onAckSeq?.(message.seq);
        }
        if (message.stream === "stdout") {
          this.writeStdout(message.chunk);
        } else if (message.stream === "stderr") {
          this.onStderr?.(message.chunk);
          if (!this.stderr.writableEnded) {
            this.stderr.write(message.chunk, "utf8");
          }
        } else if (message.stream === "exit") {
          this.recordExit(message.exitCode, message.signal);
          // End client socket so broker sees exit was acknowledged and can exit cleanly.
          if (this.socket !== null && !this.socket.destroyed) {
            this.socket.end();
          }
        }
        break;
      }
      case "pending_request": {
        this.writeStdout(message.chunk);
        break;
      }
      case "replay_complete": {
        if (!this.replaySettled) {
          this.replaySettled = true;
          this.resolveReplayComplete(message.latestSeq);
        }
        this.events.emit("replay_complete", message.latestSeq);
        break;
      }
      case "detached": {
        if (message.latestSeq > this.lastAckedSeqValue) {
          this.lastAckedSeqValue = message.latestSeq;
        }
        if (this.detachResolver !== null) {
          const resolve = this.detachResolver;
          this.detachResolver = null;
          this.finishDetached();
          resolve(this.lastAckedSeqValue);
        }
        break;
      }
      case "error": {
        clearTimeout(attachTimer);
        const error = new Error(`Session host error (${message.code}): ${message.message}`);
        if (!this.attachedSettled) {
          this.failStartup(error);
        } else {
          this.events.emit("error", error);
        }
        break;
      }
      case "pong": {
        break;
      }
    }
  }

  private recordExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    this.exitCodeValue = exitCode;
    this.signalCodeValue = signal;
    // Held output ends when it is released, after its last frames.
    if (this.heldOutput === null && !this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    this.resolveExit({ exitCode, signal });
    this.onExit?.(exitCode, signal);
    this.events.emit("exit", exitCode, signal);
  }

  private finishDetached(): void {
    if (this.detachedFlag) return;
    this.detachedFlag = true;
    if (!this.replaySettled) {
      this.replaySettled = true;
      this.resolveReplayComplete(this.lastAckedSeqValue);
    }
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    // Resolve exitPromise so Effect handles stop awaiting during planned server shutdown.
    this.resolveExit({ exitCode: 0, signal: null });
    this.events.emit("detached", this.lastAckedSeqValue);
  }
}
