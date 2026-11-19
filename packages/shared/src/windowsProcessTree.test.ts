// @effect-diagnostics nodeBuiltinImport:off -- the walk runs in a real PowerShell.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { leaderLeavingChild } from "./testing/leftoverChild.ts";
import { isWindowsHost } from "./testing/hostPlatform.ts";
import {
  WINDOWS_PROCESS_TREE_FUNCTIONS,
  windowsStopTreeArgs,
  endingWindowsTrees,
  type WindowsTreeEnding,
  withoutWindowsTreeEnding,
} from "./windowsProcessTree.ts";

it.effect("endingWindowsTrees refuses a pipeline, whose earlier processes it cannot reach", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() => Effect.die("a refused pipeline never spawns"));
    const pipeline = ChildProcess.make("a").pipe(ChildProcess.pipeTo(ChildProcess.make("b")));

    const error = yield* Effect.flip(
      Effect.scoped(endingWindowsTrees(spawner, "win32").spawn(pipeline)),
    );

    assert.equal(error.reason._tag, "BadArgument");
  }),
);

/** A Windows spawner whose process has exited unless `running`; it records each kill and walk. */
const fakeWindowsSpawner = (options: {
  readonly running: boolean;
  readonly output: "ends" | "held";
}) => {
  const events: Array<"kill" | "walk"> = [];
  let running = options.running;
  const handle = (output: Stream.Stream<Uint8Array>) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.sync(() => running),
      kill: () =>
        Effect.sync(() => {
          running = false;
          events.push("kill");
        }),
      stdin: Sink.drain,
      stdout: output,
      stderr: Stream.empty,
      all: output,
      getInputFd: () => Sink.drain,
      getOutputFd: () => output,
      unref: Effect.succeed(Effect.void),
    });
  const byte = Stream.make(new Uint8Array([1]));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand" && command.command === "powershell.exe") {
        events.push("walk");
        return handle(Stream.empty);
      }
      // What a leader left running holds a pipe it inherited open.
      return handle(options.output === "ends" ? byte : Stream.concat(byte, Stream.never));
    }),
  );
  return { events, spawner };
};

type Use = (
  handle: ChildProcessSpawner.ChildProcessHandle,
) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>;
const readToEnd: Use = (handle) => Stream.runDrain(handle.all);
const readNothing: Use = () => Effect.void;

describe("endingWindowsTrees stops a Windows tree", () => {
  it.effect.each<
    [string, WindowsTreeEnding, { running: boolean; output: "ends" | "held" }, Use, number]
  >([
    [
      "never, leftBehind, for an exited process whose output was read to its end",
      "leftBehind",
      { running: false, output: "ends" },
      readToEnd,
      0,
    ],
    [
      "never, leftBehind, for an exited process whose output nobody read",
      "leftBehind",
      { running: false, output: "held" },
      readNothing,
      0,
    ],
    [
      "once, leftBehind, for an exited process with a read of its output not ended",
      "leftBehind",
      { running: false, output: "held" },
      (handle) => Stream.runHead(handle.stdout),
      1,
    ],
    [
      "once, leftBehind, when a reader of its output is interrupted at the scope's close",
      "leftBehind",
      { running: false, output: "held" },
      (handle) =>
        Effect.gen(function* () {
          const reading = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            Stream.runDrain(
              Stream.tap(handle.getOutputFd(3), () => Deferred.succeed(reading, undefined)),
            ),
          );
          yield* Deferred.await(reading);
        }),
      1,
    ],
    [
      "once, leftBehind, for a process killed after it exited, with the scope's close",
      "leftBehind",
      { running: false, output: "ends" },
      (handle) => handle.kill(),
      1,
    ],
    [
      "once, after killing it, leftBehind, for a process still running at the scope's close",
      "leftBehind",
      { running: true, output: "ends" },
      readToEnd,
      1,
    ],
    [
      "once, always, for an exited process whose output was read to its end",
      "always",
      { running: false, output: "ends" },
      readToEnd,
      1,
    ],
    [
      "never, always, for a process unreferenced at the scope's close",
      "always",
      { running: false, output: "ends" },
      (handle) => handle.unref,
      0,
    ],
  ])("%s", ([, ending, process, use, walks]) =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner(process);

      yield* Effect.scoped(
        Effect.flatMap(
          endingWindowsTrees(fake.spawner, "win32", ending).spawn(ChildProcess.make("leader")),
          use,
        ),
      );

      assert.deepEqual(fake.events.filter((event) => event === "walk").length, walks);
      if (process.running) assert.deepEqual(fake.events, ["kill", "walk"]);
    }),
  );

  it.effect("once, leftBehind, when its scope closes by interruption", () =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner({ running: false, output: "ends" });

      yield* Effect.exit(
        Effect.scoped(
          Effect.andThen(
            endingWindowsTrees(fake.spawner, "win32", "leftBehind").spawn(
              ChildProcess.make("leader"),
            ),
            Effect.interrupt,
          ),
        ),
      );

      assert.deepEqual(fake.events, ["walk"]);
    }),
  );

  it.effect("by the outer policy alone when wrapped twice, through the spawner beneath both", () =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner({ running: false, output: "ends" });
      const outer = endingWindowsTrees(
        endingWindowsTrees(fake.spawner, "win32"),
        "win32",
        "leftBehind",
      );

      yield* Effect.scoped(Effect.flatMap(outer.spawn(ChildProcess.make("leader")), readToEnd));

      assert.deepEqual(fake.events, []);
      assert.strictEqual(withoutWindowsTreeEnding(outer), fake.spawner);
    }),
  );
});

// A process that ended leaves what it started running under a dead parent pid.
describe.runIf(isWindowsHost)("a Windows process tree", () => {
  // Times are seconds from $t. The tree's root is 10, and nothing in it started before -2.
  it.each([
    [
      // 40 and 50 name 20 and 10 as their parent but are older, so an earlier holder of that pid
      // started them; 60 is older than the tree.
      "the root and, at every level, what started after the parent it names",
      "(P 10 1 0), (P 20 10 1), (P 30 20 2), (P 40 20 0.5), (P 50 10 -1), (P 60 10 -3)",
      ["10", "20", "30"],
    ],
    [
      "what the root started, after the root exited",
      "(P 20 10 1), (P 30 20 2), (P 40 10 -3)",
      ["20", "30"],
    ],
    [
      // 10 now names another process, created at 5; 30 is what that process started.
      "what the root started before another process took its pid",
      "(P 10 1 5), (P 20 10 1), (P 30 10 6)",
      ["20"],
    ],
  ])("holds %s", (_, rows, expected) => {
    const script = [
      WINDOWS_PROCESS_TREE_FUNCTIONS,
      "$t = [DateTime]::UtcNow",
      "function P($id, $parent, $seconds) { [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; CreationDate = $t.AddSeconds($seconds) } }",
      `$all = @(${rows})`,
      "(Get-T3ProcessTree $all 10 (Ms $t.AddSeconds(-2)) (Ms $t) (Ms $t)).Keys | Sort-Object",
    ].join("\n");
    const tree = NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    );
    assert.deepEqual(tree.trim().split(/\r?\n/), expected);
  });

  it("refuses an unknown identity before selecting a live root or its descendants", () => {
    const args = windowsStopTreeArgs({ pid: 10, since: 0, created: null });
    const mock = [
      "function Get-CimInstance { @([pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; CreationDate = [DateTime]::UtcNow }, [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10; CreationDate = [DateTime]::UtcNow.AddSeconds(-10) }) }",
      "function Stop-Process { Write-Output 'unsafe stop' }",
    ].join("\n");
    const tree = NodeChildProcess.execFileSync(
      "powershell.exe",
      [...args.slice(0, -1), `${mock}\ntry { ${args.at(-1)} } catch { $_.Exception.Message }`],
      { encoding: "utf8" },
    );
    assert.equal(tree.trim(), "Cannot stop a live process without its creation time.");
  });

  it("pins each selected process before checking its creation time and stopping it", () => {
    const script = [
      WINDOWS_PROCESS_TREE_FUNCTIONS,
      "$t = [DateTime]::UtcNow; $script:passes = 0",
      "function Get-CimInstance { if ($script:passes++ -eq 0) { @([pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; CreationDate = $t }, [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10; CreationDate = $t.AddSeconds(1) }) } }",
      "function Get-Process($Id) {",
      "  $p = [pscustomobject]@{ Id = $Id; Pinned = $false; StartTime = $(if ($Id -eq 10) { $t } else { $t.AddMilliseconds(1500) }); HasExited = $false }",
      "  $p | Add-Member ScriptProperty Handle { $this.Pinned = $true; return 1 }",
      "  $p | Add-Member ScriptMethod Kill { if (-not $this.Pinned) { throw 'unpinned stop' }; Write-Output $this.Id }",
      "  $p | Add-Member ScriptMethod WaitForExit {}",
      "  $p | Add-Member ScriptMethod Dispose {}",
      "  return $p",
      "}",
      "function Stop-Process { Write-Output 'unsafe bare PID stop' }",
      "Stop-T3ProcessTree 10 (Ms $t) (Ms $t) (Ms $t)",
      "$script:passes = 0",
      "function Get-CimInstance { if ($script:passes++ -eq 0) { [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; CreationDate = $t.AddMilliseconds(500) } } }",
      "Stop-T3ProcessTree 10 (Ms $t) (Ms $t) (Ms $t)",
    ].join("\n");
    const stopped = NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    );
    assert.equal(stopped.trim(), "10");
  });

  const spawnEndingTree = (command: ChildProcess.Command, ending?: WindowsTreeEnding) =>
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      endingWindowsTrees(spawner, "win32", ending).spawn(command),
    );

  it.live("ends what its leader left running when its scope closes after the leader exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leader = yield* spawnEndingTree(leftover.command);
          yield* leftover.started;
          assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends what its leader left running when killed after the leader exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild();
      const leader = yield* spawnEndingTree(leftover.command);
      yield* leftover.started;
      assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));

      yield* leader.kill();

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leftBehind ends what its leader left holding its output when the scope closes", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ holdsOutput: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leader = yield* spawnEndingTree(leftover.command, "leftBehind");
          yield* Effect.forkScoped(Stream.runDrain(leader.stdout));
          yield* leftover.started;
          assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leftBehind ends what its leader left running when the scope is interrupted", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild();
      yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const leader = yield* spawnEndingTree(leftover.command, "leftBehind");
            yield* leftover.started;
            assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
            return yield* Effect.interrupt;
          }),
        ),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
