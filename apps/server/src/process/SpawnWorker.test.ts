// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - fixtures need real paths, the process resource list and the live environment.
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
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
      const cwd = NodeOS.tmpdir();
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
          JSON.stringify(["stdin value", NodePath.resolve(cwd), "inherited value", literal]) +
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
      const missing = yield* spawner
        .spawn(ChildProcess.make("t3-missing-command-25245"))
        .pipe(Effect.result);
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
        for (const leave of ["finds no command", "loses its launcher first", "closes"] as const) {
          const missing = leave === "finds no command";
          const child = pool.spawn(
            missing ? "t3-missing-command-25245" : process.execPath,
            missing ? [] : ["-e", ""],
            { stdio: ["pipe", "pipe", "pipe", "pipe"] },
          );
          const output = NodeStreamPromises.finished(child.stdout!.resume());
          const extra = child.stdio[3] as NodeStream.Duplex;
          // A refused write or end errors the stream, as a broken pipe would.
          const extraClosed = new Promise((resolve) =>
            extra.on("error", () => {}).once("close", resolve),
          );
          const events: Array<string | undefined> = [];
          const extraEnd = vi.fn();
          if (leave === "closes") {
            yield* Effect.promise(() => new Promise((resolve) => child.once("close", resolve)));
            extra.write("late", (error) => events.push(error?.message));
            extra.end(extraEnd);
          } else {
            // A caller may end another pipe from the callback of a write that failed.
            child.stdin?.write("input", (error) => {
              events.push(error?.message);
              extra.end(extraEnd);
            });
            const failed = new Promise<void>((resolve) =>
              child.once("error", () => {
                events.push("error");
                resolve();
              }),
            );
            // The launcher reports the start by a message, which cannot have arrived yet.
            if (leave === "loses its launcher first") child.worker.fail(new Error("lost"));
            yield* Effect.promise(() => failed);
          }
          yield* Effect.promise(() => Promise.all([extraClosed, output]));
          // As with Node, a failed launch reports its error before the writes waiting on it fail.
          expect([leave, events, extraEnd.mock.calls]).toEqual([
            leave,
            leave === "closes" ? ["write EPIPE"] : ["error", "write EPIPE"],
            [[expect.objectContaining({ code: "EPIPE" })]],
          ]);
        }
      }),
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
      // Direct callers such as the Claude adapter pass an AbortSignal, which cannot cross to a worker.
      const direct = SpawnWorker.spawnPiped(process.execPath, ["-e", "process.stdin.resume()"], {
        signal: AbortSignal.abort(),
      });
      const exited = new Promise((resolve) => direct.once("exit", () => resolve(direct.killed)));
      expect(yield* Effect.promise(() => exited)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "never ends a crashed launcher's child by its bare pid on Windows, and reports a failed tree stop",
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
          // It ends by itself once the dead launcher's end of its stdin closes.
          const root = SpawnWorker.spawnPiped(
            process.execPath,
            ["-e", "process.stdin.resume()"],
            {},
          );
          yield* Effect.promise(() => new Promise((resolve) => root.once("spawn", resolve)));
          const pid = root.pid;
          if (pid === undefined) throw new Error("The launcher reported no pid.");
          const pool = root.worker.pool;
          const launch = pool.spawn;
          using _stop = vi.spyOn(pool, "spawn").mockImplementation((_command, _args, options) => {
            if (stop === "cannot launch") return launch("t3-missing-command-25245", [], options);
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
          expect([
            stop,
            kill.mock.calls.some(([target]) => target === pid),
            report.mock.calls.length,
          ]).toEqual([stop, false, reported ? 1 : 0]);
        }
      }),
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
        const cwd = NodeOS.tmpdir();
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
        expect(output).toBe(NodePath.resolve(cwd));
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
        const failed = SpawnWorker.spawnPiped("t3-missing-command-25245", [], { signal });
        yield* Effect.promise(() => new Promise((resolve) => failed.once("error", resolve)));
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

  it("kills on abort before, while and after the launch is sent, even when another listener stops the event or closes the pool", async () => {
    // Each child ends at input EOF, sent only once its start is reported, so a lost kill ends it
    // cleanly instead of hanging the test.
    const resident = ["-e", "process.stdin.resume()"];
    // After a callback, Node runs its next-tick queue before microtasks; an abort that came first
    // kills on the next tick, as with Node's own spawn, so the caller's next tick sees it killed.
    const first = Promise.withResolvers<{
      child: ReturnType<typeof SpawnWorker.spawnPiped>;
      killed: boolean;
    }>();
    setImmediate(() => {
      try {
        const child = SpawnWorker.spawnPiped(process.execPath, resident, {
          signal: AbortSignal.abort(),
        });
        child.once("spawn", () => child.stdin.end());
        process.nextTick(() => first.resolve({ child, killed: child.killed }));
      } catch (error) {
        first.reject(error);
      }
    });
    const before = await first.promise;
    expect([before.killed, ...(await NodeEvents.EventEmitter.once(before.child, "exit"))]).toEqual([
      true,
      null,
      "SIGTERM",
    ]);
    // A pool of its own, as the listener below closes it.
    const shared = before.child.worker.pool;
    const pool = new (shared.constructor as new (platform: NodeJS.Platform) => typeof shared)(
      "win32",
    );
    const sending = new AbortController();
    sending.signal.addEventListener("abort", (event) => {
      event.stopImmediatePropagation();
      pool.close();
    });
    // The launch is copied while it is sent, and the copy reads this getter.
    const env = { ...process.env };
    Object.defineProperty(env, "T3_ABORTS", {
      enumerable: true,
      get: () => {
        sending.abort();
        return "1";
      },
    });
    const early = pool.spawn(process.execPath, resident, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: sending.signal,
      env,
    });
    early.once("spawn", () => early.stdin?.end());
    const launcherEnded = NodeEvents.EventEmitter.once(early.worker.worker, "exit").then(
      () => "launcher ended",
    );
    expect(
      await Promise.race([NodeEvents.EventEmitter.once(early, "exit"), launcherEnded]),
    ).toEqual([null, "SIGTERM"]);
    // After the launch, the kill goes out before abort() returns, as with Node's own spawn.
    const running = new AbortController();
    const late = SpawnWorker.spawnPiped(process.execPath, resident, { signal: running.signal });
    await NodeEvents.EventEmitter.once(late, "spawn");
    running.abort();
    const killedByAbort = late.killed;
    late.stdin.end();
    expect([killedByAbort, ...(await NodeEvents.EventEmitter.once(late, "exit"))]).toEqual([
      true,
      null,
      "SIGTERM",
    ]);
  });
});
