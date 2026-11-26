// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, onTestFinished, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { probeProcess } from "@t3tools/shared/processProbe";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";

import {
  argumentBatches,
  adjacentTests,
  changedPaths,
  changedWhileCheckingMessage,
  checkoutState,
  comparisonBase,
  defaultConcurrency,
  dependencyChangeFiles,
  docReaderTests,
  GIT_TIMEOUT,
  gitLines,
  ignoredInputs,
  isTestInput,
  keepModuleCache,
  runSpawner,
  runSteps,
  runTestGroups,
  spawnVp,
  splitTests,
  suiteSteps,
  testStepTimeoutSeconds,
  type Step,
  testsReaching,
  uncachedTests,
} from "./check-changed.ts";
import { cachedTestTasks } from "./lib/cached-tests.ts";
import { stageTestCache, testCachePartition } from "./lib/staged-test-cache.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { workingTree } from "../.github/scripts/check-changed-receipt.cjs";

vi.mock("node:fs/promises", { spy: true });

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

  it("keeps every test that starts bash with bash's own flags out of the file tracker", () => {
    const root = NodePath.join(import.meta.dirname, "..");
    const tests = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "-z", "--", "*.test.ts", "*.test.tsx", "*.test.mjs", ":(exclude).repos"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(
        (file) =>
          file !== "" &&
          /--no(?:profile|rc)\b/.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")),
      );
    expect(tests).toContain("apps/server/src/project/ProjectSetupScriptRunner.test.ts");
    expect(tests.filter((file) => !uncachedTests.includes(file))).toEqual([]);
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
            "apps/server/a.test.ts",
            "apps/server/b.test.ts",
            "apps/server/c.test.ts",
            "packages/client-runtime/d.test.ts",
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

      const stable = Effect.succeed([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stageTestCache(shared, cache, stable);
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
          yield* stageTestCache(shared, interrupted, stable);
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
          yield* stageTestCache(shared, cache, Effect.succeed(["guard"]));
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
            yield* stageTestCache(shared, cache, Effect.succeed([]));
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
          yield* stageTestCache(shared, cache, Effect.succeed([]));
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
          yield* stageTestCache(shared, cache, Effect.succeed([]));
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
          yield* stageTestCache(shared, cache, Effect.succeed([]));
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

  it.effect("does not count a Mac's sleep against a step's timeout", () =>
    Effect.gen(function* () {
      // A timer of a Mac that sleeps: it fires once, however long past its time the Mac woke.
      const timers = yield* Queue.unbounded<Deferred.Deferred<void>>();
      const clock = yield* Clock.Clock;
      let asleepMillis = 0;
      const fiber = yield* runSteps([{ name: "hangs", run: () => Effect.never }], {
        concurrency: 1,
        timeoutSeconds: 10,
        slotDirectory: yield* slotDirectory,
      }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillis: Effect.sync(() => asleepMillis),
          sleep: () =>
            Effect.suspend(() => {
              const wake = Deferred.makeUnsafe<void>();
              return Queue.offer(timers, wake).pipe(Effect.andThen(Deferred.await(wake)));
            }),
        }),
        Effect.forkChild,
      );
      const nextTimer = Effect.raceFirst(
        Queue.take(timers),
        Fiber.join(fiber).pipe(Effect.andThen(Effect.die("the step was killed"))),
      );
      const first = yield* nextTimer;
      asleepMillis = 900_000;
      yield* Deferred.succeed(first, undefined);
      // Nine of its ten seconds awake are left.
      for (let second = 1; second < 10; second++) {
        yield* Deferred.succeed(yield* nextTimer, undefined);
      }
      const [result] = yield* Fiber.join(fiber);

      assert.deepStrictEqual([result?.outcome, result?.time], ["TIMEOUT", "killed after 10s"]);
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

  it("names each changed file once, by the tree or, where the tree hides it, by its bytes", () => {
    const before = new Map([
      ["crlf.ts", "lf digest"],
      ["new.ts", ""],
    ]);
    const after = new Map([
      ["crlf.ts", "crlf digest"],
      ["new.ts", "new digest"],
    ]);
    const paths = changedPaths([{ status: "A", path: "new.ts" }], before, after);
    assert.deepStrictEqual(paths, [
      "A\tnew.ts",
      "M\tcrlf.ts (bytes on disk only, such as line endings)",
    ]);
    const many = Array.from({ length: 22 }, (_, index) => `A\tfile-${index}.ts`);
    const message = changedWhileCheckingMessage(many);
    assert.include(message, "A\tfile-19.ts");
    assert.notInclude(message, "A\tfile-20.ts");
    assert.include(message, "and 2 more");
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

  type GitReply = {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  const fakeGit = (reply: (args: ReadonlyArray<string>) => GitReply) =>
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        const literalArgs = args.map((arg) => {
          if (typeof arg !== "string")
            throw new Error("The Git test double expects literal arguments");
          return arg;
        });
        const { exitCode, stdout = "", stderr = "" } = reply(literalArgs);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
  const exited = (code: number) => Effect.succeed(ChildProcessSpawner.ExitCode(code));

  it.effect("fails instead of returning an empty file list when git exits nonzero", () =>
    Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeGit(() => ({ exitCode: exited(0), stdout: "a.ts\nb.ts\n" })),
        ),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeGit(() => ({ exitCode: exited(128), stderr: "fatal: index file corrupt" })),
        ),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    }),
  );

  it.effect("fails a git call that runs past its time limit", () =>
    Effect.gen(function* () {
      const listing = yield* gitLines("/repo", ["ls-files", "--others"]).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeGit(() => ({ exitCode: Effect.never })),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(GIT_TIMEOUT);
      assert.strictEqual(
        yield* Fiber.join(listing),
        `check:changed: git ls-files --others did not finish within ${GIT_TIMEOUT}`,
      );
    }),
  );

  // Each walk of a Windows process tree starts PowerShell, which takes seconds on a loaded machine, and
  // a run makes many git calls, one after another.
  it.effect("walks the tree of each step on Windows, and of no git call that exited", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = [];
      const fake = fakeGit(() => ({ exitCode: exited(0), stdout: "a.ts\n" }));
      const spawner = runSpawner(
        ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawned.push(command.command);
          return fake.spawn(command);
        }),
        "win32",
      );
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.deepStrictEqual(listed, ["a.ts"]);
      assert.deepStrictEqual(spawned, ["git"]);
      yield* spawnVp(spawner, "win32", ["lint"], "/repo", {}, () => {});
      assert.deepStrictEqual(spawned, ["git", process.execPath, "powershell.exe"]);
    }),
  );

  // A git that exits while a process it started holds its output never reaches the end of that
  // output, so the call fails at its time limit. Its pipes then stop holding the event loop, or they
  // would keep check:changed from exiting until that process ends (the patch of
  // @effect/platform-node-shared).
  it.effect("lets the run exit while a process git started still holds its output", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-held-git-"));
    const fakeGitScript = writeHolderStarter(dir, "setInterval(() => {}, 1 << 30)");
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const gitExited = yield* Deferred.make<void>();
      const pipesBefore = openPipes();
      const listing = yield* gitLines(dir, ["ls-files"]).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner
              .spawn(
                ChildProcess.make(process.execPath, [fakeGitScript], {
                  ...(ChildProcess.isStandardCommand(command) ? command.options : {}),
                  stdin: "ignore",
                }),
              )
              .pipe(
                Effect.tap((handle) =>
                  Effect.forkScoped(
                    handle.exitCode.pipe(Effect.andThen(Deferred.succeed(gitExited, undefined))),
                  ),
                ),
              ),
          ),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      // The fake git has started the holder once it has exited.
      yield* Deferred.await(gitExited);
      yield* TestClock.adjust(GIT_TIMEOUT);
      assert.strictEqual(
        yield* Fiber.join(listing),
        `check:changed: git ls-files did not finish within ${GIT_TIMEOUT}`,
      );
      // Still open, since the holder keeps their other ends, but no longer holding the event loop.
      assert.strictEqual(openPipes(), pipesBefore);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(() => removeDir(dir))));
  });

  // A process a caller unrefs may outlive its scope, and its pipes then stop holding the event loop
  // as well, or they would keep this process from exiting until that one ends.
  it.effect("lets the run exit while a process it unrefs outlives its scope", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-unrefed-"));
    const hold = NodePath.join(dir, "hold");
    NodeFS.writeFileSync(hold, "");
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const pipesBefore = openPipes();
      const pid = yield* Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make(
              process.execPath,
              ["-e", whileHeld(hold, "setInterval(() => {}, 1 << 30)")],
              { stdin: "ignore" },
            ),
          )
          .pipe(
            Effect.tap((handle) => handle.unref),
            Effect.map((handle) => handle.pid),
          ),
      );
      // The scope closed while the process still runs, and left it running.
      assert.deepStrictEqual(probeProcess(pid), { state: "alive" });
      assert.strictEqual(openPipes(), pipesBefore);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(() => removeDir(dir))));
  });

  // An ACP terminal reads its process's output after the scope that owns the process has closed,
  // until the output ends, so the patch must not cut off what a process it started writes later.
  // The reader runs in a process of its own: in this one the test runner keeps the event loop
  // running, which would hide a pipe that lets the reader's process exit before the output ends.
  it("keeps a process's output for its reader after the process's scope closes", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-late-output-"));
    const go = NodePath.join(dir, "go");
    // The holder writes once the reader's process creates go, and then ends, which ends the output.
    const starter = writeHolderStarter(
      dir,
      `const fs = require("node:fs"); const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(poll); process.stdout.write("late"); } }, 20);`,
      "early ",
    );
    const reader = [
      'import * as NodeFS from "node:fs";',
      'import * as NodeServices from "@effect/platform-node/NodeServices";',
      'import * as Effect from "effect/Effect";',
      'import * as Exit from "effect/Exit";',
      'import * as Fiber from "effect/Fiber";',
      'import * as Scope from "effect/Scope";',
      'import * as Stream from "effect/Stream";',
      'import { ChildProcess, ChildProcessSpawner } from "effect/process";',
      "const output = await Effect.gen(function* () {",
      "  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;",
      "  const scope = yield* Scope.make();",
      `  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [${JSON.stringify(starter)}])).pipe(Effect.provideService(Scope.Scope, scope));`,
      "  const reading = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkDetach);",
      "  yield* handle.exitCode;",
      "  yield* Scope.close(scope, Exit.void);",
      `  NodeFS.writeFileSync(${JSON.stringify(go)}, "");`,
      "  return yield* Fiber.join(reading);",
      "}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);",
      "process.stdout.write(output);",
    ].join("\n");
    try {
      // From this folder, whose node_modules the reader's imports resolve in. A pipe that let the
      // reader's process exit first ends it with its await unsettled, exit code 13, which rejects.
      const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        ["--input-type=module", "-e", reader],
        { cwd: import.meta.dirname, windowsHide: true },
      );
      assert.strictEqual(stdout, "early late");
    } finally {
      removeDir(dir);
    }
  });

  // The git subcommand a fake git was asked for, and the revision it names last.
  const gitCall = (args: ReadonlyArray<string>) =>
    `${args.find((arg) => /^[a-z][a-z-]*$/.test(arg))} ${args.at(-1)}`;
  const ORIGIN = "refs/remotes/origin/main";
  const UPSTREAM = "refs/remotes/upstream/main";
  // comparisonBase resolves HEAD once, and compares every candidate with that commit.
  const HEAD_COMMIT = "decade";
  const withHead = (reply: (args: ReadonlyArray<string>) => GitReply) =>
    fakeGit((args) =>
      args.at(-1) === "HEAD^{commit}"
        ? { exitCode: exited(0), stdout: `${HEAD_COMMIT}\n` }
        : reply(args),
    );

  // A ref that does not exist (rev-parse exits 1) or shares no history with HEAD (merge-base exits
  // 1) rules a candidate out, and the comparison goes no further with it.
  it.effect.each([
    {
      call: "rev-parse",
      upstream: 0,
      outcome: "compares against upstream/main",
      calls: [`rev-parse ${ORIGIN}`, `rev-parse ${UPSTREAM}`, `merge-base ${UPSTREAM}`],
    },
    {
      call: "merge-base",
      upstream: 0,
      outcome: "compares against upstream/main",
      calls: [
        `rev-parse ${ORIGIN}`,
        `merge-base ${ORIGIN}`,
        `rev-parse ${UPSTREAM}`,
        `merge-base ${UPSTREAM}`,
      ],
    },
    {
      call: "merge-base",
      upstream: 1,
      outcome: "fails once no candidate is left",
      calls: [
        `rev-parse ${ORIGIN}`,
        `merge-base ${ORIGIN}`,
        `rev-parse ${UPSTREAM}`,
        `merge-base ${UPSTREAM}`,
      ],
    },
  ])("$call exit 1 rules origin/main out and $outcome", ({ call, upstream, calls }) =>
    Effect.gen(function* () {
      const asked: Array<string> = [];
      const comparing = comparisonBase("/repo", Option.none()).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          withHead((args) => {
            if (args.includes("remote")) {
              return { exitCode: exited(0), stdout: "origin\nupstream\n" };
            }
            asked.push(gitCall(args));
            if (args.includes("rev-list")) return { exitCode: exited(0), stdout: "2\n" };
            // Only the call under test fails: for origin/main, and for upstream/main as `upstream` says.
            const code = !args.includes(call) ? 0 : args.at(-1) === ORIGIN ? 1 : upstream;
            return { exitCode: exited(code), stdout: code === 0 ? "c0ffee\n" : "" };
          }),
        ),
      );
      if (upstream === 0) {
        assert.deepStrictEqual(yield* comparing, {
          ref: "upstream/main",
          base: "c0ffee",
          ahead: 2,
        });
        assert.deepStrictEqual(asked, [...calls, `rev-list c0ffee..${HEAD_COMMIT}`]);
      } else {
        assert.strictEqual(
          yield* Effect.flip(comparing),
          "check:changed: no merge base with origin/main, upstream/main. Run git fetch or pass a ref.",
        );
        assert.deepStrictEqual(asked, calls);
      }
    }),
  );

  // A ref to a commit this clone lacks exists for rev-parse, but merge-base cannot read it, which
  // `git fetch` repairs; skipping it would compare against another main without a word.
  it.effect("fails with git's message when merge-base cannot read a ref that exists", () =>
    Effect.gen(function* () {
      const error = yield* comparisonBase("/repo", Option.none()).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          withHead((args) => {
            if (args.includes("remote")) {
              return { exitCode: exited(0), stdout: "origin\nupstream\n" };
            }
            if (args.includes("merge-base") && args.at(-1) === ORIGIN) {
              return {
                exitCode: exited(128),
                stderr: `fatal: Not a valid commit name ${ORIGIN}\n`,
              };
            }
            return { exitCode: exited(0), stdout: args.includes("rev-list") ? "1\n" : "c0ffee\n" };
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        `check:changed: git merge-base ${HEAD_COMMIT} ${ORIGIN} exited with 128: fatal: Not a valid commit name ${ORIGIN}`,
      );
    }),
  );

  // With no ref, upstream/main merges fine, so a comparison that read the stuck call as a
  // missing ref would pass instead of failing.
  it.effect.each([
    // An explicit ref is compared as the commit it names.
    { against: "an explicit ref", ref: Option.some("origin/main"), rev: "c0ffee" },
    { against: "the closest remote main", ref: Option.none(), rev: "refs/remotes/origin/main" },
  ])("fails when merge-base against $against runs past its time limit", ({ ref, rev }) =>
    Effect.gen(function* () {
      const stuck = yield* Deferred.make<void>();
      const comparing = yield* comparisonBase("/repo", ref).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          withHead((args) => {
            if (args.includes("remote")) {
              return { exitCode: exited(0), stdout: "origin\nupstream\n" };
            }
            if (args.includes("merge-base") && args.at(-1) === rev) {
              return {
                exitCode: Deferred.succeed(stuck, undefined).pipe(Effect.andThen(Effect.never)),
              };
            }
            return { exitCode: exited(0), stdout: args.includes("rev-list") ? "1\n" : "c0ffee\n" };
          }),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      // The clock moves only once the stuck call runs, so its time limit has started.
      yield* Deferred.await(stuck);
      yield* TestClock.adjust(GIT_TIMEOUT);
      assert.strictEqual(
        yield* Fiber.join(comparing),
        `check:changed: git merge-base ${HEAD_COMMIT} ${rev} did not finish within ${GIT_TIMEOUT}`,
      );
    }),
  );

  // On Windows the spawner ends the process through Node's handle, which a process cannot ignore.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills a git that ignores SIGTERM once its time limit has passed",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stuck-git-"));
      // The fake git writes to the FIFO once it ignores SIGTERM, so the clock moves only after that.
      const fifo = NodePath.join(dir, "started");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      // It runs until the test removes dir, if the spawner never kills it.
      const gitScript = NodePath.join(dir, "git");
      NodeFS.writeFileSync(
        gitScript,
        `#!/bin/sh\ntrap '' TERM\nexec 3>'${fifo}'\necho >&3\nwhile [ -e '${gitScript}' ]; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      // Read and write, so the open needs no writer and does not block, and the socket's destroy ends
      // the read whether or not the fake git ever opens the FIFO.
      const started = new NodeNet.Socket({
        fd: NodeFS.openSync(fifo, NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK),
        readable: true,
        writable: false,
      });
      const ignoresTerm = new Promise<void>((resolve) => started.once("data", () => resolve()));
      let leader = 0;
      return Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const listing = yield* gitLines(dir, ["ls-files"]).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner
                .spawn(
                  ChildProcess.setEnv(command, {
                    ...env,
                    PATH: `${dir}${NodePath.delimiter}${process.env.PATH}`,
                  }),
                )
                .pipe(Effect.tap((handle) => Effect.sync(() => (leader = handle.pid)))),
            ),
          ),
          Effect.flip,
          Effect.forkChild,
        );
        // A fake git that fails before it opens the FIFO, such as one a noexec temp folder keeps from
        // running, ends the listing instead.
        yield* Effect.raceFirst(
          Effect.promise(() => ignoresTerm),
          Fiber.join(listing).pipe(
            Effect.flatMap((error) =>
              Effect.die(`the fake git ended before it ignored SIGTERM: ${String(error)}`),
            ),
          ),
        );
        yield* TestClock.adjust(GIT_TIMEOUT);
        assert.strictEqual(
          yield* Fiber.join(listing),
          `check:changed: git ls-files did not finish within ${GIT_TIMEOUT}`,
        );
        assert.deepStrictEqual(probeProcess(leader), { state: "gone", code: "ESRCH" });
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.ensuring(
          Effect.sync(() => {
            started.destroy();
            removeDir(dir);
          }),
        ),
      );
    },
  );

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
    "server/Token.ts": "export const token = 1;\n",
    "server/caf\u00e9.ts": 'import { token } from "./Token.ts";\n',
    "server/cafe\u0301.test.ts": "",
    "server/R\u00e9sum\u00e9.ts": "export const resume = 1;\n",
    "server/Reader.test.ts": 'import { resume } from "./Re\u0301sume\u0301.ts";\n',
    "server/FOO.js": "export const foo = 1;\n",
    "server/foo.ts": "export const foo = 2;\n",
    "server/Loader.test.ts": 'import { foo } from "./foo.js";\n',
    "server/caf\u00e9-\u0131.ts": "export const dotless = 1;\n",
    "server/caf\u00e9-i.ts": "export const dotted = 1;\n",
    "server/Menu.test.ts": 'import { dotted } from "./cafe\u0301-i.ts";\n',
    "server/Clock.ts": "export const clock = 1;\n",
    "server/Lib/timer.ts": 'import { clock } from "../Clock.ts";\n',
    "server/lib/timer.test.ts": "",
  };
  it.each([
    ["server/Adapter.ts", ["server/Service.test.ts", "server/testkit/Replay.integration.test.ts"]],
    [
      "server/testkit/fixtures/case/transcript.ndjson",
      ["server/testkit/Replay.integration.test.ts"],
    ],
    ["core/src/failure.ts", ["server/Failure.test.ts"]],
    ["core/src/index.ts", []],
    // Git and the disk can spell an importer and its sibling test in different Unicode forms.
    ["server/Token.ts", ["server/cafe\u0301.test.ts"]],
    // A disk that ignores Unicode form resolves an import Git spells in another.
    ["server/R\u00e9sum\u00e9.ts", ["server/Reader.test.ts"]],
    // A disk that ignores case opens FOO.js for ./foo.js before Vite tries foo.ts.
    ["server/FOO.js", ["server/Loader.test.ts"]],
    ["server/foo.ts", ["server/Loader.test.ts"]],
    // Every file the import's key holds, not the first.
    ["server/caf\u00e9-i.ts", ["server/Menu.test.ts"]],
    ["server/Clock.ts", ["server/lib/timer.test.ts"]],
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

  it("opens the built desktop app only for startup, settlement, and sidebar changes", () => {
    const packages = readWorkspace();
    const launches = (file: string) => decide([file], packages, false).outputs.desktop_launch;
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.ts",
      "apps/server/src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts",
      "apps/web/src/components/sidebar/SidebarThreadRow.tsx",
      "apps/desktop/src/backend/DesktopBackendManager.ts",
      "apps/desktop/src/electron/ElectronProtocol.ts",
      "packages/contracts/src/settings.ts",
      "scripts/fixtures/desktop-launch/statev2.sqlite",
    ]) {
      assert.isTrue(launches(file), file);
    }
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.test.ts",
      "apps/web/src/components/chat/ChatView.tsx",
      "apps/desktop/src/updates/DesktopRemoteUpdates.ts",
      "packages/contracts/src/orchestration.ts",
    ]) {
      assert.isFalse(launches(file), file);
    }
    // A script-only change still builds the app it opens.
    assert.isTrue(decide(["scripts/smoke-desktop-app.ts"], packages, false).outputs.build);
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
      ".REPOS/vendor/use.ts": 'import { b } from "dep-b/sub";\n',
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

  it.each([
    "apps/mobile/src/fixtures/package.json",
    ".repos/vendor/package.json",
    ".REPOS/vendor/package.json",
  ])("does not select the repository command guard for %s", (changed) => {
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
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
    "packages/shared/src/testing/gitEnv.ts",
    "packages/shared/src/testing/gitRepositoryEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
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

// Code for node -e that runs `code` until the file `hold` is gone, or this test process is (a run cut
// short never removes it), then exits whatever `code` still waits for. A test ends it by removing
// its folder, never by signalling an id the system may have given an unrelated process since.
const whileHeld = (hold: string, code: string) => {
  // A worker thread shares its pid with the runner, which outlives a worker cut short.
  assert.isTrue(NodeWorkerThreads.isMainThread, "a holder needs its test in a process of its own");
  return `{ const tester = ${process.pid}; const testing = () => { try { process.kill(tester, 0); return true; } catch (error) { return error.code === "EPERM"; } }; setInterval(() => { if (!require("node:fs").existsSync(${JSON.stringify(hold)}) || !testing()) process.exit(); }, 50).unref(); } ${code}`;
};

// The stdio pipes that keep this process's event loop running. A stdin pipe, which Node destroys
// once its process exits, counts until it has closed on a later turn of the loop, so a test that
// counts them starts its processes without one.
const openPipes = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === "PipeWrap").length;

// Writes dir/starter.mjs: it starts `holder`, code for node -e, as a process that inherits its
// stdio and outlives it, writes `output` and exits. The holder runs until dir is removed.
const writeHolderStarter = (dir: string, holder: string, output = "") => {
  const hold = NodePath.join(dir, "hold");
  NodeFS.writeFileSync(hold, "");
  const starter = NodePath.join(dir, "starter.mjs");
  NodeFS.writeFileSync(
    starter,
    [
      'import { spawn } from "node:child_process";',
      'import { tmpdir } from "node:os";',
      // Outside dir, which Windows cannot delete while a running process works in it.
      `const holder = spawn(process.execPath, ["-e", ${JSON.stringify(whileHeld(hold, holder))}], { cwd: tmpdir(), stdio: "inherit", detached: true, windowsHide: true });`,
      "holder.unref();",
      `process.stdout.write(${JSON.stringify(output)});`,
    ].join("\n"),
  );
  return starter;
};

const removeDir = (dir: string) => NodeFS.rmSync(dir, { recursive: true, force: true });

const writeUnder = (root: string, file: string, content = "input") => {
  const path = NodePath.join(root, file);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  const write = (file: string, content: string) => writeUnder(root, file, content);
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

const inFixture = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
const comparing = (root: string, ref: Option.Option<string>) =>
  inFixture(comparisonBase(root, ref));
const compare = (root: string, ref: Option.Option<string>) =>
  comparing(root, ref).pipe(Effect.runPromise);

it("fingerprints ignored inputs without entering dependency trees or directory links", async () => {
  using project = fixture({});
  const write = (file: string, content?: string) => writeUnder(project.root, file, content);
  write(".gitignore", "ignored/\n.generated/\n.astro/\n*.d.ts\n.env*\nnode_modules/\n");
  const expected = [
    ".env",
    ".env.local",
    "root.d.ts",
    "target/leaked.d.ts",
    ".generated/code.ts",
    ".astro/types.ts",
    "ignored/deep/.generated/code.js",
    "ignored/deep/.astro/data.json",
    "ignored/deep/types.d.ts",
    "ignored/deep/.env.test",
    "ignored/space & дослід.d.ts",
    // Nested repositories, with a .git folder and with a .git file, are listed by their folder.
    ".generated/nested/",
    "ignored/deep/.generated/linked-repo/",
  ].sort();
  const gitInit = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main", ...args], {
      cwd: project.root,
      env,
    });
  gitInit(".generated/nested");
  // Git does not create the parent of a separate Git directory.
  const modules = NodePath.join(project.root, ".git", "modules");
  NodeFS.mkdirSync(modules);
  gitInit(
    `--separate-git-dir=${NodePath.join(modules, "linked-repo")}`,
    "ignored/deep/.generated/linked-repo",
  );
  for (const file of [
    ...expected.filter((file) => !file.endsWith("/")),
    ".generated/nested/code.ts",
    "ignored/deep/.generated/linked-repo/code.ts",
    "ignored/plain.ts",
    "unignored.ts",
    "node_modules/pkg/index.d.ts",
    "ignored/node_modules/pkg/.env",
    "target/leaked.d.ts",
    ".generated/node_modules/pkg/data.ts",
  ])
    write(file);
  NodeFS.symlinkSync(
    NodePath.join(project.root, "target"),
    NodePath.join(project.root, "ignored", "linked"),
    "junction",
  );
  NodeFS.symlinkSync(
    NodePath.join(project.root, "target"),
    NodePath.join(project.root, "node_modules", "linked"),
    "junction",
  );
  const actual = await Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* ignoredInputs(project.root).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (ChildProcess.isStandardCommand(command) && command.args.includes("ls-files")) {
            assert.include(command.args, "--directory");
            assert.notInclude(command.args, "--");
          }
          return spawner.spawn(ChildProcess.setEnv(command, env));
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
  assert.deepStrictEqual(actual, expected);
});

// The inputs `ignoredInputs` finds in `root` when Git's listing is `entries`. Git answers its other
// calls.
const ignoredInputsListed = (root: string, entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* ignoredInputs(root).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(
            ChildProcess.isStandardCommand(command) && command.args.includes("ls-files")
              ? ChildProcess.make(process.execPath, [
                  "-e",
                  `process.stdout.write(${JSON.stringify(entries.map((entry) => `${entry}\0`).join(""))})`,
                ])
              : ChildProcess.setEnv(command, env),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it("keys the test cache on ignored env files and generated sources, never a declaration", () => {
  const listed = [
    "apps/docs/.astro/content.json",
    "apps/web/.env.local",
    "packages/client/.generated/routes.d.ts",
    "packages/client/.generated/routes.ts",
    "packages/client/types.d.ts",
  ];
  assert.deepStrictEqual(listed.filter(isTestInput), [
    "apps/web/.env.local",
    "packages/client/.generated/routes.ts",
  ]);
});

it("leaves out an ignored input removed after Git listed it", async () => {
  using project = fixture({});
  // Git's listing names a folder that is gone by the time it is read.
  assert.deepStrictEqual(
    await ignoredInputsListed(project.root, ["removed/.generated/", "removed.d.ts"]),
    [],
  );
});

it("reads each ignored folder once when Git lists it beside folders inside it", async () => {
  using project = fixture({});
  const inputs = ["outer/a.d.ts", "outer/inner/b.d.ts", "outer/inner/deeper/c.d.ts"];
  for (const file of inputs) writeUnder(project.root, file);
  const reads = vi.mocked(NodeFSP.readdir);
  reads.mockClear();
  const actual = await ignoredInputsListed(project.root, [
    "outer/",
    "outer/inner/",
    "outer/inner/deeper/",
    ...inputs,
  ]);
  assert.deepStrictEqual(actual, inputs);
  assert.deepStrictEqual(
    reads.mock.calls.map(([folder]) =>
      NodePath.relative(project.root, String(folder)).replaceAll("\\", "/"),
    ),
    ["outer", "outer/inner", "outer/inner/deeper"],
  );
});

// Git for Windows lists the folders inside one a junction leads to, as `linked/dist/`; Git elsewhere
// lists the link itself. Either way the link's target is no input of this checkout.
it("leaves out what Git lists under a link", async () => {
  using project = fixture({});
  writeUnder(project.root, "target/dist/x.d.ts");
  NodeFS.symlinkSync(
    NodePath.join(project.root, "target"),
    NodePath.join(project.root, "linked"),
    "junction",
  );
  assert.deepStrictEqual(
    await ignoredInputsListed(project.root, ["linked/", "linked/dist/", "linked/dist/x.d.ts"]),
    [],
  );
});

// Git takes a folder for a nested repository only when its .git is a git directory or a file naming
// one, a linked worktree's with the commondir that holds its objects and refs. A .git that is
// neither, such as a tool's marker file, leaves what is beside it listed; a .git entry never is.
it("walks past a .git that is no repository and stops at one that is", async () => {
  using project = fixture({});
  const write = (file: string, content?: string) => writeUnder(project.root, file, content);
  const store = NodePath.join(project.root, "store");
  write("store/HEAD", "ref: refs/heads/main\n");
  NodeFS.mkdirSync(NodePath.join(store, "objects"));
  NodeFS.mkdirSync(NodePath.join(store, "refs"));
  write("store/worktrees/wt/HEAD", `${"1".repeat(40)}\n`);
  write("store/worktrees/wt/commondir", "../..\n");
  write("ignored/marked/.git", "not a repository\n");
  write("ignored/dangling/.git", "gitdir: ../nowhere\n");
  write("ignored/hollow/.git/inside.d.ts");
  write("ignored/.generated/linked/.git", "gitdir: ../../../store\r\n");
  write("ignored/.generated/worktree/.git", `gitdir: ${NodePath.join(store, "worktrees", "wt")}\n`);
  for (const file of [
    "ignored/marked/legit.d.ts",
    "ignored/dangling/a.d.ts",
    "ignored/hollow/b.d.ts",
    "ignored/.generated/linked/code.ts",
    "ignored/.generated/worktree/code.ts",
  ])
    write(file);
  assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), [
    "ignored/.generated/linked/",
    "ignored/.generated/worktree/",
    "ignored/dangling/a.d.ts",
    "ignored/hollow/b.d.ts",
    "ignored/marked/legit.d.ts",
  ]);
});

// Git passes over an entry named .git in another case when core.ignorecase is set, and takes a .GIT
// for a nested repository's .git where the file system folds case. Node resolves node_modules there
// in any case, whatever the setting says, so a NODE_MODULES folder holds dependencies.
it.each([true, false])(
  "matches .git and node_modules in any case with core.ignorecase %s",
  async (fold) => {
    using project = fixture({});
    NodeChildProcess.execFileSync("git", ["config", "core.ignorecase", String(fold)], {
      cwd: project.root,
      env,
    });
    const write = (file: string, content?: string) => writeUnder(project.root, file, content);
    write("ignored/.generated/upper/.GIT/HEAD", "ref: refs/heads/main\n");
    NodeFS.mkdirSync(NodePath.join(project.root, "ignored/.generated/upper/.GIT/objects"));
    NodeFS.mkdirSync(NodePath.join(project.root, "ignored/.generated/upper/.GIT/refs"));
    for (const file of [
      "ignored/.generated/upper/code.ts",
      "ignored/NODE_MODULES/pkg/x.d.ts",
      "ignored/other/.GIT/inside.d.ts",
      "ignored/other/b.d.ts",
    ])
      write(file);
    const foldsCase = NodeFS.existsSync(
      NodePath.join(project.root, "ignored/.generated/upper/.git"),
    );
    const unlessFolding = (file: string) => (fold ? [] : [file]);
    assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), [
      ...(foldsCase
        ? ["ignored/.generated/upper/"]
        : [
            ...unlessFolding("ignored/.generated/upper/.GIT/HEAD"),
            "ignored/.generated/upper/code.ts",
          ]),
      ...(foldsCase ? [] : ["ignored/NODE_MODULES/pkg/x.d.ts"]),
      ...unlessFolding("ignored/other/.GIT/inside.d.ts"),
      "ignored/other/b.d.ts",
    ]);
  },
);

// Node reads dependencies from the folder a lowercase node_modules link leads to, so where the file
// system keeps case a NODE_MODULES folder that link reaches holds them too. Where it folds case, the
// two names are one folder, which holds them as well.
it("passes over the folder a node_modules link leads to, whatever its case", async () => {
  using project = fixture({});
  writeUnder(project.root, "ignored/NODE_MODULES/pkg/x.d.ts");
  const link = NodePath.join(project.root, "ignored/node_modules");
  const target = NodePath.join(project.root, "ignored/NODE_MODULES");
  if (!NodeFS.existsSync(link)) NodeFS.symlinkSync(target, link, "junction");
  assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), []);
});

// A HEAD that is a FIFO would hold a read until something writes to it. Git lists the ignored folder
// that holds it without looking inside, so check:changed must not wait on it either.
it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "walks past a .git whose HEAD is a FIFO",
  async () => {
    using project = fixture({});
    const dotGit = NodePath.join(project.root, "ignored/.generated/piped/.git");
    for (const folder of ["objects", "refs"])
      NodeFS.mkdirSync(NodePath.join(dotGit, folder), { recursive: true });
    NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dotGit, "HEAD")]);
    writeUnder(project.root, "ignored/.generated/piped/code.ts");
    assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), [
      "ignored/.generated/piped/code.ts",
    ]);
  },
);

// A .git link that leads back to itself is no repository Git can read, so Git lists what is beside it.
// Windows skips it: making a link there needs a privilege.
it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "walks past a .git that is a link to itself",
  async () => {
    using project = fixture({});
    const looped = NodePath.join(project.root, "ignored/.generated/looped");
    NodeFS.mkdirSync(looped, { recursive: true });
    NodeFS.symlinkSync(".git", NodePath.join(looped, ".git"));
    writeUnder(project.root, "ignored/.generated/looped/code.ts");
    assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), [
      "ignored/.generated/looped/code.ts",
    ]);
  },
);

// Git takes a HEAD that links under refs/ without following it, so a repository whose branch has no
// commit yet is one, and takes a HEAD that links anywhere else for none, whatever the link reaches.
// Windows skips it: making a link there needs a privilege.
it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reads a HEAD that is a link as Git does",
  async () => {
    using project = fixture({});
    writeUnder(project.root, "ignored/head.txt", "ref: refs/heads/main\n");
    for (const [name, target] of [
      ["unborn", "refs/heads/main"],
      ["elsewhere", "../../../head.txt"],
    ] as const) {
      const dotGit = NodePath.join(project.root, "ignored/.generated", name, ".git");
      for (const folder of ["objects", "refs"])
        NodeFS.mkdirSync(NodePath.join(dotGit, folder), { recursive: true });
      NodeFS.symlinkSync(target, NodePath.join(dotGit, "HEAD"));
      writeUnder(project.root, `ignored/.generated/${name}/code.ts`);
    }
    assert.deepStrictEqual(await ignoredInputsListed(project.root, ["ignored/"]), [
      "ignored/.generated/elsewhere/code.ts",
      "ignored/.generated/unborn/",
    ]);
  },
);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("skips a remote without a main and fails on a main whose commit this clone lacks", async () => {
  using project = fixture({ origin: "A" });
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: project.root, env });
  git("remote", "add", "fresh", NodePath.join(project.root, "missing"));
  assert.strictEqual((await compare(project.root, Option.none())).ref, "origin/main");
  git("remote", "add", "upstream", NodePath.join(project.root, "missing"));
  // A loose ref names a commit no object holds, as after a fetch cut short.
  writeUnder(project.root, ".git/refs/remotes/upstream/main", `${"1".repeat(40)}\n`);
  const error = await comparing(project.root, Option.none()).pipe(Effect.flip, Effect.runPromise);
  assert.isTrue(
    String(error).startsWith(
      `check:changed: git merge-base ${project.commits.C} refs/remotes/upstream/main exited with 128: fatal: `,
    ),
    String(error),
  );
});

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

it("lists the ignored inputs that main's pathspecs list, without entering node_modules", async () => {
  using project = fixture({});
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: project.root, encoding: "utf8", env });
  const write = (file: string, content = "") => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(project.root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project.root, file), content);
  };
  write(".gitignore", "node_modules/\ndist/\n.generated/\n.env*\n*.gen.d.ts\nreplaced/\nskipped/");
  for (const file of ["replaced", "skipped"]) write(file);
  git("add", ".");
  git("commit", "-m", "files that directories replace");
  git("update-index", "--skip-worktree", "skipped");
  for (const file of ["replaced", "skipped"]) NodeFS.rmSync(NodePath.join(project.root, file));
  for (const file of [
    ".env.local",
    "src/types.gen.d.ts",
    "src/.generated/routes.ts",
    "dist/index.d.ts",
    "dist/node_modules/pkg/index.d.ts",
    "node_modules/pkg/index.d.ts",
    // A package folder left behind by a branch switch.
    "old/dist/a.d.ts",
    "old/node_modules/pkg/index.d.ts",
    "replaced/sub/a.d.ts",
    "skipped/a.d.ts",
  ])
    write(file);
  const command =
    "ls-files -o -i --exclude-standard -- :(glob)**/.generated/** :(glob)**/.astro/** :(glob)**/*.d.ts :(glob)**/.env* :(exclude,glob)**/node_modules/**";
  const old = git(...command.split(" "))
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.includeMembers(old, ["old/dist/a.d.ts", "replaced/sub/a.d.ts", "skipped/a.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredInputs(project.root)).pipe(Effect.runPromise), old);
});

const providerEnv = NodePath.join(
  import.meta.dirname,
  "../packages/shared/src/testing/providerEnv.ts",
);

// The run under test reads none of the settings of the check:changed run or landing turn running
// these tests, such as a landing's test step limit, so its steps run the same for whoever runs
// them. Windows reads environment names in any case, so they are left out whatever their case.
const CALLER_SETTINGS = /^(?:CHECK_CHANGED_|T3_LANDING_TURN)/iu;
const withoutCallerSettings = (from: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(from).filter(([name]) => !CALLER_SETTINGS.test(name)));

const summaryOf = (stdout: string) => stdout.slice(stdout.lastIndexOf("check:changed summary"));

function launcherFixture(caller: Readonly<Record<string, string>> = {}) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => writeUnder(root, file, content);
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    "scripts/lib/repository-command-source.ts",
    "scripts/lib/cached-tests.ts",
    "scripts/lib/cached-vitest-options.ts",
    "scripts/lib/run-cached-test-group.ts",
    "scripts/lib/staged-test-cache.ts",
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
  write(".gitignore", "node_modules/\nrecords/\n.generated/\n.env*\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      engines: { node: process.versions.node },
      scripts: {
        "knip:check:files": "knip --include files",
        "knip:check:exports": "knip --exports",
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
    "scripts/check-changed-command.ts",
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "check-changed-command.ts"),
      "utf8",
    ).replace('import.meta.resolve("vite-plus/bin")', 'import.meta.resolve("fixture-vp/bin")'),
  );
  write(
    "node_modules/fixture-vp/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/fixture-vp/cli.js",
    `
    import { randomUUID } from 'node:crypto';
    import { execFileSync, spawnSync } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    const args = process.argv.slice(2);
    // Windows gives a finished step's pid to the next process at once, so a pid-named record could be replaced.
    const settings = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:CHECK_CHANGED_|T3_LANDING_TURN)/i.test(name)));
    fs.writeFileSync(path.join(process.env.RECORDS, randomUUID() + '.json'), JSON.stringify({ args, cwd: process.cwd(), settings }), { flag: 'wx' });
    const edit = args[0] === process.env.EDIT_STEP || args.includes(process.env.EDIT_STEP);
    if (edit && !args.includes('test-cache')) {
      fs.appendFileSync(process.env.EDIT_FILE, "// edited\\n");
    }
    if (args[0] === 'test' || args.includes('test-cache')) {
      // As knip and the tests load a config while the test step runs.
      if (process.env.TEST_STEP_LOADS) {
        await (await import(pathToFileURL(path.resolve(process.env.TEST_STEP_LOADS)).href)).default;
      }
      if (process.env.MOVE_HEAD) {
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'move HEAD']);
      }
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('vite-plus/bin')), ...args], {
        stdio: 'inherit',
      });
      if (edit) fs.appendFileSync(process.env.EDIT_FILE, "// edited\\n");
      process.exit(result.status ?? 1);
    }
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    const failing = process.env.FAIL_STEP !== '' && args.join(' ').startsWith(process.env.FAIL_STEP);
    process.exit(failing ? 23 : 0);
  `,
  );
  write(
    "vite.config.mjs",
    `
    import { cachedTestTasks } from "./scripts/lib/cached-tests.ts";
    export default {
      run: { tasks: cachedTestTasks(process.env.T3_CACHED_TESTS) },
      // As the repository's test config does through scripts/lib/test-workers.ts and its setup.
      test: {
        include: ["**/*.test.ts"],
        maxWorkers: Number(process.env.T3CODE_TEST_MAX_WORKERS) || undefined,
        setupFiles: [${JSON.stringify(providerEnv)}],
      },
    };
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform, and read the
  // host's capabilities from a file outside the checkout that a test can change.
  const host = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-host-"));
  const capabilities = NodePath.join(host, "capabilities.json");
  NodeFS.writeFileSync(capabilities, JSON.stringify({ symlinks: true, ipv6Loopback: true }));
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8")
      .replace("vitePlusCommand(args, platform)", 'vitePlusCommand(args, "win32")')
      .replace('"@t3tools/shared/testing/hostCapabilityProbe"', '"./fixture-host.ts"'),
  );
  write(
    "scripts/fixture-host.ts",
    `import { readFileSync } from "node:fs";
    export { hostCapabilitiesEnv } from "@t3tools/shared/testing/hostCapabilityProbe";
    export const probeHostCapabilities = async () =>
      JSON.parse(readFileSync(${JSON.stringify(capabilities)}, "utf8"));`,
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
  const recorded = (): Array<{
    args: Array<string>;
    cwd: string;
    settings: Record<string, string>;
  }> =>
    NodeFS.readdirSync(records).map((file) =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
    );
  // `vp run check:changed` puts the checkout's bin folder first.
  const checkEnv = (checkout: string, extraEnv: Record<string, string> = {}) => ({
    ...withoutCallerSettings({ ...env, ...caller }),
    TEMP: NodeOS.tmpdir(),
    [pathKey]: [
      NodePath.join(checkout, "node_modules/.bin"),
      NodePath.join(import.meta.dirname, "../node_modules/.bin"),
      NodePath.join(checkout, "node_modules", "fixture-node-bin"),
      env[pathKey] ?? "",
    ].join(NodePath.delimiter),
    RECORDS: records,
    T3CODE_TEST_MAX_WORKERS: "6",
    ...extraEnv,
  });
  const worktrees: Array<string> = [];
  return {
    root,
    source,
    capabilities,
    git,
    write,
    commit(message: string) {
      git("add", ".");
      git("commit", "-m", message);
    },
    // A linked worktree with its own install, as two checkouts each run `vp i`.
    checkout(files: Array<string>) {
      const checkout = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks retry ")),
      );
      worktrees.push(checkout);
      git("worktree", "add", "--detach", checkout, "HEAD");
      for (const file of ["node_modules", ...files]) {
        NodeFS.cpSync(NodePath.join(root, file), NodePath.join(checkout, file), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
      const modules = NodePath.join(checkout, "node_modules");
      const store = (name: string) => NodePath.join(modules, ".pnpm", name, "node_modules");
      const vitePlus = NodeFS.realpathSync(
        NodePath.join(import.meta.dirname, "node_modules/vite-plus"),
      );
      const copies = new Map([
        ["vite-plus", vitePlus],
        ["vitest", NodeFS.realpathSync(NodePath.join(NodePath.dirname(vitePlus), "vitest"))],
      ]);
      for (const [name, shared] of copies) {
        NodeFS.cpSync(shared, NodePath.join(store(name), name), {
          recursive: true,
          verbatimSymlinks: true,
        });
        const dependencies = NodePath.dirname(shared);
        for (const entry of NodeFS.readdirSync(dependencies)) {
          for (const dependency of entry.startsWith("@")
            ? NodeFS.readdirSync(NodePath.join(dependencies, entry)).map(
                (scoped) => `${entry}/${scoped}`,
              )
            : [entry]) {
            if (dependency === name) continue;
            const link = NodePath.join(store(name), dependency);
            NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
            NodeFS.symlinkSync(
              copies.has(dependency)
                ? NodePath.join(store(dependency), dependency)
                : NodeFS.realpathSync(NodePath.join(dependencies, dependency)),
              link,
              "junction",
            );
          }
        }
      }
      NodeFS.rmSync(NodePath.join(modules, "vite-plus"));
      NodeFS.symlinkSync(
        NodePath.join(store("vite-plus"), "vite-plus"),
        NodePath.join(modules, "vite-plus"),
        "junction",
      );
      return checkout;
    },
    run(
      failStep = "",
      editStep = "",
      editFile = source,
      checkArgs: ReadonlyArray<string> = [],
      extraEnv?: Record<string, string>,
      checkout = root,
    ) {
      return NodeChildProcess.spawnSync(
        process.execPath,
        [
          "scripts/check-changed.ts",
          "HEAD",
          ...(checkArgs.includes("--concurrency") ? [] : ["--concurrency", "6"]),
          ...checkArgs,
        ],
        {
          cwd: checkout,
          encoding: "utf8",
          env: checkEnv(checkout, {
            FAIL_STEP: failStep,
            EDIT_STEP: editStep,
            EDIT_FILE: NodePath.join(root, editFile),
            ...extraEnv,
          }),
        },
      );
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      recorded().map(({ args, cwd }) => ({ args, cwd })),
    settings: (): Array<Record<string, string>> => recorded().map(({ settings }) => settings),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(records, { recursive: true, force: true });
      NodeFS.rmSync(host, { recursive: true, force: true });
      for (const checkout of worktrees) NodeFS.rmSync(checkout, { recursive: true, force: true });
    },
  };
}

// Its caller's check:changed and landing-turn settings, in either case, reach no step.
it("checks changed source paths through the Windows launcher with a fixed step budget", () => {
  using project = launcherFixture({
    check_changed_concurrency: "1",
    CHECK_CHANGED_BASE: "origin/main",
    t3_landing_turn: "turn",
    T3_LANDING_TURN_MAIN: "main",
  });
  project.write(project.source, "export const value = 2;\n");
  project.write(".repos/vendor/index.ts", "export const vendored = 1;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.some(({ args }) => args.includes(".repos/vendor/index.ts"))).toBe(false);
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
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
  for (const step of project.settings()) expect(step).toEqual({});
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  const commands = calls.map(({ args }) => args);
  expect(commands).toContainEqual(["exec", "knip", "--include", "files"]);
  expect(commands).toContainEqual(["exec", "knip", "--exports"]);
});

it("routes a manifest-only change to the repository command guard through the launcher", () => {
  using project = launcherFixture();
  const marker = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-guard-"));
  using _marker = {
    [Symbol.dispose]: () => NodeFS.rmSync(marker, { recursive: true, force: true }),
  };
  const ran = NodePath.join(marker, "ran");
  const guard = "scripts/command-arguments.test.ts";
  project.write(
    guard,
    `import { writeFileSync } from "node:fs";\nimport { it } from "vite-plus/test";\nit("passes", () => writeFileSync(${JSON.stringify(ran)}, ""));\n`,
  );
  project.write(
    "scripts/unrelated.test.ts",
    `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
  );
  project.commit("add the guard and an unrelated test");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", scripts: { verify: "node ./verify.ts" } }),
  );

  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("pass  test (1 files)");
  expect(NodeFS.existsSync(ran)).toBe(true);
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
  project.git("add", ".");
  project.git("commit", "-m", "scratch");
  project.write("scratch.ts", "export const value = 2;\n");
  project.write(
    "scratch.test.ts",
    `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
  );
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

// No import reaches app/use.test.ts, so only its name beside app/use.ts selects it.
it("runs the tests beside a file that a changed dependency patch affects", () => {
  using project = launcherFixture();
  project.write(
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\npatchedDependencies:\n  dep-a@1.0.0: patches/dep-a@1.0.0.patch\n",
  );
  project.write(
    "pnpm-lock.yaml",
    "snapshots:\n\n  dep-a@1.0.0: {}\n\n  dep-b@1.0.0:\n    dependencies:\n      dep-a: 1.0.0\n",
  );
  project.write("patches/dep-a@1.0.0.patch", "old\n");
  project.write("app/use.ts", 'import { b } from "dep-b/sub";\n');
  project.write(
    "app/use.test.ts",
    `import { it } from "vite-plus/test";\nit("passes", () => {});\n`,
  );
  project.write("app/other.ts", "export const other = 1;\n");
  project.write(
    "app/other.test.ts",
    `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
  );
  project.git("add", ".");
  project.git("commit", "-m", "patched dependency");
  project.write("patches/dep-a@1.0.0.patch", "new\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("pass  test");
});

// Only a disk that tells case apart holds a name other than the one Git records.
it.runIf(isLinuxHost)(
  "stops at a file the checked tree holds under a name the disk does not",
  () => {
    using project = launcherFixture();
    project.write("Src/old.ts", "export const old = 1;\n");
    project.git("add", ".");
    project.git("commit", "-m", "source");
    project.git("config", "core.ignoreCase", "true");
    project.write(
      "src/new.test.ts",
      `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
    );
    const result = project.run();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain("the checked tree holds Src/new.test.ts");
  },
);

it("runs the tests the checkout holds when the index names others", () => {
  using project = launcherFixture();
  const passing = `import { it } from "vite-plus/test";\nit("passes", () => {});\n`;
  project.write("old/a.test.ts", passing);
  project.write(".github/scripts/base.cjs", "module.exports = 1;\n");
  project.write(".github/scripts/user.cjs", 'module.exports = require("./base.cjs");\n');
  project.write(".github/scripts/user.test.cjs", 'require("./user.cjs");\n');
  project.git("add", ".");
  project.git("commit", "-m", "tests");
  // A file replaces a tracked directory, and the test beside an importer is deleted.
  NodeFS.rmSync(NodePath.join(project.root, "old"), { recursive: true });
  project.write("old", "a file\n");
  NodeFS.rmSync(NodePath.join(project.root, ".github/scripts/user.test.cjs"));
  project.write(".github/scripts/base.cjs", "module.exports = 2;\n");
  project.write("fixture.test.ts", passing);
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("pass  test");
  expect(project.calls().filter(({ args }) => args.includes("--test"))).toEqual([]);
});

it("fails a run whose files changed while its checks ran", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "lint");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("pass  lint");
  expect(result.stdout).toContain("files changed while the checks ran");
  expect(result.stdout).toContain(`M\t${project.source}`);
});

it("records no push pass for a tree that changed before a cached result", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n// edited\n");
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "install");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("files changed while the checks ran");
  expect(result.stdout).toContain(`M\t${project.source}`);
  // The second run matched the cached pass, so it ran no lint of its own.
  expect(project.calls().filter(({ args }) => args[0] === "lint")).toHaveLength(1);
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
  expect(result.stdout).toContain("A\tpackages/example/added.ts");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("reruns a stable group after an empty commit", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { it, expect } from "vite-plus/test";
    import {execFileSync} from "node:child_process";
    it("reads the commit subject", () => expect(execFileSync("git", ["log", "-1", "--format=%s"], {encoding:"utf8"}).trim()).toBe("fixture"));`,
  );
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.git("commit", "--allow-empty", "-m", "different");
  const next = project.run();
  expect(next.status, next.stdout + next.stderr).toBe(1);
  expect(next.stdout).toContain("FAIL  test");
});

it.each(["USER", "T3_TEST_NU_PATH", "PLAYWRIGHT_CACHE_FIXTURE", "TZ", "TMPDIR"])(
  "delivers and fingerprints %s",
  (name) => {
    using project = launcherFixture();
    // Folders outside the checkout, because the run writes its own temporary files to TMPDIR.
    const [first, changed] = [NodePath.dirname(project.capabilities), NodeOS.tmpdir()];
    project.write(
      "fixture.test.ts",
      `import { it, expect } from "vite-plus/test";
    it("reads the test environment", () => expect(process.env[${JSON.stringify(name)}]).toBe(${JSON.stringify(first)}));`,
    );
    const run = (value: string) => project.run("", "", project.source, [], { [name]: value });
    const firstRun = run(first);
    expect(firstRun.status, firstRun.stdout + firstRun.stderr).toBe(0);
    const next = run(changed);
    expect(next.status, next.stdout + next.stderr).toBe(1);
    expect(next.stdout).toContain("FAIL  test");
  },
);

it("reuses passes in another worktree with the same inputs and tracked environment, at another worker count", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { execSync } from "node:child_process";
     import { readFileSync } from "node:fs";
     import { isAbsolute } from "node:path";
     import { it, expect } from "vite-plus/test";
     it("reads a fixture in a clean environment", () => {
       expect(readFileSync("input.txt", "utf8")).toBe("pass");
       expect(process.env.INVOCATION_ID).toBeUndefined();
       expect(process.env.PLAYWRIGHT_CACHE_FIXTURE).toBe("present");
       expect(isAbsolute(process.env.PWD ?? "")).toBe(true);
       expect(execSync("fixture-tool", { cwd: "packages", encoding: "utf8" }).trim()).toBe("tool");
       expect(process.env.HOME || process.env.USERPROFILE).toBeTruthy();
     });
    `,
  );
  project.write("input.txt", "pass");
  project.write("second.test.ts", `import { it } from "vite-plus/test"; it("passes", () => {});`);
  project.write("node_modules/.bin/fixture-tool", "#!/bin/sh\necho tool\n");
  NodeFS.chmodSync(NodePath.join(project.root, "node_modules/.bin/fixture-tool"), 0o755);
  project.write("node_modules/.bin/fixture-tool.cmd", "@echo tool\r\n");

  const passthrough = { INVOCATION_ID: "first", PLAYWRIGHT_CACHE_FIXTURE: "present", TZ: "UTC" };
  const files = ["fixture.test.ts", "second.test.ts", "input.txt"];
  project.write(
    "node_modules/.modules.yaml",
    JSON.stringify({ layoutVersion: 5, prunedAt: "first" }),
  );
  const firstCheckout = project.checkout(files);
  // Two workers here and one in the retry.
  const first = project.run(
    "lint",
    "",
    project.source,
    ["--concurrency", "16"],
    passthrough,
    firstCheckout,
  );
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("pass  test (2 files)");

  project.write(
    "node_modules/.modules.yaml",
    JSON.stringify({ layoutVersion: 5, prunedAt: "second" }),
  );
  const retryCheckout = project.checkout(files);
  const repeat = project.run(
    "lint",
    "",
    project.source,
    ["--concurrency", "1"],
    { ...passthrough, INVOCATION_ID: "retry" },
    retryCheckout,
  );
  expect(repeat.status, repeat.stdout + repeat.stderr).toBe(1);
  expect(repeat.stdout).toContain("pass  test (2 files)");
  expect(repeat.stdout).toContain("cache hit, replaying");
  expect(NodeFS.readdirSync(NodePath.join(project.root, ".git/t3-check-changed/tests"))).toEqual([
    project.git("rev-parse", "HEAD").toString().trim(),
  ]);
});

it("skips a test by the host capabilities the run probes, which key its cached result", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { it } from "vite-plus/test";
    import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
    it.skipIf(!symlinksSupported)("needs symlinks", () => { throw new Error("ran with symlinks"); });`,
  );
  // The run's probe finds no symlinks. The test skips by that even where its own probe, or a value
  // an outer run passed down, would find them, so the skip is cached under the right key.
  NodeFS.writeFileSync(
    project.capabilities,
    JSON.stringify({ symlinks: false, ipv6Loopback: true }),
  );
  const first = project.run("", "", undefined, [], {
    T3_TEST_HOST_CAPABILITIES: JSON.stringify({ symlinks: true, ipv6Loopback: true }),
  });
  expect(first.status, first.stdout + first.stderr).toBe(0);
  NodeFS.writeFileSync(
    project.capabilities,
    JSON.stringify({ symlinks: true, ipv6Loopback: true }),
  );
  // A malformed value an outer run passed down never reaches the run's own probe either.
  const next = project.run("", "", undefined, [], { T3_TEST_HOST_CAPABILITIES: "invalid" });
  expect(next.status, next.stdout + next.stderr).toBe(1);
  expect(next.stdout).toContain("ran with symlinks");
});

// workingTree runs Git with this process's environment, which a hook can point at another repository.
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

// Where core.fileMode is false, Git sees no mode change, so only the checkout state reruns the test.
it.skipIf(isWindowsHost)(
  "reruns a test after a tracked file it runs changes mode where Git ignores modes",
  () => {
    using project = launcherFixture();
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

// The push gate records the tree a commit of the checkout would hold under Git's own settings.
it("checks a test that a negated ignore rule keeps where Git ignores case", () => {
  using project = launcherFixture();
  const ignore = NodePath.join(project.root, ".gitignore");
  project.write(
    ".gitignore",
    `${NodeFS.readFileSync(ignore, "utf8")}keep*.test.ts\n!Keep.test.ts\n`,
  );
  project.git("add", ".gitignore");
  project.git("commit", "-m", "ignore");
  project.git("config", "core.ignoreCase", "true");
  project.write(
    "keep.test.ts",
    `import { it } from "vite-plus/test";\nit("fails", () => {\n  throw new Error("ran");\n});\n`,
  );
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("FAIL  test");
});

it.skipIf(isWindowsHost)("replays a test after an executable it does not read changes", () => {
  using project = launcherFixture();
  for (const name of ["a.sh", "b.sh"]) {
    project.write(name, "#!/bin/sh\n");
    NodeFS.chmodSync(NodePath.join(project.root, name), 0o755);
  }
  project.git("add", "a.sh", "b.sh");
  project.git("commit", "-m", "tools");
  project.write(
    "fixture.test.ts",
    `import { it, expect } from "vite-plus/test";
    it("passes", () => expect(1).toBe(1));`,
  );
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.write("b.sh", "#!/bin/sh\necho changed\n");
  const next = project.run();
  expect(next.status, next.stdout + next.stderr).toBe(0);
  expect(next.stdout).toContain("cache hit, replaying");
});

it("fingerprints environment reads reported by the cooperative Vite+ client, without its cache path", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { createRequire } from "node:module";
    import { it, expect } from "vite-plus/test";
    it("reads a tool input", () => {
      expect(process.env.COOPERATIVE_FIXTURE).toBeUndefined();
      expect(process.env.VITE_CACHE_PATH).toBeUndefined();
      const runner = createRequire(import.meta.url)(process.env.VP_RUN_NODE_CLIENT_PATH).load();
      expect(runner.getEnv("COOPERATIVE_FIXTURE")).toBe("first");
    });`,
  );
  const run = (value: string) =>
    project.run("", "", project.source, [], { COOPERATIVE_FIXTURE: value });
  const first = run("first");
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const changed = run("changed");
  expect(changed.status, changed.stdout + changed.stderr).toBe(1);
  expect(changed.stdout).toContain("FAIL  test");
});

it("runs tests without the user's global Git config, as CI does", () => {
  using project = launcherFixture();
  const home = NodePath.dirname(project.capabilities);
  NodeFS.writeFileSync(NodePath.join(home, ".gitconfig"), "[user]\n\tname = Leaked\n");
  project.write(
    "fixture.test.ts",
    `import { spawnSync } from "node:child_process";
    import { it, expect } from "vite-plus/test";
    it("reads no global Git config", () => {
      const name = spawnSync("git", ["config", "--global", "user.name"], { encoding: "utf8" });
      expect(name.stdout).toBe("");
    });`,
  );
  const run = project.run("", "", project.source, [], { HOME: home });
  expect(run.status, run.stdout + run.stderr).toBe(0);
});

it("invalidates a replay when a file read by the test changes", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { readFileSync } from "node:fs";
    import { it, expect } from "vite-plus/test";
    it("reads a fixture", () => expect(readFileSync("input.txt", "utf8")).toBe("pass"));`,
  );
  project.write("input.txt", "pass");
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.write("input.txt", "changed");
  const changed = project.run();
  expect(changed.status, changed.stdout + changed.stderr).toBe(1);
  expect(changed.stdout).toContain("FAIL  test (1 files)");
  expect(changed.stdout).toContain("expected 'changed' to be 'pass'");
});

it("resumes completed test tasks after another group fails", () => {
  using project = launcherFixture();
  const testImport = `import { it } from "vite-plus/test";`;
  project.write("a-quick.test.ts", `${testImport} it("quick", () => {});`);
  const failing = "packages/example/z-failing.test.ts";
  NodeFS.mkdirSync(NodePath.join(project.root, "packages/example/node_modules"));
  project.write(
    failing,
    `${testImport} it("fails", () => { throw new Error("fixture failure"); });`,
  );
  const args = ["--concurrency", "1"];
  const first = project.run("", "", project.source, args);
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("a-quick.test.ts (1 test)");
  expect(first.stdout).toContain("fixture failure");
  expect(first.stdout).toContain("FAIL  test (2 files)");

  project.write(failing, `${testImport} it("passes", () => {});`);
  const repeat = project.run("", "", project.source, args);
  expect(repeat.status, repeat.stdout + repeat.stderr).toBe(0);
  expect(repeat.stdout).toMatch(/a-quick\.test\.ts.*cache hit, replaying/);
  expect(repeat.stdout).toContain("z-failing.test.ts (1 test)");
});

it("keeps test results when a concurrent check writes generated inputs", () => {
  using project = launcherFixture();
  const generated = "packages/example/.generated/types.d.ts";
  project.write(generated, "export {};\n");
  project.write(
    "fixture.test.ts",
    `import { it } from "vite-plus/test";
     it("passes", () => {});`,
  );
  const first = project.run("lint", "test-cache", generated);
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("pass  test (1 files)");

  const repeat = project.run("lint");
  expect(repeat.status, repeat.stdout + repeat.stderr).toBe(1);
  expect(repeat.stdout).toContain("cache hit, replaying");
});

it("discards test results when an ignored runtime input changes", () => {
  using project = launcherFixture();
  project.write(".env.local", "MODE=test\n");
  project.write(
    "fixture.test.ts",
    `import { readFileSync } from "node:fs";
     import { it, expect } from "vite-plus/test";
     it("reads an ignored environment file", () => {
       expect(readFileSync(".env.local", "utf8")).toContain("MODE=test");
     });`,
  );

  const first = project.run("", "test-cache", ".env.local");
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("FAIL  test (1 files)");
  const repeat = project.run();
  expect(repeat.status, repeat.stdout + repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("pass  test (1 files)");
  expect(repeat.stdout).not.toContain("cache hit, replaying");
  expect(summaryOf(first.stdout)).toContain("test results discarded");
  expect(summaryOf(first.stdout)).toContain(".env.local (ignored input)");
});

// knip and a mobile test load Metro's config while the tests run, and loading it writes the generated
// modules, ignored inputs of the tests, which a new checkout does not hold yet.
it("passes the tests of a new checkout while a config that writes their inputs loads", () => {
  using project = launcherFixture();
  const config = "apps/mobile/metro.config.js";
  project.write("apps/mobile/package.json", '{ "type": "commonjs" }\n');
  project.write(
    config,
    `const fs = require("node:fs");
    const path = require("node:path");
    const file = path.join(__dirname, ".generated", "stream", "index.js");
    const contents = "module.exports = 'stream';\\n";
    module.exports = (async () => {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) return {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      return {};
    })();`,
  );
  project.commit("mobile config");
  project.write(
    "fixture.test.ts",
    `import { it } from "vite-plus/test";\nit("passes", () => {});\n`,
  );

  const result = project.run("", "", project.source, [], { TEST_STEP_LOADS: config });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("pass  test (1 files)");
});

it.skipIf(isWindowsHost)(
  "discards test results when an ignored executable changes mode during the test step",
  () => {
    using project = launcherFixture();
    const tool = ".env.tool";
    project.write(tool, "#!/bin/sh\n");
    NodeFS.chmodSync(NodePath.join(project.root, tool), 0o755);
    project.write(
      "fixture.test.ts",
      `import { chmodSync } from "node:fs";
       import { it } from "vite-plus/test";
       it("changes a tool's mode", () => chmodSync(${JSON.stringify(tool)}, 0o644));`,
    );

    const result = project.run();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(summaryOf(result.stdout)).toContain("the checkout's file modes or untracked names");
  },
);

it("passes kept provider variables to every test", () => {
  using project = launcherFixture();
  project.write(
    "fixture.test.ts",
    `import { it, expect } from "vite-plus/test";
     it("reads a provider variable", () => expect(process.env.ANTHROPIC_FIXTURE).toBe("kept"));`,
  );
  const result = project.run("", "", project.source, [], {
    T3CODE_TEST_KEEP_PROVIDER_ENV: "1",
    ANTHROPIC_FIXTURE: "kept",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("discards test results when HEAD moves to a different commit with the same tree", () => {
  using project = launcherFixture();
  project.write("fixture.test.ts", `import { it } from "vite-plus/test"; it("passes", () => {});`);

  const first = project.run("", "", project.source, [], { MOVE_HEAD: "1" });
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(first.stdout).toContain("FAIL  test (1 files)");
  const repeat = project.run();
  expect(repeat.status, repeat.stdout + repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("pass  test (1 files)");
  expect(repeat.stdout).not.toContain("cache hit, replaying");
  expect(summaryOf(first.stdout)).toContain("HEAD, which moved from");
});

it("reports failures from every selected test group", () => {
  using project = launcherFixture();
  for (const [file, name] of [
    ["a.test.ts", "root failure"],
    ["packages/example/b.test.ts", "package failure"],
  ] as const) {
    project.write(
      file,
      `import { it } from "vite-plus/test";
       it(${JSON.stringify(name)}, () => { throw new Error(${JSON.stringify(name)}); });`,
    );
  }
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("FAIL  test (2 files)");
  expect(result.stdout).toContain("Error: root failure");
  expect(result.stdout).toContain("Error: package failure");
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

it("fails a reused pass when its test step rewrites a generated file", () => {
  using project = launcherFixture();
  const generated = "packages/example/.generated/types.d.ts";
  project.write(project.source, "export const value = 2;\n");
  project.write(generated, "export {};\n");
  project.write(
    "fixture.test.ts",
    `import { it, expect } from "vite-plus/test";
    it("passes", () => expect(1).toBe(1));`,
  );
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const next = project.run("", "test-cache", generated);
  expect(next.status, next.stdout + next.stderr).toBe(1);
  expect(next.stdout).toContain(
    "generated files changed while the previous run's pass was checked",
  );
  expect(project.calls().filter(({ args }) => args[0] === "lint")).toHaveLength(1);
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
