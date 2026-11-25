// @effect-diagnostics nodeBuiltinImport:off -- the walk runs in a real PowerShell.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { isProcessAlive } from "./processProbe.ts";
import { leaderLeavingChild } from "./testing/leftoverChild.ts";
import { isWindowsHost } from "./testing/hostPlatform.ts";
import {
  WINDOWS_PROCESS_TREE_FUNCTIONS,
  endingWindowsTrees,
  type WindowsProcessTreeRoot,
  type WindowsTreeEnding,
  windowsStopTreeArgs,
  windowsTreeRootFromNow,
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

/**
 * A Windows spawner whose process has exited unless `running`, whose kill fails if `killFails`, and
 * whose `exit` ends it, or fails its exit code with the method it names. A walk told it ran finds it
 * `gone` if set, as it `exits`, `fails` as a lost worker or `lingers`, and says it saw so at 60 s;
 * the walk `walks` lists at its place says and exits so.
 */
const fakeWindowsSpawner = (options: {
  readonly running: boolean;
  readonly output: "ends" | "held";
  readonly killFails?: boolean;
  readonly gone?: "exits" | "fails" | "lingers";
  readonly walks?: ReadonlyArray<{ readonly says: string; readonly code: number }>;
}) => {
  const events: Array<"kill" | "walk"> = [];
  const told: Array<number | "running" | undefined> = [];
  const carried: Array<string | undefined> = [];
  const exited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>();
  const refused = (method: string) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method,
      description: "refused",
    });
  const exit = (failing?: string) =>
    Deferred.doneUnsafe(
      exited,
      failing === undefined
        ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
        : Effect.fail(refused(failing)),
    );
  if (!options.running) exit();
  const handle = (
    output: Stream.Stream<Uint8Array>,
    process: Pick<ChildProcessSpawner.ChildProcessHandle, "exitCode" | "isRunning" | "kill">,
  ) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      ...process,
      stdin: Sink.drain,
      stdout: output,
      stderr: Stream.empty,
      all: output,
      getInputFd: () => Sink.drain,
      getOutputFd: () => output,
      unref: Effect.succeed(Effect.void),
    });
  const leader = {
    exitCode: Deferred.await(exited),
    isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(exited)),
    kill: () =>
      options.killFails
        ? Effect.fail(refused("kill"))
        : Effect.sync(() => {
            exit();
            events.push("kill");
          }),
  };
  const walk = (says: string, code: number) =>
    handle(Stream.make(new TextEncoder().encode(says)), {
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
    });
  const byte = Stream.make(new Uint8Array([1]));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand" && command.command === "powershell.exe") {
        events.push("walk");
        const call =
          String(command.args.at(-1) ?? "")
            .split("Stop-T3ProcessTree")
            .at(-1) ?? "";
        const ended = / -ended (\d+)/.exec(call);
        const running = / -running\b/.test(call);
        told.push(ended === null ? (running ? "running" : undefined) : Number(ended[1]));
        carried.push(/ -left (\S+)/.exec(call)?.[1]);
        if (running && options.gone === "exits") exit();
        if (running && options.gone === "fails") exit("worker");
        const scripted = options.walks?.[told.length - 1];
        if (scripted !== undefined) return walk(scripted.says, scripted.code);
        return walk(running && options.gone !== undefined ? "ended 60000\r\n" : "", 0);
      }
      // What a leader left running holds a pipe it inherited open.
      return handle(options.output === "ends" ? byte : Stream.concat(byte, Stream.never), leader);
    }),
  );
  return {
    events,
    told,
    carried,
    spawner,
    exit: (failing?: string) => Effect.sync(() => exit(failing)),
  };
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

      assert.deepEqual(
        fake.told.map((at) => typeof at === "number"),
        Array.from({ length: walks }, () => true),
      );
      if (process.running) assert.deepEqual(fake.events, ["kill", "walk"]);
    }),
  );

  it.effect("once, told the process ran, when its kill failed and it may still run", () =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner({ running: true, output: "ends", killFails: true });

      yield* Effect.scoped(
        Effect.flatMap(
          endingWindowsTrees(fake.spawner, "win32").spawn(ChildProcess.make("leader")),
          readToEnd,
        ),
      );

      assert.deepEqual(fake.told, ["running"]);
    }),
  );

  it.effect("again, told when the process exited, when a walk told it ran finds it gone", () =>
    Effect.gen(function* () {
      let now = 0;
      using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
      const fake = fakeWindowsSpawner({
        running: true,
        output: "ends",
        killFails: true,
        gone: "exits",
      });

      yield* Effect.scoped(
        Effect.flatMap(
          endingWindowsTrees(fake.spawner, "win32").spawn(ChildProcess.make("leader")),
          () =>
            Effect.sync(() => {
              now = 1_000;
            }),
        ),
      );

      assert.deepEqual(fake.told, ["running", 1_000]);
    }),
  );

  it.effect.each<[string, "lingers" | "fails" | "exits"]>([
    ["goes unreported for 5 s", "lingers"],
    ["fails without saying how the process ended", "fails"],
    ["is reported later", "exits"],
  ])("again, told when a walk told it ran found it gone, when its exit then %s", ([, gone]) =>
    Effect.gen(function* () {
      let now = 0;
      using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
      const fake = fakeWindowsSpawner({
        running: true,
        output: "ends",
        killFails: true,
        gone,
        walks: [{ says: "ended 500\r\n", code: 0 }],
      });
      const leader = yield* endingWindowsTrees(fake.spawner, "win32").spawn(
        ChildProcess.make("leader"),
      );
      now = 1_000;
      const killing = yield* Effect.forkChild(Effect.exit(leader.kill()), {
        startImmediately: true,
      });

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(killing);

      assert.deepEqual(fake.told, ["running", 500]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "again, from what the walk told it ran found, when that walk failed finding it gone",
    () =>
      Effect.gen(function* () {
        let now = 0;
        using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
        const fake = fakeWindowsSpawner({
          running: true,
          output: "ends",
          killFails: true,
          gone: "exits",
          walks: [{ says: "ended 2000\r\nleft 7 638\r\n", code: 1 }],
        });
        const leader = yield* endingWindowsTrees(fake.spawner, "win32").spawn(
          ChildProcess.make("leader"),
        );
        now = 1_000;

        const error = yield* Effect.flip(leader.kill());

        assert.deepEqual(
          [
            error.reason._tag,
            error.message.includes("PowerShell exited 1"),
            fake.told,
            fake.carried,
          ],
          ["Unknown", true, ["running", 1_000], [undefined, "7,638"]],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("ending in its next stop what a failed stop found but did not end", () =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner({
        running: false,
        output: "ends",
        walks: [{ says: "left 7 638\r\n", code: 1 }],
      });
      const leader = yield* endingWindowsTrees(fake.spawner, "win32").spawn(
        ChildProcess.make("leader"),
      );

      const first = yield* Effect.exit(leader.kill());
      yield* leader.kill();

      assert.deepEqual([first._tag, fake.carried], ["Failure", [undefined, "7,638"]]);
    }).pipe(Effect.scoped),
  );

  // A spawner fails the exit code of a process a signal ended, and a lost worker's with its own method.
  it.effect.each<[string, string | undefined, number | undefined]>([
    ["when the process exited, not when its scope closed", undefined, 1_000],
    ["when the process exited by a signal", "exitCode", 1_000],
    [
      "no end when the handle's exit fails without saying how the process ended",
      "worker",
      undefined,
    ],
  ])("telling the walk %s", ([, failing, told]) =>
    Effect.gen(function* () {
      let now = 0;
      using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
      const fake = fakeWindowsSpawner({ running: true, output: "ends" });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* endingWindowsTrees(fake.spawner, "win32").spawn(ChildProcess.make("leader"));
          now = 1_000;
          yield* fake.exit(failing);
          now = 61_000;
        }),
      );

      assert.deepEqual(fake.told, [told]);
    }),
  );

  it.effect("telling a kill after the scope closed when the unreferenced process exited", () =>
    Effect.gen(function* () {
      let now = 0;
      using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
      const fake = fakeWindowsSpawner({ running: true, output: "ends" });
      const leader = yield* Effect.scoped(
        Effect.tap(
          endingWindowsTrees(fake.spawner, "win32").spawn(ChildProcess.make("leader")),
          (handle) => handle.unref,
        ),
      );
      now = 1_000;
      yield* fake.exit();
      now = 61_000;

      yield* leader.kill();

      assert.deepEqual(fake.told, [1_000]);
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
  /** Runs `lines` after the tree's functions in Windows PowerShell; returns what they printed. */
  const runPowerShell = (...lines: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        ["$ErrorActionPreference = 'Stop'", WINDOWS_PROCESS_TREE_FUNCTIONS, ...lines].join("\n"),
      ],
      { encoding: "utf8" },
    );

  /** Settles with the process's exit code, or null when a signal ended it. */
  const exitCodeOf = (child: NodeChildProcess.ChildProcess) =>
    new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });

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
    const tree = runPowerShell(
      "$t = [DateTime]::UtcNow",
      "function P($id, $parent, $seconds) { [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; CreationDate = $t.AddSeconds($seconds) } }",
      `$all = @(${rows})`,
      "(Get-T3ProcessTree $all 10 (Ms $t.AddSeconds(-2)) (Ms $t) (Ms $t)).Keys | Sort-Object",
    );
    assert.deepEqual(tree.trim().split(/\r?\n/), expected);
  });

  /**
   * Lines that make the walk's first snapshot hold the processes `first` lists and each later one
   * those `later` lists, as `P` calls; `$global:walks` counts the snapshots taken.
   */
  const snapshots = (first: string, later = "") => [
    "function P($id, $parent, $created) { [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; CreationDate = $created } }",
    `$first = @(${first})`,
    `$later = @(${later})`,
    "$global:walks = 0",
    "function Get-CimInstance { $global:walks++; if ($global:walks -eq 1) { $first } else { $later } }",
  ];

  // $real is when CIM shows the target was created and $near the microsecond after; $soon, $late and
  // $next stand for Node's clock 500 and 50 ms before and 300 ms after $real. No process holds $gone.
  // A snapshot that lists the target at $near saw another process hold its pid. The last column is
  // what the stop output, if anything, with ended for ended and a time read while the stop ran.
  it.each<[string, string, string, string, "stopped" | "spared", number, string?]>([
    ["ends the target the walk saw", "$target 0", "(P $target 0 $real)", "", "stopped", 2],
    [
      "spares a process created a microsecond from the one the walk saw",
      "$target 0",
      "(P $target 0 $near)",
      "",
      "spared",
      2,
    ],
    [
      "spares a process that took the root's pid after the first pass",
      "$target 0",
      "(P $target 0 $real.AddSeconds(-1))",
      "(P $target 0 $real)",
      "spared",
      2,
    ],
    [
      "spares what a process that took the root's pid after the first pass started",
      "$gone 0",
      "(P $gone 0 $real.AddSeconds(-1))",
      "(P $target $gone $real)",
      "spared",
      2,
    ],
    [
      "spares what an earlier holder of the root's pid started, after the root ended",
      "$gone 0",
      "(P $gone 0 $real.AddMilliseconds(100)), (P $target $gone $real)",
      "(P $target $gone $real)",
      "spared",
      2,
    ],
    [
      "spares what a later holder of the root's pid started, after that holder ended",
      "$gone $early $early $early",
      "(P $gone 0 $real.AddMilliseconds(-100)), (P ($gone - 1) $gone $real.AddMilliseconds(-200)), (P $target $gone $real)",
      "(P $target $gone $real)",
      "spared",
      2,
    ],
    [
      "spares a process that took the root's pid half a second after the spawn",
      "$target $soon $soon $soon",
      "(P $target 0 $real)",
      "",
      "spared",
      1,
    ],
    [
      "spares what an earlier holder of the root's pid started before the root, after the root ended",
      "$gone $early $next $next",
      "(P $target $gone $real)",
      "",
      "spared",
      1,
    ],
    [
      "takes a holder of the root's pid 50 ms after the spawn for the root, which may still run",
      "$target $late $late $late",
      "(P $target 0 $real)",
      "",
      "stopped",
      2,
    ],
    [
      "spares a process that took the root's pid 50 ms after the spawn, once the root ended",
      "$target $late $late $late -ended $late",
      "(P $target 0 $real)",
      "",
      "spared",
      1,
    ],
    [
      "spares what a later holder of the root's pid started once the root ended, after it ended too",
      "$gone $early $early $early -ended $soon",
      "(P $target $gone $real)",
      "",
      "spared",
      1,
    ],
    [
      "ends the target the walk saw, told it runs",
      "$target 0 -running",
      "(P $target 0 $real)",
      "",
      "stopped",
      2,
    ],
    [
      "ends nothing, told the root runs, and says it ended when no process holds its pid",
      "$gone $early $early $early -running",
      "(P $target $gone $real)",
      "",
      "spared",
      1,
      "ended",
    ],
    [
      "ends nothing, told the root runs, and says it ended when another process holds its pid",
      "$target $soon $soon $soon -running",
      "(P $target 0 $real)",
      "",
      "spared",
      1,
      "ended",
    ],
    [
      "ends nothing, told the root runs, and says it ended when the root ends before the stop opens it",
      "$gone $early $soon $next -running",
      "(P $gone 0 $real)",
      "(P $target $gone $real)",
      "spared",
      2,
      "ended",
    ],
    [
      "ends the rest of what it found, told the root runs, and says it ended when the root ends before the stop opens it",
      "$gone $early $soon $next -running",
      "(P $gone 0 $real), (P $target $gone $real)",
      "",
      "stopped",
      2,
      "ended",
    ],
    [
      "ends a process an earlier stop left, listed with the start that stop saw",
      "$gone $early $early $early -left $target,(Ticks $real)",
      "(P $target 0 $real)",
      "",
      "stopped",
      2,
    ],
    [
      "ends what a process an earlier stop left started, at every level, once that process ended",
      "$gone $early $early $early -left ($gone - 1),(Ticks $real.AddSeconds(-2))",
      "(P ($gone - 1) 0 $real.AddSeconds(-2)), (P ($gone - 2) ($gone - 1) $real.AddSeconds(-1)), (P $target ($gone - 2) $real)",
      "",
      "stopped",
      2,
    ],
    [
      "spares a process holding the pid of one an earlier stop left, created a microsecond from it",
      "$gone $early $early $early -left $target,(Ticks $real)",
      "(P $target 0 $near)",
      "",
      "spared",
      1,
    ],
  ])("%s", async (_, stop, first, later, expected, walked, said = "") => {
    // Exits 7 once its input ends, so any other exit is the stop's.
    const target = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.stdin.on('end', () => process.exit(7)).resume()"],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    const exited = exitCodeOf(target);
    let output: string;
    try {
      output = runPowerShell(
        `$target = ${target.pid}`,
        "$real = (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $target)).CreationDate",
        "$near = $real.AddTicks(10)",
        "$early = Ms $real.AddSeconds(-10)",
        "$soon = Ms $real.AddMilliseconds(-500)",
        "$late = Ms $real.AddMilliseconds(-50)",
        "$next = Ms $real.AddMilliseconds(300)",
        "$gone = [int]::MaxValue",
        ...snapshots(first, later),
        "Ms ([DateTimeOffset]::UtcNow)",
        `Stop-T3ProcessTree ${stop}`,
        "Ms ([DateTimeOffset]::UtcNow)",
        "$global:walks",
      );
    } finally {
      target.stdin.destroy();
    }
    const code = await exited;
    const lines = output.trim().split(/\r?\n/);
    const [before, after] = [Number(lines[0]), Number(lines.at(-2))];
    const says = lines.slice(1, -2).map((line) => {
      const at = Number(/^ended (\d+)$/.exec(line)?.[1]);
      return at >= before && at <= after ? "ended" : line;
    });
    assert.deepEqual(
      {
        outcome: code === 7 ? "spared" : "stopped",
        walks: lines.at(-1),
        said: says.join(" "),
      },
      { outcome: expected, walks: String(walked), said },
    );
  });

  // The target ends after the walk read it; $started holds it open until it lets go. $seen, looked up
  // unopened, opens the free pid again for HasExited, so false stands in for a process that took it.
  // Opening fails with error 87 when the pid was free as it opened and another process had it as it
  // looked again. A later snapshot lists what holds the pid then.
  it.each([
    ["before the stop looks it up", "function Get-Process { }", ""],
    [
      "before the stop opens it and its pid goes to a running process",
      "$started.Dispose(); $seen | Add-Member NoteProperty HasExited $false -Force; function Get-Process { $seen }",
      "",
    ],
    [
      "while the stop opens it and another process takes its pid",
      "function Get-Process { [pscustomobject]@{} | Add-Member ScriptMethod get_Handle { throw [ComponentModel.Win32Exception]::new(87) } -PassThru | Add-Member ScriptMethod Dispose { } -PassThru }",
      "",
    ],
    ["before the stop ends it", "function Get-Process { $started }", ""],
    [
      "before the stop opens it and its pid goes to a process the stop may not open",
      "function Get-Process { [pscustomobject]@{} | Add-Member ScriptMethod get_Handle { throw [ComponentModel.Win32Exception]::new(5) } -PassThru | Add-Member ScriptMethod Dispose { } -PassThru }",
      "(P $target 0 $real.AddTicks(10))",
    ],
  ])("reports no error and leaves nothing for a target that ended %s", (_, lookUp, later) => {
    const output = runPowerShell(
      `$started = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', 'setTimeout(Object,600000)' -WindowStyle Hidden -PassThru`,
      "$target = $started.Id",
      "$null = $started.get_Handle()",
      "$seen = Get-Process -Id $target",
      "$real = (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $target)).CreationDate",
      ...snapshots("(P $target 0 $real)", later),
      "$started.Kill()",
      "$started.WaitForExit()",
      lookUp,
      "Stop-T3ProcessTree $target 0",
    );
    assert.equal(output.trim(), "");
  });

  // Later passes walk from the processes the stop holds, so what one started as it ended is found.
  // $held gathers the handle each process the stop opened keeps, read without opening one: during
  // the second walk it holds the ended root open, and once it returns it holds nothing.
  it("ends what a process it stopped started after the first pass", () => {
    const ended = runPowerShell(
      `$root, $child = 1, 2 | ForEach-Object { Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', 'setTimeout(Object,600000)' -WindowStyle Hidden -PassThru }`,
      "try {",
      "  $null = $root.get_Handle(); $null = $child.get_Handle()",
      "  $made = @{}; foreach ($p in Get-CimInstance Win32_Process) { $made[[int]$p.ProcessId] = $p.CreationDate }",
      ...snapshots("(P $root.Id 0 $made[$root.Id])", "(P $child.Id $root.Id $made[$child.Id])"),
      "  $global:held = @(); $opener = ${function:Open-T3Process}; $walk = ${function:Get-CimInstance}",
      "  $kept = [Diagnostics.Process].GetField('m_processHandle', [Reflection.BindingFlags]'NonPublic, Instance')",
      "  function Open-T3Process($id, $created) { $p = & $opener $id $created; if ($p) { $global:held += $kept.GetValue($p); $p } }",
      "  function Get-CimInstance { if ($global:walks -eq 1) { $global:atWalk = '{0} {1}' -f $global:held.Count, $global:held[0].IsClosed }; & $walk }",
      "  Stop-T3ProcessTree $root.Id 0",
      "  $child.WaitForExit(5000)",
      "  $global:atWalk",
      "  '{0} {1}' -f $global:held.Count, @($global:held | Where-Object IsClosed).Count",
      "} finally { foreach ($p in $root, $child) { if (-not $p.HasExited) { $p.Kill() } } }",
    );
    assert.deepEqual(ended.trim().split(/\r?\n/), ["True", "1 False", "2 2"]);
  });

  // Each snapshot adds the next process of a chain, as a tree whose processes each start another as
  // the stop ends them would. The sixth pass finds the last; the stop ends it and reports itself
  // unfinished.
  it("reports a tree still starting processes after its last pass", () => {
    const report = runPowerShell(
      `$chain = 1..6 | ForEach-Object { Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', 'setTimeout(Object,600000)' -WindowStyle Hidden -PassThru }`,
      "try {",
      "  foreach ($p in $chain) { $null = $p.get_Handle() }",
      "  $made = @{}; foreach ($p in Get-CimInstance Win32_Process) { $made[[int]$p.ProcessId] = $p.CreationDate }",
      "  $parent = 0",
      "  $rows = @(foreach ($p in $chain) { [pscustomobject]@{ ProcessId = $p.Id; ParentProcessId = $parent; CreationDate = $made[$p.Id] }; $parent = $p.Id })",
      "  $global:walks = 0",
      "  function Get-CimInstance { $global:walks++; $rows | Select-Object -First $global:walks }",
      "  try { Stop-T3ProcessTree $chain[0].Id 0 } catch { $_.Exception.Message }",
      "  @($chain | Where-Object { -not $_.WaitForExit(5000) }).Count",
      "} finally { foreach ($p in $chain) { if (-not $p.HasExited) { $p.Kill() } } }",
    );
    const [message = "", running] = report.trim().split(/\r?\n/);
    assert.deepEqual(
      { unfinished: /still started processes after 5 passes/.test(message), running },
      { unfinished: true, running: "0" },
      report,
    );
  });

  // The wait for the root fails; the stop still walks from it and ends what it started, says it left
  // the root, and then reports that failure.
  it("goes on past a wait that fails to end what the tree started", () => {
    const report = runPowerShell(
      `$leader, $child = 1, 2 | ForEach-Object { Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', 'setTimeout(Object,600000)' -WindowStyle Hidden -PassThru }`,
      "try {",
      "  $null = $leader.get_Handle(); $null = $child.get_Handle()",
      "  $made = @{}; foreach ($p in Get-CimInstance Win32_Process) { $made[[int]$p.ProcessId] = $p.CreationDate }",
      "  '{0} {1}' -f $leader.Id, (Ticks $made[$leader.Id])",
      ...snapshots(
        "(P $leader.Id 0 $made[$leader.Id])",
        "(P $child.Id $leader.Id $made[$child.Id])",
      ),
      "  $opener = ${function:Open-T3Process}",
      "  function Open-T3Process($id, $created) { $p = & $opener $id $created; if ($p -and $id -eq $leader.Id) { $p | Add-Member ScriptMethod WaitForExit { throw 'the wait failed' } -Force }; $p }",
      "  try { Stop-T3ProcessTree $leader.Id 0 } catch { $_.Exception.Message }",
      "  $child.WaitForExit(5000)",
      "} finally { foreach ($p in $leader, $child) { if (-not $p.HasExited) { $p.Kill() } } }",
    );
    const [leader, left, message = "", childEnded] = report.trim().split(/\r?\n/);
    assert.deepEqual(
      { left, reported: /the wait failed/.test(message), childEnded },
      { left: `left ${leader}`, reported: true, childEnded: "True" },
      report,
    );
  });

  // A process ended while others hold it open keeps its pid: here Node, whose event loop waits on
  // PowerShell, and PowerShell, which ends it. The stop, told the root ended, still ends what the
  // root started. The message says if the snapshot listed the ended root.
  it("ends what an ended root started while another process still holds it open", async () => {
    // Prints the pid of a child it starts, and both wait ten minutes.
    const root = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        "console.log(require('child_process').spawn(process.execPath, ['-e', 'setTimeout(Object, 600000)'], { stdio: 'ignore' }).pid); setTimeout(Object, 600000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let report: string;
    try {
      const child = await new Promise<string>((resolve, reject) => {
        let printed = "";
        root.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          printed += chunk;
          if (printed.includes("\n")) resolve(printed.trim());
        });
        root.once("error", reject);
        root.once("exit", () => reject(new Error(`The root exited first, printing ${printed}`)));
      });
      report = runPowerShell(
        `$root = Get-Process -Id ${root.pid}; $child = Get-Process -Id ${child}`,
        "try {",
        "  $null = $root.get_Handle(); $null = $child.get_Handle(); $start = Ms $root.StartTime",
        "  $root.Kill(); $null = $root.WaitForExit(5000)",
        "  $listed = [bool](Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $root.Id))",
        "  Stop-T3ProcessTree $root.Id $start $start $start -ended (Ms ([DateTime]::Now))",
        "  '{0} {1}' -f $listed, $child.WaitForExit(5000)",
        "} finally { if (-not $child.HasExited) { $child.Kill() } }",
      );
    } finally {
      root.kill();
    }
    const [listed, childEnded] = report.trim().split(" ");
    assert.equal(childEnded, "True", `the snapshot listed the ended root: ${listed}`);
  });

  // Node reads its clock around a spawn and Windows stamps the start from its own, each at its last
  // tick, so the stop allows each window a little slack. The message lists each window and stamp.
  it("ends a running root, told it runs, whose start it knows only from the clock read around its spawn", async () => {
    const spawned: Array<{ child: NodeChildProcess.ChildProcess; root: WindowsProcessTreeRoot }> =
      [];
    const exits: Array<Promise<number | null>> = [];
    let stamps: string;
    try {
      for (let index = 0; index < 8; index++) {
        const rootOf = windowsTreeRootFromNow();
        // Exits 7 once its input ends, so any other exit is the stop's.
        const child = NodeChildProcess.spawn(
          process.execPath,
          ["-e", "process.stdin.on('end', () => process.exit(7)).resume()"],
          { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
        );
        exits.push(exitCodeOf(child));
        if (child.pid === undefined) throw new Error("A root did not spawn");
        spawned.push({ child, root: rootOf(child.pid) });
      }
      const roots = spawned.map(({ root }) => root);
      stamps = runPowerShell(
        `foreach ($id in ${roots.map(({ pid }) => pid).join(", ")}) { Ms (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $id)).CreationDate }`,
        ...roots.map(({ pid, since, created }) =>
          [
            "Stop-T3ProcessTree",
            pid,
            since,
            ...(created === "unknown" ? [] : [created.from, created.to]),
            "-running",
          ].join(" "),
        ),
      );
    } finally {
      for (const { child } of spawned) child.stdin?.destroy();
    }
    const codes = await Promise.all(exits);
    assert.deepEqual(
      codes.map((code) => (code === 7 ? "spared" : "stopped")),
      spawned.map(() => "stopped"),
      `${JSON.stringify(spawned.map(({ root }) => root.created))} ${stamps.trim().split(/\r?\n/).join(" ")}`,
    );
  });

  // The walk reads start times from CIM and the stop from a handle, which counts 100 ns ticks.
  // Only processes it could open are compared, so no pid among them can change hands meanwhile.
  it("reads each start time from CIM cut to its microsecond", () => {
    const range = runPowerShell(
      "$open = @{}; foreach ($p in Get-Process) { try { $null = $p.get_Handle(); $open[$p.Id] = $p } catch { $p.Dispose() } }",
      "$skews = @(foreach ($c in Get-CimInstance Win32_Process) { $p = $open[[int]$c.ProcessId]; if ($p) { (Ticks $p.StartTime) - (Ticks $c.CreationDate) } })",
      "$open.Values | ForEach-Object { $_.Dispose() }",
      "$range = $skews | Measure-Object -Minimum -Maximum",
      "'{0} {1} {2}' -f $range.Count, $range.Minimum, $range.Maximum",
    ).trim();
    const [count = 0, least = Number.NaN, most = Number.NaN] = range.split(" ").map(Number);
    assert.deepEqual(
      { compared: count > 0, cut: least >= 0 && most <= 9 },
      { compared: true, cut: true },
      `processes, least and most ticks past CIM's time: ${range}`,
    );
  });

  // The stop says what it found ended or will not end as soon as it knows, so a stop cut short as it
  // opens or waits still passes it on: here a root gone before its open, a child it may not open (the
  // System process), and a child whose kill fails. No process holds the root's pid.
  it("says what it found ended or leaves before it opens the next target or waits", () => {
    const gone = 2 ** 31 - 1;
    const report = runPowerShell(
      `$stuck = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', 'setTimeout(Object,600000)' -WindowStyle Hidden -PassThru`,
      "try {",
      "  $null = $stuck.get_Handle()",
      "  $made = (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $stuck.Id)).CreationDate",
      ...snapshots(
        `(P ${gone} 0 $made.AddSeconds(-1)), (P $stuck.Id ${gone} $made), (P 4 ${gone} $made.AddSeconds(1))`,
        "(P 4 0 $made.AddSeconds(1))",
      ),
      "  $opener = ${function:Open-T3Process}",
      "  function Open-T3Process($id, $created) { [void]$global:order.Add('open {0}' -f $id); $p = & $opener $id $created; if ($p) { $p | Add-Member ScriptMethod Kill { throw 'the kill failed' } -Force; $p | Add-Member ScriptMethod WaitForExit { [void]$global:order.Add('wait'); $false } -Force }; $p }",
      "  $global:order = New-Object System.Collections.ArrayList",
      "  $began = Ms $made.AddSeconds(-1)",
      `  try { Stop-T3ProcessTree ${gone} 0 $began $began -running | ForEach-Object { [void]$global:order.Add($_) } } catch { [void]$global:order.Add($_.Exception.GetBaseException().NativeErrorCode) }`,
      "  'left 4 {0}' -f (Ticks $made.AddSeconds(1))",
      "  'left {0} {1}' -f $stuck.Id, (Ticks $made)",
      "  'open {0}' -f $stuck.Id",
      "  $global:order",
      "} finally { if (-not $stuck.HasExited) { $stuck.Kill() } }",
    );
    const [child = "", leader = "", held = "", ...order] = report
      .trim()
      .split(/\r?\n/)
      .map((line) => line.replace(/^ended \d+$/, "ended"));
    const said: Record<string, ReadonlyArray<string>> = {
      [`open ${gone}`]: ["ended"],
      "open 4": [child],
    };
    const opened = order.filter((line) => line.startsWith("open "));
    assert.deepEqual(
      { opened: opened.toSorted(), order },
      {
        opened: [`open ${gone}`, "open 4", held].toSorted(),
        order: [...opened.flatMap((open) => [open, ...(said[open] ?? [])]), leader, "wait", "5"],
      },
      report,
    );
  });

  // The protected System process refuses to be opened, as any process the stop may not end does,
  // while CIM still lists it with the start the walk saw. The stop says it left it.
  it("reports the refusal of a target it may not open", () => {
    const [ticks, ...report] = runPowerShell(
      "$made = (Get-CimInstance Win32_Process -Filter 'ProcessId = 4').CreationDate",
      "Ticks $made",
      ...snapshots("(P 4 0 $made)", "(P 4 0 $made)"),
      "try { Stop-T3ProcessTree 4 0 } catch { $_.Exception.GetBaseException().NativeErrorCode }",
    )
      .trim()
      .split(/\r?\n/);
    assert.deepEqual(report, [`left 4 ${ticks}`, "5"]);
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

  it.live.runIf(isWindowsHost)(
    "a kill ends the running leader alone, leaving its descendants to the checked walk",
    () =>
      Effect.gen(function* () {
        const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const leader = yield* spawner.spawn(leftover.command);
        const child = yield* leftover.started;

        yield* leader.kill();

        // taskkill /T would have ended the child by pid; the probe only checks that it still runs.
        assert.isTrue(isProcessAlive(child));
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

describe("windowsStopTreeArgs", () => {
  const callOf = (root: WindowsProcessTreeRoot) =>
    windowsStopTreeArgs(root).at(-1)?.split("\n").at(-1);

  it("names the root's end only when the caller saw it exit", () => {
    const created = { from: 5, to: 6 };
    assert.strictEqual(
      callOf({ pid: 1, since: 4, created, ended: "running" }),
      "Stop-T3ProcessTree 1 4 5 6",
    );
    assert.strictEqual(
      callOf({ pid: 1, since: 4, created, ended: 9 }),
      "Stop-T3ProcessTree 1 4 5 6 -ended 9",
    );
    assert.strictEqual(
      callOf({ pid: 1, since: 4, created: "unknown", ended: 9 }),
      "Stop-T3ProcessTree 1 4 -ended 9",
    );
  });

  it("requires every caller to state the root's creation window and end", () => {
    // Compile-time only: the calls sit in a function nothing runs.
    const rejected = () => {
      // @ts-expect-error a root with no creation window would trust any holder of its pid
      callOf({ pid: 1, since: 4, ended: "running" });
      // @ts-expect-error a root with no end would let a later holder's children count as its own
      callOf({ pid: 1, since: 4, created: "unknown" });
    };
    assert.isFunction(rejected);
  });
});
