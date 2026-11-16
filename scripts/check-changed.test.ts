// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { probeProcess } from "@t3tools/shared/processProbe";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  comparisonBase,
  defaultConcurrency,
  docReaderTests,
  GIT_TIMEOUT,
  gitLines,
  ignoredInputs,
  runSteps,
  splitTests,
  type Step,
  testsReaching,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

vi.mock("node:fs/promises", { spy: true });

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
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
        const {
          exitCode,
          stdout = "",
          stderr = "",
        } = reply(ChildProcess.isStandardCommand(command) ? command.args : []);
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
      // The fake git has started the holder and recorded its id once it has exited.
      yield* Deferred.await(gitExited);
      yield* TestClock.adjust(GIT_TIMEOUT);
      assert.strictEqual(
        yield* Fiber.join(listing),
        `check:changed: git ls-files did not finish within ${GIT_TIMEOUT}`,
      );
      // Still open, since the holder keeps their other ends, but no longer holding the event loop.
      assert.strictEqual(openPipes(), pipesBefore);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => removeHolderFixture(dir))),
    );
  });

  // An ACP terminal reads its process's output after the scope that owns the process has closed,
  // until the output ends, so the patch must not cut off what a process it started writes later.
  it.effect("keeps a process's output for its reader after the process's scope closes", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-late-output-"));
    const go = NodePath.join(dir, "go");
    // The holder writes once the test creates go, and then ends, which ends the output.
    const starter = writeHolderStarter(
      dir,
      `const fs = require("node:fs"); const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(poll); process.stdout.write("late"); } }, 20);`,
      "early ",
    );
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.make();
      const handle = yield* spawner
        .spawn(ChildProcess.make(process.execPath, [starter]))
        .pipe(Effect.provideService(Scope.Scope, scope));
      const output = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkDetach,
      );
      yield* handle.exitCode;
      yield* Scope.close(scope, Exit.void);
      NodeFS.writeFileSync(go, "");
      assert.strictEqual(yield* Fiber.join(output), "early late");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => removeHolderFixture(dir))),
    );
  });

  // Exit 1 (no shared history) and 128 (no such ref) rule a candidate out; rev-list never runs for it.
  it.effect.each([
    { code: 1, upstream: 0, outcome: "compares against upstream/main" },
    { code: 128, upstream: 0, outcome: "compares against upstream/main" },
    { code: 1, upstream: 128, outcome: "fails once no candidate is left" },
  ])("merge-base exit $code rules origin/main out and $outcome", ({ code, upstream }) =>
    Effect.gen(function* () {
      const counted: Array<string> = [];
      const comparing = comparisonBase("/repo", Option.none()).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeGit((args) => {
            if (args.includes("remote")) {
              return { exitCode: exited(0), stdout: "origin\nupstream\n" };
            }
            if (args.includes("merge-base")) {
              return args.at(-1) === "refs/remotes/origin/main"
                ? { exitCode: exited(code) }
                : { exitCode: exited(upstream), stdout: upstream === 0 ? "c0ffee\n" : "" };
            }
            counted.push(args.at(-1) ?? "");
            return { exitCode: exited(0), stdout: "2\n" };
          }),
        ),
      );
      if (upstream === 0) {
        assert.deepStrictEqual(yield* comparing, {
          ref: "upstream/main",
          base: "c0ffee",
          ahead: 2,
        });
        assert.deepStrictEqual(counted, ["c0ffee..HEAD"]);
      } else {
        assert.strictEqual(
          yield* Effect.flip(comparing),
          "check:changed: no merge base with origin/main, upstream/main. Run git fetch or pass a ref.",
        );
        assert.deepStrictEqual(counted, []);
      }
    }),
  );

  // With no ref, upstream/main merges fine, so a comparison that read the stuck call as a
  // missing ref would pass instead of failing.
  it.effect.each([
    { against: "an explicit ref", ref: Option.some("origin/main"), rev: "origin/main" },
    { against: "the closest remote main", ref: Option.none(), rev: "refs/remotes/origin/main" },
  ])("fails when merge-base against $against runs past its time limit", ({ ref, rev }) =>
    Effect.gen(function* () {
      const stuck = yield* Deferred.make<void>();
      const comparing = yield* comparisonBase("/repo", ref).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeGit((args) => {
            if (args.includes("remote")) {
              return { exitCode: exited(0), stdout: "origin\nupstream\n" };
            }
            if (args.at(-1) === rev) {
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
        `check:changed: git merge-base HEAD ${rev} did not finish within ${GIT_TIMEOUT}`,
      );
    }),
  );

  // On Windows the spawner ends the tree with taskkill, which a process cannot ignore.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills a git that ignores SIGTERM once its time limit has passed",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stuck-git-"));
      // The fake git writes to the FIFO once it ignores SIGTERM, so the clock moves only after that.
      const fifo = NodePath.join(dir, "started");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      NodeFS.writeFileSync(
        NodePath.join(dir, "git"),
        `#!/bin/sh\ntrap '' TERM\nexec 3>'${fifo}'\necho >&3\nwhile :; do sleep 1; done\n`,
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
            if (leader) killLeftover(-leader);
            NodeFS.rmSync(dir, { recursive: true, force: true });
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

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files. git documents /dev/null
// as an empty config and reads it on Windows too; Git for Windows 2.43 cannot
// open os.devNull (\\.\nul).
const fixtureConfig = {
  "core.excludesFile": "/dev/null",
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
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

// Kills a process, or with a negative id a process group, that a test may have left running.
const killLeftover = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // ESRCH: it is already gone.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

// The stdio pipes that keep this process's event loop running. A stdin pipe, which Node destroys
// once its process exits, counts until it has closed on a later turn of the loop, so a test that
// counts them starts its processes without one.
const openPipes = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === "PipeWrap").length;

// Writes dir/starter.mjs: it starts `holder`, code for node -e, as a process that inherits its
// stdio and outlives it, records the holder's id in dir/holder, writes `output` and exits.
const writeHolderStarter = (dir: string, holder: string, output = "") => {
  const starter = NodePath.join(dir, "starter.mjs");
  NodeFS.writeFileSync(
    starter,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      // Outside dir, which Windows cannot delete while a running process works in it.
      `const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { cwd: tmpdir(), stdio: "inherit", detached: true, windowsHide: true });`,
      `writeFileSync(${JSON.stringify(NodePath.join(dir, "holder"))}, String(holder.pid));`,
      "holder.unref();",
      `process.stdout.write(${JSON.stringify(output)});`,
    ].join("\n"),
  );
  return starter;
};

// Kills the holder a writeHolderStarter script started, if it got that far, and removes dir.
const removeHolderFixture = (dir: string) => {
  const holderPid = NodePath.join(dir, "holder");
  if (NodeFS.existsSync(holderPid)) killLeftover(Number(NodeFS.readFileSync(holderPid, "utf8")));
  NodeFS.rmSync(dir, { recursive: true, force: true });
};

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
  try {
    const write = (file: string, content: string) => writeUnder(root, file, content);
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
          if (ChildProcess.isStandardCommand(command)) {
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

// The inputs `ignoredInputs` finds in `root` when Git's listing is `entries`.
const ignoredInputsListed = (root: string, entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* ignoredInputs(root).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          spawner.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              `process.stdout.write(${JSON.stringify(entries.map((entry) => `${entry}\0`).join(""))})`,
            ]),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

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
  const write = (file: string, content: string) => writeUnder(root, file, content);
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
    ".github/scripts/check-node-runtime.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
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
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
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
    run(failStep = "", editStep = "", editFile = source) {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
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

it("fails a run whose files changed while its checks ran", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("", "lint");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("pass  lint");
  expect(result.stdout).toContain("files changed while the checks ran");
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
