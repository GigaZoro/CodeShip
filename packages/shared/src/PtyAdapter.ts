import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

/** What a PTY receives for client terminal input, whose `binary` data is one byte per code unit. */
export function ptyInput(data: string, binary: boolean | undefined): string | Buffer {
  return binary ? Buffer.from(data, "latin1") : data;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    /**
     * A start that can stall stays interruptible even under an uninterruptible caller, and an
     * interrupt there stops the process.
     */
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("@t3tools/shared/PtyAdapter") {}

export interface PtyListeners {
  readonly onData: (data: string) => void;
  readonly onExit: (event: PtyExitEvent) => void;
}

/**
 * Spawns a process that the current scope stops. The start is uninterruptible, apart from the
 * adapter's own stoppable waits, and attaches the listeners before any output, so a run
 * interrupted while it starts still stops its process.
 */
export const spawnScoped = (
  adapter: PtyAdapter["Service"],
  input: PtySpawnInput,
  listeners: PtyListeners,
) =>
  Effect.acquireRelease(
    adapter.spawn(input).pipe(
      Effect.map((process) => {
        const detachData = process.onData(listeners.onData);
        const detachExit = process.onExit(listeners.onExit);
        return { process, detach: () => (detachData(), detachExit()) };
      }),
    ),
    ({ process, detach }) =>
      Effect.sync(detach).pipe(
        Effect.andThen(
          Effect.sync(() => process.kill()).pipe(
            Effect.catchDefect((cause) =>
              Effect.logWarning("A terminal process could not be stopped.", { cause }),
            ),
          ),
        ),
      ),
  ).pipe(Effect.map(({ process }) => process));
