import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Windows PowerShell by absolute path, so a `powershell.exe` earlier on PATH cannot stand in. */
export const windowsPowerShellPath = (environment: {
  readonly SystemRoot?: string | undefined;
  readonly WINDIR?: string | undefined;
}) => {
  const root = environment.SystemRoot ?? environment.WINDIR;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
};

/** Runs `script` and returns its stdout; a nonzero exit fails. */
export const runWindowsPowerShell = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  script: string,
  env?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          windowsPowerShellPath(process.env),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          {
            stdin: "ignore",
            stderr: "ignore",
            ...(env === undefined ? {} : { env, extendEnv: true }),
          },
        ),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
      return stdout;
    }),
  );
