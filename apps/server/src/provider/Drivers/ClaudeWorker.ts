import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";

export class ClaudeWorkerError extends Schema.TaggedError<ClaudeWorkerError>()(
  "ClaudeWorkerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude's ${this.method} worker failed.`;
  }
}

const encodeWorkerJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const claudeConfigDirOf = (
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) => path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(homeDirectory, ".claude"));

// The SDK reads CLAUDE_CONFIG_DIR from process.env. Isolate custom homes in a
// worker so concurrent providers keep the server's environment.
export const runClaudeWorker = Effect.fn("runClaudeWorker")(function* (input: {
  readonly method: "forkSession" | "resolveSettings";
  readonly input: string;
  readonly options?: unknown;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const fromSource = import.meta.url.endsWith(".ts");
  // A single executable hosts the worker itself; it has no sibling script.
  const workerArguments = (yield* HostProcess.IsExecutable)
    ? ["__claude-history"]
    : [
        ...(fromSource ? ["--experimental-strip-types"] : []),
        yield* path.fromFileUrl(
          new URL(
            fromSource ? "../../claude-history-worker.ts" : "./claude-history-worker.mjs",
            import.meta.url,
          ),
        ),
      ];
  const executablePath = yield* HostProcess.ExecutablePath;
  const result = yield* spawnAndCollect(
    executablePath,
    ChildProcess.make(
      executablePath,
      [...workerArguments, input.method, input.input, encodeWorkerJson(input.options ?? {})],
      {
        env: {
          ...input.environment,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ),
  ).pipe(Effect.timeout("30 seconds"));
  if (result.code !== 0) {
    return yield* new ClaudeWorkerError({
      method: input.method,
      cause: result.stderr.trim() || `Claude history worker exited with code ${result.code}.`,
    });
  }
  return result.stdout;
});
