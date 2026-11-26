// @effect-diagnostics nodeBuiltinImport:off -- Exercises the detached POSIX log writer subprocess directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { assert, it } from "vite-plus/test";

it.skipIf(isWindowsHost).each([
  ["preserves binary output matching a completion frame before the command exits", "binary"],
  ["drains command shutdown diagnostics after the group receives SIGTERM", "term"],
  ["keeps the last byte already read when a timeout escalates to SIGKILL", "kill"],
  ["strips a completion frame split across writes before publishing status", "split-complete"],
] as const)("%s", async (_scenario, mode) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-writer-"));
  const log = NodePath.join(directory, "output.log");
  const status = NodePath.join(directory, "status");
  const publicArgument = "from-the-command-line";
  const child = NodeChildProcess.spawn(process.execPath, [
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
    const output =
      mode === "binary"
        ? Buffer.concat([
            Buffer.from([0xff]),
            Buffer.from(`\0${publicArgument}\0\0${token}\0`),
            Buffer.from([0xfe]),
          ])
        : mode === "split-complete"
          ? Buffer.from("before\nafter\n")
          : Buffer.from("shutting down\n\0");
    if (mode === "term" || mode === "kill") child.kill("SIGTERM");
    if (mode === "kill" || mode === "split-complete") {
      const watcher = NodeFS.watch(log);
      try {
        const persisted = NodeEvents.EventEmitter.once(watcher, "change");
        child.stdin.write(
          mode === "split-complete" ? Buffer.from(`before\n\0${token.slice(0, 6)}`) : output,
        );
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
    assert.equal(NodeFS.existsSync(status), mode === "split-complete");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
