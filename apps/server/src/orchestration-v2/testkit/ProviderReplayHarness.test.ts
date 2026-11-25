import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { makeReplayServerConfig } from "./ReplayServerConfig.ts";

it.effect.each([
  { outcome: "success", finish: Effect.void },
  { outcome: "failure", finish: Effect.fail("replay failed") },
  { outcome: "interruption", finish: Effect.interrupt },
])("removes the replay fixture after $outcome", ({ outcome, finish }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const testScope = yield* Scope.Scope;
    const fixtureDir = yield* Ref.make<string | undefined>(undefined);

    const replay = yield* Effect.gen(function* () {
      const config = yield* makeReplayServerConfig(`scope-${outcome}`);
      yield* Scope.addFinalizer(
        testScope,
        fs.remove(config.baseDir, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      assert.isTrue(yield* fs.exists(config.stateDir));
      yield* Ref.set(fixtureDir, config.baseDir);
      yield* finish;
    }).pipe(Effect.scoped, Effect.forkScoped);
    const exit = yield* Fiber.await(replay);
    const result = Exit.isSuccess(exit)
      ? "success"
      : Exit.hasInterrupts(exit)
        ? "interruption"
        : "failure";

    const directory = yield* Ref.get(fixtureDir);
    assert.equal(result, outcome);
    assert.isDefined(directory);
    assert.isFalse(yield* fs.exists(directory));
  }).pipe(Effect.provide(NodeServices.layer)),
);
