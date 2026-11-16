import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { leaderLeavingChild } from "@t3tools/shared/testing/leftoverChild";
import * as Deferred from "effect/Deferred";
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

  // The leader exits at once and leaves a child running, which each way of ending the leader reaches.
  const leaderThatLeftAChild = (leftover: Effect.Success<typeof leaderLeavingChild>) =>
    Effect.gen(function* () {
      const leader = yield* leftover.command;
      yield* leftover.started;
      assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
      return leader;
    });

  it.live("kill ends what a child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild;
      const leader = yield* leaderThatLeftAChild(leftover);

      yield* leader.kill();

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("an interrupted command ends what its child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild;
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

  it.live("a stopped worker kills what a child left running after it exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild;
      yield* leaderThatLeftAChild(leftover);

      yield* WorkerProcessSpawner.__testing.stopWorker;

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
