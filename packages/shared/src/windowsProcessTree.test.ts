import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { leaderLeavingChild, processPipe } from "./testing/leftoverChild.ts";
import { isWindowsHost } from "./testing/hostPlatform.ts";
import { attachWindowsJob, type WindowsJob } from "./windowsJob.ts";
import { markWindowsJobSpawner } from "./windowsJobSpawner.ts";
import {
  stopWindowsProcessTree,
  endingWindowsTrees,
  type WindowsTreeEnding,
  withoutWindowsTreeEnding,
  withWindowsTreeRoot,
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
  readonly job?: WindowsJob;
  readonly stopCodes?: Array<number>;
}) => {
  const job = options.job ?? {
    host: "job-host.exe",
    name: "Global\\CodeShip.Job.fake",
    child: { pid: 1, created: "134395200001234567" },
  };
  const events: Array<"kill" | "walk"> = [];
  const jobsStopped: Array<string> = [];
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
      if (command._tag === "StandardCommand" && command.command === job.host) {
        assert.deepEqual(command.args, [
          "stop",
          job.name,
          String(job.child?.pid),
          String(job.child?.created),
        ]);
        jobsStopped.push(command.args[1]!);
        if (options.job === undefined) events.push("walk");
        return {
          ...handle(Stream.empty),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.stopCodes?.shift() ?? 0)),
        };
      }
      if (command._tag === "StandardCommand" && command.command === "powershell.exe") {
        events.push("walk");
        return handle(Stream.empty);
      }
      // What a leader left running holds a pipe it inherited open.
      const child = handle(options.output === "ends" ? byte : Stream.concat(byte, Stream.never));
      attachWindowsJob(child, job);
      return child;
    }),
  );
  return { events, jobsStopped, spawner: markWindowsJobSpawner(spawner) };
};

type Use = (
  handle: ChildProcessSpawner.ChildProcessHandle,
) => Effect.Effect<unknown, PlatformError.PlatformError, Scope.Scope>;
const readToEnd: Use = (handle) => Stream.runDrain(handle.all);
const readNothing: Use = () => Effect.void;

describe("endingWindowsTrees stops a Windows tree", () => {
  it.effect("retries a failed job stop and shares its later successful cleanup", () =>
    Effect.gen(function* () {
      const fake = fakeWindowsSpawner({ running: false, output: "ends", stopCodes: [1, 0] });
      const child = yield* endingWindowsTrees(fake.spawner, "win32").spawn(
        ChildProcess.make("leader"),
      );
      const failed = yield* Effect.flip(child.kill());
      assert.include(failed.message, "Stop helper exited 1");
      yield* child.kill();
      yield* child.kill();
      assert.lengthOf(fake.jobsStopped, 2);
    }).pipe(Effect.scoped),
  );
  it.effect("refuses to infer membership from an unowned pid", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("an unowned family must not be probed or stopped"),
      );
      const error = yield* stopWindowsProcessTree({ pid: 10 }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flip,
      );
      assert.equal(error.reason._tag, "BadResource");
    }),
  );

  it.effect("retains the owned job through wrappers and stops its members without a PID walk", () =>
    Effect.gen(function* () {
      const job = {
        host: "job-host.exe",
        name: "Global\\CodeShip.Job.test",
        child: { pid: 1, created: "134395200001234567" },
      };
      const fake = fakeWindowsSpawner({ running: false, output: "ends", job });
      const outer = endingWindowsTrees(endingWindowsTrees(fake.spawner, "win32"), "win32");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { handle, root } = yield* outer
            .spawn(ChildProcess.make("leader"))
            .pipe(withWindowsTreeRoot);
          assert.deepEqual(root.job, job);
          yield* handle.kill();
        }),
      );
      assert.deepEqual(fake.jobsStopped, [job.name]);
      assert.deepEqual(fake.events, ["kill"]);
    }),
  );

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
  it.live("ends an orphaned grandchild through a standalone spawner after its parent exited", () =>
    Effect.gen(function* () {
      const member = yield* processPipe;
      const grandchild = `const s=require('node:net').connect(${JSON.stringify(member.path)},()=>s.write(String(process.pid))); s.on('error',()=>{}); s.on('close',()=>process.exit());`;
      const intermediate = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true,windowsHide:true}).unref();`;
      const spawner = endingWindowsTrees(yield* ChildProcessSpawner.ChildProcessSpawner, "win32");
      const root = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore',windowsHide:true}); c.on('exit',()=>process.stdout.write('ready')); process.stdin.resume();`,
        ]),
      );
      yield* member.started;
      yield* root.stdout.pipe(Stream.take(1), Stream.runDrain);
      yield* root.kill();
      yield* member.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const spawnEndingTree = (command: ChildProcess.Command, ending?: WindowsTreeEnding) =>
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      endingWindowsTrees(spawner, "win32", ending).spawn(command),
    );

  it.live("ends what its leader left running when its scope closes after the leader exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leader = yield* spawnEndingTree(leftover.command);
          yield* leftover.started;
          yield* Stream.run(Stream.empty, leader.stdin);
          assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends what its leader left running when killed after the leader exited", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
      const leader = yield* spawnEndingTree(leftover.command);
      yield* leftover.started;
      yield* Stream.run(Stream.empty, leader.stdin);
      assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));

      yield* leader.kill();

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leftBehind ends what its leader left holding its output when the scope closes", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ holdsOutput: true, untilInputEnds: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const leader = yield* spawnEndingTree(leftover.command, "leftBehind");
          yield* Effect.forkScoped(Stream.runDrain(leader.stdout));
          yield* leftover.started;
          yield* Stream.run(Stream.empty, leader.stdin);
          assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
        }),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leftBehind ends what its leader left running when the scope is interrupted", () =>
    Effect.gen(function* () {
      const leftover = yield* leaderLeavingChild({ untilInputEnds: true });
      yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const leader = yield* spawnEndingTree(leftover.command, "leftBehind");
            yield* leftover.started;
            yield* Stream.run(Stream.empty, leader.stdin);
            assert.equal(yield* leader.exitCode, ChildProcessSpawner.ExitCode(0));
            return yield* Effect.interrupt;
          }),
        ),
      );

      yield* leftover.ended;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
