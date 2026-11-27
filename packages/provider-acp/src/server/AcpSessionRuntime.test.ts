import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe("AcpSessionRuntime teardown", () => {
  it.live("waits for the agent's teardown that the protocol's end already started", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const stopping = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // An agent whose output is already over: the protocol ends as soon as the client reads it.
      const child = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(exited),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(137)).pipe(Effect.asVoid),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
      // Models a process stop that takes a while, like a Windows job host ending its job.
      const spawner = ChildProcessSpawner.make(() =>
        Effect.addFinalizer(() =>
          Deferred.succeed(stopping, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
          ),
        ).pipe(Effect.as(child)),
      );
      const sessionScope = yield* Scope.make();
      yield* AcpSessionRuntime.make({
        spawn: { command: "agent", args: [], shell: false },
        cwd: process.cwd(),
        clientInfo: { name: "test", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(NodeCrypto.layer),
      );
      yield* Deferred.await(stopping);

      const closing = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkChild);
      const closedEarly = yield* Fiber.await(closing).pipe(Effect.timeoutOption("200 millis"));
      expect(Option.isNone(closedEarly)).toBe(true);
      expect(yield* child.isRunning).toBe(true);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      expect(yield* child.isRunning).toBe(false);
    }),
  );
});
