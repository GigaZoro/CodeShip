// @effect-diagnostics nodeBuiltinImport:off -- the leftover child and its FIFO are real processes and files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { timeoutProcessOption } from "./processDeadline.ts";
import * as WorkerProcessSpawner from "./WorkerProcessSpawner.ts";

const layer = WorkerProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer));

const node = (script: string, options?: ChildProcess.CommandOptions) =>
  ChildProcess.make(process.execPath, ["-e", script], options);

const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;

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

  // The leftover child holds a FIFO open; its death produces EOF without polling.
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a stopped worker kills what a child left running after it exited",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-orphan-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const fifo = NodePath.join(dir, "alive");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        const alive = NodeFS.createReadStream(fifo);
        yield* Effect.addFinalizer(() => Effect.sync(() => alive.destroy()));
        const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
        const leftoverStopped = new Promise<void>((resolve) =>
          alive.once("close", () => resolve()),
        );
        alive.resume();
        const leftover =
          "require('node:fs').openSync(process.argv[1], 'w'); setTimeout(() => {}, 60_000);";
        const leader = yield* node(
          `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leftover)}, ${JSON.stringify(fifo)}], { stdio: "ignore" }).unref();`,
          quiet,
        );
        yield* Effect.promise(() => leftoverStarted);
        assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));

        yield* WorkerProcessSpawner.__testing.stopWorker;

        yield* Effect.promise(() => leftoverStopped);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
