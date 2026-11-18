// @effect-diagnostics nodeBuiltinImport:off - one test makes the main thread's execFile throw.
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  AWAIT_HOLDER_PYTHON,
  watchFreedGroupSignals,
} from "@t3tools/shared/testing/freedProcessGroups";
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

// The worker records its signals to freed process groups while watchFreedGroupSignals is in scope.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { freedGroupsWorkerPreamble } = await import("@t3tools/shared/testing/freedProcessGroups");
  class Worker extends actual.Worker {
    constructor(source: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      super(options?.eval === true ? freedGroupsWorkerPreamble + String(source) : source, options);
    }
  }
  return { ...actual, Worker };
});

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

  describe.skipIf(isWindowsHost)("a POSIX group after its leader's exit", () => {
    // Once a leader exited and its group emptied, an unrelated group may take the number.
    it.live.each([
      { through: "its release", end: Effect.void },
      { through: "a stopped worker", end: WorkerProcessSpawner.__testing.stopWorker },
    ])("gets no signal once its number may be another's, through $through", ({ end }) =>
      Effect.gen(function* () {
        const freed = yield* watchFreedGroupSignals;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const leader = yield* node("", quiet);
            yield* leader.exitCode;
            yield* end;
          }),
        );

        assert.deepEqual(freed.signals(), []);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.live("still gets the forced kill of a release that SIGTERM ended the leader of", () =>
      Effect.gen(function* () {
        const pipe = yield* processPipe;
        const staysOnTerm =
          "process.on('SIGTERM', () => {});" +
          " const s = require('node:net').connect(process.argv[1], () => s.write(String(process.pid)));" +
          " s.on('error', () => {}); setTimeout(() => {}, 300_000);";
        const leader =
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(staysOnTerm)}, ${JSON.stringify(pipe.path)}], { stdio: 'ignore' });` +
          " setInterval(() => {}, 1000);";

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* node(leader, { ...quiet, forceKillAfter: "200 millis" });
            yield* pipe.started;
          }),
        );

        yield* pipe.ended;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // A member moves back into the group from a job of its own and exits there; that job, outside
    // the group, never reaps it. The leader exits once the member has, which closes their pipe.
    it.live("releases without error a group left with members that exited unreaped", () => {
      const errors = errorLogs();
      const unreapedMember = [
        "import os, socket, sys, time",
        "group = os.getpid(); r, w = os.pipe()",
        "if os.fork() == 0:",
        "  os.close(r); os.setpgid(0, 0)",
        "  if os.fork() == 0: os.setpgid(0, group); os._exit(0)",
        "  s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.send(str(os.getpid()).encode())",
        "  os.close(w); time.sleep(300); os._exit(0)",
        "os.close(w); os.read(r, 1)",
      ].join("\n");
      return Effect.gen(function* () {
        const job = yield* processPipe;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const leader = yield* ChildProcess.make(
              "python3",
              ["-c", unreapedMember, job.path],
              quiet,
            );
            yield* leader.exitCode;
            yield* job.started;
          }),
        );

        assert.deepEqual(errors.messages, []);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, errors.layer)));
    });

    // The command reports once its holder ended, which would first end the group were the command
    // referenced.
    it.live("of an unreferenced child survives a stopped worker", () =>
      Effect.gen(function* () {
        const pipe = yield* processPipe;
        const outlivesHolder = [
          AWAIT_HOLDER_PYTHON,
          "import socket, time",
          "s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])",
          "await_holder(lambda: None)",
          "s.send(str(os.getpid()).encode()); time.sleep(300)",
        ].join("\n");
        const child = yield* ChildProcess.make("python3", ["-c", outlivesHolder, pipe.path], quiet);
        yield* Effect.asVoid(child.unref);
        yield* WorkerProcessSpawner.settle;

        yield* WorkerProcessSpawner.__testing.stopWorker;

        const outcome = yield* Effect.raceFirst(
          Effect.as(pipe.started, "survived"),
          Effect.as(pipe.ended, "ended"),
        );
        assert.equal(outcome, "survived");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  // Linux hands a ptrace stop to the tracer's waitpid, and Node reports it as an exit of the leader,
  // which still holds its pid. It runs on once a stopped worker's thread, its tracer, has ended.
  // libuv stops waiting for it at that stop, so once ended it stays a zombie until this process exits.
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

    it.live.each([
      { through: "kill", end: kill },
      { through: "a stopped worker", end: stopWorker },
    ])("has its group ended through $through", ({ end }) =>
      Effect.gen(function* () {
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
