import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VisualStudioDebugger from "./VisualStudioDebugger.ts";

interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: Array<string>;
}

type Reply = {
  readonly stdout: Stream.Stream<Uint8Array> | string;
  readonly exitCode?: Effect.Effect<number>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Arguments before the script command: the PowerShell flags and the script path.
const SCRIPT_COMMAND_INDEX = 7;

const fakePowerShell = (reply: (call: Call) => Reply) => {
  const calls: Array<Call> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      const call: Call = {
        command: args[SCRIPT_COMMAND_INDEX]!,
        args: args.slice(SCRIPT_COMMAND_INDEX + 1),
        stdin: [],
      };
      calls.push(call);
      const { stdout, exitCode = Effect.succeed(0) } = reply(call);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.map(exitCode, ChildProcessSpawner.ExitCode),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => call.stdin.push(decoder.decode(chunk))),
        ),
        stdout: typeof stdout === "string" ? Stream.make(encoder.encode(stdout)) : stdout,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const layer = VisualStudioDebugger.layer.pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-visual-studio-" })),
    Layer.provide(NodeServices.layer),
  );
  return { calls, layer };
};

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const pausedWindow = {
  solution: "C:\\repo\\App.sln",
  mode: "break",
  process: "C:\\repo\\bin\\App.exe",
  reason: "exception-thrown",
  exception: { type: "System.InvalidOperationException", details: "Order has no items" },
  location: "App.Orders.Submit",
  stack: Array.from({ length: 15 }, (_, index) => `Frame${index} [App.dll]`),
  locals: [{ name: "order", type: "App.Order", value: "{App.Order}" }],
};

describe("VisualStudioDebugger", () => {
  it.effect("reads each window the helper prints and skips PowerShell's other lines", () => {
    const powerShell = fakePowerShell(() => ({
      stdout: `WARNING: busy\n${line(pausedWindow)}${line({ solution: "C:\\repo\\Tools.sln", mode: "design" })}`,
    }));
    return Effect.gen(function* () {
      const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
      const status = yield* visualStudio.status({});
      expect(status.windows.map((window) => [window.solution, window.mode])).toEqual([
        ["C:\\repo\\App.sln", "break"],
        ["C:\\repo\\Tools.sln", "design"],
      ]);
      expect(status.windows[0]?.exception?.type).toBe("System.InvalidOperationException");
    }).pipe(Effect.provide(powerShell.layer));
  });

  it.effect("fails with the helper's reason when Visual Studio cannot be reached", () => {
    const powerShell = fakePowerShell(() => ({
      stdout: line({ error: "Visual Studio is not running on this machine." }),
      exitCode: Effect.succeed(1),
    }));
    return Effect.gen(function* () {
      const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
      const error = yield* Effect.flip(visualStudio.status({}));
      assert.strictEqual(error._tag, "VisualStudioUnavailableError");
      assert.strictEqual(error.message, "Visual Studio is not running on this machine.");
    }).pipe(Effect.provide(powerShell.layer));
  });

  it.effect("sends the expression on stdin so quotes survive the command line", () => {
    const expression = `orders["a b"].Count`;
    const powerShell = fakePowerShell(() => ({
      stdout: line({ expression, valid: true, type: "int", value: "2" }),
    }));
    return Effect.gen(function* () {
      const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
      const result = yield* visualStudio.evaluate({ expression, solution: "App" });
      expect(result.value).toBe("2");
      expect(powerShell.calls[0]?.stdin.join("")).toBe(expression);
      expect(powerShell.calls[0]?.args).toEqual(["-Solution", "App"]);
    }).pipe(Effect.provide(powerShell.layer));
  });

  it.effect("auto-continue logs each exception it passes and stops when debugging ends", () =>
    Effect.gen(function* () {
      const watchDone = yield* Deferred.make<void>();
      const powerShell = fakePowerShell((call) => {
        if (call.command === "select") return { stdout: line(pausedWindow) };
        if (call.command === "watch") {
          return {
            stdout: Stream.make(
              encoder.encode(line({ event: "resumed", ...pausedWindow })),
              encoder.encode(line({ event: "ended", resumed: 1 })),
            ),
            exitCode: Deferred.succeed(watchDone, undefined).pipe(Effect.as(0)),
          };
        }
        return { stdout: line({ solution: pausedWindow.solution, mode: "design" }) };
      });
      yield* Effect.gen(function* () {
        const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
        yield* visualStudio.autoContinue({ enabled: true });
        yield* Deferred.await(watchDone);
        const { autoContinue } = yield* visualStudio.status({});

        expect(powerShell.calls.find((call) => call.command === "watch")?.args).toEqual([
          "-TimeoutSec",
          "1800",
          "-Solution",
          "C:\\repo\\App.sln",
        ]);
        expect(autoContinue).toMatchObject({
          on: false,
          stopped: "debugging-ended",
          resumedCount: 1,
        });
        expect(autoContinue.recent[0]?.exception?.type).toBe("System.InvalidOperationException");
        expect(autoContinue.recent[0]?.stack).toHaveLength(10);
      }).pipe(Effect.provide(powerShell.layer));
    }),
  );

  it.effect("turning auto-continue off reports turned-off, not a failed watch", () => {
    const powerShell = fakePowerShell((call) =>
      call.command === "watch"
        ? { stdout: Stream.never, exitCode: Effect.never }
        : { stdout: line({ solution: pausedWindow.solution, mode: "run" }) },
    );
    return Effect.gen(function* () {
      const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
      const started = yield* visualStudio.autoContinue({ enabled: true, minutes: 5 });
      expect(started.on).toBe(true);
      const stopped = yield* visualStudio.autoContinue({ enabled: false });
      expect(stopped).toMatchObject({ on: false, stopped: "turned-off" });
    }).pipe(Effect.provide(powerShell.layer));
  });
});
