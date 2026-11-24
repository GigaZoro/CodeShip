// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import { expect, onTestFinished, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";

import {
  adjacentTests,
  argumentBatches,
  checkoutState,
  comparisonBase,
  defaultConcurrency,
  dependencyChangeFiles,
  docReaderTests,
  gitLines,
  keepModuleCache,
  runSteps,
  runTestGroups,
  splitTests,
  suiteSteps,
  testStepTimeoutSeconds,
  type Step,
  testsReaching,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

import { cachedTestTasks } from "./lib/cached-tests.ts";
import { stageTestCache, testCachePartition } from "./lib/staged-test-cache.ts";
import { workingTree } from "../.github/scripts/check-changed-receipt.cjs";

const GiB = 1024 ** 3;

const cacheDb = (cache: string) => NodePath.join(cache, "v18", "cache.db");
function storePass(cache: string, key: string, value = "pass") {
  const file = cacheDb(cache);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  using database = new NodeSqlite.DatabaseSync(file);
  database.exec("CREATE TABLE IF NOT EXISTS passes (key BLOB PRIMARY KEY, value BLOB)");
  database
    .prepare("INSERT OR REPLACE INTO passes VALUES (?, ?)")
    .run(Buffer.from(key), Buffer.from(value));
}

function storedPasses(cache: string) {
  using database = new NodeSqlite.DatabaseSync(cacheDb(cache), { readOnly: true });
  return database
    .prepare("SELECT CAST(key AS TEXT) AS key FROM passes ORDER BY key")
    .all()
    .map((row) => row.key);
}

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("budgets each full suite as a serial step, one worker for the server", () => {
    const steps = suiteSteps(["apps/web", "apps/server"], 6, () =>
      Effect.succeed({ ok: true, output: "" }),
    );
    assert.deepStrictEqual(
      steps.map(({ name, workers, serial }) => [name, workers, serial]),
      [
        ["suite apps/web", 6, true],
        ["suite apps/server", 1, true],
      ],
    );
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(docReaderTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
    assert.isTrue(decide(["docs/release-notes.md"], packages, false).outputs.test_web);
  });

  const slotDirectory = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "check-changed-slots-" });
  }).pipe(Effect.provide(NodeServices.layer));

  it.effect(
    "takes the free slots a step can use, in order, and runs serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        const slotsGiven: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          seconds: number,
          options: { workers?: number; serial?: boolean } = {},
        ): Step<never> => ({
          name,
          ...options,
          run: (slots) =>
            Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              slotsGiven[name] = slots;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep(`${seconds} seconds`);
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
        });
        const fiber = yield* runSteps(
          [
            step("light 1", 1),
            // Wants more than the budget, so it starts on what is free instead of waiting for all of it.
            step("heavy", 3, { workers: 5 }),
            step("pair", 1, { workers: 2 }),
            step("light 2", 1),
            step("test 1", 1, { serial: true }),
            step("test 2", 1, { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60, slotDirectory: yield* slotDirectory },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        assert.deepStrictEqual(slotsGiven, {
          "light 1": 1,
          heavy: 2,
          pair: 1,
          "light 2": 1,
          "test 1": 1,
          "test 2": 1,
        });
        // A step waiting for a slot is never overtaken by one later in the list.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 0,
          pair: 1,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  type Task = { task_name: string; result: unknown };
  const failed = (task: string, code: number): Task => ({
    task_name: task,
    result: { Spawned: { outcome: { Failed: { exit_code: code } } } },
  });
  const hit = (task: string): Task => ({
    task_name: task,
    result: { CacheHit: { source: "Local" } },
  });
  type Keys = [string, string, string, string];
  const report = (attempt: { tasks: ReadonlyArray<Task> }) =>
    `${attempt.tasks.at(-1)!.task_name} failed\n`;
  // Unix reports a group Vite+ killed as 137; Windows can report it as an ordinary failure.
  it.effect.each([
    {
      platform: "linux",
      attempts: ([first, middle, last, independent]: Keys) => [
        {
          limit: 2,
          completed: [],
          tasks: [hit(first), failed(middle, 1), failed(independent, 137)],
        },
        { limit: 2, completed: [first, middle], tasks: [failed(last, 1)] },
        { limit: 2, completed: [first, middle, last], tasks: [failed(independent, 1)] },
      ],
    },
    {
      platform: "win32",
      attempts: ([first, middle, last, independent]: Keys) => [
        { limit: 2, completed: [], tasks: [hit(first), failed(middle, 1), failed(independent, 1)] },
        { limit: 1, completed: [first], tasks: [failed(middle, 1)] },
        { limit: 1, completed: [first, middle], tasks: [failed(last, 1)] },
        { limit: 1, completed: [first, middle, last], tasks: [failed(independent, 1)] },
      ],
    },
  ])(
    "resumes after a middle server failure and an interrupted independent group on $platform",
    ({ platform, attempts: plan }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* slotDirectory;
        const cache = NodePath.join(directory, "cache");
        const version = NodePath.join(cache, "v18");
        const requestFile = NodePath.join(directory, "request.json");
        const summaryFile = NodePath.join(version, "last-summary.json");
        yield* fs.makeDirectory(version, { recursive: true });

        const request = {
          files: [
            "apps/server/src/server.test.ts",
            "apps/server/src/cli/project.test.ts",
            "apps/server/src/cli/update.test.ts",
            "packages/client-runtime/src/textPaste.test.ts",
          ],
          groupSize: 1,
          uncached: [],
        };
        const attempts = plan(
          cachedTestTasks(JSON.stringify(request))["test-cache"]!.dependsOn! as Keys,
        );
        const expected = attempts.map(report).join("");
        const result = yield* runTestGroups(cache, requestFile, request, 2, platform, (limit) =>
          Effect.gen(function* () {
            const attempt = attempts.shift()!;
            assert.strictEqual(limit, attempt.limit);
            const requested = JSON.parse(yield* fs.readFileString(requestFile));
            assert.deepStrictEqual(requested.completed, attempt.completed);
            yield* fs.writeFileString(summaryFile, JSON.stringify({ tasks: attempt.tasks }));
            return { ok: false, output: report(attempt) };
          }).pipe(Effect.orDie),
        );
        assert.deepStrictEqual(attempts, []);
        assert.deepStrictEqual(result, { ok: false, output: expected });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("seeds committed rows and publishes passes after success or interruption", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const cache = NodePath.join(directory, "private");
      const interrupted = NodePath.join(directory, "interrupted");
      storePass(shared, "earlier");
      using writer = new NodeSqlite.DatabaseSync(cacheDb(shared));
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("INSERT INTO passes VALUES (?, ?)")
        .run(Buffer.from("uncommitted"), Buffer.from("pass"));
      for (const name of ["last-summary.json", "db_open.lock"]) {
        NodeFS.writeFileSync(NodePath.join(shared, "v18", name), "");
      }

      const stable = Effect.succeed("unchanged");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, "unchanged", stable);
          assert.deepStrictEqual(storedPasses(cache), ["earlier"]);
          assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(cache, "v18")), ["cache.db"]);
          storePass(cache, "success");
          assert.deepStrictEqual(storedPasses(shared), ["earlier"]);
          writer.exec("ROLLBACK");
        }),
      );
      assert.deepStrictEqual(storedPasses(shared), ["earlier", "success"]);

      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, interrupted, "unchanged", stable);
          assert.deepStrictEqual(storedPasses(interrupted), ["earlier", "success"]);
          storePass(interrupted, "interrupted");
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.deepStrictEqual(storedPasses(shared), ["earlier", "success"]);
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(storedPasses(shared), ["earlier", "interrupted", "success"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves previously published passes intact when the guard changes", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const cache = NodePath.join(directory, "private");
      storePass(shared, "earlier");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, "before", Effect.succeed("after"));
          storePass(cache, "unvalidated");
        }),
      );
      assert.deepStrictEqual(storedPasses(shared), ["earlier"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges passes from concurrent runs with private snapshots", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const firstReady = yield* Deferred.make<void>();
      const secondReady = yield* Deferred.make<void>();
      const run = (key: string, ready: typeof firstReady, otherReady: typeof firstReady) =>
        Effect.scoped(
          Effect.gen(function* () {
            const cache = NodePath.join(directory, key);
            yield* stageTestCache(shared, cache, "unchanged", Effect.succeed("unchanged"));
            assert.isFalse(NodeFS.existsSync(cacheDb(cache)));
            storePass(cache, key);
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(otherReady);
          }),
        );
      yield* Effect.all(
        [run("first", firstReady, secondReady), run("second", secondReady, firstReady)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(storedPasses(shared), ["first", "second"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes only rows changed since seeding", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const cache = NodePath.join(directory, "private");
      storePass(shared, "untouched");
      storePass(shared, "updated");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, "stable", Effect.succeed("stable"));
          storePass(shared, "untouched", "newer");
          storePass(cache, "updated", "changed");
        }),
      );
      using db = new NodeSqlite.DatabaseSync(cacheDb(shared));
      assert.deepStrictEqual(
        db
          .prepare("SELECT CAST(value AS TEXT) AS value FROM passes ORDER BY key")
          .all()
          .map((row) => row.value),
        ["newer", "changed"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts with an empty private cache when the seed is busy", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const cache = NodePath.join(directory, "private");
      storePass(shared, "earlier");
      using writer = new NodeSqlite.DatabaseSync(cacheDb(shared));
      writer.exec("BEGIN EXCLUSIVE");
      let seedTimeout: number | undefined;
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      using _observe = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql) {
          if (sql.startsWith("VACUUM INTO"))
            seedTimeout = Number(prepare.call(this, "PRAGMA busy_timeout").get()?.timeout);
          return prepare.call(this, sql);
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, "stable", Effect.succeed("stable"));
          assert.isFalse(NodeFS.existsSync(cacheDb(cache)));
          writer.exec("ROLLBACK");
          expect(seedTimeout).toBeLessThan(1000);
          storePass(cache, "new");
        }),
      );
      assert.deepStrictEqual(storedPasses(shared), ["earlier", "new"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back a version when a published table has a different schema", () =>
    Effect.gen(function* () {
      const directory = yield* slotDirectory;
      const shared = NodePath.join(directory, "shared");
      const cache = NodePath.join(directory, "private");
      storePass(shared, "earlier");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, "unchanged", Effect.succeed("unchanged"));
          storePass(cache, "new");
          using source = new NodeSqlite.DatabaseSync(cacheDb(cache));
          using destination = new NodeSqlite.DatabaseSync(cacheDb(shared));
          source.exec("CREATE TABLE other (key BLOB PRIMARY KEY, value BLOB)");
          destination.exec("CREATE TABLE other (key BLOB PRIMARY KEY, value TEXT)");
        }),
      );
      assert.deepStrictEqual(storedPasses(shared), ["earlier"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only the current install's module cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const caches = NodePath.join(yield* slotDirectory, "check-changed");
      const current = NodePath.join(caches, "current");
      yield* keepModuleCache(current);
      for (const install of ["earlier", "current"]) {
        yield* fs.makeDirectory(NodePath.join(caches, install, "modules"), { recursive: true });
      }
      yield* keepModuleCache(current);
      assert.deepStrictEqual(yield* fs.readDirectory(caches), ["current"]);
      assert.deepStrictEqual(yield* fs.readDirectory(current), ["modules"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("marks the HEAD's test cache used and removes those unused for three days", () =>
    Effect.gen(function* () {
      const partitions = NodePath.join(yield* slotDirectory, "tests");
      const day = 24 * 60 * 60 * 1000;
      const now = Date.UTC(2026, 0, 10);
      yield* TestClock.setTime(now);
      for (const [entry, age] of [
        ["head", 5 * day],
        ["recent", 2 * day],
        ["unused", 4 * day],
      ] as const) {
        NodeFS.mkdirSync(NodePath.join(partitions, entry, "v18"), { recursive: true });
        const used = (now - age) / 1000;
        NodeFS.utimesSync(NodePath.join(partitions, entry), used, used);
      }
      const current = yield* testCachePartition(partitions, "head");
      assert.strictEqual(current, NodePath.join(partitions, "head"));
      assert.deepStrictEqual(NodeFS.readdirSync(partitions).toSorted(), ["head", "recent"]);
      assert.strictEqual(NodeFS.statSync(NodePath.join(partitions, "head")).mtimeMs, now);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("marks its HEAD's test cache used only after another run's removal of it ends", () =>
    Effect.gen(function* () {
      const partitions = NodePath.join(yield* slotDirectory, "tests");
      const partition = NodePath.join(partitions, "head");
      const now = Date.UTC(2026, 0, 10);
      yield* TestClock.setTime(now);
      NodeFS.mkdirSync(NodePath.join(partition, "v18"), { recursive: true });
      const unused = (now - 4 * 24 * 60 * 60 * 1000) / 1000;
      NodeFS.utimesSync(partition, unused, unused);
      // Another run's cleanup holds the lock and has found the partition unused.
      using cleanup = new NodeSqlite.DatabaseSync(`${partitions}.sqlite`);
      cleanup.exec("BEGIN EXCLUSIVE");
      const run = yield* testCachePartition(partitions, "head").pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      NodeFS.rmSync(partition, { recursive: true });
      cleanup.exec("ROLLBACK");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(run), partition);
      assert.isTrue(NodeFS.existsSync(partition));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a run's test cache private when a stalled run holds the lock", () =>
    Effect.gen(function* () {
      const partitions = NodePath.join(yield* slotDirectory, "tests");
      NodeFS.mkdirSync(partitions, { recursive: true });
      using stalled = new NodeSqlite.DatabaseSync(`${partitions}.sqlite`);
      stalled.exec("BEGIN EXCLUSIVE");
      const run = yield* testCachePartition(partitions, "head").pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      assert.isUndefined(yield* Fiber.join(run));
      stalled.exec("ROLLBACK");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a run's test cache private when it cannot mark its partition used", () =>
    Effect.gen(function* () {
      const partitions = NodePath.join(yield* slotDirectory, "tests");
      NodeFS.mkdirSync(partitions, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(partitions, "head"), "");
      assert.isUndefined(yield* testCachePartition(partitions, "head"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shares one budget between runs that use the same slot directory", () =>
    Effect.gen(function* () {
      let active = 0;
      let maxActive = 0;
      const step = (name: string): Step<never> => ({
        name,
        run: () =>
          Effect.gen(function* () {
            maxActive = Math.max(maxActive, ++active);
            yield* Effect.sleep("1 second");
            active--;
            return { ok: true, output: "" };
          }),
      });
      const options = { concurrency: 2, timeoutSeconds: 60, slotDirectory: yield* slotDirectory };
      const first = yield* runSteps([step("a 1"), step("a 2")], options).pipe(Effect.forkChild);
      const second = yield* runSteps([step("b 1"), step("b 2")], options).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const results = [...(yield* Fiber.join(first)), ...(yield* Fiber.join(second))];

      assert.deepStrictEqual(
        results.map((result) => result.outcome),
        ["pass", "pass", "pass", "pass"],
      );
      assert.strictEqual(maxActive, 2);
    }),
  );

  it.effect(
    "gives the next free slot to the run holding the landing turn ahead of an earlier waiter",
    () =>
      Effect.gen(function* () {
        const started: Array<string> = [];
        const step = (name: string, seconds: number): Step<never> => ({
          name,
          run: () =>
            Effect.gen(function* () {
              started.push(name);
              yield* Effect.sleep(`${seconds} seconds`);
              return { ok: true, output: "" };
            }),
        });
        const options = { concurrency: 1, timeoutSeconds: 60, slotDirectory: yield* slotDirectory };
        const holder = yield* runSteps([step("holder", 3)], options).pipe(Effect.forkChild);
        yield* TestClock.adjust("100 millis");
        const earlier = yield* runSteps([step("earlier", 1)], options).pipe(Effect.forkChild);
        yield* TestClock.adjust("100 millis");
        const landing = yield* runSteps([step("landing", 1)], { ...options, landing: true }).pipe(
          Effect.forkChild,
        );
        for (let second = 0; second < 10; second++) yield* TestClock.adjust("1 second");
        yield* Effect.all([Fiber.join(holder), Fiber.join(earlier), Fiber.join(landing)]);

        assert.deepStrictEqual(started, ["holder", "landing", "earlier"]);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: () =>
              Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
          },
          { name: "fails", run: () => Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: () => Effect.succeed({ ok: true, output: "" }) },
          { name: "allowed longer", run: () => Effect.never, timeoutSeconds: 20 },
        ],
        { concurrency: 4, timeoutSeconds: 10, slotDirectory: yield* slotDirectory },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      assert.isTrue(interrupted);
      yield* TestClock.adjust("10 seconds");
      const results = yield* Fiber.join(fiber);

      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
          ["allowed longer", "TIMEOUT", "killed after 20s"],
        ],
      );
    }),
  );

  it.effect("prints what a step wrote before its timeout killed it", () =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const fiber = yield* runSteps(
        [
          {
            name: "hangs after writing",
            run: (_slots, collect) =>
              Effect.sync(() => collect("FAIL apps/server/x.test.ts\n")).pipe(
                Effect.andThen(Effect.never),
              ),
          },
        ],
        { concurrency: 1, timeoutSeconds: 10, slotDirectory: yield* slotDirectory },
      ).pipe(
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => void logs.push(args.join(" ")),
        } as Console.Console),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      assert.isTrue(logs.some((line) => line.includes("FAIL apps/server/x.test.ts")));
    }),
  );

  it("bounds the test step by an explicit timeout and caps its per-file growth otherwise", () => {
    assert.strictEqual(testStepTimeoutSeconds(3, 900, false), 900);
    assert.strictEqual(testStepTimeoutSeconds(20, 900, false), 2400);
    assert.strictEqual(testStepTimeoutSeconds(5000, 900, false), 3600);
    assert.strictEqual(testStepTimeoutSeconds(5000, 600, true), 600);
    assert.strictEqual(testStepTimeoutSeconds(5000, 900, false, 9000), 9000);
  });

  it("splits a path list into steps whose arguments fit a Windows command line", () => {
    assert.deepStrictEqual(argumentBatches([], 10), []);
    assert.deepStrictEqual(argumentBatches(["aaaa", "bbbb", "cc", "dddddddddddd", "e"], 10), [
      ["aaaa", "bbbb"],
      ["cc"],
      ["dddddddddddd"],
      ["e"],
    ]);
  });

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  // A provider's replay suite reaches its adapter through the adapter's testkit
  // and the fixture index, which is how 40b1b72673 broke one unseen. A service's
  // own tests reach it through the service.
  const reachSources: Record<string, string> = {
    "server/Adapter.ts": "export const run = 1;\n",
    "server/Adapter.testkit.ts": 'import { run } from "./Adapter.ts";\n',
    "server/testkit/fixtures/index.ts": [
      'import "../../Adapter.testkit.ts";',
      'export const transcript = new URL("./case/transcript.ndjson", import.meta.url);',
    ].join("\n"),
    "server/testkit/fixtures/case/transcript.ndjson": "{}\n",
    "server/testkit/Replay.integration.test.ts":
      'import { transcript } from "./fixtures/index.ts";\n',
    "server/Service.ts": 'import { run } from "./Adapter.ts";\n',
    "server/Service.test.ts": 'import { service } from "./Service.ts";\n',
    "core/src/failure.ts": "export const code = 1;\n",
    "core/src/index.ts":
      '// Public API.\nexport * from "./failure.ts";\nexport { type A } from "./a.ts";\n',
    "server/Failure.test.ts": 'import { code } from "@t3/core/failure";\n',
    "server/Barrel.test.ts": 'import { code } from "@t3/core";\n',
  };
  it.each([
    ["server/Adapter.ts", ["server/Service.test.ts", "server/testkit/Replay.integration.test.ts"]],
    [
      "server/testkit/fixtures/case/transcript.ndjson",
      ["server/testkit/Replay.integration.test.ts"],
    ],
    ["core/src/failure.ts", ["server/Failure.test.ts"]],
    ["core/src/index.ts", []],
  ])("selects the tests that reach %s", (changed, expected) => {
    assert.deepStrictEqual(
      testsReaching({
        changed: [changed],
        files: new Set(Object.keys(reachSources)),
        packages: [
          {
            name: "@t3/core",
            dir: "core",
            exports: { ".": "./src/index.ts", "./failure": { import: "./src/failure.ts" } },
          },
        ],
        read: (file) => reachSources[file] ?? "",
      }),
      expected,
    );
  });

  describe("dependencyChangeFiles", () => {
    const workspace = (patch: string) => `patchedDependencies:\n  dep-a@1.0.0: patches/${patch}\n`;
    const lock = (version: string) =>
      [
        "snapshots:",
        "",
        `  dep-a@${version}:`,
        "    dependencies:",
        "      leaf: 1.0.0",
        "",
        "  dep-b@1.0.0:",
        "    dependencies:",
        "      dep-a: " + version,
        "",
      ].join("\n");
    const sources: Record<string, string> = {
      "app/use.ts": 'import { b } from "dep-b/sub";\n',
      "app/use.test.ts": 'import { x } from "./use.ts";\n',
      "app/other.ts": 'import { y } from "unrelated";\n',
    };
    const run = (
      changed: Array<string>,
      before: Record<string, string>,
      after: Record<string, string>,
    ) =>
      dependencyChangeFiles({
        changed,
        before: (file) => before[file] ?? "",
        after: (file) => after[file] ?? "",
        files: new Set(Object.keys(sources)),
        read: (file) => sources[file] ?? "",
      });

    it("selects files that import a patched package's dependents when only the patch changes", () => {
      const same = {
        "pnpm-workspace.yaml": workspace("dep-a@1.0.0.patch"),
        "pnpm-lock.yaml": lock("1.0.0"),
      };
      assert.deepStrictEqual(run(["patches/dep-a@1.0.0.patch"], same, same), ["app/use.ts"]);
    });

    it("selects them when a lockfile version changes, and nothing for an unrelated lockfile change", () => {
      const before = { "pnpm-lock.yaml": lock("1.0.0") };
      assert.deepStrictEqual(run(["pnpm-lock.yaml"], before, { "pnpm-lock.yaml": lock("1.0.1") }), [
        "app/use.ts",
      ]);
      assert.deepStrictEqual(run(["pnpm-lock.yaml"], before, before), []);
    });
  });

  it.each([
    "infra/task-cache/scripts/install.ts",
    "infra/tool/scripts/added.mts",
    ".github/scripts/added.cjs",
    "tools/added.ts",
    "removed.ts",
    "package.json",
    "apps/server/package.json",
    "apps/mobile/package.json",
    "infra/task-cache/package.json",
    "packages/source-control-github/package.json",
  ])("selects the repository command guard when %s changes", (changed) => {
    const test = "scripts/command-arguments.test.ts";
    const sources = new Map([
      [test, NodeFS.readFileSync(new URL("./command-arguments.test.ts", import.meta.url), "utf8")],
      ...(changed === "removed.ts" ? [] : [[changed, "export const command = 1;"] as const]),
    ]);
    assert.deepStrictEqual(
      testsReaching({
        changed: [changed],
        files: new Set(sources.keys()),
        packages: [],
        read: (file) => sources.get(file) ?? "",
      }),
      [test],
    );
  });

  it.each(["apps/mobile/src/fixtures/package.json", ".repos/vendor/package.json"])(
    "does not select the repository command guard for %s",
    (changed) => {
      const guard = "scripts/command-arguments.test.ts";
      assert.deepStrictEqual(
        testsReaching({
          changed: [changed],
          files: new Set([changed, guard]),
          packages: [],
          read: () => "",
        }),
        [],
      );
    },
  );

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

it("finds sibling tests once each, in any case or Unicode form Git spells them", () => {
  const directory = "packages/example";
  const test = `${directory}/related.test.ts`;
  const code = [
    `${directory}/related.ts`,
    test,
    `${directory}/caf\u00e9.ts`,
    `${directory}/stra\u00dfe.ts`,
    `${directory}/Lib/thing.ts`,
  ];
  const files = [
    ...code,
    `${directory}/cafe\u0301.test.ts`,
    `${directory}/STRA\u1e9eE.test.ts`,
    `${directory}/nested/related.test.ts`,
    `${directory}/lib/thing.test.ts`,
  ];
  assert.deepStrictEqual(
    [...adjacentTests(files, code)],
    [
      test,
      `${directory}/cafe\u0301.test.ts`,
      `${directory}/STRA\u1e9eE.test.ts`,
      `${directory}/lib/thing.test.ts`,
    ],
  );
});

it("leaves out vendored tests, changed or beside a changed file", () => {
  const directory = ".repos/effect-smol/packages/effect";
  const code = [`${directory}/Schema.ts`, `${directory}/Schema.test.ts`];
  assert.deepStrictEqual([...adjacentTests(code, code)], []);
  // A case-insensitive checkout can list a changed file in another case than the disk or its tests.
  const changed = [".REPOS/vendor/Foo.ts", ".REPOS/vendor/Bar.test.ts"];
  assert.deepStrictEqual(
    [...adjacentTests([...changed, ".repos/vendor/Foo.test.ts"], changed)],
    [],
  );
});

// Git ignores a scratch test, which a commit of the checkout leaves out.
it("leaves out a sibling test that Git ignores", () => {
  using project = launcherFixture();
  const ignore = NodePath.join(project.root, ".gitignore");
  project.write(".gitignore", `${NodeFS.readFileSync(ignore, "utf8")}scratch.test.ts\n`);
  project.write("scratch.ts", "export const value = 1;\n");
  project.commit("scratch");
  project.write("scratch.ts", "export const value = 2;\n");
  project.write(
    "scratch.test.ts",
    `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
  );
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(project.calls().some(({ args }) => args.includes("scratch.test.ts"))).toBe(false);
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files. Git for Windows maps /dev/null to its
// null device but cannot open NodeOS.devNull (\\.\nul).
const fixtureConfig = {
  "core.excludesFile": "/dev/null",
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
  try {
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    git,
    write,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const compare = (root: string, ref: Option.Option<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* comparisonBase(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

function isolateGit() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("GIT_")) vi.stubEnv(name, value);
  }
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

const stateChangesWithMode = (
  kind: string,
  mode: string,
  fileMode: boolean,
  name: string,
  from = 0o755,
) =>
  Effect.gen(function* () {
    isolateGit();
    const project = yield* Effect.acquireDisposable(Effect.sync(() => fixture({})));
    const { git, root, write } = project;
    const tool = NodePath.join(root, name);
    const commit = (file = name) => {
      git("add", file);
      git("commit", "-m", "tool");
    };
    write(".gitignore", ".env*\n");
    commit(".gitignore");
    if (kind === "case-folded untracked") {
      write(name.toLowerCase(), "#!/bin/sh\necho other\n");
      commit(name.toLowerCase());
      git("config", "core.ignoreCase", "true");
    }
    write(name, "#!/bin/sh\necho tool\n");
    if (kind === "plain tracked") commit();
    if (kind === "symlink placeholder") {
      // Git checks a symlink out as a file holding its target where core.symlinks is false.
      git("config", "core.symlinks", "false");
      const blob = git("hash-object", "-w", name);
      git("update-index", "--add", "--cacheinfo", `120000,${blob},${name}`);
      commit();
    }
    if (kind.endsWith("embedded repository")) {
      const nested = NodePath.join(root, name.split("/")[0]!);
      for (const args of [["init"], ["add", "."], ["commit", "--allow-empty", "-m", "nested"]]) {
        git("-C", nested, ...args);
      }
    }
    NodeFS.chmodSync(tool, from);
    if (kind === "tracked") commit();
    git("config", "core.fileMode", String(fileMode));
    const objects = NodePath.join(root, ".git", "checked-objects");
    NodeFS.mkdirSync(objects);
    const head = git("rev-parse", "HEAD");
    const state = Effect.suspend(() =>
      checkoutState({ root, objects, head, tree: workingTree(root, objects) }),
    ).pipe(Effect.provide(NodeServices.layer));
    const before = yield* state;
    expect(yield* state).toBe(before);
    NodeFS.chmodSync(tool, mode);
    expect(yield* state).not.toBe(before);
  });

// Git for Windows records no executable bit.
describe.skipIf(isWindowsHost)("checkoutState", () => {
  it.effect.each([
    ["tracked", "644", true, "tool.sh"],
    ["tracked", "644", false, "tool.sh"],
    ["tracked", "744", true, "tool.sh"],
    ["plain tracked", "744", false, "tool.sh"],
    ["untracked", "644", false, "tool.sh"],
    ["untracked", "644", false, 'tool"one.sh'],
    ["ignored", "644", true, ".env.tool"],
    ["ignored", "655", true, ".env.tool"],
    ["symlink placeholder", "744", true, "tool.sh"],
    ["ignored embedded repository", "744", true, ".env.nested/tool.sh"],
    ["untracked embedded repository", "744", true, "nested/tool.sh"],
    // Git never lists a file named .git, which only a walk into the repository finds.
    ["untracked embedded repository", "744", true, "nested/fixture/.git"],
  ] as const)(
    "keys the checkout state on a %s file changing from mode 755 to %s, with core.fileMode %s (%s)",
    ([kind, mode, fileMode, name]) => stateChangesWithMode(kind, mode, fileMode, name),
  );

  // A runner in the file's group may run it though its owner may not.
  it.effect(
    "keys the checkout state on a file only its group may run changing from mode 654 to 644",
    () => stateChangesWithMode("tracked", "644", true, "tool.sh", 0o654),
  );

  // Only a disk that tells case apart holds both names.
  it.effect.runIf(isLinuxHost)(
    "keys the checkout state on an untracked file whose name differs in case from a tracked one changing mode",
    () => stateChangesWithMode("case-folded untracked", "744", true, "Tool.sh"),
  );
});

function launcherFixture(realTests = false) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    "scripts/lib/repository-command-source.ts",
    "packages/shared/src/testing/providerEnv.ts",
    "scripts/lib/staged-test-cache.ts",
    "scripts/lib/cached-tests.ts",
    "scripts/lib/cached-vitest-options.ts",
    "scripts/lib/run-cached-test-group.ts",
    "scripts/lib/test-host-input.ts",
    ".github/scripts/ci-changes.cjs",
    ".github/scripts/check-node-runtime.cjs",
    ".github/scripts/check-changed-receipt.cjs",
    ".github/scripts/git-history.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  // Resolve the test runner's Node even when the runtime check removes Vite+'s injected path.
  const nodeBin = NodePath.join(root, "node_modules", "fixture-node-bin");
  NodeFS.mkdirSync(NodePath.dirname(nodeBin), { recursive: true });
  NodeFS.symlinkSync(NodePath.dirname(process.execPath), nodeBin, "junction");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  write(".gitignore", "node_modules/\nrecords/\n.generated/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      engines: { node: process.versions.node },
      scripts: {
        "knip:check": "knip --include files",
        "check:changed": "node scripts/check-changed.ts",
      },
    }),
  );
  write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", scripts: { test: "vp test run" } }),
  );
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/fixture-vp/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/fixture-vp/cli.js",
    `
    import { randomUUID } from 'node:crypto';
    import { execFileSync, spawnSync } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    // Windows gives a finished step's pid to the next process at once, so a pid-named record could be replaced.
    fs.writeFileSync(path.join(process.env.RECORDS, randomUUID() + '.json'), JSON.stringify({ args, cwd: process.cwd() }), { flag: 'wx' });
    if (${realTests} && args.slice(0, 3).join(" ") === "exec node --test") {
      const result = spawnSync(process.execPath, args.slice(2), { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    }
    if (args.includes('test-cache') && !${realTests}) {
      const { files } = JSON.parse(fs.readFileSync(process.env.T3_CHECK_CHANGED_TEST_REQUEST, 'utf8'));
      fs.writeFileSync(path.join(process.env.RECORDS, randomUUID() + '.json'), JSON.stringify({args:['test', ...files], cwd:process.cwd()}));
    }
    if (${realTests} && (args[0] === 'test' || args.includes('test-cache'))) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('vite-plus/bin')), ...args], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    }
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    if (args[0] === process.env.EDIT_STEP) {
      if (process.env.EDIT_FILE) fs.appendFileSync(process.env.EDIT_FILE, "// edited\\n");
      else execFileSync('git', ['commit', '--allow-empty', '-m', 'move HEAD']);
    }
    const failing = process.env.FAIL_STEP !== '' && args.join(' ').startsWith(process.env.FAIL_STEP);
    process.exit(failing ? 23 : 0);
  `,
  );
  write(
    "scripts/check-changed-command.ts",
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "check-changed-command.ts"),
      "utf8",
    ).replace('import.meta.resolve("vite-plus/bin")', 'import.meta.resolve("fixture-vp/bin")'),
  );
  write(
    "vite.config.mjs",
    `
    import { cachedTestTasks } from "./scripts/lib/cached-tests.ts";
    export default {
      run: { cache: { scripts: false }, tasks: cachedTestTasks(process.env.T3_CACHED_TESTS) },
      test: { maxWorkers: 1, setupFiles: ["./packages/shared/src/testing/providerEnv.ts"] }
    };
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared", "vite-plus"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-records-"));
  return {
    root,
    source,
    write,
    git,
    commit(message: string) {
      git("add", ".");
      git("commit", "-m", message);
    },
    run(failStep = "", editStep = "", editFile = source, extraEnv: NodeJS.ProcessEnv = {}) {
      const command = realTests
        ? [
            NodePath.join(root, "node_modules/vite-plus/dist/bin.js"),
            "run",
            "check:changed",
            "HEAD",
          ]
        : ["scripts/check-changed.ts", "HEAD"];
      return NodeChildProcess.spawnSync(process.execPath, command, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
          [pathKey]: [nodeBin, env[pathKey]].filter(Boolean).join(NodePath.delimiter),
          TEMP: NodeOS.tmpdir(),
          RECORDS: records,
          ...extraEnv,
          FAIL_STEP: failStep,
          EDIT_STEP: editStep,
          EDIT_FILE: editFile && NodePath.join(root, editFile),
        },
      });
    },
    takeReceipts() {
      const directory = NodePath.join(root, ".git/t3-check-changed/passed");
      const receipts = NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [];
      for (const file of receipts) NodeFS.unlinkSync(NodePath.join(directory, file));
      return receipts.length;
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(records, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args.join(" ") === "run licenses:check")).toBe(true);
  expect(calls.filter(({ args }) => args[0] === "install")).toEqual([
    { args: ["install", "--frozen-lockfile", "--prefer-offline"], cwd: project.root },
  ]);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("routes a manifest-only change to the repository command guard through the launcher", () => {
  using project = launcherFixture();
  const guard = "scripts/command-arguments.test.ts";
  project.write(guard, "export {};\n");
  project.write("scripts/unrelated.test.ts", "export {};\n");
  project.commit("add the guard and an unrelated test");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", scripts: { verify: "node ./verify.ts" } }),
  );

  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const tests = project.calls().filter(({ args }) => args[0] === "test");
  expect(tests).toHaveLength(1);
  expect(tests[0]?.args.at(-1)).toBe(guard);
  expect(tests[0]?.args).not.toContain("scripts/unrelated.test.ts");
});

// Where core.fileMode is false, Git sees no mode change, so only the checkout state reruns the test.
it.skipIf(isWindowsHost)(
  "reruns a test after a tracked file it runs changes mode where Git ignores modes",
  () => {
    using project = launcherFixture(true);
    const tool = NodePath.join(project.root, "tool.sh");
    project.write("tool.sh", "#!/bin/sh\necho tool\n");
    project.git("add", "tool.sh");
    project.git("commit", "-m", "tool");
    NodeFS.chmodSync(tool, 0o755);
    project.git("config", "core.fileMode", "false");
    project.write(
      "fixture.test.ts",
      `import { execFileSync } from "node:child_process";
      import { statSync } from "node:fs";
      import { it, expect } from "vite-plus/test";
      it("runs the tool", () => {
        expect(statSync("tool.sh").mode & 0o111).toBe(0o111);
        expect(execFileSync("./tool.sh", { encoding: "utf8" })).toBe("tool\\n");
      });`,
    );
    const first = project.run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    NodeFS.chmodSync(tool, 0o744);
    const next = project.run();
    expect(next.status, next.stdout + next.stderr).toBe(1);
    expect(next.stdout).toContain("FAIL  test");
  },
);

it.each(["node", "filtered compiler"])(
  "reruns the selected %s cases before renewing a receipt",
  (runner) => {
    using project = launcherFixture(true);
    const calls = NodePath.join(project.root, "node_modules/.vite/runner-calls");
    NodeFS.mkdirSync(NodePath.dirname(calls), { recursive: true });
    const body = `appendFileSync(${JSON.stringify(calls)}, "run\\n");
    if (process.env.T3_TEST_WARM_FAILURE === "1") throw Error("warm runner failure");`;
    if (runner === "node") {
      project.write(
        ".github/scripts/current.test.cjs",
        `const { it } = require("node:test"); const { appendFileSync } = require("node:fs");
       it("current", () => { ${body} });`,
      );
    } else {
      project.write(
        "apps/web/src/reactCompilerCoverage.test.ts",
        `import { it } from "vite-plus/test"; import { appendFileSync } from "node:fs";
       it("compiles apps/web/src/current.ts", () => { ${body} });
       it("compiles apps/web/src/unselected.ts", () => { throw Error("outside filter"); });`,
      );
      project.commit("compiler coverage");
      project.write("apps/web/src/current.ts", "export const value = 1;");
    }
    for (const [attempt, fail] of ["0", "1", "0"].entries()) {
      const result = project.run("", "", "", { T3_TEST_WARM_FAILURE: fail });
      expect(result.status, result.stdout + result.stderr).toBe(fail === "1" ? 1 : 0);
      expect(NodeFS.readFileSync(calls, "utf8")).toBe("run\n".repeat(attempt + 1));
      expect(project.takeReceipts()).toBe(fail === "1" ? 0 : 1);
    }
  },
);

it.skipIf(isWindowsHost).each(["cold", "warm"])(
  "withholds the %s receipt after a later runner changes tested permissions",
  (cache) => {
    using project = launcherFixture(true);
    project.git("config", "core.fileMode", "false");
    project.write("input.txt", "unchanged");
    NodeFS.chmodSync(NodePath.join(project.root, "input.txt"), 0o600);
    const calls = NodePath.join(project.root, "node_modules/.vite/permission-calls");
    NodeFS.mkdirSync(NodePath.dirname(calls), { recursive: true });
    project.write(
      "permissions.test.ts",
      `import { it, expect } from "vite-plus/test";
    import { appendFileSync, statSync } from "node:fs";
    it("reads the tested mode", () => { appendFileSync(${JSON.stringify(calls)}, "V");
      expect(statSync("input.txt").mode & 0o777).toBe(0o600); });`,
    );
    project.write(
      ".github/scripts/later.test.cjs",
      `const { it } = require("node:test");
    const { appendFileSync, chmodSync } = require("node:fs");
    it("later runner", () => { appendFileSync(${JSON.stringify(calls)}, "N");
      if (process.env.CHANGE_AFTER_VITEST === "1") chmodSync("input.txt", 0o644); });`,
    );
    const run = (change: string) =>
      project.run("", "", "", { CHECK_CHANGED_CONCURRENCY: "1", CHANGE_AFTER_VITEST: change });
    if (cache === "warm") {
      const first = run("0");
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(project.takeReceipts()).toBe(1);
    }
    const changed = run("1");
    expect(changed.status, changed.stdout + changed.stderr).toBe(1);
    expect(NodeFS.readFileSync(calls, "utf8")).toBe(cache === "warm" ? "VNN" : "VN");
    expect(project.takeReceipts()).toBe(0);
    const next = run("0");
    expect(next.status, next.stdout + next.stderr).toBe(1);
    expect(NodeFS.readFileSync(calls, "utf8")).toBe(cache === "warm" ? "VNNVN" : "VNVN");
    expect(project.takeReceipts()).toBe(0);
  },
);

// The helper is a real executable resolved through PATH on POSIX.
it.skipIf(isWindowsHost).each(["forks", "threads"])(
  "reruns an indirect host command replaced at the same path in %s",
  (pool) => {
    using project = launcherFixture(true);
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-changed-host-tool-"));
    try {
      const config = NodePath.join(project.root, "vite.config.mjs");
      project.write(
        "vite.config.mjs",
        NodeFS.readFileSync(config, "utf8").replace(
          "maxWorkers: 1",
          `maxWorkers: 1, pool: "${pool}"`,
        ),
      );
      project.commit("set the project worker pool");
      const helper = NodePath.join(bin, "archive-tool");
      NodeFS.writeFileSync(helper, "#!/bin/sh\nprintf first", { mode: 0o755 });
      const calls = NodePath.join(project.root, "node_modules/.vite/host-calls");
      NodeFS.mkdirSync(NodePath.dirname(calls), { recursive: true });
      project.write(
        "archive.ts",
        `import { execFileSync } from "node:child_process";
      export const archive = () => execFileSync("archive-tool", { encoding: "utf8" });`,
      );
      project.write(
        "archive.test.ts",
        `import { it, expect } from "vite-plus/test";
      import { appendFileSync } from "node:fs"; import { archive } from "./archive.ts";
      it("reads host tool output", () => { appendFileSync(${JSON.stringify(calls)}, "T");
        expect(archive()).toBe("first"); });`,
      );
      project.write(
        ".github/scripts/published.test.cjs",
        `const { it } = require("node:test");
      const { readdirSync } = require("node:fs");
      it("published groups can no longer read their host marker", () => {
        const dir = "node_modules/.cache/check-changed-host";
        if (readdirSync(dir, { recursive: true, withFileTypes: true }).some(entry => entry.isFile()))
          throw Error("host marker survived publication");
      });`,
      );
      const run = () =>
        project.run("", "", "", {
          PATH: [bin, env.PATH].join(NodePath.delimiter),
          CHECK_CHANGED_CONCURRENCY: "1",
        });
      const cold = run();
      expect(cold.status, cold.stdout + cold.stderr).toBe(0);
      expect(project.takeReceipts()).toBe(1);
      NodeFS.writeFileSync(helper, "#!/bin/sh\nprintf other");
      const warm = run();
      expect(warm.status, warm.stdout + warm.stderr).toBe(1);
      expect(NodeFS.readFileSync(calls, "utf8")).toBe("TT");
      expect(project.takeReceipts()).toBe(0);
    } finally {
      NodeFS.rmSync(bin, { recursive: true, force: true });
    }
  },
);

it("reuses an idle FFI binding and runs a group again when it calls the binding", () => {
  using project = launcherFixture(true);
  const ffi = NodeFS.realpathSync(
    NodePath.join(import.meta.dirname, "../packages/shared/node_modules/ffi-rs"),
  );
  NodeFS.symlinkSync(ffi, NodePath.join(project.root, "node_modules/ffi-rs"), "junction");
  const calls = NodePath.join(project.root, "node_modules/.vite/native-calls");
  NodeFS.mkdirSync(NodePath.dirname(calls), { recursive: true });
  for (const native of [false, true]) {
    project.write(
      "native.test.ts",
      `import { it, expect } from "vite-plus/test";
      import { DataType, open } from "ffi-rs";
      import { appendFileSync } from "node:fs";
      it("uses the binding", () => { appendFileSync(${JSON.stringify(calls)}, "T");
        expect(typeof DataType.I32).toBe("number");
        ${native ? 'expect(() => open({ library: "missing", path: "./missing-shared-library" })).toThrow();' : ""}
      });`,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const pass = project.run();
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      expect(project.takeReceipts()).toBe(1);
    }
    expect(NodeFS.readFileSync(calls, "utf8")).toBe(native ? "TTT" : "T");
  }
});

it("invalidates a completed group when checkout-local Git configuration changes", () => {
  using project = launcherFixture(true);
  project.git("config", "fixture.value", "initial-value");
  const calls = NodePath.join(project.root, "node_modules/.vite/config-calls");
  NodeFS.mkdirSync(NodePath.dirname(calls), { recursive: true });
  project.write(
    "config.test.ts",
    `import { it, expect } from "vite-plus/test";
    import { appendFileSync, readFileSync } from "node:fs";
    it("observes the checkout configuration", () => { appendFileSync(${JSON.stringify(calls)}, "T");
      expect(readFileSync(".git/config", "utf8")).toContain("initial-value"); });`,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const pass = project.run();
    expect(pass.status, pass.stdout + pass.stderr).toBe(0);
    expect(project.takeReceipts()).toBe(1);
  }
  expect(NodeFS.readFileSync(calls, "utf8")).toBe("T");
  project.git("config", "fixture.value", "replacement-value");
  const invalid = project.run();
  expect(invalid.status, invalid.stdout + invalid.stderr).toBe(1);
  expect(NodeFS.readFileSync(calls, "utf8")).toBe("TT");
  expect(project.takeReceipts()).toBe(0);
});

it("resumes passed groups after a failed gate and invalidates a changed test input", () => {
  using project = launcherFixture(true);
  NodeFS.mkdirSync(NodePath.join(project.root, "packages/example/node_modules"));
  const counters = NodePath.join(project.root, "node_modules/.vite/invocations");
  NodeFS.mkdirSync(counters, { recursive: true });
  const testSource = (name: string, body: string) => `
    import { randomUUID } from "node:crypto";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { expect, it } from "vite-plus/test";
    it("${name}", () => {
      writeFileSync(join(${JSON.stringify(counters)}, "${name}-" + randomUUID()), "");
      ${body}
    });
  `;
  const counts = () =>
    NodeFS.readdirSync(counters)
      .map((name) => name.split("-")[0])
      .sort();
  project.write(
    "a-quick.test.ts",
    testSource(
      "quick",
      'expect(process.env.VITE_CACHE_PATH).toBeUndefined(); expect(readFileSync("input.txt", "utf8")).toBe("pass");',
    ),
  );
  project.write("input.txt", "pass");
  const failing = "packages/example/z-failing.test.ts";
  project.write(failing, testSource("other", 'throw new Error("fixture failure");'));
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("fixture failure");
  expect(counts()).toEqual(["other", "quick"]);
  expect(NodeFS.existsSync(NodePath.join(project.root, ".git/t3-check-changed/passed"))).toBe(
    false,
  );

  project.write(failing, testSource("other", ""));
  const retry = project.run();
  expect(retry.status, retry.stdout + retry.stderr).toBe(0);
  expect(counts()).toEqual(["other", "other", "quick"]);

  project.write("input.txt", "changed");
  const invalid = project.run();
  expect(invalid.status, invalid.stdout + invalid.stderr).toBe(1);
  expect(counts()).toEqual(["other", "other", "quick", "quick"]);
});

it.each(["source", "HEAD"])("rejects a gate when %s changes during checks", (changed) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "lint", changed === "source" ? project.source : "");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("pass  lint");
  expect(result.stdout).toContain(
    changed === "source"
      ? "files changed while the checks ran"
      : "HEAD changed while the checks ran",
  );
  expect(NodeFS.existsSync(NodePath.join(project.root, ".git/t3-check-changed/passed"))).toBe(
    false,
  );
});

it("records no push pass for a tree that changed before a cached result", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n// edited\n");
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "install");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(project.calls().filter(({ args }) => args[0] === "lint")).toHaveLength(1);
  expect(result.stdout).toContain("files changed while the checks ran");
});

// Git for Windows records no executable bit for an untracked file.
it.skipIf(isWindowsHost)("checks again after an untracked file's mode changed", () => {
  using project = launcherFixture();
  const tool = "packages/example/tool.ts";
  project.write(tool, "export const tool = 1;\n");
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  NodeFS.chmodSync(NodePath.join(project.root, tool), 0o755);
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(project.calls().filter(({ args }) => args[0] === "lint")).toHaveLength(2);
});

it("caches no pass for a file that appeared after the files were listed", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "install", "packages/example/added.ts");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("rejects a package support range without a development pin", () => {
  using project = launcherFixture();
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", engines: { node: `>=${process.versions.node}` } }),
  );
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain(
    `packages/example: set devEngines.runtime to node ${process.versions.node}`,
  );
  expect(project.calls()).toEqual([]);
});

it("passes uncached when a check rewrites a generated file", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write("packages/example/.generated/types.d.ts", "export {};\n");
  const result = project.run("", "lint", "packages/example/.generated/types.d.ts");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("pass not cached: generated files changed during the run");
});

it("stops before any check when the lockfile does not install", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("install --frozen-lockfile");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain("check:changed could not install pnpm-lock.yaml");
  expect(project.calls().map(({ args }) => args[0])).toEqual(["install"]);
});

it("installs Chromium before web browser tests and runs none without it", () => {
  using project = launcherFixture();
  project.write("apps/web/src/view.browser.test.tsx", "export {};\n");
  const result = project.run("exec node apps/web/node_modules/playwright/cli.js install");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain(
    "check:changed could not install Chromium for the browser tests",
  );
  expect(
    project
      .calls()
      .map(({ args }) => args.slice(0, 3).join(" "))
      .toSorted(),
  ).toEqual([
    "exec node apps/web/node_modules/playwright/cli.js",
    "install --frozen-lockfile --prefer-offline",
  ]);
});

it.each([
  ["unused patches", "install --lockfile-only"],
  ["third-party licenses", "run licenses:check"],
  ["lint", "lint"],
])("reports a failing %s step with its output", (step, failing) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(failing);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[1] === "--lockfile-only");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  const command = failing.split(" ")[0];
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${command}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${command}`);
  expect(result.stdout).toContain(`FAIL  ${step}`);
  if (step === "lint") {
    expect(result.stdout).toContain("pass  unused patches");
    expect(result.stdout).toContain("pass  third-party licenses");
  }
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});
