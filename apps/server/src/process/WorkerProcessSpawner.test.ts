// @effect-diagnostics nodeBuiltinImport:off -- compiles a test native host on Windows.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  AWAIT_HOLDER_PYTHON,
  hostHoldsProcessGroups,
  watchFreedGroupSignals,
} from "@t3tools/shared/testing/freedProcessGroups";
import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { leaderLeavingChild, processPipe } from "@t3tools/shared/testing/leftoverChild";
import { windowsFrameworkCompiler, WindowsJobHost } from "@t3tools/shared/windowsJob";
import { WINDOWS_JOB_START_TIMEOUT_SECONDS } from "@t3tools/shared/windowsJobSpawner";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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

// Where a POSIX host holds no group, nothing may signal one once its leader exited.
const unheldPosix = !isWindowsHost && !hostHoldsProcessGroups(process.env);

describe("WorkerProcessSpawner", () => {
  it.live.runIf(isWindowsHost)(
    "preserves the rejected native host path in worker spawn errors",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* fs.makeTempDirectoryScoped({ prefix: "t3-blocked-host-" });
        const error = yield* node("", quiet).pipe(
          Effect.provideService(WindowsJobHost, Effect.succeed(host)),
          Effect.flip,
        );
        assert.include(error.message, host);
        assert.notInclude(error.message, "AppLocker or WDAC");
        assert.equal(error.reason._tag, "NotFound");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, layer))),
  );

  it.effect.runIf(isWindowsHost)(
    "stops a job host that never reports its child and fails the launch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stalled-host-" });
        const host = yield* processPipe;
        // Node runs this for the host's "owned" mode: it keeps its ownership channel open and never
        // reports the suspended child, as a host stalled before its start reply would.
        yield* fs.writeFileString(
          path.join(directory, "owned.js"),
          `const s=require('node:net').connect(${JSON.stringify(host.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit()); setInterval(()=>{},1e9);`,
        );
        const launch = yield* ChildProcess.make("provider.exe", [], {
          ...quiet,
          cwd: directory,
        }).pipe(
          Effect.provideService(WindowsJobHost, Effect.succeed(process.execPath)),
          Effect.scoped,
          Effect.flip,
          Effect.forkChild,
        );
        yield* host.started;
        // The worker reported the host's start before this sync's reply, so its deadline runs.
        yield* WorkerProcessSpawner.settle;
        yield* TestClock.adjust(`${WINDOWS_JOB_START_TIMEOUT_SECONDS - 1} seconds`);
        assert.isUndefined(launch.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const error = yield* Fiber.join(launch);
        assert.equal(error.reason._tag, "TimedOut");
        assert.include(error.message, "did not start the command within 30 s");
        yield* host.ended;
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, layer))),
  );

  it.live.runIf(isWindowsHost)("stops the Windows job before ending its host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-job-stop-order-" });
      const sourcePath = path.join(directory, "Host.cs");
      const exePath = path.join(directory, "Host.exe");
      const stopSawPath = path.join(directory, "stop-saw.txt");
      // Mock native host: records its PID, announces a started child on the replies fd, and
      // stays alive until "stop" runs. If signalGroup kills the host before spawning "stop",
      // "stop" observes the host already dead and bypasses the Job Object drain barrier.
      yield* fs.writeFileString(
        sourcePath,
        [
          "using System;",
          "using System.Diagnostics;",
          "using System.IO;",
          "using System.Runtime.InteropServices;",
          "using System.Text;",
          "using System.Threading;",
          "class Host {",
          "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
          "  struct Startup { public int cb; public IntPtr r1,d,t; public int x,y,xs,ys,xc,yc,fa,fl; public short sw,r2; public IntPtr rd,i,o,e; }",
          '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern void GetStartupInfo(out Startup s);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] b, int n, out int w, IntPtr ov);',
          "  static int Main(string[] args) {",
          "    string dir = Path.GetDirectoryName(typeof(Host).Assembly.Location);",
          '    string pidFile = Path.Combine(dir, "host.pid");',
          '    string sawFile = Path.Combine(dir, "stop-saw.txt");',
          '    if (args[0] == "stop") {',
          "      int pid = int.Parse(File.ReadAllText(pidFile).Trim());",
          "      bool alive = false;",
          "      try { using (var p = Process.GetProcessById(pid)) { alive = !p.HasExited; } } catch {}",
          '      File.WriteAllText(sawFile, alive ? "host-alive" : "host-dead");',
          "      if (alive) { try { using (var p = Process.GetProcessById(pid)) { p.Kill(); p.WaitForExit(5000); } } catch {} }",
          "      return 0;",
          "    }",
          "    File.WriteAllText(pidFile, Process.GetCurrentProcess().Id.ToString());",
          "    Startup st; GetStartupInfo(out st);",
          "    int fd = int.Parse(args[2]);",
          "    int count = Marshal.ReadInt32(st.rd);",
          "    IntPtr reply = Marshal.ReadIntPtr(st.rd, 4 + count + (fd + 1) * IntPtr.Size);",
          '    byte[] msg = Encoding.UTF8.GetBytes("S 4242 12345\\n");',
          "    int w; WriteFile(reply, msg, msg.Length, out w, IntPtr.Zero);",
          "    Thread.Sleep(Timeout.Infinite);",
          "    return 0;",
          "  }",
          "}",
        ].join("\n"),
      );
      const compiled = NodeChildProcess.spawnSync(
        windowsFrameworkCompiler(process.env.SystemRoot ?? "C:\\Windows"),
        ["/nologo", "/optimize+", "/platform:x64", `/out:${exePath}`, sourcePath],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
      const handle = yield* ChildProcess.make("provider.exe", [], {
        ...quiet,
        cwd: directory,
      }).pipe(Effect.provideService(WindowsJobHost, Effect.succeed(exePath)));
      yield* handle.kill();
      const saw = yield* fs.readFileString(stopSawPath);
      assert.equal(saw, "host-alive");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, layer))),
  );

  it.live.runIf(isWindowsHost)(
    "ends an orphaned grandchild when its worker stops after the intermediate exited",
    () =>
      Effect.gen(function* () {
        const member = yield* processPipe;
        const grandchild = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
        const intermediate = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true,windowsHide:true}).unref();`;
        const root = yield* node(
          `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore',windowsHide:true}); c.on('exit',()=>process.stdout.write('ready')); process.stdin.resume();`,
        );
        yield* member.started;
        yield* root.stdout.pipe(Stream.take(1), Stream.runDrain);
        yield* WorkerProcessSpawner.__testing.stopWorker;
        yield* member.ended;
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("relays stdin, output and the exit code", () =>
    Effect.gen(function* () {
      const handle = yield* node(
        "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { require('node:fs').writeSync(3, Buffer.from([0,255,9])); process.exitCode = 3; });",
        {
          stdin: Stream.encodeText(Stream.make("hello ", "worker")),
          additionalFds: { fd3: { type: "output" } },
        },
      );
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);

      assert.equal(stdout, "hello worker");
      assert.deepEqual(
        (yield* handle.getOutputFd(3).pipe(Stream.runCollect)).flatMap((chunk) => [...chunk]),
        [0, 255, 9],
      );
      assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(3));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.skipIf(isWindowsHost)("runs Git in the directory used to look up its launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const repository = path.join(root, "repo");
      yield* fs.makeDirectory(path.join(repository, "child"), { recursive: true });
      yield* fs.symlink("repo/child", path.join(root, "link"));
      for (const [directory, marker] of [
        [root, "other"],
        [repository, "repository"],
      ] as const) {
        yield* fs.makeDirectory(path.join(directory, "bin"));
        yield* fs.writeFileString(
          path.join(directory, "bin/git"),
          `#!/bin/sh\necho ${marker}\npwd -P\n`,
          {
            mode: 0o700,
          },
        );
      }
      const cwd = path.join(root, "link") + "/..";
      const env = { PATH: "bin" };
      const git = yield* resolveSpawnCommand("git", [], { cwd, env });
      const child = yield* ChildProcess.make(git.command, git.args, { cwd, env });
      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.equal(yield* child.exitCode, ChildProcessSpawner.ExitCode(0));
      assert.equal(output, `repository\n${yield* fs.realPath(repository)}\n`);
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkerProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );

  it.live.runIf(isWindowsHost)("preserves shell parsing inside the owned job", () =>
    Effect.gen(function* () {
      const child = yield* ChildProcess.make('echo "two words" & echo second', [], { shell: true });
      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.include(output, '"two words"');
      assert.include(output, "second");
      assert.equal(yield* child.exitCode, 0);
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
      yield* Stream.run(Stream.empty, leader.stdin);
      assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
      return leader;
    });

  it.live.skipIf(unheldPosix)("kill ends what a child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
      const leader = yield* leaderThatLeftAChild(leftover);

      yield* leader.kill();

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.skipIf(unheldPosix)(
    "an interrupted command ends what its child left running after it exited",
    () =>
      Effect.gen(function* () {
        const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
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

  describe.skipIf(isWindowsHost)("a POSIX group after its leader's exit", () => {
    it.live.each([
      { through: "its release", end: Effect.void },
      { through: "a stopped worker", end: WorkerProcessSpawner.__testing.stopWorker },
    ])("spares a reused group whose leader exited, through $through", ({ end }) =>
      Effect.gen(function* () {
        const freed = yield* watchFreedGroupSignals;

        yield* Effect.scoped(
          Effect.gen(function* () {
            // Bash would change BASHOPTS, so this command starts without a holder.
            const leader = yield* node("", { ...quiet, extendEnv: true, env: { BASHOPTS: "" } });
            yield* leader.exitCode;
            freed.reuseWithoutLeader(leader.pid);
            yield* end;
          }),
        );

        assert.deepEqual(freed.signals(), []);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.live.skipIf(unheldPosix)(
      "still gets the forced kill of a release that SIGTERM ended the leader of",
      () =>
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

    // Its holder reads EOF on the stopped worker's pipes and ends the group while it keeps the
    // number; only it knows when the number stops being ours.
    it.live.skipIf(unheldPosix)(
      "of a referenced child ends through its holder with a stopped worker",
      () =>
        Effect.gen(function* () {
          const pipe = yield* processPipe;
          const reports =
            "const s = require('node:net').connect(process.argv[1], () => s.write(String(process.pid)));" +
            " s.on('error', () => {}); setInterval(() => {}, 1000);";
          yield* ChildProcess.make(process.execPath, ["-e", reports, pipe.path], quiet);
          const pid = yield* pipe.started;
          const kill = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(process, "kill")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );

          yield* WorkerProcessSpawner.__testing.stopWorker;

          yield* pipe.ended;
          assert.notInclude(
            kill.mock.calls.map(([target]) => target),
            -pid,
          );
        }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // The command ends its holder, then reports; nothing else ends it once the worker stopped.
    it.live("of a referenced child whose holder ended gets no signal from a stopped worker", () =>
      Effect.gen(function* () {
        const pipe = yield* processPipe;
        const losesHolder = [
          AWAIT_HOLDER_PYTHON,
          "import signal, socket, time",
          "def end_holder():",
          "    for pid in holders():",
          "        try: os.kill(pid, signal.SIGKILL)",
          "        except ProcessLookupError: pass",
          "s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])",
          "await_holder(end_holder)",
          "s.send(str(os.getpid()).encode()); time.sleep(300)",
        ].join("\n");
        yield* ChildProcess.make("python3", ["-c", losesHolder, pipe.path], quiet);
        const pid = yield* pipe.started;
        yield* WorkerProcessSpawner.settle;
        const kill = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const signal = process.kill.bind(process);
            return vi
              .spyOn(process, "kill")
              .mockImplementation((target, code) => target === -pid || signal(target, code));
          }),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );

        yield* WorkerProcessSpawner.__testing.stopWorker;

        assert.notInclude(
          kill.mock.calls.map(([target]) => target),
          -pid,
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });

  // Linux hands a ptrace stop to the tracer's waitpid, and Node reports it as an exit of the leader,
  // which still holds its pid. It runs on once a stopped worker's thread, its tracer, has ended.
  // libuv stops waiting for it at that stop, so once ended it stays a zombie until this process exits.
  describe.runIf(isLinuxHost && !unheldPosix)(
    "a leader Node reported as exited at a ptrace stop",
    () => {
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
    },
  );

  describe.skipIf(unheldPosix)("past its leader's exit", () => {
    it.live.each([
      { through: "a new worker", replacement: Effect.void },
      { through: "no worker", replacement: WorkerProcessSpawner.__testing.failWorkerStarts },
    ])(
      "a stopped worker kills what a child left running after it exited, through $through",
      ({ replacement }) =>
        Effect.gen(function* () {
          const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
          yield* leaderThatLeftAChild(leftover);
          yield* replacement;

          yield* WorkerProcessSpawner.__testing.stopWorker;

          yield* leftover.ended;
        }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});
