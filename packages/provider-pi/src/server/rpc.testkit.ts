import { attachWindowsJob } from "@t3tools/shared/windowsJob";
import { markWindowsJobSpawner } from "@t3tools/shared/windowsJobSpawner";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Protocol fakes own synthetic processes; windowsJob.test.ts exercises native membership.
export const makePiProtocolSpawner = (spawn: Parameters<typeof ChildProcessSpawner.make>[0]) =>
  markWindowsJobSpawner(
    ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand" && command.command === "fake-job-host.exe")
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_998),
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
          }),
        );
      return spawn(command).pipe(
        Effect.map((handle) => {
          attachWindowsJob(handle, {
            host: "fake-job-host.exe",
            name: "Global\\CodeShip.Job.pi-test",
            child: { pid: handle.pid, created: "134396649968103675" },
          });
          return handle;
        }),
      );
    }),
  );
