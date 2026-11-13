import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { publishServer } from "./service.testkit.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

/** `t3 doctor --fix` with an installed service that runs `restart` when it starts again. */
const doctor = (input: {
  readonly baseDir: string;
  readonly dryRun: boolean;
  readonly calls: string[];
  readonly restart: Effect.Effect<unknown>;
}) =>
  runDoctor(
    { baseDir: input.baseDir, dbPath: `${input.baseDir}/userdata/statev2.sqlite` },
    { fix: true, dryRun: input.dryRun, interactive: false },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(BootService.BootService)({
          status: Effect.succeed({
            supported: true,
            installed: true,
            current: true,
            unitPath: "/home/me/.config/systemd/user/t3code.service",
            logPath: "/home/me/.t3/userdata/logs/boot-service.log",
          }),
          withStopped: (operation) =>
            Effect.sync(() => input.calls.push("pause")).pipe(
              Effect.andThen(operation),
              Effect.ensuring(
                Effect.sync(() => input.calls.push("resume")).pipe(Effect.andThen(input.restart)),
              ),
              Effect.map((result) => ({ result, restarted: true })),
            ),
        }),
        Layer.succeed(DatabaseMaintenance, {
          inspect: () =>
            Effect.succeed({
              databaseBytes: 2000,
              reclaimableBytes: 1000,
              incrementalVacuumEnabled: false,
              legacyDatabaseBytes: 4000,
            }),
          compact: () =>
            Effect.sync(() => {
              input.calls.push("compact");
              return {
                beforeBytes: 2000,
                afterBytes: 1000,
                deletedEventCount: 1,
                deletedReceiptCount: 0,
              };
            }),
          removeLegacyDatabase: () => Effect.sync(() => input.calls.push("remove legacy")),
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("t3 doctor", (it) => {
  it.effect(
    "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-test-" });
        const calls: string[] = [];
        const restart = publishServer(fs, baseDir);
        yield* doctor({ baseDir, dryRun: true, calls, restart });
        assert.deepEqual(calls, []);
        yield* doctor({ baseDir, dryRun: false, calls, restart });
        assert.deepEqual(calls, ["pause", "compact", "resume"]);
      }),
  );

  // regression: `t3 doctor --fix` returned before the service it restarted served
  it.effect("--fix says so when the service it restarted never serves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-test-" });
      const restarted = yield* Deferred.make<void>();
      const run = yield* doctor({
        baseDir,
        dryRun: false,
        calls: [],
        restart: Deferred.succeed(restarted, undefined),
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(restarted);
      yield* TestClock.adjust("2 minutes");

      expect(yield* Fiber.join(run)).toMatchObject({
        _tag: "UserError",
        userMessage: expect.stringContaining("did not start within 2 minutes"),
      });
    }),
  );
});
