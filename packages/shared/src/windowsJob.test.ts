// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise native Windows handles and inherited descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeStreamConsumers from "node:stream/consumers";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";
import { isWindowsHost } from "./testing/hostPlatform.ts";
import { processPipe } from "./testing/leftoverChild.ts";
import { windowsJobSpawn } from "./windowsJobNode.ts";
import {
  prepareWindowsJobHost,
  windowsFrameworkCompiler,
  WindowsJobHost,
  windowsJobName,
  windowsJobOf,
} from "./windowsJob.ts";
import { owningWindowsJobs, WINDOWS_JOB_START_TIMEOUT_SECONDS } from "./windowsJobSpawner.ts";
import { stopWindowsProcessTree } from "./windowsProcessTree.ts";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs/promises", { spy: true });

class CacheHeldError extends Schema.TaggedError<CacheHeldError>()("CacheHeldError", {
  code: Schema.Literals(["EPERM", "EBUSY"]),
  message: Schema.String,
}) {}

class WindowsJobTestError extends Schema.TaggedError<WindowsJobTestError>()("WindowsJobTestError", {
  cause: Schema.Defect(),
}) {}

it.each([
  ["EACCES", false, true],
  ["UNKNOWN", true, true],
  [1260, false, true],
  [5, true, true],
  ["ENOENT", true, false],
] as const)(
  "preserves a rejected SDK host spawn: %s, asynchronous %s",
  async (code, asynchronous, policy) => {
    const host = "C:/cache/unsigned-host.exe";
    const original = Object.assign(new Error("operating system rejected spawn"), {
      code,
      errno: -4092,
    });
    const fake = Object.assign(new NodeChildProcess.ChildProcess(), {
      stdio: Array.from({ length: 5 }, () => new NodeStream.PassThrough()),
    });
    using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementationOnce(() => {
      if (!asynchronous) throw original;
      queueMicrotask(() => {
        fake.emit("error", original);
        fake.emit("close", null, null);
      });
      return fake;
    });
    const error = await new Promise<Error & { code?: string | number; path?: string }>(
      (resolve) => {
        try {
          windowsJobSpawn(host)("provider.exe", []).once("error", resolve);
        } catch (cause) {
          resolve(cause as Error);
        }
      },
    );
    for (const stream of fake.stdio) stream?.destroy();
    assert.equal(error.code, code);
    assert.equal(error.path, host);
    assert.include(error.message, host);
    assert.include(error.message, "operating system rejected spawn");
    assert.equal(error.message.includes("AppLocker or WDAC"), policy);
  },
);

it.effect("preserves a rejected standalone host spawn and its system error", () =>
  Effect.gen(function* () {
    const host = "C:/cache/unsigned-host.exe";
    const cause = Object.assign(new Error("spawn access denied"), { code: "EACCES", errno: -4092 });
    const spawner = ChildProcessSpawner.make(() =>
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "spawn",
        cause,
      }),
    );
    const error = yield* owningWindowsJobs(spawner, "win32")
      .spawn(ChildProcess.make("provider.exe"))
      .pipe(
        Effect.provideService(WindowsJobHost, Effect.succeed(host)),
        Effect.scoped,
        Effect.flip,
      );
    assert.equal(error.reason._tag, "PermissionDenied");
    assert.include(error.message, host);
    assert.include(error.message, "AppLocker or WDAC");
    assert.include(error.message, "spawn access denied");
  }),
);

it.effect("stops a job host that never reports its child and fails the launch", () =>
  Effect.gen(function* () {
    const ended = yield* Deferred.make<void>();
    let kills = 0;
    // A host stalled before its start reply: its channel stays open and it never exits by itself.
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.as(Deferred.await(ended), ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.map(Deferred.isDone(ended), (done) => !done),
          kill: () =>
            Effect.sync(() => {
              kills++;
              Deferred.doneUnsafe(ended, Effect.void);
            }),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    const launch = yield* owningWindowsJobs(spawner, "win32")
      .spawn(ChildProcess.make("provider.exe"))
      .pipe(
        Effect.provideService(WindowsJobHost, Effect.succeed("C:/cache/job-host.exe")),
        Effect.scoped,
        Effect.flip,
        Effect.forkChild,
      );
    yield* TestClock.adjust(`${WINDOWS_JOB_START_TIMEOUT_SECONDS - 1} seconds`);
    assert.equal(kills, 0);
    yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(launch);
    assert.equal(error.reason._tag, "TimedOut");
    assert.include(error.message, "did not start the command within 30 s");
    assert.equal(kills, 1);
  }),
);

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve([code, signal]));
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-job-" });
  const host = yield* prepareWindowsJobHost().pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = windowsJobName(NodeCrypto.randomUUID());
  /** The host's stdout; a host that rejects the operation fails the test with its stderr. */
  const invoke = (args: ReadonlyArray<string>, env?: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(host, args, {
            stdin: "ignore",
            ...(env === undefined ? {} : { env, extendEnv: true }),
          }),
        );
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(code, 0, `host ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
        return stdout;
      }),
    );
  // A count by name alone succeeds only when the job object no longer exists; a live job rejects it.
  const assertJobGone = Effect.fn("WindowsJobTest.assertJobGone")(function* () {
    assert.equal(yield* invoke(["count", name]), "0\r\n");
  });
  return { fs, path, home, host, spawner, name, invoke, assertJobGone };
});

const compileFixture = Effect.fn("WindowsJobTest.compile")(function* (
  home: string,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const file = path.join(home, "Fixture.cs");
  const executable = path.join(home, "Fixture.exe");
  yield* fs.writeFileString(file, source);
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          windowsFrameworkCompiler(env.SystemRoot!),
          ["/nologo", "/target:exe", `/out:${executable}`, file],
          { windowsHide: true },
          (error, stdout, stderr) =>
            error === null ? resolve() : reject(new Error(`${error.message}: ${stdout}${stderr}`)),
        );
      }),
    catch: (cause) => new WindowsJobTestError({ cause }),
  });
  return executable;
});

const nativeSource = Effect.fn("WindowsJobTest.source")(function* () {
  const implementation = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(new URL("./windowsJob.ts", import.meta.url), "utf8"),
    catch: (cause) => new WindowsJobTestError({ cause }),
  });
  const source = /const SOURCE = String.raw`([\s\S]*?)`;/u.exec(implementation)?.[1];
  assert.isDefined(source);
  return source!;
});

describe.runIf(isWindowsHost)("a Windows job", () => {
  it.live("finishes SDK cleanup when the host exits before publishing child identity", () =>
    Effect.gen(function* () {
      const { host, home, path } = yield* fixture;
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => windowsJobSpawn(host)(path.join(home, "missing-command.exe"), [])),
        (handle) =>
          Effect.sync(() => {
            handle.kill();
          }),
      );
      const errors: Error[] = [];
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.on("error", (error) => errors.push(error));
            child.once("close", () => resolve());
          }),
      );
      assert.equal(errors.length, 1);
      assert.isUndefined(windowsJobOf(child)?.child);
      yield* stopWindowsProcessTree({ pid: child.pid!, job: windowsJobOf(child)! });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails a stop when the job stays active beyond its termination budget", () =>
    Effect.gen(function* () {
      const { home, spawner } = yield* fixture;
      const implementation = yield* nativeSource();
      const stop = / static void Stop\(IntPtr job\) \{[\s\S]*?\n \}/.exec(implementation)?.[0];
      assert.isDefined(stop);
      // Compile the actual wait against a stuck kernel response and a clock already at its limit.
      const executable = yield* compileFixture(
        home,
        `using System;
class Stopwatch { public static Stopwatch StartNew() { return new Stopwatch(); } public long ElapsedMilliseconds { get { return 20000; } } }
class Thread { public static void Sleep(int ms) { throw new Exception("Unbounded job wait"); } }
class Fixture {
 static void Limits(IntPtr job, bool closed) {} static bool TerminateJobObject(IntPtr job, uint code) { return true; }
 static void Check(bool value) {} static uint Count(IntPtr job) { return 1; }
 ${stop}
 static int Main() { try { Stop(IntPtr.Zero); return 1; } catch(TimeoutException error) { Console.WriteLine(error.Message); return 0; } }
}`,
      );
      const child = yield* spawner.spawn(ChildProcess.make(executable));
      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.equal(yield* child.exitCode, 0);
      assert.include(output, "still has active processes after 20 seconds");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not stop a replacement job with the same name or a child outside that job", () =>
    Effect.gen(function* () {
      const { host, home, path, fs, name, spawner, invoke } = yield* fixture;
      const originalFile = path.join(home, "original-pid");
      const original = yield* spawner.spawn(
        ChildProcess.make(host, ["run", name, originalFile, process.execPath, "-e", ""]),
      );
      yield* original.exitCode;
      const originalIdentity = (yield* fs.readFileString(originalFile))
        .trim()
        .split(" ")
        .map((value) => value.replace(/^ft:/, ""));
      const member = yield* processPipe;
      const source = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
      const replacementFile = path.join(home, "replacement-pid");
      const replacement = yield* spawner.spawn(
        ChildProcess.make(host, ["run", name, replacementFile, process.execPath, "-e", source]),
      );
      yield* member.started;
      assert.include(yield* invoke(["stop", name, ...originalIdentity]), "not ours");
      assert.isTrue(yield* replacement.isRunning);
      const outsiderPid = String(process.pid);
      const outsiderCreated = (yield* invoke(["identity", outsiderPid])).trim();
      assert.equal(Number(yield* invoke(["count", name, outsiderPid, outsiderCreated])), 0);
      assert.include(yield* invoke(["stop", name, outsiderPid, outsiderCreated]), "not ours");
      assert.isTrue(yield* replacement.isRunning);
      const [pid, created] = (yield* fs.readFileString(replacementFile))
        .trim()
        .split(" ")
        .map((value) => value.replace(/^ft:/, ""));
      assert.include(
        yield* invoke([
          "stop",
          name,
          pid!,
          String(BigInt(created!) + (BigInt(created!) % 10_000n === 9_999n ? -1n : 1n)),
        ]),
        "not ours",
      );
      assert.isTrue(yield* replacement.isRunning);
      yield* invoke(["stop", name, pid!, created!]);
      yield* member.ended;
      yield* replacement.exitCode;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("tells whether a live process's command line names a text", () =>
    Effect.gen(function* () {
      const { spawner, invoke } = yield* fixture;
      const member = yield* processPipe;
      const marker = `t3-marker-${NodeCrypto.randomUUID()}`;
      const source = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
      yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", source, marker]));
      const pid = String(yield* member.started);
      const created = (yield* invoke(["identity", pid])).trim();
      assert.equal((yield* invoke(["identity", pid, marker])).trim(), `${created} named`);
      assert.equal(
        (yield* invoke(["identity", pid, `${marker}-elsewhere`])).trim(),
        `${created} other`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("preserves every FILETIME tick when identifying a process", () =>
    Effect.gen(function* () {
      const { home, spawner, invoke } = yield* fixture;
      const query = yield* compileFixture(
        home,
        `using System;
using System.Runtime.InteropServices;
class Fixture {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long made,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
 static void Main(string[] args) {
  var process=OpenProcess(0x1000,false,int.Parse(args[0]));
  try {
   long made,exited,kernel,user;
   if(!GetProcessTimes(process,out made,out exited,out kernel,out user)) throw new System.ComponentModel.Win32Exception();
   Console.WriteLine(made);
  } finally { CloseHandle(process); }
 }
}`,
      );
      const expected = (yield* spawner.string(
        ChildProcess.make(query, [String(process.pid)]),
      )).trim();
      assert.equal((yield* invoke(["identity", String(process.pid)])).trim(), expected);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["owned", "owned-raw", "run", "run-raw", "git-path"] as const)(
    "releases stdout before a child exits or receives stdin EOF, %s",
    (mode) =>
      Effect.gen(function* () {
        const { host, home, path, fs, name } = yield* fixture;
        const executable = yield* compileFixture(
          home,
          `using System;
using System.Runtime.InteropServices;
class Fixture {
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first,IntPtr second);
 [DllImport("kernel32.dll")] static extern uint PssCaptureSnapshot(IntPtr process,uint flags,uint context,out IntPtr snapshot);
 [DllImport("kernel32.dll")] static extern uint PssFreeSnapshot(IntPtr process,IntPtr snapshot);
 [DllImport("kernel32.dll")] static extern uint PssWalkMarkerCreate(IntPtr allocator,out IntPtr marker);
 [DllImport("kernel32.dll")] static extern uint PssWalkMarkerFree(IntPtr marker);
 [DllImport("kernel32.dll")] static extern uint PssWalkSnapshot(IntPtr snapshot,int kind,IntPtr marker,IntPtr buffer,uint size);
 static void Check(uint result) { if(result!=0) throw new System.ComponentModel.Win32Exception((int)result); }
 static void Main() {
  uint entrySize=IntPtr.Size==8 ? 136u : 104u;
  IntPtr snapshot,marker,entry=Marshal.AllocHGlobal((int)entrySize),output=GetStdHandle(-11);
  var handles=new System.Collections.Generic.List<IntPtr>();
  Check(PssCaptureSnapshot(new IntPtr(-1),4,0,out snapshot));
  Check(PssWalkMarkerCreate(IntPtr.Zero,out marker));
  for(;;) {
   uint status=PssWalkSnapshot(snapshot,2,marker,entry,entrySize);
   if(status==259)break;
   Check(status);
   IntPtr handle=Marshal.ReadIntPtr(entry);
   if(CompareObjectHandles(handle,output)) handles.Add(handle);
  }
  PssWalkMarkerFree(marker); PssFreeSnapshot(new IntPtr(-1),snapshot); Marshal.FreeHGlobal(entry);
  foreach(var handle in handles) CloseHandle(handle);
  Console.OpenStandardInput().ReadByte();
 }
}`,
        );
        let mergedHost = host;
        const owned = mode === "owned" || mode === "owned-raw";
        if (!owned) {
          const mergeHome = path.join(home, "merged-host");
          yield* fs.makeDirectory(mergeHome);
          // Set the actual inherited standard handles to the same pipe before entering the host.
          mergedHost = yield* compileFixture(
            mergeHome,
            (yield* nativeSource()).replace("public static int Main(", "public static int Run(") +
              `
class TestEntry {
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetStdHandle(int number,IntPtr handle);
 static int Main(string[] args) {
  if(!SetStdHandle(-12,GetStdHandle(-11))) throw new Win32Exception();
  return CodeShipJobHost.Run(args);
 }
}`,
          );
        }
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned
              ? windowsJobSpawn(host)(executable, [], {
                  windowsVerbatimArguments: mode === "owned-raw",
                })
              : NodeChildProcess.spawn(
                  mergedHost,
                  mode === "git-path" ? [mode, name, executable] : [mode, name, "", executable],
                  {
                    windowsHide: true,
                    env: {
                      ...process.env,
                      T3CODE_WINDOWS_JOB_DIAGNOSTIC: path.join(home, "host-error.log"),
                    },
                  },
                ),
          ),
          (child) =>
            Effect.sync(() => {
              child.kill();
            }),
        );
        const exit = exited(child);
        yield* Effect.tryPromise({
          try: () => NodeStreamConsumers.buffer(child.stdout!),
          catch: (cause) => new WindowsJobTestError({ cause }),
        });
        assert.isNull(child.exitCode, "stdout EOF must precede the child's exit");
        child.stdin!.end();
        assert.equal((yield* Effect.promise(() => exit))[0], 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a post-start job stop failure out of launch status", () =>
    Effect.gen(function* () {
      const { home, path, fs, name, spawner } = yield* fixture;
      const source = yield* nativeSource();
      const stopping = "   Stop(job);\n   return unchecked((int)code);";
      assert.include(source, stopping);
      const host = yield* compileFixture(
        home,
        source.replace(
          stopping,
          '   throw new TimeoutException("injected job termination timeout");',
        ),
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(host, ["run", name, path.join(home, "pid"), process.execPath, "-e", ""]),
      );
      assert.equal(yield* child.exitCode, 125);
      assert.isTrue(yield* fs.exists(path.join(home, "pid")));
      assert.isFalse(yield* fs.exists(path.join(home, "exit-status")));
      const output = yield* fs.readFileString(path.join(home, "output.log"));
      assert.include(output, "Could not end the command's job: injected job termination timeout");
      assert.notInclude(output, "Could not start the command");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rebuilds a truncated cached host before executing it", () =>
    Effect.gen(function* () {
      const { host, home, path, fs } = yield* fixture;
      const anotherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-job-corrupt-" });
      yield* fs.copy(path.join(home, ".cache"), path.join(anotherHome, ".cache"));
      const cached = path.join(anotherHome, ".cache", "t3", "windows-job", path.basename(host));
      yield* fs.writeFileString(cached, "truncated");
      const rebuilt = yield* prepareWindowsJobHost().pipe(
        Effect.provideService(HostProcess.HomeDirectory, anotherHome),
      );
      assert.isAbove(Number((yield* fs.stat(rebuilt)).size), 9);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["manifest", "executable"] as const)(
    "rebuilds an unreadable cached host entry: %s",
    (entry) =>
      Effect.gen(function* () {
        const { host, home, path, fs, spawner } = yield* fixture;
        const anotherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-job-unreadable-" });
        yield* fs.copy(path.join(home, ".cache"), path.join(anotherHome, ".cache"));
        const cache = path.join(anotherHome, ".cache", "t3", "windows-job");
        const manifest = (yield* fs.readDirectory(cache)).find((name) => name.endsWith(".sha256"))!;
        const blocked = path.join(cache, entry === "manifest" ? manifest : path.basename(host));
        const { readFile, rename } = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        using _read = vi.spyOn(NodeFSP, "readFile").mockImplementation((file, options) => {
          if (String(file) === blocked)
            return Promise.reject(
              new CacheHeldError({
                message: "cache entry is held by another process",
                code: entry === "manifest" ? "EPERM" : "EBUSY",
              }),
            );
          return readFile(file, options);
        });
        using _rename = vi.spyOn(NodeFSP, "rename").mockImplementation((from, to) => {
          if (entry === "manifest" && String(to) === blocked)
            return Promise.reject(
              new CacheHeldError({ message: "cache index is locked", code: "EBUSY" }),
            );
          return rename(from, to);
        });
        const rebuilt = yield* prepareWindowsJobHost().pipe(
          Effect.provideService(HostProcess.HomeDirectory, anotherHome),
        );
        assert.notEqual(rebuilt, blocked);
        const identity = yield* spawner.string(
          ChildProcess.make(rebuilt, ["identity", String(process.pid)]),
        );
        assert.match(identity.trim(), /^\d+$/);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("shares concurrent cache repair and retains the executable another server may use", () =>
    Effect.gen(function* () {
      const { host, home, path, fs } = yield* fixture;
      const anotherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-job-concurrent-" });
      yield* fs.copy(path.join(home, ".cache"), path.join(anotherHome, ".cache"));
      const cached = path.join(anotherHome, ".cache", "t3", "windows-job", path.basename(host));
      yield* fs.writeFileString(cached, "truncated");
      using compile = vi.spyOn(NodeChildProcess, "execFile");
      compile.mockClear();
      const repaired = yield* Effect.all([prepareWindowsJobHost(), prepareWindowsJobHost()], {
        concurrency: 2,
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, anotherHome));
      assert.equal(compile.mock.calls.length, 1);
      assert.equal(repaired[0], repaired[1]);
      assert.equal(yield* fs.readFileString(cached), "truncated");
      assert.isAbove(Number((yield* fs.stat(repaired[0]!)).size), 9);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["before start", "referenced", "unreferenced", "referenced again"] as const)(
    "owns the command when the worker control pipe closes, %s",
    (state) =>
      Effect.gen(function* () {
        const { host, name, invoke, assertJobGone } = yield* fixture;
        const member = yield* processPipe;
        const source = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(host, ["owned", name, "3", process.execPath, "-e", source], {
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
            }),
          ),
          (child) =>
            Effect.sync(() => {
              child.kill();
            }),
        );
        const control = child.stdio[3] as import("node:stream").Duplex;
        const replies = child.stdio[4] as import("node:stream").Readable;
        const lines = NodeReadline.createInterface({ input: replies });
        const messages = lines[Symbol.asyncIterator]();
        yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()));
        const line = () =>
          Effect.tryPromise({
            try: async () => {
              const result = await messages.next();
              assert.isFalse(result.done, "the native host publishes its ownership handshake");
              return result.value;
            },
            catch: (cause) => new WindowsJobTestError({ cause }),
          });
        const exit = exited(child);
        assert.equal(yield* line(), "W");
        if (state === "before start") {
          control.end();
          assert.equal((yield* Effect.promise(() => exit))[0], 125);
          yield* assertJobGone();
          return;
        }
        control.write("R");
        const started = yield* line();
        assert.match(started, /^S \d+ \d+$/);
        yield* member.started;
        if (state !== "referenced") {
          control.write("U");
          assert.equal(yield* line(), "U");
        }
        if (state === "referenced again") {
          control.write("R");
          assert.equal(yield* line(), "R");
        }
        control.end();
        if (state === "unreferenced") {
          // The acknowledged unref outlives its worker; an independent controller still owns the job.
          assert.isAtLeast(
            Number(yield* invoke(["count", name, ...started.split(" ").slice(1)])),
            1,
          );
          yield* invoke(["stop", name, ...started.split(" ").slice(1)]);
        }
        yield* member.ended;
        yield* Effect.promise(() => exit);
        yield* assertJobGone();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["native", "SDK"] as const)(
    "preserves binary streams, extra descriptors, arguments, environment and exit code through %s",
    (mode) =>
      Effect.gen(function* () {
        const { host, home, name, path } = yield* fixture;
        const args = ["space here", 'a"quote', "trailing\\", "", "日本語"];
        const source = [
          "process.stdin.pipe(process.stdout);",
          "process.stdin.on('end', () => {",
          " require('node:fs').writeSync(3, Buffer.from([9,0,255]));",
          " process.stderr.write(JSON.stringify({args:process.argv.slice(1),env:process.env.T3_JOB_TEST,cwd:process.cwd()}));",
          " process.exitCode=23;",
          "});",
        ].join("\n");
        const result = yield* Effect.tryPromise({
          try: async () => {
            const child = (mode === "SDK" ? windowsJobSpawn(host) : NodeChildProcess.spawn)(
              mode === "SDK" ? process.execPath : host,
              [
                ...(mode === "SDK" ? [] : ["run", name, "", process.execPath]),
                "-e",
                source,
                ...args,
              ],
              {
                cwd: home,
                env: {
                  ...process.env,
                  T3_JOB_TEST: "inherited",
                  T3CODE_WINDOWS_JOB_DIAGNOSTIC: path.join(home, "host-error.log"),
                },
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe", "pipe"],
              },
            );
            try {
              const pending = Promise.all([
                exited(child),
                NodeStreamConsumers.buffer(child.stdout!),
                NodeStreamConsumers.buffer(child.stderr!),
                NodeStreamConsumers.buffer(child.stdio[3] as import("node:stream").Readable),
              ]);
              child.stdin!.end(Buffer.from([0, 1, 2, 255, 10]));
              return await pending;
            } finally {
              child.kill();
            }
          },
          catch: (cause) => new WindowsJobTestError({ cause }),
        });
        assert.equal(result[0][0], 23);
        assert.deepEqual([...result[1]], [0, 1, 2, 255, 10]);
        assert.deepEqual([...result[3]], [9, 0, 255]);
        assert.deepEqual(JSON.parse(result[2].toString()), { args, env: "inherited", cwd: home });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("owns an orphaned grandchild through the SDK spawn callback", () =>
    Effect.gen(function* () {
      const { host, invoke } = yield* fixture;
      const member = yield* processPipe;
      const source = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
      const intermediate = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(source)}],{stdio:'ignore',detached:true,windowsHide:true}).unref();`;
      const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore',windowsHide:true}); c.on('exit',()=>process.stdout.write('ready')); process.stdin.resume();`;
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => windowsJobSpawn(host)(process.execPath, ["-e", root])),
        (child) =>
          Effect.sync(() => {
            child.kill();
          }),
      );
      const exit = exited(child);
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      yield* member.started;
      yield* Effect.promise(() => ready);
      const identity = windowsJobOf(child)?.child;
      assert.isDefined(identity);
      assert.equal(identity!.created, (yield* invoke(["identity", String(identity!.pid)])).trim());
      child.kill();
      yield* Effect.promise(() => exit);
      yield* member.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["stop", "host crash"] as const)(
    "retains an orphaned grandchild's membership across %s without selecting an unrelated process",
    (action) =>
      Effect.gen(function* () {
        const { host, home, path, fs, name, spawner, invoke, assertJobGone } = yield* fixture;
        const member = yield* processPipe;
        const unrelated = yield* processPipe;
        const connected = (pipe: string) =>
          `const s=require('node:net').connect(${JSON.stringify(pipe)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
        const outsider = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", connected(unrelated.path)]),
        );
        yield* unrelated.started;
        const intermediate = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(connected(member.path))}],{stdio:'ignore',detached:true,windowsHide:true}).unref();`;
        const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore',windowsHide:true}); c.on('exit',()=>process.stdout.write('ready')); process.stdin.resume();`;
        const pidFile = path.join(home, "pid");
        const leader = yield* spawner.spawn(
          ChildProcess.make(host, ["run", name, pidFile, process.execPath, "-e", root]),
        );
        yield* member.started;
        // The intermediate has exited before the controller observes membership or stops the job.
        yield* leader.stdout.pipe(Stream.take(1), Stream.runDrain);
        const [pid, created] = (yield* fs.readFileString(pidFile))
          .trim()
          .split(" ")
          .map((value) => value.replace(/^ft:/, ""));
        assert.equal((yield* invoke(["identity", String(pid)])).trim(), created);
        assert.isAtLeast(Number(yield* invoke(["count", name, pid!, created!])), 2);
        if (action === "stop") yield* invoke(["stop", name, String(pid), String(created)]);
        else yield* leader.kill();
        yield* member.ended;
        if (action === "stop") {
          yield* leader.exitCode;
        } else {
          const interrupted = yield* Effect.flip(leader.exitCode);
          assert.equal(interrupted.reason.method, "exitCode");
          assert.include(String(interrupted.cause), "receipt of signal: 'SIGTERM'");
        }
        yield* assertJobGone();
        assert.isTrue(yield* outsider.isRunning);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "stops a legacy root with the processes it started, only at its exact creation time",
    () =>
      Effect.gen(function* () {
        const { spawner, invoke } = yield* fixture;
        const leaf = yield* processPipe;
        const middle = yield* processPipe;
        const unrelated = yield* processPipe;
        const connected = (pipe: string) =>
          `const s=require('node:net').connect(${JSON.stringify(pipe)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
        const outsider = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", connected(unrelated.path)]),
        );
        yield* unrelated.started;
        // Node ends a child it did not detach with its parent, which a command's wrapper never
        // does, so each child detaches. The middle one starts the leaf: the stop crosses two generations.
        const spawned = (script: string) =>
          `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(script)}],{detached:true,stdio:'ignore',windowsHide:true}).unref();`;
        const intermediate = `${connected(middle.path)} ${spawned(connected(leaf.path))}`;
        const source = `${spawned(intermediate)} process.stdin.resume();`;
        const legacy = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", source]));
        yield* middle.started;
        yield* leaf.started;
        const made = BigInt((yield* invoke(["identity", String(legacy.pid)])).trim());
        const sameMillisecond = made + (made % 10_000n === 9_999n ? -1n : 1n);
        assert.equal(
          (yield* invoke(["stop-tree", String(legacy.pid), String(sameMillisecond)])).trim(),
          "",
        );
        assert.isTrue(yield* legacy.isRunning);
        assert.equal((yield* invoke(["stop-tree", String(legacy.pid), String(made)])).trim(), "");
        yield* leaf.ended;
        yield* middle.ended;
        yield* legacy.exitCode;
        assert.isTrue(yield* outsider.isRunning);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs a git shim whose path names a cmd variable at that path as written", () =>
    Effect.gen(function* () {
      const { fs, path, home, name, invoke } = yield* fixture;
      // cmd would read %USERNAME% in its command text as the user's name.
      const folder = path.join(home, "%USERNAME%");
      yield* fs.makeDirectory(folder);
      const shim = path.join(folder, "git.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\necho shim %1 [%T3CODE_GIT_SHIM%]\r\n");
      const output = yield* invoke(["git-path", name, shim], {
        T3CODE_WINDOWS_JOB_DIAGNOSTIC: path.join(home, "host-error.log"),
      });
      // A batch file reads an unset variable as nothing: the shim does not inherit its path.
      assert.equal(output.trim(), "shim --exec-path []");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("publishes an early start failure without waiting for a pid", () =>
    Effect.gen(function* () {
      const { host, home, path, fs, name, spawner } = yield* fixture;
      const child = yield* spawner.spawn(
        ChildProcess.make(host, [
          "run",
          name,
          path.join(home, "pid"),
          path.join(home, "missing.exe"),
        ]),
      );
      assert.equal(yield* child.exitCode, 125);
      assert.equal((yield* fs.readFileString(path.join(home, "exit-status"))).trim(), "125");
      assert.include(
        yield* fs.readFileString(path.join(home, "output.log")),
        "Could not start the command:",
      );
      assert.isFalse(yield* fs.exists(path.join(home, "pid")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
