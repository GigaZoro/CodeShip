// @effect-diagnostics nodeBuiltinImport:off -- the leftover child is a real process on a real pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";

import * as HostProcess from "../HostProcess.ts";

/**
 * A leader that starts a child and exits at once; the child would run for 5 minutes, past every
 * test's timeout. It holds a pipe to this process, so `ended` completes when it ends, without
 * polling. On Windows the child is detached; on POSIX it stays in the leader's process group.
 * Cleanup kills a child still connected, so still the owner of its pid, and closes the pipe.
 */
export const leaderLeavingChild = Effect.gen(function* () {
  const windows = (yield* HostProcess.Platform) === "win32";
  const name = `t3-leftover-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const pipe = windows ? `\\\\.\\pipe\\${name}` : NodePath.join(NodeOS.tmpdir(), `${name}.sock`);
  const started = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<void>();
  const sockets = new Set<NodeNet.Socket>();
  let childPid: number | undefined;
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.once("data", (pid: string) => {
      childPid = Number(pid);
      Deferred.doneUnsafe(started, Effect.void);
    });
    socket.once("close", () => {
      sockets.delete(socket);
      Deferred.doneUnsafe(ended, Effect.void);
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(pipe, () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (childPid !== undefined && !Deferred.isDoneUnsafe(ended)) process.kill(childPid);
    }),
  );
  const child =
    "const s = require('node:net').connect(process.argv[1], () => s.write(String(process.pid)));" +
    " s.on('error', () => {}); s.on('close', () => process.exit()); setTimeout(() => {}, 300_000);";
  const leader =
    "const [child, pipe] = process.argv.slice(1);" +
    " require('node:child_process').spawn(process.execPath, ['-e', child, pipe]," +
    ` { detached: ${windows}, stdio: 'ignore', windowsHide: true }).unref();`;
  return {
    command: ChildProcess.make(process.execPath, ["-e", leader, child, pipe], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
    /** The child connected. */
    started: Deferred.await(started),
    /** The child ended, or this process closed the pipe. */
    ended: Deferred.await(ended),
  };
});
