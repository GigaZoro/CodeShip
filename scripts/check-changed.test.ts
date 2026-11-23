// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";

import {
  argumentBatches,
  comparisonBase,
  defaultConcurrency,
  dependencyChangeFiles,
  docReaderTests,
  gitLines,
  runSteps,
  splitTests,
  suiteSteps,
  testStepTimeoutSeconds,
  type Step,
  testsReaching,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

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
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
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

function launcherFixture() {
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
      scripts: { "knip:check": "knip --include files" },
    }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import { randomUUID } from 'node:crypto';
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    // Windows gives a finished step's pid to the next process at once, so a pid-named record could be replaced.
    fs.writeFileSync(path.join(process.env.RECORDS, randomUUID() + '.json'), JSON.stringify({ args, cwd: process.cwd() }), { flag: 'wx' });
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    if (args[0] === process.env.EDIT_STEP) fs.appendFileSync(process.env.EDIT_FILE, "// edited\\n");
    const failing = process.env.FAIL_STEP !== '' && args.join(' ').startsWith(process.env.FAIL_STEP);
    process.exit(failing ? 23 : 0);
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
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
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
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    commit(message: string) {
      git("add", ".");
      git("commit", "-m", message);
    },
    run(failStep = "", editStep = "", editFile = source) {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
          [pathKey]: [nodeBin, env[pathKey]].filter(Boolean).join(NodePath.delimiter),
          TEMP: NodeOS.tmpdir(),
          RECORDS: records,
          FAIL_STEP: failStep,
          EDIT_STEP: editStep,
          EDIT_FILE: NodePath.join(root, editFile),
        },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
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

it("fails a run whose files changed while its checks ran", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "lint");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("pass  lint");
  expect(result.stdout).toContain("files changed while the checks ran");
});

it("records no push pass for a tree that changed before a cached result", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n// edited\n");
  const first = project.run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "install");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("Nothing changed since the last passing run");
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
  expect(result.stdout).not.toContain("Nothing changed since the last passing run");
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
