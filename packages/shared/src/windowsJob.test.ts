// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise native Windows handles and inherited descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
import { prepareWindowsJobHost, windowsJobName } from "./windowsJob.ts";

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

describe.runIf(isWindowsHost)("a Windows job", () => {
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
        assert.match(yield* line(), /^S \d+ \d+$/);
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
          yield* invoke(["stop", name]);
        }
        yield* member.ended;
        yield* Effect.promise(() => exit);
        assert.equal(Number(yield* invoke(["count", name])), 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("preserves binary streams, extra descriptors, arguments, environment and exit code", () =>
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
        const child = NodeChildProcess.spawn(
          host,
          ["run", name, "", process.execPath, "-e", source, ...args],
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
        if (action === "stop") yield* invoke(["stop", name]);
        else yield* leader.kill();
        yield* member.ended;
        yield* leader.exitCode;
        assert.equal(Number(yield* invoke(["count", name])), 0);
        assert.isTrue(yield* outsider.isRunning);
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
