// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Standalone detached broker process spawned via `__session-host` fast path.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import {
  endedWindowsTreeRoot,
  windowsStopTreeArgs,
  windowsTreeRootFromNow,
  type WindowsProcessTreeRoot,
} from "@t3tools/shared/windowsProcessTreeScript";

import { linuxIdentity, timeIdentity, windowIdentity } from "../commandRunner/processIdentity.ts";
import {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_BUFFER_FRAMES,
  DEFAULT_ORPHAN_TTL_MS,
  DEFAULT_TERMINATE_GRACE_MS,
  KILL_CONFIRM_MS,
  encodeBrokerMessage,
  ensurePrivateSocketDirectory,
  parseBrokerClientMessage,
  type BrokerFrame,
  type BrokerServerMessage,
  type SessionHostConfig,
  type SessionHostReadyInfo,
} from "./protocol.ts";

const AUTH_TIMEOUT_MS = 5_000;
// A provider waits on a handful of requests at a time; a larger set means responses are not seen.
const MAX_UNANSWERED_REQUESTS = 1_000;
const MAX_CLIENT_LINE_BYTES = 64 * 1024 * 1024;
const POST_EXIT_IDLE_CAP_MS = 60_000;
/** Past this a stdin line is not a JSON-RPC reply worth tracking; it is passed on untracked. */
const MAX_TRACKED_STDIN_LINE_CHARS = 1024 * 1024;
/** A client that does not read the last frames in this long is not going to. */
const CLIENT_CLOSE_WAIT_MS = 1_000;

interface BufferedFrameEntry {
  readonly frame: BrokerFrame;
  readonly bytes: number;
}

/**
 * OS process creation precedes Node's uptime origin (loaded Electron starts plus `ps` whole-second
 * truncation), so the fallback window extends further below `startedAtMs` than above it.
 */
const START_ESTIMATE_LOWER_SLACK_MS = 10_000;
const START_ESTIMATE_UPPER_SLACK_MS = 250;

/** When this process started, estimated from its uptime, as the window a later reading must fall in. */
const selfStartWindow = () => {
  const startedAtMs = Math.round(Date.now() - process.uptime() * 1_000);
  return windowIdentity(
    startedAtMs - START_ESTIMATE_LOWER_SLACK_MS,
    startedAtMs + START_ESTIMATE_UPPER_SLACK_MS,
  );
};

export function readSelfProcessIdentity(platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    try {
      const stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
      const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
      return linuxIdentity(stat, bootId) ?? null;
    } catch {
      return null;
    }
  }
  if (platform !== "win32") {
    try {
      const out = NodeChildProcess.execFileSync(
        "ps",
        ["-p", String(process.pid), "-o", "lstart="],
        {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          encoding: "utf8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      // Parsed as readProcessStartedAt parses it, so the check after an update reads the same time.
      const startedAt = Date.parse(`${out.trim()} UTC`);
      return Number.isFinite(startedAt) ? timeIdentity(startedAt) : selfStartWindow();
    } catch {
      return selfStartWindow();
    }
  }
  return selfStartWindow();
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return NodeCrypto.timingSafeEqual(expectedBuf, actualBuf);
}

interface JsonRpcLine {
  readonly method: string | undefined;
  readonly id: string | undefined;
  readonly resolvedId: string | undefined;
}

const encodeJsonRpcId = (id: unknown): string | undefined =>
  typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? JSON.stringify(id)
    : undefined;

function parseJsonRpcLine(line: string): JsonRpcLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const params = record.params;
  return {
    method: typeof record.method === "string" ? record.method : undefined,
    id: encodeJsonRpcId(record.id),
    resolvedId:
      typeof params === "object" && params !== null
        ? encodeJsonRpcId((params as Record<string, unknown>).requestId)
        : undefined,
  };
}

function signalChildTree(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to signaling the direct child if it is no longer a process group leader.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function killWindowsProcessTree(root: WindowsProcessTreeRoot): Promise<void> {
  return new Promise((resolve) => {
    const killer = NodeChildProcess.spawn("powershell.exe", windowsStopTreeArgs(root), {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

function safeUnlink(filePath: string): void {
  try {
    NodeFS.unlinkSync(filePath);
  } catch {
    // Ignore ENOENT / already removed.
  }
}

function writeReadyFile(filePath: string, info: SessionHostReadyInfo): void {
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(info)}\n`, { encoding: "utf8", mode: 0o600 });
  NodeFS.renameSync(tempPath, filePath);
}

function readAndUnlinkConfig(configPath: string): SessionHostConfig {
  try {
    const raw = NodeFS.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionHostConfig>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.platform !== "string" ||
      typeof parsed.socketPath !== "string" ||
      typeof parsed.authToken !== "string" ||
      typeof parsed.command !== "string" ||
      !Array.isArray(parsed.args) ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.readyFilePath !== "string"
    ) {
      throw new Error("Invalid session host config payload.");
    }
    return {
      id: parsed.id,
      platform: parsed.platform as NodeJS.Platform,
      socketPath: parsed.socketPath,
      authToken: parsed.authToken,
      command: parsed.command,
      args: parsed.args.map(String),
      cwd: parsed.cwd,
      env: parsed.env && typeof parsed.env === "object" ? parsed.env : {},
      orphanTtlMs:
        typeof parsed.orphanTtlMs === "number" && parsed.orphanTtlMs > 0
          ? parsed.orphanTtlMs
          : DEFAULT_ORPHAN_TTL_MS,
      maxBufferBytes:
        typeof parsed.maxBufferBytes === "number" && parsed.maxBufferBytes > 0
          ? parsed.maxBufferBytes
          : DEFAULT_MAX_BUFFER_BYTES,
      maxBufferFrames:
        typeof parsed.maxBufferFrames === "number" && parsed.maxBufferFrames > 0
          ? parsed.maxBufferFrames
          : DEFAULT_MAX_BUFFER_FRAMES,
      readyFilePath: parsed.readyFilePath,
      jsonRpc: parsed.jsonRpc === true,
      shell: parsed.shell === true,
    };
  } finally {
    safeUnlink(configPath);
  }
}

export async function runSessionHostBroker(args: ReadonlyArray<string>): Promise<void> {
  const configPath = args[0];
  if (!configPath) {
    process.exitCode = 2;
    return;
  }

  let config: SessionHostConfig;
  try {
    config = readAndUnlinkConfig(configPath);
  } catch {
    process.exitCode = 2;
    return;
  }

  // Server exit or broken pipes must never bring down a surviving provider host.
  process.on("SIGHUP", () => {});
  process.on("SIGPIPE", () => {});

  const brokerIdentity = readSelfProcessIdentity(config.platform);
  const isPosix = config.platform !== "win32";

  if (isPosix) {
    try {
      ensurePrivateSocketDirectory(NodePath.dirname(config.socketPath));
    } catch {
      process.exitCode = 2;
      return;
    }
    safeUnlink(config.socketPath);
  }

  const ringBuffer: Array<BufferedFrameEntry> = [];
  let bufferedBytes = 0;
  let latestSeq = 0;
  let droppedFrames = 0;
  // JSON-RPC requests from the child that no client answered yet, keyed by their encoded id.
  const unansweredRequests = new Map<string, { readonly seq: number; readonly line: string }>();

  let childExited = false;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;

  let activeClient: NodeNet.Socket | null = null;
  let orphanTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let resolveDone: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const sendToSocket = (socket: NodeNet.Socket, message: BrokerServerMessage): void => {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(encodeBrokerMessage(message));
    } catch {
      // Disconnect handling will arm orphan recovery.
    }
  };

  type BrokerFrameInput = BrokerFrame extends infer F
    ? F extends BrokerFrame
      ? Omit<F, "seq">
      : never
    : never;

  const trackChildLines = (text: string, seq: number) => {
    for (const line of text.split("\n")) {
      const message = parseJsonRpcLine(line);
      if (message === undefined) continue;
      if (message.method !== undefined && message.id !== undefined) {
        unansweredRequests.set(message.id, { seq, line: `${line}\n` });
        if (unansweredRequests.size > MAX_UNANSWERED_REQUESTS) {
          const oldest = unansweredRequests.keys().next().value;
          if (oldest !== undefined) unansweredRequests.delete(oldest);
        }
      } else if (message.method === "serverRequest/resolved" && message.resolvedId !== undefined) {
        unansweredRequests.delete(message.resolvedId);
      }
    }
  };

  let stdinPartialLine = "";
  let stdinSkippingLine = false;
  const trackClientInput = (text: string) => {
    const lines = (stdinPartialLine + text).split("\n");
    stdinPartialLine = lines.pop() ?? "";
    if (stdinSkippingLine && lines.length > 0) {
      lines.shift();
      stdinSkippingLine = false;
    }
    if (stdinPartialLine.length > MAX_TRACKED_STDIN_LINE_CHARS) {
      stdinPartialLine = "";
      stdinSkippingLine = true;
    }
    for (const line of lines) {
      const message = parseJsonRpcLine(line);
      if (message !== undefined && message.method === undefined && message.id !== undefined) {
        unansweredRequests.delete(message.id);
      }
    }
  };

  const pushFrame = (frameWithoutSeq: BrokerFrameInput): BrokerFrame => {
    latestSeq += 1;
    const frame = { ...frameWithoutSeq, seq: latestSeq } as BrokerFrame;
    const bytes = frame.stream === "exit" ? 0 : Buffer.byteLength(frame.chunk, "utf8");
    ringBuffer.push({ frame, bytes });
    bufferedBytes += bytes;

    while (
      ringBuffer.length > 1 &&
      (bufferedBytes > config.maxBufferBytes || ringBuffer.length > config.maxBufferFrames)
    ) {
      const evicted = ringBuffer.shift();
      if (evicted !== undefined) {
        bufferedBytes -= evicted.bytes;
        droppedFrames += 1;
      }
    }

    if (activeClient !== null) {
      sendToSocket(activeClient, frame);
    }
    return frame;
  };

  // Spawned once the socket listens: a broker that cannot serve must not leave a child behind.
  let child!: NodeChildProcess.ChildProcessWithoutNullStreams;
  let windowsChildRoot: WindowsProcessTreeRoot | undefined;
  const stdoutDecoder = new NodeStringDecoder.StringDecoder("utf8");
  const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");

  // A frame ends at a line end, so a replay after any seq starts at the beginning of a message.
  let stdoutPartialLine = "";
  const pushStdout = (text: string) => {
    const frame = pushFrame({ type: "frame", stream: "stdout", chunk: text });
    if (config.jsonRpc) trackChildLines(text, frame.seq);
  };
  const finishChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (childExited) return;
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
    if (windowsChildRoot !== undefined) {
      windowsChildRoot = endedWindowsTreeRoot(windowsChildRoot);
    }

    const stdoutTail = stdoutPartialLine + stdoutDecoder.end();
    stdoutPartialLine = "";
    if (stdoutTail.length > 0) {
      pushStdout(stdoutTail);
    }
    const stderrTail = stderrDecoder.end();
    if (stderrTail.length > 0) {
      pushFrame({ type: "frame", stream: "stderr", chunk: stderrTail });
    }

    pushFrame({
      type: "frame",
      stream: "exit",
      chunk: "",
      exitCode: code,
      signal,
    });

    if (activeClient === null && !shuttingDown) {
      armOrphanTimer();
    }
  };

  const clearOrphanTimer = () => {
    if (orphanTimer !== null) {
      clearTimeout(orphanTimer);
      orphanTimer = null;
    }
  };

  const server = NodeNet.createServer();

  const shutdown = async (
    signal: NodeJS.Signals = "SIGTERM",
    graceMs: number = DEFAULT_TERMINATE_GRACE_MS,
  ): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearOrphanTimer();

    if (config.platform === "win32") {
      if (windowsChildRoot !== undefined) {
        await killWindowsProcessTree(windowsChildRoot);
      }
    } else if (!childExited && child.pid !== undefined) {
      signalChildTree(child, signal, config.platform);
      await new Promise<void>((resolve) => {
        if (childExited) {
          resolve();
          return;
        }
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const graceTimer = setTimeout(() => {
          if (!childExited) {
            signalChildTree(child, "SIGKILL", config.platform);
          }
          // SIGKILL cannot be ignored; the cap covers only stdio a grandchild keeps open, so the
          // exit frame still reaches the client before it is closed.
          killTimer = setTimeout(resolve, KILL_CONFIRM_MS);
          killTimer.unref();
        }, graceMs);
        graceTimer.unref();
        child.once("close", () => {
          clearTimeout(graceTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          resolve();
        });
      });
    }

    // The client goes after the child, so it receives the exit frame and knows the process is gone.
    if (activeClient !== null) {
      const client = activeClient;
      activeClient = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          client.destroy();
          resolve();
        }, CLIENT_CLOSE_WAIT_MS);
        timer.unref();
        client.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          client.end();
        } catch {
          client.destroy();
        }
      });
    }

    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    if (isPosix) {
      safeUnlink(config.socketPath);
    }
    safeUnlink(config.readyFilePath);
    resolveDone?.();
  };

  const armOrphanTimer = () => {
    clearOrphanTimer();
    if (shuttingDown) return;
    const ttlMs = childExited
      ? Math.min(config.orphanTtlMs, POST_EXIT_IDLE_CAP_MS)
      : config.orphanTtlMs;
    orphanTimer = setTimeout(() => {
      void shutdown("SIGTERM", DEFAULT_TERMINATE_GRACE_MS);
    }, ttlMs);
  };

  server.on("connection", (socket) => {
    let authenticated = false;
    let buffer = "";
    const decoder = new NodeStringDecoder.StringDecoder("utf8");

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        sendToSocket(socket, {
          type: "error",
          code: "unauthorized",
          message: "Authentication timeout.",
        });
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);
    authTimeout.unref();

    const handleLine = (line: string) => {
      if (line.length === 0) return;
      const message = parseBrokerClientMessage(line);
      if (message === undefined) {
        sendToSocket(socket, {
          type: "error",
          code: "bad_request",
          message: "Malformed session host client message.",
        });
        if (!authenticated) {
          socket.destroy();
        }
        return;
      }

      if (!authenticated) {
        if (message.type !== "attach") {
          sendToSocket(socket, {
            type: "error",
            code: "unauthorized",
            message: "First message must be attach.",
          });
          socket.destroy();
          return;
        }
        if (!tokensEqual(config.authToken, message.authToken)) {
          sendToSocket(socket, {
            type: "error",
            code: "unauthorized",
            message: "Invalid session host auth token.",
          });
          socket.destroy();
          return;
        }

        clearTimeout(authTimeout);
        authenticated = true;

        if (activeClient !== null && activeClient !== socket) {
          const previous = activeClient;
          activeClient = null;
          previous.destroy();
        }

        activeClient = socket;
        clearOrphanTimer();

        const oldestSeq = ringBuffer.length > 0 ? ringBuffer[0]!.frame.seq : latestSeq + 1;
        sendToSocket(socket, {
          type: "attached",
          sessionHostId: config.id,
          brokerPid: process.pid,
          brokerIdentity,
          childPid: child.pid ?? null,
          latestSeq,
          oldestSeq,
          droppedFrames,
          exited: childExited,
          exitCode: childExitCode,
          signal: childExitSignal,
        });

        // The previous server may have seen these and died before answering; replayed frames
        // already carry the later ones.
        for (const pending of unansweredRequests.values()) {
          if (pending.seq <= message.afterSeq) {
            sendToSocket(socket, { type: "pending_request", chunk: pending.line });
          }
        }
        for (const entry of ringBuffer) {
          if (entry.frame.seq > message.afterSeq) {
            sendToSocket(socket, entry.frame);
          }
        }
        sendToSocket(socket, { type: "replay_complete", latestSeq });
        return;
      }

      switch (message.type) {
        case "stdin": {
          if (!childExited && child.stdin.writable) {
            const payload =
              message.encoding === "base64" ? Buffer.from(message.data, "base64") : message.data;
            if (config.jsonRpc) {
              trackClientInput(typeof payload === "string" ? payload : payload.toString("utf8"));
            }
            child.stdin.write(payload);
          }
          break;
        }
        case "stdin_end": {
          if (!childExited && child.stdin.writable) {
            child.stdin.end();
          }
          break;
        }
        case "signal": {
          if (!childExited) {
            signalChildTree(child, message.signal, config.platform);
          }
          break;
        }
        case "detach": {
          if (activeClient === socket) {
            activeClient = null;
          }
          sendToSocket(socket, { type: "detached", latestSeq });
          socket.end();
          armOrphanTimer();
          break;
        }
        case "terminate": {
          void shutdown(message.signal ?? "SIGTERM", message.graceMs ?? DEFAULT_TERMINATE_GRACE_MS);
          break;
        }
        case "ping": {
          sendToSocket(socket, {
            type: "pong",
            latestSeq,
            childAlive: !childExited,
          });
          break;
        }
        case "attach": {
          // Already authenticated; ignore duplicate attach.
          break;
        }
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > MAX_CLIENT_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (activeClient === socket) {
        // Only a detach keeps the child: a server that crashed or stopped without one is not
        // coming back for it, and its provider tree must not outlive it.
        activeClient = null;
        void shutdown();
      }
    });

    socket.on("error", () => {
      // Handled by close event.
    });
  });

  // The socket is created owner-only, so no other user can connect before the chmod either.
  const previousUmask = isPosix ? process.umask(0o177) : undefined;
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(config.socketPath, () => resolve(true));
  }).finally(() => {
    if (previousUmask !== undefined) process.umask(previousUmask);
  });
  let private_ = listening;
  if (listening && isPosix) {
    try {
      NodeFS.chmodSync(config.socketPath, 0o600);
    } catch {
      private_ = false;
    }
  }
  if (!private_) {
    server.close();
    if (isPosix && listening) safeUnlink(config.socketPath);
    process.exitCode = 2;
    return;
  }

  const captureWindowsRoot = config.platform === "win32" ? windowsTreeRootFromNow() : undefined;
  child = NodeChildProcess.spawn(config.command, [...config.args], {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: isPosix,
    windowsHide: true,
    shell: config.shell,
  });
  windowsChildRoot =
    captureWindowsRoot !== undefined && child.pid !== undefined
      ? captureWindowsRoot(child.pid)
      : undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    const text = stdoutPartialLine + stdoutDecoder.write(chunk);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // A line longer than the whole buffer could never be replayed anyway; pass it on in parts.
      if (text.length > config.maxBufferBytes) {
        stdoutPartialLine = "";
        pushStdout(text);
      } else {
        stdoutPartialLine = text;
      }
      return;
    }
    stdoutPartialLine = text.slice(lastNewline + 1);
    pushStdout(text.slice(0, lastNewline + 1));
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    if (text.length > 0) {
      pushFrame({ type: "frame", stream: "stderr", chunk: text });
    }
  });

  child.stdin.on("error", () => {
    // Ignore EPIPE when child exits while server writes stdin.
  });

  child.once("error", (error) => {
    pushFrame({
      type: "frame",
      stream: "stderr",
      chunk: `Session host failed to spawn child process: ${error.message}\n`,
    });
    finishChildExit(1, null);
  });

  child.once("close", (code, signal) => {
    finishChildExit(code, signal);
  });

  server.once("error", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGTERM");
  });

  const readyInfo: SessionHostReadyInfo = {
    sessionHostId: config.id,
    brokerPid: process.pid,
    brokerIdentity,
    childPid: child.pid ?? null,
    socketPath: config.socketPath,
  };
  writeReadyFile(config.readyFilePath, readyInfo);
  if (process.stdout.writable) {
    try {
      process.stdout.write(`${JSON.stringify(readyInfo)}\n`);
    } catch {
      // Ignore EPIPE when spawned with detached stdio: "ignore".
    }
  }

  armOrphanTimer();
  await donePromise;
}
