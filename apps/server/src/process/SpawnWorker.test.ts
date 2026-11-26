// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - fixtures need real paths, the process resource list and the live environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as SpawnWorker from "./SpawnWorker.ts";

const envChdir = vi.hoisted(() => ({ supported: true }));
vi.mock("@t3tools/shared/envTrampoline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/envTrampoline")>()),
  supportsEnvChdir: () => Promise.resolve(envChdir.supported),
}));

const layer = SpawnWorker.layer.pipe(Layer.provide(NodeServices.layer));
const missingCommand = "t3-missing-command-25245";
// libuv's ENOENT, which Node reports for a missing command: -2 on POSIX, -4058 on Windows.
const missingCommandErrno = [...NodeUtil.getSystemErrorMap()].find(
  ([, [name]]) => name === "ENOENT",
)?.[0];
/** Node's close comes once each output stream has ended or its reader destroyed it. */
const outputDone = (...streams: ReadonlyArray<NodeStream.Readable | null>) =>
  streams.every((stream) => stream === null || stream.readableEnded || stream.destroyed);
const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);
const node = (script: string, args: ReadonlyArray<string> = [], options = {}) =>
  ChildProcess.make(process.execPath, ["-e", script, ...args], options);

describe("SpawnWorker", () => {
  it.live("runs children on a launcher thread where the server thread would wait on them", () =>
    Effect.gen(function* () {
      for (const [platform, hasEnvChdir, onServerThread] of [
        ["win32", true, false],
        ["linux", true, true],
        ["linux", false, false],
      ] as const) {
        envChdir.supported = hasEnvChdir;
        const launched = Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            node("process.stdout.write('ready');process.stdin.resume()"),
          );
          expect(yield* child.stdout.pipe(Stream.take(1), text)).toBe("ready");
          // The thread that called spawn owns the native process handle.
          expect(process.getActiveResourcesInfo().includes("ProcessWrap")).toBe(onServerThread);
          expect(yield* child.isRunning).toBe(true);
        });
        yield* launched.pipe(
          Effect.scoped,
          Effect.provide(SpawnWorker.layerServer.pipe(Layer.provide(NodeServices.layer))),
          Effect.provideService(HostProcess.Platform, platform),
        );
      }
    }),
  );

  it.live("preserves stdin, large output, env, cwd, literal args and additional descriptors", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const literal = "quote' \" $HOME; * & %PATH%";
      const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
      const script = `
        const fs = require('node:fs');
        const input = fs.readFileSync(0, 'utf8');
        fs.writeSync(1, JSON.stringify([input, process.cwd(), process.env.SPAWN_WORKER_TEST, process.argv[1]]) + '\\n');
        fs.writeSync(1, 'a'.repeat(1024 * 1024));
        fs.writeSync(2, 'b'.repeat(1024 * 1024));
      `;
      for (let i = 0; i < 3; i++) {
        const child = yield* spawner.spawn(
          node(script, [literal], {
            cwd,
            env: { SPAWN_WORKER_TEST: "inherited value" },
            extendEnv: true,
            stdin: Stream.encodeText(Stream.make("stdin value")),
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [text(child.stdout), text(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(stdout).toBe(
          JSON.stringify(["stdin value", cwd, "inherited value", literal]) +
            "\n" +
            "a".repeat(1024 * 1024),
        );
        expect(stderr).toBe("b".repeat(1024 * 1024));
        expect(code).toBe(0);
      }
      // The launcher threads already exist, so this needs the server's environment at launch time.
      process.env.SPAWN_WORKER_LATE = "set after start";
      const late = yield* spawner.spawn(
        node("process.stdout.write(process.env.SPAWN_WORKER_LATE)"),
      );
      expect(yield* text(late.stdout)).toBe("set after start");
      delete process.env.SPAWN_WORKER_LATE;
      const extra = yield* spawner.spawn(
        node("require('node:fs').writeSync(3, 'fd3 value')", [], {
          additionalFds: { fd3: { type: "output" } },
        }),
      );
      const [fd3, extraCode] = yield* Effect.all([text(extra.getOutputFd(3)), extra.exitCode], {
        concurrency: "unbounded",
      });
      expect(fd3).toBe("fd3 value");
      expect(extraCode).toBe(0);
      const reader = yield* spawner.spawn(
        node("process.stdin.on('end', () => process.stdout.write('eof')).resume()"),
      );
      yield* Stream.fail("abandoned input").pipe(Stream.run(reader.stdin), Effect.ignore);
      expect(yield* text(reader.stdout)).toBe("eof");
      const pipeline = node("process.stdout.write('piped')").pipe(
        ChildProcess.pipeTo(
          node("process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"),
        ),
      );
      const piped = yield* spawner.spawn(pipeline);
      expect(yield* text(piped.stdout)).toBe("PIPED");
      expect(yield* piped.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports launch errors and exit codes, and keeps launching after either", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missing = yield* spawner.spawn(ChildProcess.make(missingCommand)).pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing)) expect(missing.failure.reason._tag).toBe("NotFound");
      const failed = yield* spawner.spawn(node("process.exit(23)"));
      expect(yield* failed.exitCode).toBe(23);
      const healthy = yield* spawner.spawn(node("process.stdout.write('ok')"));
      expect(yield* text(healthy.stdout)).toBe("ok");
      expect(yield* healthy.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "fails waiting and later writes and ends, and ends output, once a child leaves its launcher",
    () =>
      Effect.gen(function* () {
        // spawnPiped gives no descriptor beyond stderr; the pool it uses does.
        const first = SpawnWorker.spawnPiped(process.execPath, ["-e", ""], {});
        // Closed first, so no row's launcher still holds it.
        yield* Effect.promise(
          () =>
            new Promise((resolve, reject) => first.once("close", resolve).once("error", reject)),
        );
        const pool = first.worker.pool;
        // As with Node, a failed launch reports its error before the writes waiting on it fail, and
        // a close comes last, once every output is done, whether or not anyone reads it.
        for (const [leave, command, args, expected] of [
          [
            "finds no command",
            missingCommand,
            [],
            ["error", "write EPIPE", `close ${missingCommandErrno} null, output done`],
          ],
          // Node's spawn throws for a null byte in an argument; the launcher's throws in its thread.
          [
            "cannot be launched",
            process.execPath,
            ["-e", "\u0000"],
            ["error", "write EPIPE", "close null null, output done"],
          ],
          [
            "loses its launcher first",
            process.execPath,
            ["-e", ""],
            ["error", "write EPIPE", "close null null, output done"],
          ],
          ["closes", process.execPath, ["-e", ""], ["close 0 null, output done", "write EPIPE"]],
        ] as const) {
          const child = pool.spawn(command, args, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
          const output = NodeStreamPromises.finished(child.stdout!.resume());
          const extra = child.stdio[3] as NodeStream.Duplex;
          // A refused write or end errors the stream, as a broken pipe would.
          const extraClosed = new Promise((resolve) =>
            extra.on("error", () => {}).once("close", resolve),
          );
          const events: Array<string | undefined> = [];
          const extraEnd = vi.fn();
          const closed = new Promise<void>((resolve) =>
            child
              .once("error", () => events.push("error"))
              .once("close", (code, signal) => {
                const done = outputDone(child.stdout, child.stderr, extra);
                events.push(`close ${code} ${signal}, output ${done ? "done" : "open"}`);
                resolve();
              }),
          );
          if (leave === "closes") {
            yield* Effect.promise(() => closed);
            extra.write("late", (error) => events.push(error?.message));
            extra.end(extraEnd);
          } else {
            // A caller may end another pipe from the callback of a write that failed.
            child.stdin?.write("input", (error) => {
              events.push(error?.message);
              extra.end(extraEnd);
            });
            // The launcher reports the start by a message, which cannot have arrived yet.
            if (leave === "loses its launcher first") child.worker.fail(new Error("lost"));
            yield* Effect.promise(() => closed);
          }
          yield* Effect.promise(() => Promise.all([extraClosed, output]));
          expect([leave, events, extraEnd.mock.calls]).toEqual([
            leave,
            expected,
            [[expect.objectContaining({ code: "EPIPE" })]],
          ]);
        }
      }),
  );

  it.live(
    "closes a child once a reader holding its output reads it, or at once when it has none",
    () =>
      Effect.gen(function* () {
        // A child of its own keeps the output open after the child exits.
        const outlived =
          "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }).unref()";
        for (const [output, script, expected] of [
          ["held", "process.stdout.write('held')", [0, "held"]],
          ["none", "", [1, null]],
          ["none, ending after the exit", outlived, [1, null]],
        ] as const) {
          const pool = new SpawnWorker.__testing.SpawnWorkerPool("win32");
          const child = pool.spawn(process.execPath, ["-e", script], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          pool.close();
          // As in Node, only a 'readable' listener reads its output, and the close waits for its end.
          child.stdout!.on("readable", () => {});
          let closes = 0;
          child.on("close", () => closes++);
          // The launcher ends once it has sent the close, whether or not the output was read.
          yield* Effect.promise(() => NodeEvents.EventEmitter.once(child.worker.worker, "exit"));
          const closesAtLauncherEnd = closes;
          const closed = closes === 0 ? NodeEvents.EventEmitter.once(child, "close") : undefined;
          const read: Buffer | null = child.stdout!.read();
          if (closed !== undefined) yield* Effect.promise(() => closed);
          // No error listener stays behind, so an error after the close is the caller's, as in Node.
          expect([
            output,
            closesAtLauncherEnd,
            read?.toString() ?? null,
            closes,
            child.stdout!.listenerCount("error"),
          ]).toEqual([output, ...expected, 1, 0]);
        }
      }),
  );

  it.live("a short child's output ends while a sibling launched beside it still runs", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const untilStdin =
        "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0))";
      // Workers that own a child stay alive, as beside a running agent, so each round's two
      // launches land on two warm workers at once.
      yield* Effect.all(
        Array.from({ length: 4 }, () =>
          Effect.gen(function* () {
            const holder = yield* spawner.spawn(node(untilStdin));
            expect(yield* holder.stdout.pipe(Stream.take(1), text)).toBe("ready");
          }),
        ),
        { concurrency: "unbounded" },
      );
      for (let round = 0; round < 20; round++) {
        const [sibling, output] = yield* Effect.all(
          [
            spawner.spawn(node(untilStdin, [], { stdin: { stream: Stream.never } })),
            spawner
              .spawn(node("process.stdout.write('ok')"))
              .pipe(Effect.flatMap((child) => text(child.stdout))),
          ],
          { concurrency: "unbounded" },
        );
        expect(output).toBe("ok");
        expect(yield* sibling.isRunning).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("kills running commands, detached or not, and on scope interruption", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const detached of [true, false]) {
        const child = yield* spawner.spawn(
          node("process.stdout.write(String(process.pid));process.stdin.resume()", [], {
            detached,
          }),
        );
        const pid = yield* child.stdout.pipe(Stream.take(1), text);
        expect(Number(pid)).toBe(child.pid);
        yield* child.kill();
        expect(yield* child.isRunning).toBe(false);
      }
      const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const running = yield* Effect.gen(function* () {
        const scoped = yield* spawner.spawn(node("process.stdin.resume()"));
        yield* Deferred.succeed(started, scoped);
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);
      const scoped = yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(yield* scoped.isRunning).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "never ends a crashed launcher's child by its bare pid on Windows, reports a failed tree stop, and kills nothing on abort meanwhile",
    () =>
      Effect.gen(function* () {
        // The root may have ended since its launcher died, so its pid can name another process.
        for (const [stop, reported] of [
          ["exits 0", false],
          ["exits 1", true],
          ["loses its launcher before the start is reported", true],
          ["cannot launch", true],
          ["cannot get a launcher", true],
        ] as const) {
          // @effect-diagnostics-next-line abortControllerInEffect:off -- a Node caller's own signal, aborted mid-stop.
          const aborts = new AbortController();
          // It ends by itself once the dead launcher's end of its stdin closes.
          const root = SpawnWorker.spawnPiped(process.execPath, ["-e", "process.stdin.resume()"], {
            signal: aborts.signal,
          });
          const rootErrors: Array<string> = [];
          root.on("error", (error: Error) => rootErrors.push(error.name));
          yield* Effect.promise(() => new Promise((resolve) => root.once("spawn", resolve)));
          const pid = root.pid;
          if (pid === undefined) throw new Error("The launcher reported no pid.");
          const pool = root.worker.pool;
          const launch = pool.spawn;
          let killedWhileStopping: boolean | undefined;
          using requestStop = vi
            .spyOn(pool, "spawn")
            .mockImplementation((_command, _args, options) => {
              // The tree stop starts once the launcher is gone, so an abort now can signal nothing.
              aborts.abort();
              killedWhileStopping = root.killed;
              if (stop === "cannot launch") return launch(missingCommand, [], options);
              if (stop === "cannot get a launcher") throw new Error("No thread for a launcher.");
              const code = stop === "exits 0" ? 0 : 1;
              const child = launch(process.execPath, ["-e", `process.exit(${code})`], options);
              // A microtask runs before the launcher's reply can arrive.
              if (stop === "loses its launcher before the start is reported") {
                queueMicrotask(() => child.worker.fail(new Error("lost")));
              }
              return child;
            });
          using report = vi.spyOn(pool, "report").mockImplementation(() => {});
          using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
          const exited = new Promise((resolve) => root.once("exit", resolve));
          void root.worker.worker.terminate();
          yield* Effect.promise(() => exited);
          const [command, args] = requestStop.mock.calls[0] ?? [];
          expect(command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
          const created = root.treeRoot?.created;
          if (created === undefined || created === "unknown") throw new Error("No creation window");
          expect(args?.at(-1)).toMatch(
            new RegExp(`Stop-T3ProcessTree ${pid} ${created.from} ${created.from} ${created.to}$`),
          );
          expect([
            stop,
            kill.mock.calls.some(([target]) => target === pid),
            report.mock.calls.length,
            killedWhileStopping,
            rootErrors,
          ]).toEqual([stop, false, reported ? 1 : 0, false, []]);
        }
      }),
  );

  it.live(
    "signals the leader by handle and waits for descendant cleanup before reporting exit",
    () =>
      Effect.gen(function* () {
        const pool = new SpawnWorker.__testing.SpawnWorkerPool("win32");
        const stopStarted = Promise.withResolvers<() => void>();
        let finishStop: (() => void) | undefined;
        using stop = vi.spyOn(pool, "killTree").mockImplementation((_root, done) => {
          finishStop = done;
          stopStarted.resolve(done);
        });
        const child = pool.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stopTreeOnKill = true;
        pool.close();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!child.exited) child.stdin?.end();
            finishStop?.();
          }),
        );
        const events: Array<string> = [];
        child.on("exit", () => events.push("exit"));
        child.on("close", () => events.push("close"));
        const closed = NodeEvents.EventEmitter.once(child, "close");
        yield* Effect.promise(() => NodeEvents.EventEmitter.once(child, "spawn"));
        using posted = vi.spyOn(child.worker, "post");
        expect(child.kill()).toBe(true);
        expect(posted).toHaveBeenCalledWith({ type: "kill", id: child.id, signal: "SIGTERM" });
        const finish = yield* Effect.promise(() => stopStarted.promise);
        expect(stop).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            pid: child.pid,
            created: expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) }),
            ended: expect.any(Number),
          }),
          finish,
        );
        expect(events).toEqual([]);
        expect(child.kill()).toBe(false);
        finishStop = undefined;
        finish();
        yield* Effect.promise(() => closed);
        expect(events).toEqual(["exit", "close"]);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
    "stops a detached Windows descendant on a direct Claude-style child kill",
    () =>
      Effect.gen(function* () {
        const connected = Promise.withResolvers<NodeNet.Socket>();
        const server = NodeNet.createServer(connected.resolve);
        const sockets = new Set<NodeNet.Socket>();
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.close();
            for (const socket of sockets) socket.destroy();
          }),
        );
        const port = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) =>
              server
                .once("error", reject)
                .listen(0, "127.0.0.1", () =>
                  resolve((server.address() as NodeNet.AddressInfo).port),
                ),
            ),
        );
        const descendant = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("close", () => process.exit())`;
        const child = SpawnWorker.spawnPiped(
          process.execPath,
          [
            "-e",
            `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { detached: true, stdio: "ignore" }).unref(); process.stdin.resume();`,
            String(port),
          ],
          {},
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!child.exited) child.stdin.end();
          }),
        );
        const exited = NodeEvents.EventEmitter.once(child, "exit");
        const socket = yield* Effect.promise(() => connected.promise);
        const disconnected = NodeEvents.EventEmitter.once(socket, "close");
        expect(child.kill()).toBe(true);
        yield* Effect.promise(() => Promise.all([exited, disconnected]));
      }).pipe(Effect.scoped),
  );

  it.live("keeps a child working after its spawner layer closes, then ends its launcher", () =>
    Effect.gen(function* () {
      // A child's scope can outlive the spawner layer whose release closes the pool.
      for (const finish of ["ends its input", "is stopped"] as const) {
        const launcherEnded = Promise.withResolvers<void>();
        const terminate = NodeWorkerThreads.Worker.prototype.terminate;
        using _terminate = vi
          .spyOn(NodeWorkerThreads.Worker.prototype, "terminate")
          .mockImplementation(function (this: NodeWorkerThreads.Worker) {
            const exited = terminate.call(this);
            void exited.then(() => launcherEnded.resolve());
            return exited;
          });
        yield* Effect.gen(function* () {
          const child = yield* Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            return yield* spawner.spawn(node("process.stdin.pipe(process.stdout)"));
          }).pipe(Effect.provide(layer));
          if (finish === "ends its input") {
            // Written only now, after the layer's release closed the pool.
            yield* Stream.make("input").pipe(Stream.encodeText, Stream.run(child.stdin));
            expect(yield* text(child.stdout)).toBe("input");
            expect(yield* child.exitCode).toBe(0);
          } else {
            yield* child.kill();
            expect(yield* child.isRunning).toBe(false);
          }
        }).pipe(Effect.scoped);
        yield* Effect.promise(() => launcherEnded.promise);
      }
    }),
  );

  it.live(
    "closes a child whose output the caller destroys after it exits, while a descendant holds it",
    () =>
      Effect.gen(function* () {
        // The descendant lives only while connected here, so it ends with the test or its runner.
        const connected = Promise.withResolvers<void>();
        const connections = new Set<NodeNet.Socket>();
        const control = NodeNet.createServer((connection) => {
          connections.add(connection);
          connected.resolve();
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            control.close();
            for (const connection of connections) connection.destroy();
          }),
        );
        const port = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) =>
              control
                .once("error", reject)
                .listen(0, "127.0.0.1", () =>
                  resolve((control.address() as NodeNet.AddressInfo).port),
                ),
            ),
        );
        const descendant = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("close", () => process.exit())`;
        const child = SpawnWorker.spawnPiped(
          process.execPath,
          [
            "-e",
            `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: ["ignore", "inherit", "ignore"] });
             process.exit(0);`,
            String(port),
          ],
          {},
        );
        const exited = new Promise((resolve) => child.once("exit", resolve));
        yield* Effect.promise(() => Promise.all([exited, connected.promise]));
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.stdout.destroy();
        yield* Effect.promise(() => closed);
      }).pipe(Effect.scoped),
  );

  it.live(
    "takes a file URL as the working directory, and an unref before the start is reported",
    () =>
      Effect.gen(function* () {
        const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
        const located = SpawnWorker.spawnPiped(
          process.execPath,
          ["-e", "process.stdout.write(process.cwd())"],
          {
            cwd: NodeURL.pathToFileURL(cwd),
          },
        );
        let output = "";
        located.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
        yield* Effect.promise(() => new Promise((resolve) => located.once("close", resolve)));
        expect(output).toBe(cwd);
        const quiet = SpawnWorker.spawnPiped(
          process.execPath,
          ["-e", "process.stdin.resume()"],
          {},
        );
        const launcher = quiet.worker.worker;
        using ref = vi.spyOn(launcher, "ref");
        using unref = vi.spyOn(launcher, "unref");
        const referenced = () =>
          Math.max(0, ...ref.mock.invocationCallOrder) >
          Math.max(0, ...unref.mock.invocationCallOrder);
        quiet.unref();
        // The launch keeps its launcher referenced until the start is reported.
        const launching = referenced();
        const started = yield* Effect.promise(
          () => new Promise<boolean>((resolve) => quiet.once("spawn", () => resolve(referenced()))),
        );
        const closed = new Promise((resolve) => quiet.once("close", resolve));
        quiet.kill();
        yield* Effect.promise(() => closed);
        expect([launching, started]).toEqual([true, false]);
      }),
  );

  it.live(
    "starts nothing and keeps no abort listener for a launch it refuses or that fails, and reads its signal only before the send",
    () =>
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const listeners = () => NodeEvents.EventEmitter.getEventListeners(signal, "abort").length;
        using post = vi.spyOn(NodeWorkerThreads.Worker.prototype, "postMessage");
        const sent = () =>
          post.mock.calls.filter(
            ([message], call) =>
              message.type === "spawn" && post.mock.results[call]?.type === "return",
          ).length;
        const failed = SpawnWorker.spawnPiped(missingCommand, [], { signal });
        yield* Effect.promise(
          () => new Promise((resolve) => failed.on("error", () => {}).once("close", resolve)),
        );
        expect([sent(), listeners()]).toEqual([1, 0]);
        const pool = failed.worker.pool;
        const unreadable = yield* Effect.abortSignal;
        Object.defineProperty(unreadable, "aborted", {
          get: () => {
            throw new Error("unreadable signal");
          },
        });
        // Node's own spawn throws for each of these before it starts anything.
        for (const [options, refusal] of [
          [{ cwd: new URL("https://example.com/") }, { code: "ERR_INVALID_URL_SCHEME" }],
          [{ signal: {} as AbortSignal }, { name: "TypeError" }],
          [{ signal: unreadable }, { message: "unreadable signal" }],
          [
            { signal, env: { T3_UNSENDABLE: Symbol() as unknown as string } },
            { name: "DataCloneError" },
          ],
        ] as const) {
          expect(() => SpawnWorker.spawnPiped(process.execPath, ["-e", ""], options)).toThrow(
            expect.objectContaining(refusal),
          );
          expect([
            sent(),
            listeners(),
            [...pool.workers].map((worker) => [worker.launching, worker.children.size]),
          ]).toEqual([1, 0, [...pool.workers].map(() => [0, 0])]);
        }
        // A read after the launch is sent could throw once the child has started.
        const readFirst = yield* Effect.abortSignal;
        const sentBefore = sent();
        Object.defineProperty(readFirst, "aborted", {
          get: () => {
            if (sent() > sentBefore) throw new Error("read after the launch was sent");
            return false;
          },
        });
        const launched = SpawnWorker.spawnPiped(process.execPath, ["-e", ""], {
          signal: readFirst,
        });
        yield* Effect.promise(() => NodeEvents.EventEmitter.once(launched, "close"));
      }).pipe(Effect.scoped),
  );

  it("reports launches, aborts and exits as Node's spawn does", async () => {
    // Each child ends at input EOF, sent once its start is reported, so a lost kill ends it
    // cleanly instead of hanging the test.
    const resident = ["-e", "process.stdin.resume()"];
    type Abort = "never" | "before" | "while sent" | "once sent" | "once started";
    type Observed = NodeEvents.EventEmitter & {
      readonly killed: boolean;
      readonly stdin: NodeStream.Writable | null;
      readonly stdout: NodeStream.Readable | null;
      readonly stderr: NodeStream.Readable | null;
    };
    // What a caller sees, in order, from Node's spawn or from a pool of the test's own, closed
    // once the launch is sent so a child it drops ends its launcher instead of hanging the test.
    const run = async (
      command: string,
      args: ReadonlyArray<string>,
      abort: Abort,
      pool?: InstanceType<typeof SpawnWorker.__testing.SpawnWorkerPool>,
      killSignal: NodeJS.Signals = "SIGTERM",
    ) => {
      const controller = new AbortController();
      if (abort === "before") controller.abort();
      // Another listener stops the event, and closes the pool while the launch is sent.
      controller.signal.addEventListener("abort", (event) => {
        event.stopImmediatePropagation();
        pool?.close();
      });
      // The launch is copied while it is sent, and the copy reads this getter.
      const env = { ...process.env };
      if (abort === "while sent") {
        Object.defineProperty(env, "T3_ABORTS", {
          enumerable: true,
          get: () => {
            controller.abort();
            return "1";
          },
        });
      }
      const options: NodeChildProcess.SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller.signal,
        killSignal,
        env,
      };
      let child: Observed;
      let ended: Promise<string> | undefined;
      if (pool === undefined) child = NodeChildProcess.spawn(command, args, options);
      else {
        const launched = pool.spawn(command, args, options);
        pool.close();
        ended = NodeEvents.EventEmitter.once(launched.worker.worker, "exit").then(
          () => "launcher ended",
        );
        child = launched;
      }
      const seen: Array<unknown> = [["killed at return", child.killed]];
      if (abort === "once sent") {
        controller.abort();
        seen.push(["aborted", child.killed]);
      }
      let killedOnNextTick: boolean | undefined;
      process.nextTick(() => {
        killedOnNextTick = child.killed;
      });
      child.on("spawn", () => {
        seen.push("spawn");
        if (abort === "once started") {
          controller.abort(new Error("stopped"));
          seen.push(["aborted", child.killed]);
        }
        child.stdin?.end();
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        seen.push(["error", error.name, error.code, error.cause === controller.signal.reason]),
      );
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        seen.push(["exit", code, signal]),
      );
      let closes = 0;
      const closed = new Promise((resolve) =>
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          closes++;
          resolve(["close", code, signal, child.killed, outputDone(child.stdout, child.stderr)]);
        }),
      );
      seen.push(await (ended === undefined ? closed : Promise.race([closed, ended])));
      // The launcher ends once its last child closes, and its end closes no child again.
      await ended;
      seen.push(["closes", closes]);
      // An abort that came first kills on the next tick. Node also reports its start on that tick,
      // which the worker cannot, so a failed launch and an abort at the start are not compared.
      if (command !== missingCommand && abort !== "once started") {
        seen.push(["killed on the next tick", killedOnNextTick]);
      }
      return seen;
    };
    const { SpawnWorkerPool } = SpawnWorker.__testing;
    for (const [command, args, abort, killSignal] of [
      [missingCommand, [], "never"],
      [missingCommand, [], "before"],
      [process.execPath, ["-e", "process.exit(3)"], "never"],
      [process.execPath, resident, "before"],
      [process.execPath, resident, "while sent"],
      [process.execPath, resident, "once started", "SIGKILL"],
    ] as const) {
      const node = await run(command, args, abort, undefined, killSignal);
      const worker = await run(command, args, abort, new SpawnWorkerPool("win32"), killSignal);
      expect([command, abort, worker]).toEqual([command, abort, node]);
    }
    // Node knows at once whether its launch failed, so it reports this kill before the start; the
    // worker knows only once it answers, so this acts as an abort that came before the spawn.
    expect([
      await run(process.execPath, resident, "once sent", new SpawnWorkerPool("win32")),
      await run(missingCommand, [], "once sent", new SpawnWorkerPool("win32")),
    ]).toEqual([
      [
        ["killed at return", false],
        ["aborted", true],
        "spawn",
        ["error", "AbortError", "ABORT_ERR", true],
        ["exit", null, "SIGTERM"],
        ["close", null, "SIGTERM", true, true],
        ["closes", 1],
        ["killed on the next tick", true],
      ],
      [
        ["killed at return", false],
        ["aborted", true],
        ["error", "Error", "ENOENT", false],
        ["close", missingCommandErrno, null, false, true],
        ["closes", 1],
      ],
    ]);
  });
});
