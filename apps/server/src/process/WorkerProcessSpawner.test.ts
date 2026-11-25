// @effect-diagnostics nodeBuiltinImport:off - one test makes the main thread's execFile throw.
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { leaderLeavingChild, processPipe } from "@t3tools/shared/testing/leftoverChild";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import { timeoutProcessOption } from "./processDeadline.ts";
import * as WorkerProcessSpawner from "./WorkerProcessSpawner.ts";

const layer = WorkerProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer));
// Takes the Windows paths on any host.
const windowsLayer = WorkerProcessSpawner.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
);

const node = (script: string, options?: ChildProcess.CommandOptions) =>
  ChildProcess.make(process.execPath, ["-e", script], options);

const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;

const errorLogs = () => {
  const messages: Array<unknown> = [];
  const logged = Deferred.makeUnsafe<void>();
  const logger = Logger.make(({ logLevel, message, cause }) => {
    if (logLevel !== "Error") return;
    messages.push([message, Cause.pretty(cause)]);
    Deferred.doneUnsafe(logged, Effect.void);
  });
  return { messages, logged: Deferred.await(logged), layer: Logger.layer([logger]) };
};

// Within the scope, the main thread's execFile throws as Node's does for a spawn error like ENOMEM.
const execFileThrows = (error: Error) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const childProcess = NodeModule.createRequire(import.meta.url)(
        "node:child_process",
      ) as typeof NodeChildProcess;
      const spy = vi.spyOn(childProcess, "execFile").mockImplementation(() => {
        throw error;
      });
      NodeModule.syncBuiltinESMExports();
      return spy;
    }),
    (spy) =>
      Effect.sync(() => {
        spy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }),
  );

// Within the scope, the main thread's execFile records its arguments and never runs PowerShell.
const execFileCalls = Effect.acquireRelease(
  Effect.sync(() => {
    const childProcess = NodeModule.createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof NodeChildProcess;
    const calls: Array<ReadonlyArray<string>> = [];
    const spy = vi.spyOn(childProcess, "execFile").mockImplementation(((
      _file: string,
      args: ReadonlyArray<string>,
    ) => {
      calls.push(args);
    }) as never);
    NodeModule.syncBuiltinESMExports();
    return { spy, calls };
  }),
  ({ spy }) =>
    Effect.sync(() => {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }),
);

describe("WorkerProcessSpawner", () => {
  it.live("relays stdin, output and the exit code", () =>
    Effect.gen(function* () {
      const handle = yield* node(
        "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.exitCode = 3; });",
        { stdin: Stream.encodeText(Stream.make("hello ", "worker")) },
      );
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);

      assert.equal(stdout, "hello worker");
      assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(3));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("relays output past the high-water mark intact", () =>
    Effect.gen(function* () {
      const bytes = 3 * 1024 * 1024;
      const handle = yield* node(`process.stdout.write(Buffer.alloc(${bytes}, 120));`);
      const received = yield* handle.stdout.pipe(
        Stream.runFold(
          () => 0,
          (total, chunk) => total + chunk.byteLength,
        ),
      );

      assert.equal(received, bytes);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports a missing executable as NotFound", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        ChildProcess.make("t3-worker-spawner-missing-executable", [], quiet).pipe(Effect.scoped),
      );

      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.findErrorOption(exit);
      assert.isTrue(Option.isSome(error));
      if (Option.isNone(error)) return;
      assert.equal(error.value.reason._tag, "NotFound");
    }).pipe(Effect.provide(layer)),
  );

  it.live("kills a child that was unreferenced and whose scope closed", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const handle = yield* node("setInterval(() => {}, 1000);", quiet).pipe(Scope.provide(scope));
      yield* Effect.asVoid(handle.unref);
      yield* Scope.close(scope, Exit.void);

      yield* handle.kill({ killSignal: "SIGKILL" });

      assert.isFalse(yield* handle.isRunning);
    }).pipe(Effect.provide(layer)),
  );

  it.live("a deadline returns an exit the worker held back while it started another process", () =>
    Effect.gen(function* () {
      const exited = yield* node("setTimeout(() => {}, 200);", quiet);
      yield* WorkerProcessSpawner.__testing.slowStarts(2_000);
      yield* Effect.forkScoped(node("", quiet));

      const exitCode = yield* exited.exitCode.pipe(timeoutProcessOption("1 second"));

      assert.deepStrictEqual(exitCode, Option.some(ChildProcessSpawner.ExitCode(0)));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("a command cancelled while another process starts stops waiting at once", () =>
    Effect.gen(function* () {
      yield* WorkerProcessSpawner.__testing.slowStarts(1_000);
      const starting = yield* Effect.forkScoped(node("", quiet), { startImmediately: true });
      const queued = yield* Effect.forkScoped(node("", quiet), { startImmediately: true });

      yield* Fiber.interrupt(queued);

      assert.isUndefined(starting.pollUnsafe());
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("settles after the start in progress, ahead of the starts queued behind it", () =>
    Effect.gen(function* () {
      yield* WorkerProcessSpawner.__testing.slowStarts(1_000);
      yield* Effect.forkScoped(node("", quiet), { startImmediately: true });
      const queued = yield* Effect.forkScoped(node("", quiet), { startImmediately: true });

      yield* WorkerProcessSpawner.settle;

      assert.isUndefined(queued.pollUnsafe());
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  // The leader exits at once and leaves a child running, which each way of ending the leader reaches.
  const leaderThatLeftAChild = (leftover: Effect.Success<ReturnType<typeof leaderLeavingChild>>) =>
    Effect.gen(function* () {
      const leader = yield* leftover.command;
      yield* leftover.started;
      assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
      return leader;
    });

  it.live("kill ends what a child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild();
      const leader = yield* leaderThatLeftAChild(leftover);

      yield* leader.kill();

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("an interrupted command ends what its child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild();
      const exited = yield* Deferred.make<void>();
      const command = yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* leaderThatLeftAChild(leftover);
          yield* Deferred.succeed(exited, undefined);
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      );
      yield* Deferred.await(exited);

      yield* Fiber.interrupt(command);

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("releasing a failed command logs no error once nothing of it runs", () => {
    const errors = errorLogs();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.flatMap(node("process.exit(1)", quiet), (handle) => handle.exitCode),
      );

      assert.deepEqual(errors.messages, []);
    }).pipe(Effect.provide(Layer.merge(layer, errors.layer)));
  });

  // It exits when the stopped worker closes its stdin, and no one hears of that exit. As in the
  // server, the spawning fiber has the logger and the spawner's layer does not.
  const leaderOfWorkerToStop = (errors: ReturnType<typeof errorLogs>) =>
    node("process.stdin.resume();", { stdout: "ignore", stderr: "ignore" }).pipe(
      Effect.provide(errors.layer),
    );

  // PowerShell is missing here, so the walk fails as a denied WMI query does on Windows.
  it.live.skipIf(isWindowsHost)(
    "a stopped worker that cannot start another walks the tree and logs to the spawning fiber",
    () => {
      const errors = errorLogs();
      return Effect.gen(function* () {
        const leader = yield* leaderOfWorkerToStop(errors);
        const kill = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(process, "kill")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        yield* WorkerProcessSpawner.__testing.failWorkerStarts;

        yield* WorkerProcessSpawner.__testing.stopWorker;

        yield* errors.logged;
        assert.notInclude(
          kill.mock.calls.map(([pid]) => pid),
          leader.pid,
        );
      }).pipe(Effect.scoped, Effect.provide(windowsLayer));
    },
  );

  it.live(
    "a stopped worker's walk of a leader whose exit it relayed bounds the root by that exit",
    () =>
      Effect.gen(function* () {
        const leader = yield* node("", quiet);
        yield* leader.exitCode;
        const { calls } = yield* execFileCalls;
        yield* WorkerProcessSpawner.__testing.failWorkerStarts;

        yield* WorkerProcessSpawner.__testing.stopWorker;

        assert.match(calls.at(-1)?.at(-1) ?? "", / -ended \d+$/);
      }).pipe(Effect.scoped, Effect.provide(windowsLayer)),
  );

  it.live("a stopped worker's walk of a leader that may still run names no end", () => {
    const errors = errorLogs();
    return Effect.gen(function* () {
      yield* leaderOfWorkerToStop(errors);
      const { calls } = yield* execFileCalls;
      yield* WorkerProcessSpawner.__testing.failWorkerStarts;

      yield* WorkerProcessSpawner.__testing.stopWorker;

      assert.notInclude(calls.at(-1)?.at(-1) ?? "", "-ended");
    }).pipe(Effect.scoped, Effect.provide(windowsLayer));
  });

  it.live(
    "a stopped worker whose tree walk cannot start PowerShell logs it and fails its children",
    () => {
      const errors = errorLogs();
      return Effect.gen(function* () {
        const leader = yield* leaderOfWorkerToStop(errors);
        yield* execFileThrows(Object.assign(new Error("spawn ENOMEM"), { code: "ENOMEM" }));
        yield* WorkerProcessSpawner.__testing.failWorkerStarts;

        yield* WorkerProcessSpawner.__testing.stopWorker;

        yield* errors.logged;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(leader.exitCode)));
      }).pipe(Effect.scoped, Effect.provide(windowsLayer));
    },
  );

  // POSIX gives no process the pid of a group that still exists, so one holding it ended the group.
  it.live.skipIf(isWindowsHost)(
    "a stopped worker spares the group of a reaped leader whose pid another process took",
    () =>
      Effect.gen(function* () {
        const leader = yield* node("", quiet);
        yield* leader.exitCode;
        const kill = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const signal = process.kill.bind(process);
            return vi
              .spyOn(process, "kill")
              .mockImplementation((pid, code) =>
                pid === leader.pid && code === 0 ? true : signal(pid, code),
              );
          }),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );

        yield* WorkerProcessSpawner.__testing.stopWorker;

        assert.notDeepInclude(kill.mock.calls, [-leader.pid, "SIGKILL"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  // Linux hands a ptrace stop to the tracer's waitpid, and Node reports it as an exit of the leader,
  // which still holds its pid: stopped, or as a zombie if another process kills it there. It runs on
  // once a stopped worker's thread, its tracer, has ended. libuv stops waiting for it at that stop,
  // so once ended it stays a zombie until this process exits.
  describe.runIf(isLinuxHost)("a leader Node reported as exited at a ptrace stop", () => {
    const tracedStop = [
      "import ctypes, os, signal, socket, sys, time",
      "def hold(path):",
      "    s = socket.socket(socket.AF_UNIX); s.connect(path); s.send(str(os.getpid()).encode()); return s",
      "if os.fork() == 0:",
      "    left = hold(sys.argv[2]); time.sleep(300); sys.exit()",
      "led = hold(sys.argv[1])",
      "if ctypes.CDLL(None).ptrace(0, 0, None, None) != 0: sys.exit(2)",
      "os.kill(os.getpid(), signal.SIGSTOP)",
      "time.sleep(300)",
    ].join("\n");
    const kill = (leader: ChildProcessSpawner.ChildProcessHandle) =>
      leader.kill({ killSignal: "SIGKILL" });
    const stopWorker = () => WorkerProcessSpawner.__testing.stopWorker;
    const killedAtExit = WorkerProcessSpawner.__testing.leadersKilledAtExit;

    it.live.each([
      { state: "still stopped", atExit: Effect.void, through: "kill", end: kill },
      { state: "still stopped", atExit: Effect.void, through: "a stopped worker", end: stopWorker },
      { state: "killed as its exit arrived", atExit: killedAtExit, through: "kill", end: kill },
      {
        state: "killed as its exit arrived",
        atExit: killedAtExit,
        through: "a stopped worker",
        end: stopWorker,
      },
    ])("$state, has its group ended through $through", ({ atExit, end }) =>
      Effect.gen(function* () {
        yield* atExit;
        const led = yield* processPipe;
        const left = yield* processPipe;
        const leader = yield* ChildProcess.make(
          "python3",
          ["-c", tracedStop, led.path, left.path],
          quiet,
        );
        assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
        yield* left.started;

        yield* end(leader);

        yield* led.ended;
        yield* left.ended;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  it.live.each([
    { through: "a new worker", replacement: Effect.void },
    { through: "no worker", replacement: WorkerProcessSpawner.__testing.failWorkerStarts },
  ])(
    "a stopped worker kills what a child left running after it exited, through $through",
    ({ replacement }) =>
      Effect.gen(function* () {
        const leftover = yield* leaderLeavingChild();
        yield* leaderThatLeftAChild(leftover);
        yield* replacement;

        yield* WorkerProcessSpawner.__testing.stopWorker;

        yield* leftover.ended;
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
