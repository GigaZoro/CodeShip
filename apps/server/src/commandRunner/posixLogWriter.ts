// @effect-diagnostics nodeBuiltinImport:off -- The detached writer runs before the server runtime loads.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

export const LOG_TRIM_AT_BYTES = 8 * 1024 * 1024;
export const LOG_KEEP_BYTES = 4 * 1024 * 1024;
export const TRIMMED_MARKER = "[CodeShip removed earlier output to keep this log small]\n";

const ROTATED_LOG_FLAGS =
  NodeFS.constants.O_RDWR |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_TRUNC |
  NodeFS.constants.O_APPEND;

export async function runPosixLogWriter(args: readonly string[]): Promise<void> {
  const [logPath, statusPath] = args;
  if (!logPath || !statusPath) throw new Error("Missing command log writer arguments.");
  const token = NodeCrypto.randomUUID();
  const header = Buffer.from(TRIMMED_MARKER);
  const completion = Buffer.from(`\0${token}\0`);
  const empty = Buffer.alloc(0);
  const tempPath = `${logPath}.tmp`;
  let log = NodeFS.openSync(logPath, "a+", 0o600);
  let size = NodeFS.fstatSync(log).size;
  // The group receives TERM together. Its commands may still write while handling the signal.
  process.on("SIGTERM", () => undefined);
  NodeFS.writeFileSync(1, `${token}\n`);

  const append = (bytes: Buffer) => {
    if (bytes.length === 0) return;
    if (size + bytes.length <= LOG_TRIM_AT_BYTES) {
      NodeFS.writeFileSync(log, bytes);
      size += bytes.length;
      return;
    }
    const incoming = bytes.subarray(Math.max(0, bytes.length - LOG_KEEP_BYTES));
    const tail = Buffer.allocUnsafe(LOG_KEEP_BYTES - incoming.length);
    let offset = 0;
    while (offset < tail.length) {
      const count = NodeFS.readSync(
        log,
        tail,
        offset,
        tail.length - offset,
        size - tail.length + offset,
      );
      if (count === 0) throw new Error("Command log ended before its retained tail.");
      offset += count;
    }
    const next = NodeFS.openSync(tempPath, ROTATED_LOG_FLAGS, 0o600);
    NodeFS.writeFileSync(next, header);
    NodeFS.writeFileSync(next, tail);
    NodeFS.writeFileSync(next, incoming);
    NodeFS.renameSync(tempPath, logPath);
    NodeFS.closeSync(log);
    log = next;
    size = header.length + LOG_KEEP_BYTES;
  };

  let pending = empty;
  let completed = false;
  // Not readSync(0): the bundled CLI's node:process import makes stdin non-blocking before this runs.
  for await (const input of process.stdin as AsyncIterable<Buffer>) {
    if (completed) {
      append(input);
      continue;
    }
    const bytes = pending.length === 0 ? input : Buffer.concat([pending, input]);
    const end = bytes.lastIndexOf(completion);
    if (end !== -1 && NodeFS.existsSync(`${statusPath}.tmp`)) {
      if (end < pending.length) {
        size -= pending.length - end;
        NodeFS.ftruncateSync(log, size);
      } else {
        append(bytes.subarray(pending.length, end));
      }
      NodeFS.renameSync(`${statusPath}.tmp`, statusPath);
      try {
        NodeFS.writeFileSync(1, "\n");
      } catch (error) {
        // A stopped wrapper can close its acknowledgment pipe while descendants still write.
        if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) throw error;
      }
      completed = true;
      pending = empty;
      append(bytes.subarray(end + completion.length));
      continue;
    }
    append(input);
    // Only a suffix beginning at the last NUL can be a partial completion frame.
    const nul = bytes.lastIndexOf(0);
    const suffix = nul < 0 ? empty : bytes.subarray(nul);
    pending =
      suffix.length > 0 && completion.subarray(0, suffix.length).equals(suffix)
        ? Buffer.from(suffix)
        : empty;
  }
  NodeFS.closeSync(log);
}
