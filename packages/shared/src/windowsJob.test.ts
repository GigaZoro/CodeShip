// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise native Windows handles and inherited descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";
import * as NodeStreamConsumers from "node:stream/consumers";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";
import { isWindowsHost } from "./testing/hostPlatform.ts";
import { processPipe } from "./testing/leftoverChild.ts";
import { windowsJobSpawn } from "./windowsJobNode.ts";
import { prepareWindowsJobHost, windowsJobName, windowsJobOf } from "./windowsJob.ts";
import { stopWindowsProcessTree } from "./windowsProcessTree.ts";

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
  const invoke = (args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(host, args, { stdin: "ignore" }));
  return { fs, path, home, host, spawner, name, invoke };
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
  yield* Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          path.join(env.SystemRoot!, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
          ["/nologo", "/target:exe", `/out:${executable}`, file],
          { windowsHide: true },
          (error, stdout, stderr) =>
            error === null ? resolve() : reject(new Error(`${error.message}: ${stdout}${stderr}`)),
        );
      }),
  );
  return executable;
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
      const implementation = yield* Effect.tryPromise(() =>
        NodeFSP.readFile(new URL("./windowsJob.ts", import.meta.url), "utf8"),
      );
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
      const originalIdentity = (yield* fs.readFileString(originalFile)).trim().split(" ");
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
      assert.include(yield* invoke(["stop", name, outsiderPid, outsiderCreated]), "not ours");
      assert.isTrue(yield* replacement.isRunning);
      const [pid, created] = (yield* fs.readFileString(replacementFile)).trim().split(" ");
      assert.include(
        yield* invoke(["stop", name, pid!, String(Number(created) + 500)]),
        "not ours",
      );
      assert.isTrue(yield* replacement.isRunning);
      yield* invoke(["stop", name, pid!, created!]);
      yield* member.ended;
      yield* replacement.exitCode;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([false, true])(
    "releases stdout before an owned child exits or receives stdin EOF, raw %s",
    (raw) =>
      Effect.gen(function* () {
        const { host, home } = yield* fixture;
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
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            windowsJobSpawn(host)(executable, [], { windowsVerbatimArguments: raw }),
          ),
          (child) =>
            Effect.sync(() => {
              child.kill();
            }),
        );
        const exit = exited(child);
        yield* Effect.tryPromise(() => NodeStreamConsumers.buffer(child.stdout));
        assert.isNull(child.exitCode, "stdout EOF must precede the child's exit");
        child.stdin.end();
        assert.equal((yield* Effect.promise(() => exit))[0], 0);
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

  it.live.each(["before start", "referenced", "unreferenced", "referenced again"] as const)(
    "owns the command when the worker control pipe closes, %s",
    (state) =>
      Effect.gen(function* () {
        const { host, name, invoke } = yield* fixture;
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
          Effect.tryPromise(async () => {
            const result = await messages.next();
            assert.isFalse(result.done, "the native host publishes its ownership handshake");
            return result.value;
          });
        const exit = exited(child);
        assert.equal(yield* line(), "W");
        if (state === "before start") {
          control.end();
          assert.equal((yield* Effect.promise(() => exit))[0], 125);
          assert.equal(Number(yield* invoke(["count", name])), 0);
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
          assert.isAtLeast(Number(yield* invoke(["count", name])), 1);
          yield* invoke(["stop", name, ...started.split(" ").slice(1)]);
        }
        yield* member.ended;
        yield* Effect.promise(() => exit);
        assert.equal(Number(yield* invoke(["count", name])), 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["native", "SDK"] as const)(
    "preserves binary streams, extra descriptors, arguments, environment and exit code through %s",
    (mode) =>
      Effect.gen(function* () {
        const { host, home, name } = yield* fixture;
        const args = ["space here", 'a"quote', "trailing\\", "", "日本語"];
        const source = [
          "process.stdin.pipe(process.stdout);",
          "process.stdin.on('end', () => {",
          " require('node:fs').writeSync(3, Buffer.from([9,0,255]));",
          " process.stderr.write(JSON.stringify({args:process.argv.slice(1),env:process.env.T3_JOB_TEST,cwd:process.cwd()}));",
          " process.exitCode=23;",
          "});",
        ].join("\n");
        const result = yield* Effect.tryPromise(async () => {
          const child = (mode === "SDK" ? windowsJobSpawn(host) : NodeChildProcess.spawn)(
            mode === "SDK" ? process.execPath : host,
            [...(mode === "SDK" ? [] : ["run", name, "", process.execPath]), "-e", source, ...args],
            {
              cwd: home,
              env: { ...process.env, T3_JOB_TEST: "inherited" },
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
        });
        assert.equal(result[0][0], 23);
        assert.deepEqual([...result[1]], [0, 1, 2, 255, 10]);
        assert.deepEqual([...result[3]], [9, 0, 255]);
        assert.deepEqual(JSON.parse(result[2].toString()), { args, env: "inherited", cwd: home });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("owns an orphaned grandchild through the SDK spawn callback", () =>
    Effect.gen(function* () {
      const { host } = yield* fixture;
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
      child.kill();
      yield* Effect.promise(() => exit);
      yield* member.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["stop", "host crash"] as const)(
    "retains an orphaned grandchild's membership across %s without selecting an unrelated process",
    (action) =>
      Effect.gen(function* () {
        const { host, home, path, fs, name, spawner, invoke } = yield* fixture;
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
        const [pid, created] = (yield* fs.readFileString(pidFile)).split(" ").map(Number);
        assert.equal(Number(yield* invoke(["identity", String(pid)])), created);
        assert.isAtLeast(Number(yield* invoke(["count", name])), 2);
        if (action === "stop") yield* invoke(["stop", name, String(pid), String(created)]);
        else yield* leader.kill();
        yield* member.ended;
        yield* leader.exitCode;
        assert.equal(Number(yield* invoke(["count", name])), 0);
        assert.isTrue(yield* outsider.isRunning);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a legacy root through its pinned handle only at the exact creation time", () =>
    Effect.gen(function* () {
      const { spawner, invoke } = yield* fixture;
      const member = yield* processPipe;
      const source = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
      const child = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", source]));
      yield* member.started;
      const made = Number(yield* invoke(["identity", String(child.pid)]));
      yield* invoke(["stop-process", String(child.pid), String(made - 500)]);
      assert.isTrue(yield* child.isRunning);
      yield* invoke(["stop-process", String(child.pid), String(made)]);
      yield* member.ended;
      yield* child.exitCode;
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
