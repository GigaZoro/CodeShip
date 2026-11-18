import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { withGitSpawnBudget } from "./GitSpawnBudget.ts";

const handle = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

const runJob = (spawns: number, budget: number) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(handle)),
      ),
    );
    yield* Effect.forEach(
      Array.from({ length: spawns }),
      () => driver.execute({ operation: "test.spawn", cwd: "/repo", args: ["status"] }),
      { concurrency: 4, discard: true },
    ).pipe(withGitSpawnBudget("test-job", budget), Effect.provide(Logger.layer([logger])));
    return warnings;
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-spawn-budget-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect("a job within its git spawn budget logs nothing", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runJob(5, 5), []);
  }),
);

it.effect("a job past its git spawn budget logs the count once", () =>
  Effect.gen(function* () {
    const warnings = yield* runJob(6, 5);
    assert.strictEqual(warnings.length, 1);
    assert.include(JSON.stringify(warnings[0]), "git spawn budget");
    assert.include(JSON.stringify(warnings[0]), "6");
  }),
);
