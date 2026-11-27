// @effect-diagnostics nodeBuiltinImport:off -- Exercises the detached __session-host broker subprocess and IPC socket directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { isProcessAlive } from "@t3tools/shared/processProbe";
import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DetachedStdioHandle } from "./DetachedStdioHandle.ts";
import {
  ensurePrivateSocketDirectory,
  resolveSessionHostSocketPath,
  type SessionHostConfig,
} from "./protocol.ts";

const BIN_PATH = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const HOST_PLATFORM: NodeJS.Platform = isWindowsHost ? "win32" : isLinuxHost ? "linux" : "darwin";

/**
 * Tiny mock provider child process:
 * - Opens a local TCP control socket on 127.0.0.1:0 so tests can trigger output
 *   deterministically while the broker has no attached client (without timers or polling).
 * - Echoes NDJSON stdin commands to stdout/stderr.
 */
const MOCK_PROVIDER_SCRIPT = `
const net = require("node:net");
const readline = require("node:readline");

const controlServer = net.createServer((socket) => {
  const rl = readline.createInterface({ input: socket });
  rl.on("line", (line) => {
    if (line === "burst") {
      process.stdout.write(JSON.stringify({ kind: "detached", seq: 1 }) + "\\n");
      process.stdout.write(JSON.stringify({ kind: "detached", seq: 2 }) + "\\n");
      process.stderr.write("stderr:detached\\n");
      process.stdout.write(JSON.stringify({ kind: "detached", seq: 3 }) + "\\n", () => {
        socket.write("done\\n");
      });
    } else if (line === "ping") {
      socket.write("pong\\n");
    } else if (line === "half1") {
      process.stdout.write('{"kind":"split",', () => socket.write("done\\n"));
    } else if (line === "half2") {
      process.stdout.write('"n":1}\\n', () => socket.write("done\\n"));
    } else if (line === "requests") {
      const lines = [
        { jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: {} },
        { jsonrpc: "2.0", id: 8, method: "item/fileChange/requestApproval", params: {} },
        { jsonrpc: "2.0", id: 9, method: "item/tool/requestUserInput", params: {} },
        { jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: 8 } },
      ];
      process.stdout.write(lines.map((l) => JSON.stringify(l) + "\\n").join(""), () => {
        socket.write("done\\n");
      });
    }
  });
});

controlServer.listen(0, "127.0.0.1", () => {
  const addr = controlServer.address();
  process.stdout.write(
    JSON.stringify({ kind: "ready", pid: process.pid, controlPort: addr.port }) + "\\n",
  );
});

const stdinRl = readline.createInterface({ input: process.stdin });
stdinRl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.cmd === undefined && msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ kind: "answered", id: msg.id }) + "\\n");
  } else if (msg.cmd === "echo") {
    process.stderr.write("stderr:" + msg.tag + "\\n");
    process.stdout.write(JSON.stringify({ kind: "echo", pid: process.pid, tag: msg.tag }) + "\\n");
  } else if (msg.cmd === "exit") {
    controlServer.close();
    process.exit(msg.code ?? 0);
  }
});
`;

const createLineReader = (stream: NodeJS.ReadableStream) => {
  const buffered: Array<string> = [];
  const waiters: Array<(line: string) => void> = [];
  let partial = "";

  stream.on("data", (chunk: Buffer | string) => {
    partial += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = partial.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = partial.slice(0, newlineIndex).replace(/\r$/, "");
      partial = partial.slice(newlineIndex + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        buffered.push(line);
      }
      newlineIndex = partial.indexOf("\n");
    }
  });

  return {
    nextLine: (): Promise<string> => {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<string>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
};

const sendControlCommand = (port: number, command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const nl = response.indexOf("\n");
      if (nl !== -1) {
        const line = response.slice(0, nl);
        socket.end();
        resolve(line);
      }
    });
    socket.once("connect", () => {
      socket.write(`${command}\n`);
    });
  });

interface SpawnedTestBroker {
  readonly dir: string;
  readonly id: string;
  readonly authToken: string;
  readonly socketPath: string;
  readonly broker: NodeChildProcess.ChildProcess;
  readonly exited: Promise<unknown>;
  readonly cleanup: () => Promise<void>;
}

const spawnTestBroker = async (
  overrides: {
    readonly orphanTtlMs?: number;
    readonly maxBufferBytes?: number;
    readonly maxBufferFrames?: number;
  } = {},
): Promise<SpawnedTestBroker> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-host-test-"));
  const id = NodeCrypto.randomUUID();
  const authToken = NodeCrypto.randomBytes(24).toString("hex");
  const socketPath = resolveSessionHostSocketPath(dir, id, HOST_PLATFORM);
  const configPath = NodePath.join(dir, `cfg-${id}.json`);
  const readyFilePath = NodePath.join(dir, `ready-${id}.json`);

  const config: SessionHostConfig = {
    id,
    platform: HOST_PLATFORM,
    socketPath,
    authToken,
    command: process.execPath,
    args: ["-e", MOCK_PROVIDER_SCRIPT],
    cwd: dir,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    orphanTtlMs: overrides.orphanTtlMs ?? 60_000,
    maxBufferBytes: overrides.maxBufferBytes ?? 1_024 * 1_024,
    maxBufferFrames: overrides.maxBufferFrames ?? 1_000,
    readyFilePath,
    jsonRpc: true,
  };
  NodeFS.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

  const broker = NodeChildProcess.spawn(
    process.execPath,
    [BIN_PATH, "__session-host", configPath],
    {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const exited = NodeEvents.EventEmitter.once(broker, "close");

  const readyLine = await createLineReader(broker.stdout).nextLine();
  const readyInfo = JSON.parse(readyLine) as { sessionHostId: string };
  assert.equal(readyInfo.sessionHostId, id);
  assert.isTrue(NodeFS.existsSync(readyFilePath));

  const cleanup = async () => {
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGKILL");
    }
    await exited;
    if (!isWindowsHost && NodeFS.existsSync(socketPath)) {
      NodeFS.rmSync(socketPath, { force: true });
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, id, authToken, socketPath, broker, exited, cleanup };
};

describe("Detached session host broker (__session-host)", () => {
  it("detaches cleanly, buffers stdout/stderr while detached, replays in order on reattach, and continues live stdin/stdout", async () => {
    const host = await spawnTestBroker();
    let childPid: number | null = null;
    try {
      const handle1 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: 0,
      });
      const stdout1 = createLineReader(handle1.stdout);
      const stderr1 = createLineReader(handle1.stderr);

      const readyLine = JSON.parse(await stdout1.nextLine()) as {
        kind: string;
        pid: number;
        controlPort: number;
      };
      assert.equal(readyLine.kind, "ready");
      childPid = readyLine.pid;

      handle1.stdin.write(`${JSON.stringify({ cmd: "echo", tag: "before" })}\n`);
      const echoBefore = JSON.parse(await stdout1.nextLine()) as {
        kind: string;
        pid: number;
        tag: string;
      };
      assert.equal(echoBefore.tag, "before");
      assert.equal(echoBefore.pid, childPid);
      assert.equal(await stderr1.nextLine(), "stderr:before");

      const detachedAtSeq = await handle1.detach();
      assert.isAbove(detachedAtSeq, 0);
      assert.isNull(host.broker.exitCode);
      assert.isTrue(isProcessAlive(childPid));

      // While detached (no client connected), trigger the provider child to emit stdout + stderr frames.
      const controlAck = await sendControlCommand(readyLine.controlPort, "burst");
      assert.equal(controlAck, "done");

      // Reattach with a brand-new handle simulating the restarted t3-server.
      const handle2 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: detachedAtSeq,
      });
      const stdout2 = createLineReader(handle2.stdout);
      const stderr2 = createLineReader(handle2.stderr);

      const replayedStdout = [
        JSON.parse(await stdout2.nextLine()) as { kind: string; seq: number },
        JSON.parse(await stdout2.nextLine()) as { kind: string; seq: number },
        JSON.parse(await stdout2.nextLine()) as { kind: string; seq: number },
      ];
      assert.deepEqual(replayedStdout, [
        { kind: "detached", seq: 1 },
        { kind: "detached", seq: 2 },
        { kind: "detached", seq: 3 },
      ]);
      assert.equal(await stderr2.nextLine(), "stderr:detached");

      // Verify live bidirectional stdio still works with the exact same surviving child process.
      handle2.stdin.write(`${JSON.stringify({ cmd: "echo", tag: "after" })}\n`);
      const echoAfter = JSON.parse(await stdout2.nextLine()) as {
        kind: string;
        pid: number;
        tag: string;
      };
      assert.equal(echoAfter.tag, "after");
      assert.equal(echoAfter.pid, childPid);
      assert.equal(await stderr2.nextLine(), "stderr:after");

      await handle2.terminate();
      await host.exited;
      assert.isFalse(isProcessAlive(childPid));
      if (!isWindowsHost) {
        assert.isFalse(NodeFS.existsSync(host.socketPath));
      }
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Best-effort cleanup.
        }
      }
      await host.cleanup();
    }
  });

  it("rejects attaching clients with an invalid authToken without killing the child", async () => {
    const host = await spawnTestBroker();
    try {
      let rejectedError: Error | null = null;
      try {
        await DetachedStdioHandle.connect({
          sessionHostId: host.id,
          socketPath: host.socketPath,
          authToken: "wrong-auth-token",
          initialAfterSeq: 0,
        });
      } catch (error) {
        rejectedError = error instanceof Error ? error : new Error(String(error));
      }
      assert.isNotNull(rejectedError);
      assert.include(rejectedError?.message ?? "", "unauthorized");

      const validHandle = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: 0,
      });
      const stdout = createLineReader(validHandle.stdout);
      const ready = JSON.parse(await stdout.nextLine()) as { kind: string; pid: number };
      assert.equal(ready.kind, "ready");
      await validHandle.terminate();
      await host.exited;
    } finally {
      await host.cleanup();
    }
  });

  it("auto-terminates child and unlinks socket when left detached past orphanTtlMs", async () => {
    const host = await spawnTestBroker({ orphanTtlMs: 80 });
    let childPid: number | null = null;
    try {
      const handle = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: 0,
      });
      const stdout = createLineReader(handle.stdout);
      const ready = JSON.parse(await stdout.nextLine()) as { kind: string; pid: number };
      childPid = ready.pid;
      assert.isTrue(isProcessAlive(childPid));

      await handle.detach();

      // Broker watchdog fires after orphanTtlMs and exits cleanly without any polling in the test.
      await host.exited;
      assert.isFalse(isProcessAlive(childPid));
      if (!isWindowsHost) {
        assert.isFalse(NodeFS.existsSync(host.socketPath));
      }
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Best-effort cleanup.
        }
      }
      await host.cleanup();
    }
  });

  it.live(
    "detaches instead of killing while detaching for update, and supports ChildProcessHandle",
    () =>
      Effect.gen(function* () {
        const host = yield* Effect.promise(() => spawnTestBroker());
        let childPid: number | null = null;
        return yield* Effect.gen(function* () {
          const handle1 = yield* Effect.promise(() =>
            DetachedStdioHandle.connect({
              sessionHostId: host.id,
              socketPath: host.socketPath,
              authToken: host.authToken,
              initialAfterSeq: 0,
            }),
          );
          const childHandle1 = handle1.asChildProcessHandle();
          const stdout1 = createLineReader(handle1.stdout);
          const ready = JSON.parse(yield* Effect.promise(() => stdout1.nextLine())) as {
            kind: string;
            pid: number;
          };
          childPid = ready.pid;

          // A scope finalizer that kills the provider during a planned update detaches instead.
          handle1.markDetachingForUpdate();
          yield* childHandle1.kill();
          assert.isFalse(handle1.killed);
          const seq = yield* Effect.promise(() => handle1.detach());
          assert.isTrue(isProcessAlive(childPid));

          // Reattach and wrap as an Effect ChildProcessHandle to verify Effect Stream/Sink I/O.
          const handle2 = yield* Effect.promise(() =>
            DetachedStdioHandle.connect({
              sessionHostId: host.id,
              socketPath: host.socketPath,
              authToken: host.authToken,
              initialAfterSeq: seq,
            }),
          );
          const childHandle = handle2.asChildProcessHandle();

          yield* Stream.make(
            new TextEncoder().encode(`${JSON.stringify({ cmd: "echo", tag: "effect-handle" })}\n`),
          ).pipe(Stream.run(childHandle.stdin));
          const firstChunk = yield* childHandle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
            Stream.runCollect,
          );
          const parsed = JSON.parse(firstChunk[0] ?? "") as {
            kind: string;
            pid: number;
            tag: string;
          };
          assert.equal(parsed.tag, "effect-handle");
          assert.equal(parsed.pid, childPid);

          yield* Effect.promise(() => handle2.terminate());
          yield* Effect.promise(() => host.exited);
          assert.isFalse(isProcessAlive(childPid));
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              if (childPid !== null && isProcessAlive(childPid)) {
                try {
                  process.kill(childPid, "SIGKILL");
                } catch {
                  // Best-effort cleanup.
                }
              }
              await host.cleanup();
            }),
          ),
        );
      }),
  );

  it("cuts frames on whole lines, so a reattach never replays half a line", async () => {
    const host = await spawnTestBroker();
    let childPid: number | null = null;
    try {
      const handle1 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: 0,
      });
      const ready = JSON.parse(await createLineReader(handle1.stdout).nextLine()) as {
        pid: number;
        controlPort: number;
      };
      childPid = ready.pid;

      assert.equal(await sendControlCommand(ready.controlPort, "half1"), "done");
      const detachedAtSeq = await handle1.detach();
      assert.equal(await sendControlCommand(ready.controlPort, "half2"), "done");

      const handle2 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: detachedAtSeq,
      });
      const replayed = await createLineReader(handle2.stdout).nextLine();
      assert.deepEqual(JSON.parse(replayed), { kind: "split", n: 1 });

      await handle2.terminate();
      await host.exited;
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
      await host.cleanup();
    }
  });

  it("re-sends requests the child is still waiting on to the next attached client", async () => {
    const host = await spawnTestBroker();
    let childPid: number | null = null;
    try {
      const handle1 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: 0,
      });
      const stdout1 = createLineReader(handle1.stdout);
      const ready = JSON.parse(await stdout1.nextLine()) as { pid: number; controlPort: number };
      childPid = ready.pid;

      assert.equal(await sendControlCommand(ready.controlPort, "requests"), "done");
      for (let index = 0; index < 4; index += 1) await stdout1.nextLine();
      handle1.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`);
      assert.deepEqual(JSON.parse(await stdout1.nextLine()), { kind: "answered", id: 7 });
      const detachedAtSeq = await handle1.detach();

      const handle2 = await DetachedStdioHandle.connect({
        sessionHostId: host.id,
        socketPath: host.socketPath,
        authToken: host.authToken,
        initialAfterSeq: detachedAtSeq,
      });
      const stdout2 = createLineReader(handle2.stdout);
      // Request 7 was answered and request 8 resolved by the child, so only 9 is still open.
      const resent = JSON.parse(await stdout2.nextLine()) as { id: number; method: string };
      assert.equal(resent.id, 9);
      assert.equal(resent.method, "item/tool/requestUserInput");
      handle2.stdin.write(`${JSON.stringify({ cmd: "echo", tag: "live" })}\n`);
      assert.equal((JSON.parse(await stdout2.nextLine()) as { tag: string }).tag, "live");

      await handle2.terminate();
      await host.exited;
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
      await host.cleanup();
    }
  });

  it("kills the child when its client disconnects without a detach", async () => {
    // Far beyond the test timeout, so only the disconnect itself can stop the child in time.
    const host = await spawnTestBroker({ orphanTtlMs: 10 * 60_000 });
    let childPid: number | null = null;
    try {
      const socket = NodeNet.createConnection(host.socketPath);
      await NodeEvents.EventEmitter.once(socket, "connect");
      const lines = createLineReader(socket);
      socket.write(
        `${JSON.stringify({ type: "attach", afterSeq: 0, authToken: host.authToken })}\n`,
      );
      assert.equal((JSON.parse(await lines.nextLine()) as { type: string }).type, "attached");
      let readyFrame: { type: string; stream?: string; chunk?: string };
      do {
        readyFrame = JSON.parse(await lines.nextLine()) as typeof readyFrame;
      } while (readyFrame.type !== "frame" || readyFrame.stream !== "stdout");
      childPid = (JSON.parse(readyFrame.chunk ?? "") as { pid: number }).pid;

      socket.destroy();
      await host.exited;
      assert.isFalse(isProcessAlive(childPid));
    } finally {
      if (childPid !== null && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
      await host.cleanup();
    }
  });
});

describe.skipIf(isWindowsHost)("ensurePrivateSocketDirectory", () => {
  it("refuses a symlinked socket directory and makes a shared one private", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-host-dir-"));
    try {
      const target = NodePath.join(base, "target");
      NodeFS.mkdirSync(target, { mode: 0o700 });
      const link = NodePath.join(base, "link");
      NodeFS.symlinkSync(target, link);
      assert.throws(() => ensurePrivateSocketDirectory(link), /not a real directory/);

      const shared = NodePath.join(base, "shared");
      NodeFS.mkdirSync(shared);
      NodeFS.chmodSync(shared, 0o755);
      ensurePrivateSocketDirectory(shared);
      assert.equal(NodeFS.lstatSync(shared).mode & 0o777, 0o700);
    } finally {
      NodeFS.rmSync(base, { recursive: true, force: true });
    }
  });
});
