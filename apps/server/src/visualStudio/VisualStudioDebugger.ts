import {
  VISUAL_STUDIO_AUTO_CONTINUE_DEFAULT_MINUTES,
  type VisualStudioAutoContinue,
  type VisualStudioAutoContinueInput,
  type VisualStudioAutoContinueStop,
  type VisualStudioControlInput,
  type VisualStudioError,
  type VisualStudioEvalInput,
  VisualStudioEvalResult,
  VisualStudioHelperError,
  type VisualStudioResumedBreak,
  type VisualStudioStatusInput,
  type VisualStudioStatusResult,
  VisualStudioUnavailableError,
  VisualStudioWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { VISUAL_STUDIO_SCRIPT } from "./visualStudioScript.ts";

const POWERSHELL = "powershell.exe";
// COM's busy-retry filter needs a single-threaded apartment.
const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-STA",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
];
// Each COM call may retry for 30 seconds while Visual Studio is busy.
const COMMAND_TIMEOUT = "2 minutes";
const START_TIMEOUT = "20 minutes";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 500;
const RECENT_BREAKS = 10;
const RECENT_FRAMES = 10;
const RECENT_DETAILS_LENGTH = 2000;

const ScriptError = Schema.Struct({ error: Schema.String });
const decodeWindowLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ScriptError, VisualStudioWindow])),
);
const decodeEvalLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ScriptError, VisualStudioEvalResult])),
);
const decodeWatchLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      ScriptError,
      Schema.Struct({
        event: Schema.Literals(["resumed", "paused"]),
        ...VisualStudioWindow.fields,
      }),
      Schema.Struct({ event: Schema.Literals(["ended", "timeout"]) }),
    ]),
  ),
);

interface AutoContinueSession {
  readonly id: number;
  readonly solution: string;
  readonly untilMillis: number;
  readonly resumedCount: number;
  readonly recent: ReadonlyArray<VisualStudioResumedBreak>;
  readonly stopped?: { readonly reason: VisualStudioAutoContinueStop; readonly detail?: string };
}

export class VisualStudioDebugger extends Context.Service<
  VisualStudioDebugger,
  {
    readonly status: (
      input: VisualStudioStatusInput,
    ) => Effect.Effect<VisualStudioStatusResult, VisualStudioError>;
    readonly evaluate: (
      input: VisualStudioEvalInput,
    ) => Effect.Effect<VisualStudioEvalResult, VisualStudioError>;
    readonly control: (
      input: VisualStudioControlInput,
    ) => Effect.Effect<VisualStudioWindow, VisualStudioError>;
    /** Presses Continue on every exception break until debugging ends, a time limit, or off. */
    readonly autoContinue: (
      input: VisualStudioAutoContinueInput,
    ) => Effect.Effect<VisualStudioAutoContinue, VisualStudioError>;
  }
>()("t3/visualStudio/VisualStudioDebugger") {}

const solutionArgs = (solution: string | undefined) => (solution ? ["-Solution", solution] : []);

// PowerShell can print warnings among the JSON lines.
const isJsonLine = (line: string) => line.trimStart().startsWith("{");

const scriptFailure = (error: string) =>
  new VisualStudioUnavailableError({ reason: error.slice(0, MAX_REASON_LENGTH) });

const outputError = (cause: unknown) => new VisualStudioHelperError({ stage: "output", cause });

const toResumedBreak = (window: VisualStudioWindow): VisualStudioResumedBreak => ({
  ...(window.reason === undefined ? {} : { reason: window.reason }),
  exception: window.exception
    ? {
        type: window.exception.type,
        ...(window.exception.details === undefined
          ? {}
          : { details: window.exception.details.slice(0, RECENT_DETAILS_LENGTH) }),
      }
    : null,
  ...(window.location === undefined ? {} : { location: window.location }),
  stack: (window.stack ?? []).slice(0, RECENT_FRAMES),
});

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scriptLock = yield* Semaphore.make(1);
  const scriptWritten = yield* Ref.make(false);
  const watcher = yield* FiberHandle.make();
  const session = yield* Ref.make<AutoContinueSession | undefined>(undefined);
  const sessionIds = yield* Ref.make(0);

  const directory = path.join(stateDir, "visual-studio");
  const scriptPath = path.join(directory, "vsdbg.ps1");

  // Written once per server start, so an updated T3.CodeShip always runs its own script.
  const ensureScript = scriptLock
    .withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(scriptWritten)) return scriptPath;
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(scriptPath, VISUAL_STUDIO_SCRIPT);
        yield* Ref.set(scriptWritten, true);
        return scriptPath;
      }),
    )
    .pipe(Effect.mapError((cause) => new VisualStudioHelperError({ stage: "run", cause })));

  const runScript = Effect.fn("VisualStudioDebugger.runScript")(function* (
    command: "status" | "select" | "eval" | VisualStudioControlInput["action"],
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    yield* Effect.annotateCurrentSpan({ command });
    const script = yield* ensureScript;
    const output = yield* runner
      .run({
        command: POWERSHELL,
        args: [...POWERSHELL_ARGS, script, command, ...args],
        timeout: command === "start" ? START_TIMEOUT : COMMAND_TIMEOUT,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        stdin,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new VisualStudioHelperError({
              stage: cause._tag === "ProcessTimeoutError" ? "timeout" : "run",
              cause,
            }),
        ),
      );
    const lines = output.stdout.split(/\r?\n/).filter(isJsonLine);
    if (lines.length === 0) return yield* outputError(new Error(output.stderr.slice(0, 2000)));
    return lines;
  });

  const windowsFrom = Effect.fn("VisualStudioDebugger.windowsFrom")(function* (
    lines: ReadonlyArray<string>,
  ) {
    const windows: Array<VisualStudioWindow> = [];
    for (const line of lines) {
      const decoded = yield* decodeWindowLine(line).pipe(Effect.mapError(outputError));
      if ("error" in decoded) return yield* scriptFailure(decoded.error);
      windows.push(decoded);
    }
    return windows;
  });

  const lastWindow = (lines: ReadonlyArray<string>) =>
    windowsFrom(lines.slice(-1)).pipe(Effect.map((windows) => windows[0]!));

  const autoContinueState = Ref.get(session).pipe(
    Effect.map((current): VisualStudioAutoContinue =>
      current === undefined
        ? { on: false, resumedCount: 0, recent: [] }
        : {
            on: current.stopped === undefined,
            solution: current.solution,
            until: DateTime.formatIso(DateTime.makeUnsafe(current.untilMillis)),
            ...(current.stopped === undefined
              ? {}
              : {
                  stopped: current.stopped.reason,
                  ...(current.stopped.detail === undefined
                    ? {}
                    : { stoppedReason: current.stopped.detail }),
                }),
            resumedCount: current.resumedCount,
            recent: current.recent,
          },
    ),
  );

  const stopSession = (id: number, reason: VisualStudioAutoContinueStop, detail?: string) =>
    Ref.update(session, (current) =>
      current?.id === id && current.stopped === undefined
        ? { ...current, stopped: detail === undefined ? { reason } : { reason, detail } }
        : current,
    );

  const recordResumed = (id: number, window: VisualStudioWindow) =>
    Ref.update(session, (current) =>
      current?.id === id
        ? {
            ...current,
            resumedCount: current.resumedCount + 1,
            recent: [...current.recent, toResumedBreak(window)].slice(-RECENT_BREAKS),
          }
        : current,
    );

  // Runs for the whole auto-continue session; its outer operation owns the span.
  const watch = Effect.fnUntraced(function* (run: {
    readonly id: number;
    readonly solution: string;
    readonly minutes: number;
    readonly includeBreakpoints: boolean;
  }) {
    const script = yield* ensureScript;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        POWERSHELL,
        [
          ...POWERSHELL_ARGS,
          script,
          "watch",
          "-TimeoutSec",
          String(run.minutes * 60),
          ...solutionArgs(run.solution),
          ...(run.includeBreakpoints ? ["-IncludeBreakpoints"] : []),
        ],
        { shell: false, stdout: "pipe", stderr: "pipe" },
      ),
    );
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter(isJsonLine),
      Stream.mapEffect((line) => decodeWatchLine(line)),
      Stream.runForEach((event) => {
        if ("error" in event) return stopSession(run.id, "failed", event.error);
        switch (event.event) {
          case "resumed":
            return recordResumed(run.id, event);
          case "paused":
            return stopSession(run.id, "paused");
          case "ended":
            return stopSession(run.id, "debugging-ended");
          case "timeout":
            return stopSession(run.id, "time-limit");
        }
      }),
    );
    yield* child.exitCode;
  });

  const runWatch = (run: Parameters<typeof watch>[0]) =>
    watch(run).pipe(
      Effect.scoped,
      Effect.catch((cause) =>
        Effect.logWarning("Visual Studio auto-continue failed", { cause }).pipe(
          Effect.andThen(
            stopSession(run.id, "failed", "T3.CodeShip lost its connection to Visual Studio."),
          ),
        ),
      ),
      // A helper that exits without a final event did not finish its watch.
      Effect.ensuring(
        stopSession(run.id, "failed", "The Visual Studio helper stopped unexpectedly."),
      ),
    );

  const status: VisualStudioDebugger["Service"]["status"] = Effect.fn(
    "VisualStudioDebugger.status",
  )(function* (input) {
    const windows = yield* windowsFrom(yield* runScript("status", solutionArgs(input.solution)));
    return { windows, autoContinue: yield* autoContinueState };
  });

  const evaluate: VisualStudioDebugger["Service"]["evaluate"] = Effect.fn(
    "VisualStudioDebugger.evaluate",
  )(function* (input) {
    const lines = yield* runScript("eval", solutionArgs(input.solution), input.expression);
    const decoded = yield* decodeEvalLine(lines.at(-1)!).pipe(Effect.mapError(outputError));
    if ("error" in decoded) return yield* scriptFailure(decoded.error);
    return decoded;
  });

  const control: VisualStudioDebugger["Service"]["control"] = Effect.fn(
    "VisualStudioDebugger.control",
  )(function* (input) {
    return yield* lastWindow(yield* runScript(input.action, solutionArgs(input.solution)));
  });

  const autoContinue: VisualStudioDebugger["Service"]["autoContinue"] = Effect.fn(
    "VisualStudioDebugger.autoContinue",
  )(function* (input) {
    const previous = yield* Ref.get(session);
    if (previous !== undefined) yield* stopSession(previous.id, "turned-off");
    yield* FiberHandle.clear(watcher);
    if (!input.enabled) return yield* autoContinueState;

    // Pin the watch to the window chosen now, so another one that starts debugging later
    // does not take it over.
    const target = yield* lastWindow(yield* runScript("select", solutionArgs(input.solution)));
    const minutes = input.minutes ?? VISUAL_STUDIO_AUTO_CONTINUE_DEFAULT_MINUTES;
    const id = yield* Ref.updateAndGet(sessionIds, (value) => value + 1);
    yield* Ref.set(session, {
      id,
      solution: target.solution,
      untilMillis: (yield* Clock.currentTimeMillis) + minutes * 60_000,
      resumedCount: 0,
      recent: [],
    });
    yield* FiberHandle.run(
      watcher,
      runWatch({
        id,
        solution: target.solution,
        minutes,
        includeBreakpoints: input.includeBreakpoints === true,
      }),
    );
    return yield* autoContinueState;
  });

  return VisualStudioDebugger.of({ status, evaluate, control, autoContinue });
});

export const layer = Layer.effect(VisualStudioDebugger, make);
