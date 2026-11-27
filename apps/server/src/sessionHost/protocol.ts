// @effect-diagnostics nodeBuiltinImport:off -- Shared lightweight protocol module loaded by the standalone broker fast path.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Only drivers whose running turn a new server can adopt run in a session host (docs/internals/server-updates.md).
export type SessionHostDriver = "codex";

export type SessionHostStatus = "running" | "detached_for_update" | "exited" | "dead";

export const DEFAULT_ORPHAN_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_BUFFER_FRAMES = 20_000;
export const DEFAULT_TERMINATE_GRACE_MS = 2_000;

/**
 * macOS caps Unix domain socket `sun_path` at 104 bytes (Linux at 108). Keep a safety margin so
 * sockets under deep worktree or temporary directories fall back to a short tmpdir path.
 */
const MAX_POSIX_SOCKET_PATH_BYTES = 96;

export interface SessionHostConfig {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly socketPath: string;
  readonly authToken: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly orphanTtlMs: number;
  readonly maxBufferBytes: number;
  readonly maxBufferFrames: number;
  readonly readyFilePath: string;
  /**
   * The child speaks newline-delimited JSON-RPC. The broker then remembers each request the child
   * sent that no client answered, so a server that attaches later can still answer it.
   */
  readonly jsonRpc: boolean;
  /** Run `command` through the shell, as resolveSpawnCommand asks for Windows `.cmd` shims. */
  readonly shell: boolean;
}

export interface SessionHostReadyInfo {
  readonly sessionHostId: string;
  readonly brokerPid: number;
  readonly brokerIdentity: string | null;
  readonly childPid: number | null;
  readonly socketPath: string;
}

export type BrokerFrame =
  | {
      readonly type: "frame";
      readonly seq: number;
      readonly stream: "stdout" | "stderr";
      readonly chunk: string;
    }
  | {
      readonly type: "frame";
      readonly seq: number;
      readonly stream: "exit";
      readonly chunk: "";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export type BrokerServerMessage =
  | {
      readonly type: "attached";
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
  | BrokerFrame
  | {
      // A request the child sent at or before afterSeq that no client answered. It is sent before
      // the replay and carries no seq, because the client already holds that frame's seq.
      readonly type: "pending_request";
      readonly chunk: string;
    }
  | {
      readonly type: "replay_complete";
      readonly latestSeq: number;
    }
  | {
      readonly type: "detached";
      readonly latestSeq: number;
    }
  | {
      readonly type: "pong";
      readonly latestSeq: number;
      readonly childAlive: boolean;
    }
  | {
      readonly type: "error";
      readonly code: "unauthorized" | "bad_request" | "spawn_failed";
      readonly message: string;
    };

export type BrokerClientMessage =
  | {
      readonly type: "attach";
      readonly afterSeq: number;
      readonly authToken: string;
    }
  | {
      readonly type: "stdin";
      readonly data: string;
      readonly encoding?: "utf8" | "base64";
    }
  | {
      readonly type: "stdin_end";
    }
  | {
      readonly type: "signal";
      readonly signal: NodeJS.Signals;
    }
  | {
      readonly type: "detach";
    }
  | {
      readonly type: "terminate";
      readonly signal?: NodeJS.Signals;
      readonly graceMs?: number;
    }
  | {
      readonly type: "ping";
    };

export function resolveSessionHostSocketPath(
  stateDir: string,
  sessionHostId: string,
  platform: NodeJS.Platform,
): string {
  const shortId = NodeCrypto.createHash("sha256").update(sessionHostId).digest("hex").slice(0, 16);
  if (platform === "win32") {
    return `\\\\.\\pipe\\t3-session-host-${shortId}`;
  }
  const preferred = NodePath.join(stateDir, "session-hosts", `${shortId}.sock`);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_POSIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  const stateHash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 8);
  const fallback = NodePath.join(NodeOS.tmpdir(), `t3sh-${stateHash}`, `${shortId}.sock`);
  if (Buffer.byteLength(fallback, "utf8") <= MAX_POSIX_SOCKET_PATH_BYTES) {
    return fallback;
  }
  return NodePath.join("/tmp", `t3sh-${stateHash}`, `${shortId}.sock`);
}

/**
 * Creates the directory that holds a session host socket, or proves an existing one is private.
 * The `/tmp` fallback is shared with every local user, so a directory another user planted, or a
 * symlink to one, would let them replace the socket and read the provider's stdio.
 */
export function ensurePrivateSocketDirectory(directory: string): void {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  // lstat, not stat: a symlink to a directory must fail here instead of being followed.
  const stat = NodeFS.lstatSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`Session host socket directory ${directory} is not a real directory.`);
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Session host socket directory ${directory} belongs to another user.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    NodeFS.chmodSync(directory, 0o700);
    const tightened = NodeFS.lstatSync(directory);
    if ((tightened.mode & 0o077) !== 0) {
      throw new Error(`Session host socket directory ${directory} is not private.`);
    }
  }
}

export function encodeBrokerMessage(message: BrokerClientMessage | BrokerServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseBrokerClientMessage(line: string): BrokerClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "attach":
      if (
        typeof raw.afterSeq !== "number" ||
        !Number.isSafeInteger(raw.afterSeq) ||
        raw.afterSeq < 0 ||
        typeof raw.authToken !== "string"
      ) {
        return undefined;
      }
      return { type: "attach", afterSeq: raw.afterSeq, authToken: raw.authToken };
    case "stdin":
      if (typeof raw.data !== "string") return undefined;
      if (raw.encoding !== undefined && raw.encoding !== "utf8" && raw.encoding !== "base64") {
        return undefined;
      }
      return {
        type: "stdin",
        data: raw.data,
        ...(raw.encoding !== undefined ? { encoding: raw.encoding } : {}),
      };
    case "stdin_end":
      return { type: "stdin_end" };
    case "signal":
      if (typeof raw.signal !== "string" || raw.signal.length === 0) return undefined;
      return { type: "signal", signal: raw.signal as NodeJS.Signals };
    case "detach":
      return { type: "detach" };
    case "terminate":
      return {
        type: "terminate",
        ...(typeof raw.signal === "string" ? { signal: raw.signal as NodeJS.Signals } : {}),
        ...(typeof raw.graceMs === "number" && Number.isFinite(raw.graceMs) && raw.graceMs >= 0
          ? { graceMs: raw.graceMs }
          : {}),
      };
    case "ping":
      return { type: "ping" };
    default:
      return undefined;
  }
}

export function parseBrokerServerMessage(line: string): BrokerServerMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "attached":
      if (
        typeof raw.sessionHostId !== "string" ||
        typeof raw.brokerPid !== "number" ||
        (raw.brokerIdentity !== null && typeof raw.brokerIdentity !== "string") ||
        (raw.childPid !== null && typeof raw.childPid !== "number") ||
        typeof raw.latestSeq !== "number" ||
        typeof raw.oldestSeq !== "number" ||
        typeof raw.droppedFrames !== "number" ||
        typeof raw.exited !== "boolean" ||
        (raw.exitCode !== null && typeof raw.exitCode !== "number") ||
        (raw.signal !== null && typeof raw.signal !== "string")
      ) {
        return undefined;
      }
      return {
        type: "attached",
        sessionHostId: raw.sessionHostId,
        brokerPid: raw.brokerPid,
        brokerIdentity: raw.brokerIdentity,
        childPid: raw.childPid,
        latestSeq: raw.latestSeq,
        oldestSeq: raw.oldestSeq,
        droppedFrames: raw.droppedFrames,
        exited: raw.exited,
        exitCode: raw.exitCode,
        signal: raw.signal as NodeJS.Signals | null,
      };
    case "frame":
      if (typeof raw.seq !== "number" || typeof raw.stream !== "string") return undefined;
      if (raw.stream === "stdout" || raw.stream === "stderr") {
        if (typeof raw.chunk !== "string") return undefined;
        return { type: "frame", seq: raw.seq, stream: raw.stream, chunk: raw.chunk };
      }
      if (raw.stream === "exit") {
        if (
          (raw.exitCode !== null &&
            raw.exitCode !== undefined &&
            typeof raw.exitCode !== "number") ||
          (raw.signal !== null && raw.signal !== undefined && typeof raw.signal !== "string")
        ) {
          return undefined;
        }
        return {
          type: "frame",
          seq: raw.seq,
          stream: "exit",
          chunk: "",
          exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
          signal: typeof raw.signal === "string" ? (raw.signal as NodeJS.Signals) : null,
        };
      }
      return undefined;
    case "pending_request":
      if (typeof raw.chunk !== "string") return undefined;
      return { type: "pending_request", chunk: raw.chunk };
    case "replay_complete":
      if (typeof raw.latestSeq !== "number") return undefined;
      return { type: "replay_complete", latestSeq: raw.latestSeq };
    case "detached":
      if (typeof raw.latestSeq !== "number") return undefined;
      return { type: "detached", latestSeq: raw.latestSeq };
    case "pong":
      if (typeof raw.latestSeq !== "number" || typeof raw.childAlive !== "boolean") {
        return undefined;
      }
      return { type: "pong", latestSeq: raw.latestSeq, childAlive: raw.childAlive };
    case "error":
      if (
        (raw.code !== "unauthorized" &&
          raw.code !== "bad_request" &&
          raw.code !== "spawn_failed") ||
        typeof raw.message !== "string"
      ) {
        return undefined;
      }
      return { type: "error", code: raw.code, message: raw.message };
    default:
      return undefined;
  }
}
