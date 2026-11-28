// @effect-diagnostics nodeBuiltinImport:off -- Exercises the detached POSIX log writer subprocess directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ownProcessGroup } from "@t3tools/shared/processGroup";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { assert, it } from "vite-plus/test";

it.skipIf(isWindowsHost).each([
  ["preserves binary output matching a completion frame before the command exits", "binary"],
  ["drains command shutdown diagnostics after the group receives SIGTERM", "term"],
  ["keeps the last byte already read when a timeout escalates to SIGKILL", "kill"],
  ["strips a completion frame split across writes before publishing status", "split-complete"],
  // The bundled CLI imports node:process before the writer starts, which makes stdin non-blocking.
  ["reads its input after node:process made stdin non-blocking", "bundled"],
] as const)("%s", async (_scenario, mode) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-writer-"));
  const log = NodePath.join(directory, "output.log");
  const status = NodePath.join(directory, "status");
  const publicArgument = "from-the-command-line";
  const child = NodeChildProcess.spawn(process.execPath, [
    ...(mode === "bundled" ? ["--import", 'data:text/javascript,import "node:process";'] : []),
    NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    "__command-log",
    log,
    status,
    publicArgument,
  ]);
  const exited = NodeEvents.EventEmitter.once(child, "close");
  try {
    const stdout = child.stdout[Symbol.asyncIterator]();
    const ready = await stdout.next();
    assert.isFalse(ready.done);
    const token = String(ready.value).trim();
    const completes = mode === "split-complete" || mode === "bundled";
    const output =
      mode === "binary"
        ? Buffer.concat([
            Buffer.from([0xff]),
            Buffer.from(`\0${publicArgument}\0\0${token}\0`),
            Buffer.from([0xfe]),
          ])
        : completes
          ? Buffer.from("before\nafter\n")
          : Buffer.from("shutting down\n\0");
    if (mode === "term" || mode === "kill") child.kill("SIGTERM");
    if (mode === "kill" || completes) {
      const watcher = NodeFS.watch(log);
      try {
        const persisted = NodeEvents.EventEmitter.once(watcher, "change");
        child.stdin.write(completes ? Buffer.from(`before\n\0${token.slice(0, 6)}`) : output);
        await persisted;
        if (mode === "kill") {
          // A descendant still holds the write end when the grace period expires.
          child.kill("SIGKILL");
        } else {
          NodeFS.writeFileSync(`${status}.tmp`, "0\n");
          child.stdin.end(Buffer.from(`${token.slice(6)}\0after\n`));
          const ack = await stdout.next();
          assert.isFalse(ack.done);
          assert.equal(String(ack.value), "\n");
        }
      } finally {
        watcher.close();
      }
    } else {
      child.stdin.end(output);
    }
    assert.deepEqual(await exited, mode === "kill" ? [null, "SIGKILL"] : [0, null]);
    assert.deepEqual(NodeFS.readFileSync(log), output);
    assert.equal(NodeFS.existsSync(status), completes);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(isWindowsHost).each([
  ["reads a >8 KiB named FIFO on --input-fd 3 after node:process ran", "fd3"],
  ["reads a >8 KiB named FIFO on stdin after node:process ran", "stdin"],
] as const)("%s", async (_scenario, mode) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-writer-fifo-"));
  const log = NodePath.join(directory, "output.log");
  const status = NodePath.join(directory, "status");
  const payloadFile = NodePath.join(directory, "payload.bin");
  const payload = Buffer.alloc(16 * 1024 + 17, 0x61);
  NodeFS.writeFileSync(payloadFile, payload);
  const binPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
  const script = [
    'mkfifo -m 600 "$1.pipe" "$1.ack"',
    mode === "fd3"
      ? '"$3" --import \'data:text/javascript,import "node:process";\' "$4" __command-log "$1" "$2" --input-fd 3 </dev/null 3<"$1.pipe" >"$1.ack" &'
      : '"$3" --import \'data:text/javascript,import "node:process";\' "$4" __command-log "$1" "$2" <"$1.pipe" >"$1.ack" &',
    "wpid=$!",
    'exec 4>"$1.pipe" 3<"$1.ack"',
    'rm -f "$1.pipe" "$1.ack"',
    "IFS= read -r token <&3",
    '[ -n "$token" ] || exit 2',
    'cat "$5" >&4',
    'printf "0\\n" >"$2.tmp"',
    'printf "\\000%s\\000" "$token" >&4',
    "exec 4>&-",
    "IFS= read -r ack <&3",
    'wait "$wpid"',
  ].join("\n");
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", script, "t3-fifo-test", log, status, process.execPath, binPath, payloadFile],
    { detached: true },
  );
  const group = ownProcessGroup(child, undefined);
  const exited = NodeEvents.EventEmitter.once(child, "close");
  try {
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(NodeFS.readFileSync(log), payload);
    assert.equal(NodeFS.readFileSync(status, "utf8"), "0\n");
  } finally {
    try {
      group.signal("SIGKILL");
    } catch {
      // Group already gone.
    }
    await exited;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
