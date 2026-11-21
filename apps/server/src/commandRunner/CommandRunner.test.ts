// @effect-diagnostics nodeBuiltinImport:off - The commands under test are real processes, watched through the files they leave.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type MemoryShortage,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  isFifoHolderHeld,
  layerHeldProcessGroups,
  releaseFifoHolder,
  signalProcessGroup,
} from "@t3tools/shared/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isProcessAlive } from "@t3tools/shared/processProbe";
import {
  hostHoldsProcessGroups,
  watchFreedGroupSignals,
} from "@t3tools/shared/testing/freedProcessGroups";
import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { windowsStopTreeArgs } from "@t3tools/shared/windowsProcessTree";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { seedLiveParent } from "../orchestration-v2/testkit/LiveParentThread.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import { readProcessStartedAt } from "../serverRuntimeState.ts";
import * as CommandRunner from "./CommandRunner.ts";
import { ENDED_IDENTITY, identityWindow, timeIdentity } from "./processIdentity.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A command needs no provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Every parent wake the orchestrator offers, in order. */
class Offers extends Context.Service<
  Offers,
  Queue.Queue<ProviderContinuationRequests.ProviderContinuationRequest>
>()("t3/commandRunner/CommandRunner.test/Offers") {}
const layerOffers = Layer.effect(
  Offers,
  Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>(),
);
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "command-runner" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.effect(
      ProviderContinuationRequests.ProviderContinuationRequests,
      Offers.pipe(
        Effect.map((offers) => ({
          offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(offers, request).pipe(Effect.asVoid),
          take: Effect.never,
        })),
      ),
    ),
  ),
  Layer.provideMerge(layerOffers),
);
const layerThreads = Layer.unwrap(
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: orchestrator.dispatch,
      getThreadRecords: orchestrator.getThreadRecords,
      streamDomainEvents: orchestrator.streamDomainEvents,
    }),
  ),
);
/** The calling thread's provider, whose own settings give its shell commands these variables. */
const providerShell = (shellEnvironment?: ProviderInstance["shellEnvironment"]) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) =>
      Effect.succeed(
        id === instanceId
          ? ({
              instanceId,
              enabled: true,
              ...(shellEnvironment === undefined ? {} : { shellEnvironment }),
            } as ProviderInstance)
          : undefined,
      ),
  });
const exited = (code: number, stdout: string, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const isWindowsLaunch = (input: ProcessRunner.ProcessRunInput) =>
  input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"));
/** Fails the Windows launch, after its scripts are written, and hands over the launcher's input. */
const refuseWindowsLaunch = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  launcher: Deferred.Deferred<ProcessRunner.ProcessRunInput>,
): ProcessRunner.ProcessRunner["Service"] => ({
  run: (input) =>
    !isWindowsLaunch(input)
      ? processRunner.run(input)
      : Deferred.succeed(launcher, input).pipe(
          Effect.as(exited(1, "", "Win32_Process.Create returned 9")),
        ),
});
/** How far the wall clock of a runner on `fakeWindows` steps back during a launch, as NTP can. */
const CLOCK_STEPS_BACK_MS = 60_000;
/** How long a runner on `fakeWindows` stalls, as a busy scheduler can: both its clocks move on. */
const CLOCK_PAUSE_MS = 1_000;
/** The whole second after `at`, which a file's time keeps exactly. */
const secondAfter = (at: number) => (Math.floor(at / 1_000) + 1) * 1_000;
/** Writes the pid file a wrapper names itself in, as it does the second after `at`. */
const nameWrapper = (directory: string, pid: number, at: number) => {
  const file = NodePath.join(directory, "pid");
  NodeFS.writeFileSync(file, `${pid}\r\n`);
  NodeFS.utimesSync(file, secondAfter(at) / 1_000, secondAfter(at) / 1_000);
};
/** When the last launch on `fakeWindows` was made, which pid a start read asks about, and when. */
interface StartReadAt {
  readonly launched: number;
  readonly pid: number;
  readonly read: number;
}
/**
 * Windows on any host: a launch's wrapper is made as it returns, start reads give `startOf`, and
 * tree stops hand over their arguments. The clock stands still, so load never looks like a step,
 * but for `readTakes` and `clock`: a step back per launch, and with `stalls` a pause after each
 * yielded read before the first launch and one outlasting the step at the first after each launch.
 */
const fakeWindows = (options: {
  readonly startOf: (at: StartReadAt) => number | undefined;
  /** What the launcher prints after the pid: the wrapper's start, or that it found none. */
  readonly launcherSees?: "start" | "none";
  /** Whether the wrapper named itself in its pid file, the second after its launch, by then. */
  readonly namedItself?: boolean;
  /** The launcher fails after its wrapper started: exits non-zero after the pid, or times out. */
  readonly launcherFails?: "exits" | "times-out";
  /** How long each start read takes: both clocks move on by it. */
  readonly readTakes?: number;
  readonly clock?: { readonly stepsBack: number; readonly stalls?: boolean };
}) =>
  Effect.gen(function* () {
    const realClock = yield* Clock.Clock;
    // Not ahead of the real clock, which dates the pid files the tests leave.
    const wallAt = realClock.currentTimeMillisUnsafe();
    const monotonicAt = realClock.monotonicTimeNanosUnsafe();
    let steppedBack = 0;
    let paused = 0;
    let launched = false;
    let stallAfterLaunch = false;
    const millis = () => wallAt - steppedBack + paused;
    const monotonic = () => monotonicAt + BigInt(paused) * 1_000_000n;
    // Spans and logs read the unsafe forms, so only the runner's own yielded reads stall.
    const thenStall = <A>(read: () => A) =>
      Effect.sync(() => {
        const at = read();
        if (options.clock?.stalls === true && !launched) paused += CLOCK_PAUSE_MS;
        if (stallAfterLaunch) {
          stallAfterLaunch = false;
          paused += CLOCK_STEPS_BACK_MS + CLOCK_PAUSE_MS;
        }
        return at;
      });
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: thenStall(millis),
      currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
      currentTimeNanos: thenStall(() => BigInt(millis()) * 1_000_000n),
      monotonicTimeNanosUnsafe: monotonic,
      monotonicTimeNanos: thenStall(monotonic),
      sleep: (duration) => realClock.sleep(duration),
    };
    const standIn = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
          stdio: "ignore",
        }),
      ),
      (child) => Effect.sync(() => child.kill()),
    );
    const wrapper = standIn.pid ?? (yield* Effect.die("The stand-in wrapper did not start"));
    const launches = yield* Queue.unbounded<number>();
    const stops = yield* Queue.unbounded<ReadonlyArray<string>>();
    let lastLaunch = Number.NaN;
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) => {
        if (isWindowsLaunch(input)) {
          return Effect.gen(function* () {
            steppedBack += options.clock?.stepsBack ?? 0;
            launched = true;
            lastLaunch = millis();
            stallAfterLaunch = options.clock?.stalls === true;
            if (options.namedItself === true) {
              const wrapperPath = /-File "(.+run\.ps1)"/.exec(input.args.join(" "))?.[1] ?? "";
              nameWrapper(NodePath.dirname(wrapperPath), wrapper, lastLaunch);
            }
            yield* Queue.offer(launches, lastLaunch);
            const seen = {
              start: DateTime.formatIso(DateTime.makeUnsafe(lastLaunch)),
              none: ENDED_IDENTITY,
            };
            if (options.launcherFails === "times-out") {
              return yield* new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                timeoutMs: 30_000,
              });
            }
            if (options.launcherFails === "exits") {
              return exited(1, `${wrapper}\r\n`, "Exception getting StartTime");
            }
            const sees = options.launcherSees;
            return exited(0, `${wrapper}\r\n${sees === undefined ? "" : `${seen[sees]}\r\n`}`);
          });
        }
        const script = input.args.join(" ");
        // Before the start read: the stop's script also calls Get-Process.
        if (script.includes("Stop-T3ProcessTree")) {
          return Queue.offer(stops, input.args).pipe(Effect.as(exited(0, "")));
        }
        const startRead = /Get-Process -Id (\d+)/.exec(script);
        if (startRead !== null) {
          return Effect.sync(() => {
            const at = { launched: lastLaunch, pid: Number(startRead[1]), read: millis() };
            paused += options.readTakes ?? 0;
            const startedAt = options.startOf(at);
            return startedAt === undefined
              ? exited(1, "", "Get-Process timed out")
              : exited(0, DateTime.formatIso(DateTime.makeUnsafe(startedAt)));
          });
        }
        return Effect.die(`Not a Windows call the runner makes: ${input.command}`);
      },
    };
    const on = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      );
    return { wrapper, launches, stops, on };
  });
const PROC_STAT = /^\/proc\/\d+\/stat$/;
/**
 * Runs `before` ahead of each read of a process's start (only `pid`'s when given), from /proc on
 * Linux and by ps elsewhere, and fails that read when it gives "fail".
 */
const aroundStartReads =
  (before: Effect.Effect<"fail" | "read">, pid?: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const fs = yield* FileSystem.FileSystem;
      return yield* effect.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            input.command !== "ps" || (pid !== undefined && !input.args.includes(String(pid)))
              ? processRunner.run(input)
              : Effect.flatMap(before, (then) =>
                  then === "fail" ? Effect.succeed(exited(1, "")) : processRunner.run(input),
                ),
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) =>
            !PROC_STAT.test(path) || (pid !== undefined && path !== `/proc/${pid}/stat`)
              ? fs.readFileString(path, encoding)
              : Effect.flatMap(before, (then) =>
                  then === "fail"
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "readFileString",
                          pathOrDescriptor: path,
                        }),
                      )
                    : fs.readFileString(path, encoding),
                ),
        }),
      );
    });
/** Fails each look for a wrapper's pid file, as a run directory that refuses access does. */
const pidFileUnseen = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (path) =>
          NodePath.basename(path) !== "pid"
            ? fs.exists(path)
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "exists",
                  pathOrDescriptor: path,
                }),
              ),
      }),
    );
  });
const layerTest = Layer.mergeAll(
  layerThreads,
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  providerShell(),
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-runner-" }),
  NodeCrypto.layer,
  MemoryAdmission.layerTest(),
).pipe(
  Layer.provideMerge(layerOrchestration),
  // As the server spawns: each detached group stays held until its spawn's scope closes.
  Layer.provideMerge(layerHeldProcessGroups.pipe(Layer.provideMerge(NodeServices.layer))),
);

/**
 * One server's life: a fresh runner that picks up what an earlier one left, until `use` ends.
 * Memory is read on every pass unless `shortageRecheck` holds a shortage.
 */
const withServer = <A, E, R>(
  use: (runner: CommandRunner.CommandRunner["Service"]) => Effect.Effect<A, E, R>,
  shortageRecheck = Duration.zero,
) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner.CommandRunner;
    yield* runner.start();
    return yield* use(runner);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.fresh(CommandRunner.layer)),
    Effect.provideService(CommandRunner.WatchInterval, Duration.millis(50)),
    Effect.provideService(CommandRunner.ShortageRecheck, shortageRecheck),
  );

const callerOf = (threadId: ThreadId): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:command-runner"),
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "provider-session:command-runner",
  thread: {
    threadId,
    providerSessionId: "provider-session:command-runner",
    providerInstanceId: instanceId,
  },
  client: undefined,
});

/**
 * Resolves once `file` exists, from its state rather than folder events: on macOS a file made just
 * after `fs.watch` returns can raise none, and a sandbox refuses the watch. It looks on a timer
 * because `fs.watchFile` reports only a change from a baseline it reads after it returns, which a
 * file made meanwhile is already part of.
 */
const awaitFile = (file: string) =>
  Effect.callback<void>((resume) => {
    // @effect-diagnostics-next-line globalTimersInEffect:off - it.effect's TestClock never advances Effect.sleep, and the file comes from a real process.
    const timer = setInterval(() => {
      if (!NodeFS.existsSync(file)) return;
      clearInterval(timer);
      resume(Effect.void);
    }, 20);
    return Effect.sync(() => clearInterval(timer));
  });

/** Resolves once each of `threadIds` has been offered a wake. */
const wakesOf = (threadIds: ReadonlyArray<ThreadId>) =>
  Offers.pipe(
    Effect.flatMap((offers) => {
      const waiting = new Set<string>(threadIds);
      return Queue.take(offers).pipe(
        Effect.tap((request) => Effect.sync(() => waiting.delete(request.threadId))),
        Effect.repeat({ until: () => waiting.size === 0 }),
      );
    }),
  );

/** The next wake offered to `threadId`. */
const nextWake = (threadId: ThreadId) =>
  Offers.pipe(
    Effect.flatMap((offers) =>
      Queue.take(offers).pipe(Effect.repeat({ until: (request) => request.threadId === threadId })),
    ),
  );

describe("awaitFile", () => {
  it.effect("sees a file made right after the wait began", () =>
    Effect.gen(function* () {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-await-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
      );
      // watchFile takes its baseline stat on another thread after it returns, so a file made
      // just after can already be in that baseline, and no change is ever reported.
      yield* Effect.forEach(
        Array.from({ length: 300 }, (_, i) => NodePath.join(folder, String(i))),
        (file) =>
          Effect.all([awaitFile(file), Effect.sync(() => NodeFS.writeFileSync(file, ""))], {
            concurrency: "unbounded",
          }),
        { concurrency: "unbounded" },
      );
    }),
  );
});

const commandRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly status: string;
      readonly exit_code: number | null;
      readonly pid: number | null;
      readonly process_identity: string | null;
      readonly started_at: string;
      readonly deadline_at: string;
      readonly delivered_at: string | null;
      readonly last_alive_at: string | null;
      readonly probe_error: string | null;
      readonly lost_reason: string | null;
      readonly lost_output: string | null;
      readonly directory: string;
    }>`
      SELECT status, exit_code, pid, process_identity, started_at, deadline_at, delivered_at,
        last_alive_at, probe_error, lost_reason, lost_output, directory
      FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

/** What the record holds when its server stops between starting it and recording the pid. */
const forgetPid = (taskId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE command_runs SET pid = NULL, process_identity = NULL, last_alive_at = NULL
      WHERE task_id = ${taskId}
    `,
  );

/** Leaves a pid file naming `pid` as all that names its process, as when its server stopped. */
const leavePidFile = (taskId: string, pid: number) =>
  Effect.gen(function* () {
    const row = (yield* commandRow(taskId))!;
    yield* forgetPid(taskId);
    nameWrapper(row.directory, pid, Date.parse(row.started_at));
  });

// The runner launches without the shell configuration the environment may give, as this probe does.
const holdsGroups = hostHoldsProcessGroups();

/** Out of the runner's sight, the command's holder still keeps the number, for the cleanup to use. */
const hideHolder = (directory: string) =>
  Effect.gen(function* () {
    if (!holdsGroups) return;
    const holder = NodePath.join(directory, "group-holder");
    const hidden = `${holder}.hidden`;
    NodeFS.renameSync(holder, hidden);
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.renameSync(hidden, holder)));
  });

const taskOf = (threadId: ThreadId, taskId: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map((projection) => projection.subagents.find((task) => task.id === taskId)),
  );

/**
 * A chat whose run is live, in its own folder, whose commands are stopped, and left to no later
 * server, when the test ends.
 */
const liveChat = (name: string) =>
  Effect.gen(function* () {
    const workspace = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${name}-`)),
    );
    const parent = yield* seedLiveParent({ name, driver, modelSelection, worktreePath: workspace });
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.addFinalizer(() =>
      sql<{ readonly pid: number | null; readonly directory: string }>`
        SELECT pid, directory FROM command_runs WHERE thread_id = ${parent.threadId}
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => {
            const holder = NodePath.join(row.directory, "group-holder");
            return Effect.try(() => {
              // Once its holder is released, the group's number may be another group's.
              if (!isFifoHolderHeld(holder)) return;
              // oxlint-disable-next-line t3code/no-raw-process-group-signal -- its holder keeps the number
              signalProcessGroup(
                // A failed test can leave a row without its pid; the wrapper's pid file still names it.
                row.pid ??
                  Number.parseInt(
                    NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8"),
                    10,
                  ),
                "SIGKILL",
              );
            }).pipe(
              Effect.ignore,
              Effect.andThen(Effect.try(() => releaseFifoHolder(holder)).pipe(Effect.ignore)),
            );
          }),
        ),
        Effect.ignore,
        // The tests share one database: a later test's server would adopt these, and its fakes
        // would then answer for them.
        Effect.andThen(
          sql`
            UPDATE command_runs SET delivered_at = COALESCE(delivered_at, started_at)
            WHERE thread_id = ${parent.threadId}
          `.pipe(Effect.orDie),
        ),
        Effect.andThen(
          Effect.sync(() => NodeFS.rmSync(workspace, { recursive: true, force: true })),
        ),
      ),
    );
    return { ...parent, workspace };
  });

const deletionOf = (threadId: ThreadId) =>
  ({
    type: "thread.delete",
    commandId: CommandId.make(`command:delete:${threadId}`),
    threadId,
  }) as const;

const archiveOf = (threadId: ThreadId) =>
  ({
    type: "thread.archive",
    commandId: CommandId.make(`command:archive:${threadId}`),
    threadId,
  }) as const;

/** Ends the chat's turn, as an agent's ends after it asks, so the chat can be archived. */
const endTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const [turn] = (yield* threads.getThreadRecords(threadId, ["runs"])).runs;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`command:end-turn:${threadId}`),
      events: [
        {
          id: EventId.make(`event:end-turn:${threadId}`),
          type: "run.updated",
          threadId,
          runId: turn!.id,
          nodeId: turn!.rootNodeId!,
          providerInstanceId: turn!.providerInstanceId,
          occurredAt: now,
          payload: { ...turn!, status: "completed", completedAt: now },
        },
      ],
    });
  });

/**
 * The chat service with its first `lost` hand-overs of a command's end lost, as a dispatch that
 * fails is. `told` resolves once one is taken; each hand-over is offered to `tries`.
 */
const losingEnds = (lost: number) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const told = yield* Deferred.make<void>();
    const tries = yield* Queue.unbounded<void>();
    let attempts = 0;
    return {
      told,
      tries,
      attempts: () => attempts,
      on: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            dispatch: (command) => {
              if (command.type !== "delegated_task.command.complete") {
                return threads.dispatch(command);
              }
              attempts += 1;
              return Queue.offer(tries, undefined).pipe(
                Effect.andThen(
                  attempts <= lost
                    ? Effect.fail(
                        new Orchestrator.OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                        }),
                      )
                    : threads
                        .dispatch(command)
                        .pipe(Effect.ensuring(Deferred.succeed(told, undefined))),
                ),
              );
            },
          }),
        ),
    };
  });

/** What task_cancel records for a command. */
const cancellationOf = (threadId: ThreadId, taskId: string) =>
  ({
    type: "delegated_task.command.complete",
    commandId: CommandId.make(`command:cancel:${taskId}`),
    parentThreadId: threadId,
    taskId: NodeId.make(taskId),
    status: "cancelled",
    result: "Cancelled.",
  }) as const;

/**
 * Starts a child that writes `ready` once it can note a stop signal, and `stopped` on one. It ends
 * once the test's folder is gone, since the cleanup leaves alone a group the runner let go.
 */
const STOP_NOTING_CHILD = `sh -c 'trap "echo > stopped; exit 0" TERM; echo > ready; while [ -e ready ]; do sleep 1; done' &`;
/** Once `go` exists it kills its wrapper, leaving no exit status, then writes `orphaned`. */
const ORPHANING_COMMAND = `echo orphaning; ${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; kill -9 $PPID; echo > orphaned; wait`;

// Tests of sh, kill and process groups skip on Windows, which lacks them. Its wrapper's stop and lost paths are
// tested in "a Windows command whose wrapper ended".

// Real processes and the real clock: the runner watches commands on a wall-clock interval.
it.layer(layerTest, { excludeTestServices: true })("a command run apart from its agent", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "keeps running through a restart and wakes its chat once with its end",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-survives");
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "until [ -e go ]; do sleep 0.05; done; echo checked; exit 3",
            label: "Checks",
          }),
        );
        // The first server is gone; the command still waits for its go.
        const wake = yield* withServer(() =>
          Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")).pipe(
            Effect.andThen(nextWake(chat.threadId)),
          ),
        );
        assert.equal(wake.threadId, chat.threadId);
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "failed");
        assert.match(task?.result ?? "", /^Exited with code 3 after .+\.\nLast output:\nchecked\n/);
        assert.include(task?.result ?? "", `Full output: ${started.logPath}`);
        // A later server, even one that starts before the end was marked delivered, wakes the chat
        // for nothing but the next command's end.
        const next = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), { command: "echo second" })
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        assert.equal((yield* taskOf(chat.threadId, next.taskId))?.status, "completed");
        const row = yield* commandRow(started.taskId);
        assert.equal(row?.status, "exited");
        assert.isNotNull(row?.delivered_at);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "delivers an end that came while no server was running, once one starts",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-ends-while-down");
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "until [ -e go ]; do sleep 0.05; done; echo built",
          }),
        );
        const statusFile = NodePath.join(NodePath.dirname(started.logPath), "exit-status");
        const ended = awaitFile(statusFile);
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
        yield* ended;
        // The status file is written as it ends, so its time is the end, not the next server's start.
        const startedAt = Date.parse((yield* commandRow(started.taskId))!.started_at);
        const endedAtSeconds = (startedAt + 42_000) / 1000;
        NodeFS.utimesSync(statusFile, endedAtSeconds, endedAtSeconds);
        yield* withServer(() => nextWake(chat.threadId));
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        assert.match(task?.result ?? "", /^Exited with code 0 after 42s\.\nLast output:\nbuilt\n/);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "adopts a command whose server stopped before it recorded the pid",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-pid-unrecorded");
        const running = awaitFile(NodePath.join(chat.workspace, "running"));
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo > running; until [ -e go ]; do sleep 0.05; done; echo adopted",
          }),
        );
        // Its wrapper names itself before it runs the command; a restart takes far longer.
        yield* running;
        yield* forgetPid(started.taskId);
        yield* withServer(() =>
          Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")).pipe(
            Effect.andThen(nextWake(chat.threadId)),
          ),
        );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.match(task?.result ?? "", /^Exited with code 0 after .+\.\nLast output:\nadopted\n/);
        assert.isNotNull((yield* commandRow(started.taskId))?.pid);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps the end of a log that grew too large, after a note that it was cut",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-log-trimmed");
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), {
              command: "head -c 9000000 /dev/zero | tr '\\0' x; echo; echo last-line",
            })
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        const log = NodeFS.readFileSync(started.logPath, "utf8");
        assert.match(
          log,
          /^\[CodeShip removed earlier output to keep this log small\]\nx+\nlast-line\n$/,
        );
        assert.isBelow(log.length, 8 * 1024 * 1024);
      }),
  );

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
    it.effect.each([
      ["names another process's start", "command-recovered-other", true],
      ["is missing, as an older server left it", "command-recovered-unowned", false],
    ] as const)(
      "leaves running the group of a recovered command whose recorded identity %s",
      ([, name, otherStart]) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(name);
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* awaitFile(NodePath.join(chat.workspace, "ready"));
          // A running holder keeps the pid the command's, whatever the file says.
          yield* hideHolder(NodePath.dirname(started.logPath));
          const file = NodePath.join(NodePath.dirname(started.logPath), "identity");
          if (otherStart && isLinuxHost) {
            const [, boot = ""] = NodeFS.readFileSync(file, "utf8").split("\n");
            NodeFS.writeFileSync(file, `1 (x) S ${"0 ".repeat(18)}1\n${boot}\n`);
          } else if (otherStart) {
            NodeFS.writeFileSync(file, "Sat Jan  1 00:00:00 2000\n");
          } else {
            NodeFS.rmSync(file);
          }
          yield* forgetPid(started.taskId);
          yield* withServer(() => nextWake(chat.threadId));
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "lost");
          assert.equal(row?.lost_reason, "pid-reused");
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );

    it.effect.each([
      ["/t3-agent-tools", true, "command-agent-shell"],
      ["", true, "command-agent-shell-empty-path"],
      ["/t3-agent-tools", false, "command-agent-shell-no-host-path"],
      ["", false, "command-agent-shell-empty-path-no-host-path"],
    ] as const)(
      "gives a command what its agent's own shell commands get, shell options only to the command, PATH %j, host PATH %s",
      ([PATH, hostHasPath, name]) =>
        Effect.gen(function* () {
          const { PATH: _hostPath, ...hostWithoutPath } = process.env;
          const chat = yield* liveChat(name);
          NodeFS.mkdirSync(NodePath.join(chat.workspace, "sub"));
          const started = yield* withServer((runner) =>
            runner
              .run(callerOf(chat.threadId), {
                command:
                  'printf "%s %s %s %s\\n%s\\n%s\\n" "$AGENT_SETTING" "$T3CODE_THREAD_ID" "$HOST_KEPT" "${HOST_REMOVED-removed}" "$PATH" "$SHELLOPTS"; exit 7',
                cwd: "sub",
              })
              .pipe(Effect.tap(() => nextWake(chat.threadId))),
          ).pipe(
            Effect.provide(
              providerShell((cwd, { HOST_REMOVED: _removed, ...inherited }) =>
                // A PATH without the wrapper's own tools, which it still needs to record the end.
                // sh reads no startup files that could add to it.
                Effect.succeed({
                  ...inherited,
                  AGENT_SETTING: `set for ${cwd}`,
                  PATH,
                  SHELL: "/bin/sh",
                  // bash as /bin/sh takes this as its own option; dash ignores it.
                  SHELLOPTS: "errexit",
                }),
              ),
            ),
            Effect.provideService(HostProcess.Environment, {
              ...(hostHasPath ? process.env : hostWithoutPath),
              HOST_KEPT: "kept",
              HOST_REMOVED: "host",
            }),
          );
          const [seen, commandPath, shellOptions] = NodeFS.readFileSync(
            started.logPath,
            "utf8",
          ).split("\n");
          // Read for the chat's folder, as the agent's own settings were, though it ran below it.
          assert.equal(started.shell, "sh");
          assert.equal(seen, `set for ${chat.workspace} ${chat.threadId} kept removed`);
          assert.equal(commandPath, PATH);
          assert.match(shellOptions ?? "", /errexit/);
          const task = yield* taskOf(chat.threadId, started.taskId);
          assert.equal(task?.status, "failed");
          assert.match(task?.result ?? "", /^Exited with code 7 after /);
        }),
    );
  });

  it.effect(
    "starts a Windows command from a hidden wrapper, with the host environment under its agent's in Unicode, each name once, writing no value and reading none to start",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-environment");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const refused = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "Write-Output started" }),
        ).pipe(
          Effect.flip,
          Effect.provide(
            // Spellings Windows reads as one name; the later one is the value the agent's own get.
            providerShell(
              (_cwd, { HOST_REMOVED: _removed, SystemRoot: _systemRoot, ...inherited }) =>
                Effect.succeed({
                  ...inherited,
                  PATH: "C:\\agent",
                  AGENT_SETTING: "from user settings",
                  agent_setting: "from settings",
                }),
            ),
          ),
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, {
            Path: "C:\\host",
            HOST_ONLY: "kept",
            HOST_REMOVED: "removed by its settings",
            SystemRoot: "C:\\Windows",
            T3CODE_AUTH_TOKEN: "server only",
          }),
        );
        assert.include(refused.message, "Win32_Process.Create returned 9");
        const launch = yield* Deferred.await(launcher);
        assert.deepEqual(
          Buffer.from(launch.stdin ?? "", "base64")
            .toString("utf8")
            .split("\0")
            .toSorted(),
          [
            "HOST_ONLY=kept",
            "PATH=C:\\agent",
            `T3CODE_THREAD_ID=${chat.threadId}`,
            "agent_setting=from settings",
          ],
        );
        const launcherScript = launch.args.join(" ");
        assert.include(launcherScript, "CreateFlags = [uint32]1024");
        // SW_HIDE: otherwise every command opens a console window on the user's desktop.
        assert.include(launcherScript, "ShowWindow = [uint16]0");
        assert.include(
          launcherScript,
          "HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
        );
        assert.include(
          launcherScript,
          "Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
        );
        const runPath = /-File "(.+run\.ps1)"/.exec(launcherScript)?.[1] ?? "";
        // The wrapper reads no variable, so no setting can move the cmd or PowerShell it starts.
        assert.notMatch(NodeFS.readFileSync(runPath, "utf8"), /\$env:/i);
        const scriptPath = NodePath.join(NodePath.dirname(runPath), "command.ps1");
        for (const file of [runPath, scriptPath]) {
          assert.notInclude(NodeFS.readFileSync(file, "utf8"), "from settings");
        }
      }),
  );

  // PowerShell 5.1 drops a `"` inside an argument to a program, so `bash -c '<command>'` lost them.
  it.effect(
    "hands a Windows bash command to Git Bash as a file whose path is its only argument, so PowerShell never reads it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-bash-file");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const command = `grep -E "^# (pass|fail)" results.txt\necho '$t3Ok' "a \\"b\\"" \`date\``;
        yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command, shell: "bash" }),
        ).pipe(
          Effect.flip,
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
        );
        const launch = yield* Deferred.await(launcher);
        const folder = NodePath.dirname(
          /-File "(.+run\.ps1)"/.exec(launch.args.join(" "))?.[1] ?? "",
        );
        const bashScript = NodePath.join(folder, "command.sh");
        assert.equal(NodeFS.readFileSync(bashScript, "utf8"), command);
        const powershell = NodeFS.readFileSync(NodePath.join(folder, "command.ps1"), "utf8");
        assert.notInclude(powershell, "results.txt");
        assert.include(
          powershell,
          `ProcessStartInfo]::new([IO.Path]::Combine($t3GitBash, 'bash.exe'), '"${bashScript.replaceAll("\\", "/")}"')`,
        );
      }),
  );

  /** Runs a command on `windows`, which a cancel ends while no server runs; then the next server. */
  const cancelledWhileNoServerRan = (
    windows: Effect.Success<ReturnType<typeof fakeWindows>>,
    threadId: ThreadId,
    between: (taskId: string) => Effect.Effect<void, never, SqlClient.SqlClient> = () =>
      Effect.void,
  ) =>
    Effect.gen(function* () {
      const started = yield* windows.on(
        withServer((runner) => runner.run(callerOf(threadId), { command: "Write-Output started" })),
      );
      const launched = yield* Queue.take(windows.launches);
      yield* between(started.taskId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch(cancellationOf(threadId, started.taskId));
      // A run waits until the server has adopted what the earlier one left, stopping this one.
      yield* windows.on(
        withServer((runner) => runner.run(callerOf(threadId), { command: "Write-Output next" })),
      );
      return { row: (yield* commandRow(started.taskId))!, launched };
    });

  // Otherwise a process that took the pid after its wrapper ended passes for the wrapper.
  it.effect.each([
    ["while the clock held", "command-win-launched", { stepsBack: 0 }],
    [
      "once the clock stepped back during it",
      "command-win-launch-stepped",
      { stepsBack: CLOCK_STEPS_BACK_MS },
    ],
    [
      "once the clock stepped back during it, and the server stalled around it",
      "command-win-launch-stalled",
      { stepsBack: CLOCK_STEPS_BACK_MS, stalls: true },
    ],
  ] as const)(
    "bounds a Windows command's tree stop to a root made between its record and its launch's return, each widened by how far the clock stepped back, %s, when its wrapper's start could not be read",
    ([, name, clock]) =>
      Effect.gen(function* () {
        // First, so its stand-in outlives the chat's cleanup, which signals the recorded pid.
        const windows = yield* fakeWindows({ startOf: () => undefined, clock });
        const chat = yield* liveChat(name);
        const { row, launched } = yield* cancelledWhileNoServerRan(windows, chat.threadId);
        const since = Date.parse(row.started_at);
        const bounds = identityWindow(row.process_identity)!;
        assert.deepEqual(yield* Queue.clear(windows.stops), [
          windowsStopTreeArgs({ pid: windows.wrapper, since, created: bounds }),
        ]);
        // By the step alone, which no stall widens.
        assert.equal(since - bounds.from, clock.stepsBack);
        // Its wrapper is stamped as it was made: after the step, or as much later just before it.
        assert.isAtMost(bounds.from, launched);
        assert.isAtLeast(bounds.to, launched + clock.stepsBack);
      }),
  );

  it.effect.each([
    [
      "its launcher, though the clock stepped back during the launch",
      "command-win-launcher-read",
      true,
      0,
    ],
    [
      "right after its launch, made just before the clock stepped back during it",
      "command-win-launch-read",
      false,
      CLOCK_STEPS_BACK_MS,
    ],
  ] as const)(
    "pins a Windows command's tree stop to its wrapper's start, read by %s",
    ([, name, launcherReads, madeAfterLaunch]) =>
      Effect.gen(function* () {
        const windows = yield* fakeWindows({
          startOf: ({ launched }) => (launcherReads ? undefined : launched + madeAfterLaunch),
          ...(launcherReads ? { launcherSees: "start" as const } : {}),
          clock: { stepsBack: CLOCK_STEPS_BACK_MS },
        });
        const chat = yield* liveChat(name);
        const { launched } = yield* cancelledWhileNoServerRan(windows, chat.threadId);
        const made = launched + madeAfterLaunch;
        assert.deepEqual(yield* Queue.clear(windows.stops), [
          windowsStopTreeArgs({
            pid: windows.wrapper,
            since: made,
            created: { from: made, to: made },
          }),
        ]);
      }),
  );

  it.effect.each([
    ["a second and a half", "command-win-launch-read-reused", 1_500],
    // Within the second a later read allows, which the stop's root does not.
    ["half a second", "command-win-launch-read-reused-soon", 500],
  ] as const)(
    "bounds a Windows command's tree stop to its launch, not to a process that took its pid %s after the start read right after the launch began",
    ([, name, after]) =>
      Effect.gen(function* () {
        let holderMade: number | undefined;
        const windows = yield* fakeWindows({
          startOf: ({ read }) => (holderMade ??= read + after),
          readTakes: 2_000,
        });
        const chat = yield* liveChat(name);
        const { row, launched } = yield* cancelledWhileNoServerRan(windows, chat.threadId);
        const from = Date.parse(row.started_at);
        assert.deepEqual(yield* Queue.clear(windows.stops), [
          windowsStopTreeArgs({
            pid: windows.wrapper,
            since: from,
            created: { from, to: launched },
          }),
        ]);
      }),
  );

  it.effect.each([
    ["finds", "command-win-launcher-found-none", false],
    ["cannot look for", "command-win-launcher-found-none-unseen", true],
  ] as const)(
    "reports a Windows command lost at once without reading its pid's holder, and stops it with no holder of its pid as root from its record, which a clock step back put after its pid file, once its launcher found its wrapper gone and another process holds the pid, with a pid file the launch %s",
    ([, name, unseen]) =>
      Effect.gen(function* () {
        let startReads = 0;
        const windows = yield* fakeWindows({
          // Inside the window the clock's step back widened by a minute, which would pass it for
          // the wrapper.
          startOf: ({ launched }) => {
            startReads += 1;
            return launched + 1_000;
          },
          launcherSees: "none",
          namedItself: true,
          clock: { stepsBack: CLOCK_STEPS_BACK_MS },
        });
        const chat = yield* liveChat(name);
        const server = windows.on(
          withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                command: "Write-Output started",
              });
              yield* nextWake(chat.threadId);
              const row = (yield* commandRow(started.taskId))!;
              assert.deepEqual(
                [row.status, row.lost_reason, startReads, yield* Queue.clear(windows.stops)],
                [
                  "lost",
                  "pid-reused",
                  0,
                  [
                    windowsStopTreeArgs({
                      pid: windows.wrapper,
                      since: Date.parse(row.started_at),
                      created: { from: 0, to: 0 },
                    }),
                  ],
                ],
              );
            }),
          ),
        );
        yield* unseen ? pidFileUnseen(server) : server;
      }),
  );

  it.effect.each([
    ["exits non-zero after printing its pid", "command-win-launcher-exits", "exits"],
    ["times out after its wrapper started", "command-win-launcher-times-out", "times-out"],
  ] as const)(
    "watches a Windows command whose launcher %s, instead of reporting it unstarted",
    ([, name, launcherFails]) =>
      Effect.gen(function* () {
        const windows = yield* fakeWindows({
          startOf: () => undefined,
          namedItself: true,
          launcherFails,
        });
        const chat = yield* liveChat(name);
        yield* windows.on(
          withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                command: "Write-Output started",
              });
              const row = yield* commandRow(started.taskId);
              assert.deepEqual([row?.status, row?.pid], ["running", windows.wrapper]);
            }),
          ),
        );
      }),
  );

  it.effect(
    "fails to start a Windows command whose launcher found its wrapper gone before it named itself, and leaves nothing to stop",
    () =>
      Effect.gen(function* () {
        const windows = yield* fakeWindows({ startOf: () => undefined, launcherSees: "none" });
        const chat = yield* liveChat("command-win-wrapper-ended-unnamed");
        const failed = yield* windows.on(
          withServer((runner) =>
            runner
              .run(callerOf(chat.threadId), { command: "Write-Output started" })
              .pipe(Effect.flip),
          ),
        );
        const task = (yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
        )).subagents.find((subagent) => subagent.command !== undefined);
        assert.deepEqual(
          [
            failed.message,
            task?.status,
            yield* commandRow(task?.id ?? ""),
            yield* Queue.clear(windows.stops),
          ],
          [
            "Could not start the command: PowerShell ended before it started the command.",
            "failed",
            undefined,
            [],
          ],
        );
      }),
  );

  it.effect(
    "reports a Windows command lost, and stops it bounded to its launch, once a later server finds under its pid a process made after that launch, though its wrapper's own start could not be read",
    () =>
      Effect.gen(function* () {
        const holder: { startedAt: number | undefined } = { startedAt: undefined };
        // Once: the next command's own start read must not find that process.
        const windows = yield* fakeWindows({
          startOf: () => {
            const startedAt = holder.startedAt;
            holder.startedAt = undefined;
            return startedAt;
          },
        });
        const chat = yield* liveChat("command-win-pid-reused");
        const started = yield* windows.on(
          withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: "Write-Output started" }),
          ),
        );
        holder.startedAt = (yield* Queue.take(windows.launches)) + 60_000;
        // A run waits until the server has adopted what the earlier one left.
        yield* windows.on(
          withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: "Write-Output next" }),
          ),
        );
        const row = (yield* commandRow(started.taskId))!;
        const since = Date.parse(row.started_at);
        const bounds = identityWindow(row.process_identity)!;
        assert.deepEqual(
          [row.status, row.lost_reason, row.pid, yield* Queue.clear(windows.stops)],
          [
            "lost",
            "pid-reused",
            windows.wrapper,
            [windowsStopTreeArgs({ pid: windows.wrapper, since, created: bounds })],
          ],
        );
      }),
  );

  it.effect.each([
    [
      "once its wrapper had ended, with no holder of its pid as root",
      "command-win-recovered-gone",
      true,
    ],
    // A process that took its pid later, after its file was written, is not taken for its root.
    [
      "while its wrapper ran, its start unread, as made between its record and its file",
      "command-win-recovered",
      false,
    ],
  ] as const)(
    "stops a Windows command that a later server recovered from its pid file %s",
    ([, name, gone]) =>
      Effect.gen(function* () {
        const windows = yield* fakeWindows({ startOf: () => undefined });
        const chat = yield* liveChat(name);
        // Past any pid_max, so the probe finds no process.
        const pid = gone ? 2 ** 31 - 1 : windows.wrapper;
        const { row } = yield* cancelledWhileNoServerRan(windows, chat.threadId, (taskId) =>
          leavePidFile(taskId, pid).pipe(Effect.orDie),
        );
        const recorded = Date.parse(row.started_at);
        const named = secondAfter(recorded);
        assert.deepEqual(yield* Queue.clear(windows.stops), [
          // Whatever holds a gone wrapper's pid is another process, so it is no root. No clock
          // reading caps its children: one taken after a step back can come before their starts.
          windowsStopTreeArgs({
            pid,
            since: named,
            created: gone ? { from: 0, to: 0 } : { from: recorded, to: named },
          }),
        ]);
      }),
  );

  it.effect.each([
    [
      "its agent's shell environment cannot be read",
      "command-agent-shell-unreadable",
      providerShell(() =>
        Effect.fail(
          new ProviderDriverError({ driver, instanceId, detail: "settings.json is not JSON" }),
        ),
      ),
      "settings.json is not JSON",
    ],
    [
      "its agent's provider is no longer running",
      "command-agent-provider-gone",
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.undefined,
      }),
      "provider is turned off or not running",
    ],
    [
      // Its secrets were never resolved, so its shell environment would run the command without them.
      "its agent's provider is turned off",
      "command-agent-provider-off",
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed({ instanceId, enabled: false } as ProviderInstance),
      }),
      "provider is turned off",
    ],
  ] as const)("starts no command when %s", ([, name, providers, message]) =>
    Effect.gen(function* () {
      const chat = yield* liveChat(name);
      const failed = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "true" }),
      ).pipe(Effect.provide(providers), Effect.flip);
      assert.equal(failed.code, "provider_unavailable");
      assert.include(failed.message, message);
      const projection = yield* Orchestrator.OrchestratorV2.pipe(
        Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
      );
      assert.lengthOf(projection.subagents, 0);
    }),
  );

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
    describe.skipIf(!holdsGroups)(
      "where a holder keeps the number of a group its wrapper left",
      () => {
        it.effect.each([
          ["while no server runs", "command-lost", false, false],
          [
            "before its server recorded the pid, while no server runs",
            "command-lost-pid-unrecorded",
            false,
            true,
          ],
          ["while a server watches it", "command-lost-watched", true, false],
        ] as const)(
          "reports a command whose wrapper was killed %s as lost, and stops what it started",
          ([, name, watching, pidUnrecorded]) =>
            Effect.gen(function* () {
              const chat = yield* liveChat(name);
              // As a reboot would; what it started lives on.
              const request = { command: ORPHANING_COMMAND };
              const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
              const orphaned = awaitFile(NodePath.join(chat.workspace, "orphaned"));
              const go = ready.pipe(
                Effect.andThen(
                  Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")),
                ),
              );
              const started = watching
                ? yield* withServer((runner) =>
                    runner
                      .run(callerOf(chat.threadId), request)
                      .pipe(Effect.tap(() => go.pipe(Effect.andThen(nextWake(chat.threadId))))),
                  )
                : yield* withServer((runner) => runner.run(callerOf(chat.threadId), request)).pipe(
                    Effect.tap(({ taskId }) =>
                      go.pipe(
                        Effect.andThen(orphaned),
                        Effect.andThen(pidUnrecorded ? forgetPid(taskId) : Effect.void),
                        Effect.andThen(withServer(() => nextWake(chat.threadId))),
                      ),
                    ),
                  );
              const task = yield* taskOf(chat.threadId, started.taskId);
              assert.equal(task?.status, "failed");
              assert.match(task?.result ?? "", /without an exit status/);
              const row = yield* commandRow(started.taskId);
              assert.equal(row?.status, "lost");
              // How it ended stays on its record.
              assert.equal(row?.lost_reason, "gone");
              assert.equal(row?.probe_error, "ESRCH");
              assert.equal(row?.last_alive_at === null, pidUnrecorded);
              assert.include(row?.lost_output ?? "", "orphaning");
              assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
            }),
        );
      },
    );

    // As if an unrelated group took the number of the command's once that ended, and left members.
    it.effect("signals no group after the command's own ended with its wrapper", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-group-freed");
        const { started, signals } = yield* withServer((runner) =>
          Effect.gen(function* () {
            const freed = yield* watchFreedGroupSignals;
            const started = yield* runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND });
            go(chat);
            yield* nextWake(chat.threadId);
            return { started, signals: freed.signals() };
          }),
        );

        assert.equal((yield* commandRow(started.taskId))?.lost_reason, "gone");
        assert.deepEqual(signals, []);
      }),
    );

    it.effect.skipIf(!holdsGroups)(
      "waits while a probe cannot tell whether its wrapper runs, stopping nothing and still trimming its log",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-probe-unknown");
          const probes = yield* Queue.unbounded<void>();
          const kill = process.kill.bind(process);
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const orphaned = awaitFile(NodePath.join(chat.workspace, "orphaned"));
          yield* withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                // As ORPHANING_COMMAND, with a log too large once `go` exists.
                command: `${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; head -c 9000000 /dev/zero | tr '\\0' x; echo; kill -9 $PPID; echo > orphaned; wait`,
              });
              yield* ready;
              const wrapperPid = (yield* commandRow(started.taskId))!.pid!;
              // A probe failure that is not ESRCH, as an overloaded or restricted host can give.
              const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
                if (pid !== wrapperPid || signal !== 0) return kill(pid, signal);
                Queue.offerUnsafe(probes, undefined);
                throw Object.assign(new Error(`kill EIO ${pid}`), { code: "EIO" });
              });
              yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
              NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
              yield* orphaned;
              // Its wrapper is gone, and the check that made the first later probe has finished.
              yield* Queue.clear(probes);
              yield* Queue.take(probes);
              yield* Queue.take(probes);
              const waiting = yield* commandRow(started.taskId);
              assert.equal(waiting?.status, "running");
              assert.equal(waiting?.probe_error, "EIO");
              assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
              const log = NodeFS.readFileSync(started.logPath, "utf8");
              assert.match(log, /^\[CodeShip removed earlier output to keep this log small\]\n/);
              assert.isBelow(log.length, 8 * 1024 * 1024);
              probe.mockRestore();
              yield* nextWake(chat.threadId);
              const lost = yield* commandRow(started.taskId);
              assert.equal(lost?.lost_reason, "gone");
              assert.equal(lost?.probe_error, "ESRCH");
              assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
            }),
          );
        }),
    );
  });

  it.effect.skipIf(isWindowsHost)(
    "watches a command whose request was cancelled while it started",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-request-cancelled");
        const agentScope = yield* AgentScope;
        const launching = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const ended = yield* withServer((runner) =>
          Effect.gen(function* () {
            const request = yield* runner
              .run(callerOf(chat.threadId), {
                command: "until [ -e go ]; do sleep 0.05; done; echo watched",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(launching);
            // What a cancelled MCP call does to its handler.
            yield* Effect.forkChild(Fiber.interrupt(request), { startImmediately: true });
            yield* Deferred.succeed(proceed, undefined);
            yield* Fiber.await(request);
            const projection = yield* Orchestrator.OrchestratorV2.pipe(
              Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
            );
            const task = projection.subagents.find((each) => each.command !== undefined);
            assert.isNotNull((yield* commandRow(task!.id))?.pid);
            NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
            yield* nextWake(chat.threadId);
            return yield* taskOf(chat.threadId, task!.id);
          }),
        ).pipe(
          Effect.provideService(AgentScope, {
            ...agentScope,
            wrap: (input) =>
              Deferred.succeed(launching, undefined).pipe(
                Effect.andThen(Deferred.await(proceed)),
                Effect.andThen(agentScope.wrap(input)),
              ),
          }),
        );
        assert.equal(ended?.status, "completed");
        assert.match(ended?.result ?? "", /Last output:\nwatched\n/);
      }),
  );

  it.effect.each([
    [
      "its chat was deleted",
      "command-chat-deleted-early",
      (threadId: ThreadId) => deletionOf(threadId),
      "Stopped: the chat was deleted.",
    ],
    [
      "its task was cancelled",
      "command-cancelled-early",
      (threadId: ThreadId, taskId: string) => cancellationOf(threadId, taskId),
      "Cancelled.",
    ],
  ] as const)(
    "never starts a command when %s while its request was recorded",
    ([, name, close, message]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const refused = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo started" }).pipe(Effect.flip),
        ).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            dispatch: (command) =>
              threads.dispatch(command).pipe(
                Effect.tap((recorded) => {
                  const task = recorded.storedEvents.find(
                    (stored) => stored.event.type === "subagent.updated",
                  )?.event;
                  return command.type === "delegated_task.command.request" &&
                    task?.type === "subagent.updated"
                    ? threads.dispatch(close(chat.threadId, task.payload.id))
                    : Effect.void;
                }),
              ),
          }),
        );
        assert.equal(refused.message, message);
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT task_id FROM command_runs WHERE thread_id = ${chat.threadId}`;
        assert.lengthOf(rows, 0);
      }),
  );

  it.effect.skipIf(isWindowsHost)("stops a command whose chat was deleted while it started", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-chat-deleted-late");
      const agentScope = yield* AgentScope;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const starting = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const deletionStopHeld = yield* Deferred.make<void>();
      const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
      const stopped = awaitFile(NodePath.join(chat.workspace, "stopped"));
      const started = yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = yield* runner
            .run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` })
            .pipe(Effect.forkChild);
          yield* Deferred.await(starting);
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.dispatch(deletionOf(chat.threadId))),
          );
          yield* Deferred.succeed(proceed, undefined);
          const result = yield* Fiber.join(request);
          yield* stopped;
          return result;
        }),
      ).pipe(
        // run() wraps the command just before it spawns it, holding the lock until it watches it.
        Effect.provideService(AgentScope, {
          ...agentScope,
          wrap: (input) =>
            Deferred.succeed(starting, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(agentScope.wrap(input)),
            ),
        }),
        // The deletion records the task's end before it stops the command, which by then can note
        // the stop signal; one that came first would end it without a note. A failed start's end,
        // with no child to write `ready`, passes at once.
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          dispatch: (command) =>
            (command.type === "delegated_task.command.complete" &&
            command.commandId === `command:command-task-deleted:${command.taskId}`
              ? ready.pipe(Effect.andThen(Deferred.succeed(deletionStopHeld, undefined)))
              : Effect.void
            ).pipe(Effect.andThen(threads.dispatch(command))),
        }),
      );
      assert.isTrue(yield* Deferred.isDone(deletionStopHeld));
      assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
    }),
  );

  it.effect.skipIf(isWindowsHost)(
    "never starts a command for a retry of a request that could not start it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-unstarted");
        const request = { command: "echo started", clientRequestId: "command-unstarted" };
        const unstartable = yield* AgentScope;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), request).pipe(Effect.flip),
        ).pipe(
          Effect.provideService(AgentScope, {
            ...unstartable,
            wrap: ({ args }) => Effect.succeed({ command: "/nonexistent/t3-shell", args }),
          }),
        );
        assert.match(first.message, /^Could not start the command: /);
        const retried = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), request).pipe(Effect.flip),
        );
        assert.equal(retried.message, first.message);
        const projection = yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
        );
        const tasks = projection.subagents.filter((task) => task.command !== undefined);
        assert.deepEqual(
          tasks.map((task) => task.status),
          ["failed"],
        );
        assert.isUndefined(yield* commandRow(tasks[0]!.id));
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "stops everything the command started when its task is cancelled",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-cancelled");
        const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
        const stopped = awaitFile(NodePath.join(chat.workspace, "stopped"));
        yield* withServer((runner) =>
          Effect.gen(function* () {
            // A grandchild that notes the stop signal, so the test sees the whole tree got it.
            const started = yield* runner.run(callerOf(chat.threadId), {
              command: `${STOP_NOTING_CHILD} wait`,
            });
            yield* ready;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
            yield* stopped;
            const row = yield* commandRow(started.taskId);
            assert.equal(row?.status, "stopped");
          }),
        );
      }),
  );

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
    const stopsOnceAServerStarts = ([, name, cutStop, wrapperGone]: readonly [
      string,
      string,
      boolean,
      boolean,
    ]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
        const orphaned = awaitFile(NodePath.join(chat.workspace, "orphaned"));
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
          }),
        );
        yield* ready;
        if (wrapperGone) {
          // Its wrapper ended, as it does on the stop signal, while what it started still runs.
          NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
          yield* orphaned;
        }
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
        if (cutStop) {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE command_runs SET status = 'stopped', ended_at = started_at
            WHERE task_id = ${started.taskId}
          `;
        }
        // A run waits until the server has adopted what the earlier one left.
        yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));
        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        const row = yield* commandRow(started.taskId);
        assert.equal(row?.status, "stopped");
        assert.isNotNull(row?.delivered_at);
      });

    it.effect.each([
      ["its task is cancelled while no server runs", "command-cancelled-down", false, false],
      ["its server stopped before it finished stopping it", "command-stop-cut", true, false],
    ] as const)("stops a command when %s, once a server starts", stopsOnceAServerStarts);

    describe.skipIf(!holdsGroups)(
      "where a holder keeps the number of a group its wrapper left",
      () => {
        it.effect.each([
          [
            "its server stopped while stopping it, after its wrapper ended",
            "command-stop-orphaned",
            true,
            true,
          ],
        ] as const)("stops a command when %s, once a server starts", stopsOnceAServerStarts);
      },
    );

    it.effect(
      "signals no group under a running pid whose start it cannot tell, without a holder",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-identity-unknown");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          const run = (yield* commandRow(started.taskId))!;
          yield* hideHolder(run.directory);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
          UPDATE command_runs SET process_identity = NULL WHERE task_id = ${started.taskId}
        `;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));

          assert.isTrue(isProcessAlive(run.pid!));
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );

    it.effect.skipIf(!holdsGroups)(
      "stops a command whose pid its server never recorded while its holder keeps the number",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-pid-file-older");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          const run = (yield* commandRow(started.taskId))!;
          yield* forgetPid(started.taskId);
          // A later step of the wall clock moves the start ps reports past when it wrote its pid.
          NodeFS.utimesSync(NodePath.join(run.directory, "pid"), 946_684_800, 946_684_800);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));

          assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
          assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
        }),
    );

    it.effect(
      "signals no process under an unrecorded pid whose start it cannot read, without a holder",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-pid-unrecorded-unread");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const decoyReady = awaitFile(NodePath.join(chat.workspace, "decoy-ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          const run = (yield* commandRow(started.taskId))!;
          yield* hideHolder(run.directory);
          // A group leader that took the pid the wrapper's file names after the file was written.
          const decoy = NodeChildProcess.spawn(
            "sh",
            [
              "-c",
              `trap "echo > decoy-stopped; exit 0" TERM; echo > decoy-ready; while [ -e decoy-ready ]; do sleep 1; done`,
            ],
            { cwd: chat.workspace, detached: true, stdio: "ignore" },
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => decoy.kill("SIGKILL")));
          yield* decoyReady;
          const pidFile = NodePath.join(run.directory, "pid");
          const named = NodeFS.readFileSync(pidFile, "utf8");
          NodeFS.writeFileSync(pidFile, `${decoy.pid}\n`);
          if (!isLinuxHost) {
            // ps reads whole seconds, so the wrapper's recorded start goes well before the decoy's.
            NodeFS.writeFileSync(
              NodePath.join(run.directory, "identity"),
              "Sat Jan  1 00:00:00 2000\n",
            );
          }
          yield* forgetPid(started.taskId);
          const sql = yield* SqlClient.SqlClient;
          // So that the cleanup finds the command's own group.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.writeFileSync(pidFile, named)).pipe(
              Effect.andThen(
                sql`UPDATE command_runs SET pid = ${run.pid}, process_identity = ${run.process_identity} WHERE task_id = ${started.taskId}`,
              ),
              Effect.ignore,
            ),
          );
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          let startReads = 0;
          yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: "true" }),
          ).pipe(
            aroundStartReads(
              Effect.sync(() => {
                startReads += 1;
                return startReads === 1 ? "fail" : "read";
              }),
              decoy.pid!,
            ),
          );

          assert.isAbove(startReads, 0);
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "decoy-stopped")));
        }),
    );
  });

  describe.runIf(isLinuxHost)("Linux process identity", () => {
    it.effect(
      "still stops a command after a step of the wall clock moved its start on that clock",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-clock-step");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          // So that only its identity tells the runner the group is still the command's.
          yield* hideHolder((yield* commandRow(started.taskId))!.directory);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          const fileSystem = yield* FileSystem.FileSystem;
          // A start on the wall clock adds the boot time, which every step of that clock moves.
          yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: "true" }),
          ).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.FileSystem.of({
                ...fileSystem,
                readFileString: (file, encoding) =>
                  file === "/proc/stat"
                    ? fileSystem
                        .readFileString(file, encoding)
                        .pipe(
                          Effect.map((text) => text.replace(/^btime \d+$/mu, "btime 946684800")),
                        )
                    : fileSystem.readFileString(file, encoding),
              }),
            ),
          );
          assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
          assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
        }),
    );

    it.effect("still stops a command recorded with its start time, as before boot identities", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-time-identity");
        const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
        );
        yield* ready;
        const run = (yield* commandRow(started.taskId))!;
        yield* hideHolder(run.directory);
        const startedAt = yield* readProcessStartedAt(run.pid!);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE command_runs SET process_identity = ${timeIdentity(startedAt!)}
          WHERE task_id = ${started.taskId}
        `;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
        yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));

        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
      }),
    );
  });

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
    it.effect(
      "reports a command lost when a later start read finds another process under its pid",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-unconfirmed-identity");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          const sql = yield* SqlClient.SqlClient;
          // A start time that differs from the real one stands for a process that took the pid.
          yield* sql`
          UPDATE command_runs SET process_identity = CASE WHEN process_identity LIKE 'boot:%'
            THEN 'boot:other:1' ELSE 'time:0' END
          WHERE task_id = ${started.taskId}
        `;
          let startReads = 0;
          const { pid } = (yield* commandRow(started.taskId))!;
          yield* withServer(() => nextWake(chat.threadId)).pipe(
            aroundStartReads(
              Effect.sync(() => {
                startReads += 1;
                // Adoption's read fails, as it does on a loaded machine.
                return startReads === 1 ? "fail" : "read";
              }),
              pid!,
            ),
          );
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "lost");
          assert.equal(row?.lost_reason, "pid-reused");
          assert.isAbove(startReads, 1);
        }),
    );

    it.effect.skipIf(!holdsGroups)(
      "stops a held command after the wall clock stepped past its start",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-clock-stepped-ahead");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` }),
          );
          yield* ready;
          const sql = yield* SqlClient.SqlClient;
          // A forward step of the wall clock puts the boot it estimates after the command's start.
          yield* sql`
          UPDATE command_runs SET started_at = '2000-01-01T00:00:00.000Z'
          WHERE task_id = ${started.taskId}
        `;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));

          assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
          assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
        }),
    );

    it.effect.each([
      ["the group its ended wrapper's pid names", "command-rebooted-orphaned", true],
      ["a process of unknown start under its wrapper's pid", "command-rebooted-reused", false],
    ] as const)(
      "reports a command from before a reboot as lost and leaves alone %s",
      ([, name, wrapperGone]) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(name);
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const orphaned = awaitFile(NodePath.join(chat.workspace, "orphaned"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), {
              command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
            }),
          );
          yield* ready;
          if (wrapperGone) {
            NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
            yield* orphaned;
          }
          // A reboot leaves no holder running.
          yield* hideHolder((yield* commandRow(started.taskId))!.directory);
          const sql = yield* SqlClient.SqlClient;
          // Started before the machine last booted, so what its pid names now is someone else's.
          yield* sql`
          UPDATE command_runs SET started_at = '2000-01-01T00:00:00.000Z', process_identity = NULL
          WHERE task_id = ${started.taskId}
        `;
          yield* withServer(() => nextWake(chat.threadId));
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "lost");
          assert.equal(row?.lost_reason, "rebooted");
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );
  });
});

type LossWave = {
  readonly id: string;
  readonly time: string;
  readonly lost: number;
  readonly running: number;
  readonly runs: ReadonlyArray<{ readonly taskId: string; readonly lostReason: string | null }>;
};

/** The waves in the losses log, oldest first. */
const lossWaves = Effect.map(ServerConfig.ServerConfig, ({ logsDir }) => {
  const file = NodePath.join(logsDir, CommandRunner.LOSS_LOG_FILE);
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LossWave);
});

/** A command an earlier server recorded lost, in the wave `waveId` names, or in none yet. */
const seedLoss = (loss: {
  readonly taskId: string;
  readonly directory: string;
  readonly endedAt: string;
  readonly waveId: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status,
        started_at, deadline_at, ended_at, delivered_at, probe_error, lost_reason, loss_wave_id,
        loss_unplaced)
      VALUES (${loss.taskId}, 'thread-earlier', ${`run-${loss.taskId}`}, 'true', ${loss.directory},
        ${loss.directory}, 'lost', ${loss.endedAt}, ${loss.endedAt}, ${loss.endedAt},
        ${loss.endedAt}, 'ESRCH', 'gone', ${loss.waveId}, ${loss.waveId === null ? 1 : 0})
    `;
  });

/** A command an earlier server saw exit, and delivered. */
const seedExited = (run: {
  readonly taskId: string;
  readonly directory: string;
  readonly startedAt: string;
  readonly endedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status,
        exit_code, started_at, deadline_at, ended_at, delivered_at)
      VALUES (${run.taskId}, 'thread-earlier', ${`run-${run.taskId}`}, 'true', ${run.directory},
        ${run.directory}, 'exited', 0, ${run.startedAt}, ${run.endedAt}, ${run.endedAt},
        ${run.endedAt})
    `;
  });

const waveIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly wave_id: string }>`SELECT wave_id FROM command_loss_waves`).map(
    (row) => row.wave_id,
  );
});

const seedWave = (waveId: string, startedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_loss_waves (wave_id, started_at, running) VALUES (${waveId}, ${startedAt}, 0)
    `;
  });

/** Once `go` exists it kills its wrapper, so it ends without an exit status. */
const LOSING_COMMAND = "until [ -e go ]; do sleep 0.05; done; kill -9 $PPID";
const go = (chat: { readonly workspace: string }) =>
  NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");

/**
 * Resolves once a pass that began after the call has ended, its wave noted. A pass wakes a command's
 * chat before it notes its wave, and run() waits for the pass under way, so the second command
 * starts only after the pass that saw the first one end; at a server's start none is under way.
 */
const nextPass = (runner: CommandRunner.CommandRunner["Service"], threadId: ThreadId) => {
  const runToEnd = runner
    .run(callerOf(threadId), { command: "true" })
    .pipe(Effect.andThen(nextWake(threadId)));
  return runToEnd.pipe(Effect.andThen(runToEnd));
};

describe("placing lost commands in waves", () => {
  it("joins the last wave while each loss comes within a minute after the one before, and starts one from more than half the commands of the minute up to a loss", () => {
    const lostAt = (...seconds: ReadonlyArray<number>) =>
      seconds.map((at) => ({ taskId: `task-${at}`, at: at * 1000 }));
    const commands = (count: number) => () => count;
    const place = (
      lastLossAt: number | undefined,
      losses: ReadonlyArray<{ readonly taskId: string; readonly at: number }>,
      commandsAt: (second: number) => number,
    ) => {
      const { joining, waves, waiting } = CommandRunner.placeLosses(
        lastLossAt === undefined ? undefined : lastLossAt * 1000,
        losses,
        (at) => commandsAt(at / 1000),
      );
      const seconds = (placed: ReadonlyArray<{ readonly at: number }>) =>
        placed.map((loss) => loss.at / 1000);
      return {
        joining: seconds(joining),
        waves: waves.map((wave) => seconds(wave.losses)),
        waiting: seconds(waiting),
      };
    };
    const none = { joining: [], waves: [], waiting: [] };
    assert.deepEqual(place(0, lostAt(100, 50), commands(3)), { ...none, joining: [50, 100] });
    // 65 s after the loss before it, so it starts a wave of its own.
    assert.deepEqual(place(0, lostAt(50, 115), commands(1)), {
      ...none,
      joining: [50],
      waves: [[115]],
    });
    // Lost before the last wave's latest loss, so it is not part of that wave.
    assert.deepEqual(place(100, lostAt(90), commands(3)), { ...none, waiting: [90] });
    assert.deepEqual(place(undefined, lostAt(10, 20), commands(4)), { ...none, waiting: [10, 20] });
    assert.deepEqual(place(undefined, lostAt(10, 20), commands(3)), { ...none, waves: [[10, 20]] });
    // More than a minute apart, so neither counts with the other.
    assert.deepEqual(place(undefined, lostAt(0, 70), commands(3)), { ...none, waiting: [0, 70] });
    // Against the commands that ran up to each loss, not fewer that run later.
    assert.deepEqual(
      place(undefined, lostAt(10, 20), (second) => (second < 30 ? 5 : 1)),
      { ...none, waiting: [10, 20] },
    );
  });
});

// Each has a database and logs folder of its own, since a wave counts every loss of the last minute.
describe.skipIf(isWindowsHost)("a wave of lost commands", () => {
  it.layer(layerTest, { excludeTestServices: true })("lost together", (it) => {
    it.effect("is logged once, and not again by the next server", () =>
      Effect.gen(function* () {
        const chats = yield* Effect.forEach(["one", "two", "three"], (name) =>
          liveChat(`command-wave-${name}`),
        );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Effect.forEach(chats, (chat) =>
              runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
            );
            for (const chat of chats) go(chat);
            yield* wakesOf(chats.map((chat) => chat.threadId));
            yield* nextPass(runner, chats[0]!.threadId);
          }),
        );
        // It counts the same losses, and finds them logged.
        yield* withServer((runner) => nextPass(runner, chats[0]!.threadId));
        assert.lengthOf(yield* waveIds, 1);
        const waves = yield* lossWaves;
        assert.lengthOf(waves, 1);
        // It holds all three, also when two were lost a pass before the third, which already is a wave.
        assert.equal(waves[0]!.lost, 3);
        assert.deepEqual(
          waves[0]!.runs.map((run) => run.lostReason),
          ["gone", "gone", "gone"],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost across a restart", (it) => {
    it.effect("counts the losses an earlier server recorded in the last minute", () =>
      Effect.gen(function* () {
        const chats = yield* Effect.forEach(["one", "two", "three"], (name) =>
          liveChat(`command-wave-restart-${name}`),
        );
        const [one, two, three] = [chats[0]!, chats[1]!, chats[2]!];
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Effect.forEach(chats, (chat) =>
              runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
            );
            go(one);
            yield* nextWake(one.threadId);
            yield* nextPass(runner, one.threadId);
          }),
        );
        // One lost while two run is no wave.
        assert.lengthOf(yield* lossWaves, 0);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            go(two);
            go(three);
            yield* wakesOf([two.threadId, three.threadId]);
            yield* nextPass(runner, two.threadId);
          }),
        );
        // Three of the four commands of the minute, nextPass's first one included, were lost.
        const waves = yield* lossWaves;
        assert.deepEqual(
          waves.map(({ lost, running }) => ({ lost, running })),
          [{ lost: 3, running: 0 }],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost after another ended", (it) => {
    it.effect(
      "is no wave when only half the commands of the minute were lost, though the other ended before a restart",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-half");
          yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
          );
          // The earlier server saw another command end normally, and delivered its end.
          const endedAt = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.seconds(10)),
          );
          yield* seedExited({
            taskId: "task-ended",
            directory: NodePath.join(chat.workspace, "task-ended"),
            startedAt: endedAt,
            endedAt,
          });
          yield* withServer((runner) =>
            Effect.gen(function* () {
              go(chat);
              yield* nextWake(chat.threadId);
              yield* nextPass(runner, chat.threadId);
            }),
          );
          assert.lengthOf(yield* lossWaves, 0);
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost on both sides of a restart", (it) => {
    it.effect("goes on as the wave its losses follow, holding each loss once", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-wave-continued");
        const now = yield* DateTime.now;
        const secondsAgo = (seconds: number) =>
          DateTime.formatIso(DateTime.subtractDuration(now, Duration.seconds(seconds)));
        // The earlier server began a wave 70 s ago, lost one more command 20 s ago, and stopped
        // before it placed that one in the wave.
        yield* seedWave("wave-earlier", secondsAgo(70));
        for (const [taskId, seconds, waveId] of [
          ["task-a", 70, "wave-earlier"],
          ["task-b", 70, "wave-earlier"],
          ["task-c", 20, null],
        ] as const) {
          yield* seedLoss({
            taskId,
            directory: NodePath.join(chat.workspace, taskId),
            endedAt: secondsAgo(seconds),
            waveId,
          });
        }
        const started = yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              command: LOSING_COMMAND,
            });
            go(chat);
            yield* nextWake(chat.threadId);
            yield* nextPass(runner, chat.threadId);
            return started;
          }),
        );
        const waves = yield* lossWaves;
        assert.deepEqual(
          waves.map(({ id, time, lost, runs }) => ({
            id,
            time,
            lost,
            runs: runs.map((run) => run.taskId),
          })),
          [
            {
              id: "wave-earlier",
              time: secondsAgo(70),
              lost: 4,
              runs: ["task-a", "task-b", "task-c", started.taskId],
            },
          ],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost before a restart", (it) => {
    it.effect(
      "is placed by the next server however much later it starts, against the commands that ran then",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-unplaced");
          const now = yield* DateTime.now;
          const secondsAgo = (seconds: number) =>
            DateTime.formatIso(DateTime.subtractDuration(now, Duration.seconds(seconds)));
          // The earlier server recorded these and stopped before it placed them.
          for (const [taskId, seconds] of [
            ["task-a", 120],
            ["task-b", 120],
            ["task-c", 120],
            ["task-lone", 600],
          ] as const) {
            yield* seedLoss({
              taskId,
              directory: NodePath.join(chat.workspace, taskId),
              endedAt: secondsAgo(seconds),
              waveId: null,
            });
          }
          // With this one running too, the lone loss was only half of its minute's commands.
          yield* seedExited({
            taskId: "task-ran",
            directory: NodePath.join(chat.workspace, "task-ran"),
            startedAt: secondsAgo(660),
            endedAt: secondsAgo(590),
          });
          yield* withServer((runner) => nextPass(runner, chat.threadId));
          assert.deepEqual(
            (yield* lossWaves).map(({ time, lost, runs }) => ({
              time,
              lost,
              runs: runs.map((run) => run.taskId),
            })),
            [{ time: secondsAgo(120), lost: 3, runs: ["task-a", "task-b", "task-c"] }],
          );
          // None is read again at the next pass.
          const sql = yield* SqlClient.SqlClient;
          assert.lengthOf(yield* sql`SELECT task_id FROM command_runs WHERE loss_unplaced = 1`, 0);
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost alone", (it) => {
    it.effect(
      "is the only running command lost, and is logged once the log can be written, by a server that starts minutes later too",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-alone");
          const { logsDir } = yield* ServerConfig.ServerConfig;
          const logPath = NodePath.join(logsDir, CommandRunner.LOSS_LOG_FILE);
          // The log cannot be written while its temporary file's path is taken.
          NodeFS.mkdirSync(`${logPath}.tmp`, { recursive: true });
          const started = yield* withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                command: LOSING_COMMAND,
              });
              go(chat);
              yield* nextWake(chat.threadId);
              yield* nextPass(runner, chat.threadId);
              return started;
            }),
          );
          assert.lengthOf(yield* lossWaves, 0);
          const sql = yield* SqlClient.SqlClient;
          const minutesAgo = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(3)),
          );
          yield* sql`
            UPDATE command_runs SET ended_at = ${minutesAgo} WHERE task_id = ${started.taskId}
          `;
          yield* withServer((runner) =>
            Effect.gen(function* () {
              // Each run waits for the pass under way, so at least one write has failed here.
              yield* nextPass(runner, chat.threadId);
              yield* nextPass(runner, chat.threadId);
              assert.lengthOf(yield* lossWaves, 0);
              NodeFS.rmdirSync(`${logPath}.tmp`);
              yield* nextPass(runner, chat.threadId);
              yield* nextPass(runner, chat.threadId);
            }),
          );
          assert.deepEqual(
            (yield* lossWaves).map(({ lost, running, runs }) => ({
              lost,
              running,
              runs: runs.map((run) => run.taskId),
            })),
            [{ lost: 1, running: 0, runs: [started.taskId] }],
          );
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost long ago", (it) => {
    it.effect("goes once the records it holds go, 14 days after their ends were delivered", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-wave-kept");
        const now = yield* DateTime.now;
        for (const [waveId, days] of [
          ["wave-old", 15],
          ["wave-recent", 13],
        ] as const) {
          const endedAt = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(days)));
          yield* seedWave(waveId, endedAt);
          yield* seedLoss({
            taskId: `task-${waveId}`,
            directory: NodePath.join(chat.workspace, waveId),
            endedAt,
            waveId,
          });
        }
        // The second run waits for the first pass, which writes the log.
        yield* withServer((runner) =>
          nextPass(runner, chat.threadId).pipe(Effect.andThen(nextPass(runner, chat.threadId))),
        );
        assert.deepEqual(
          (yield* lossWaves).map((wave) => wave.id),
          ["wave-recent"],
        );
        assert.deepEqual(yield* waveIds, ["wave-recent"]);
      }),
    );
  });
});

/** Whether `pid` is still running once it has had a moment to end after being stopped. */
const stillRunning = (pid: number) =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Wait-Process -Id ${pid} -Timeout 10 -ErrorAction SilentlyContinue; if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
    ],
    { encoding: "utf8" },
  ).trim() === "alive";

describe("the shell a command runs in", () => {
  it.each([
    ["win32", { SHELL: "/bin/zsh" }, undefined, "powershell", "powershell.exe"],
    ["win32", { SHELL: "/bin/zsh" }, "bash", "bash", "bash.exe"],
    ["darwin", { SHELL: "/bin/zsh" }, undefined, "zsh", "/bin/zsh"],
    ["darwin", { SHELL: "/bin/zsh" }, "bash", "bash", "bash"],
    ["linux", { SHELL: "/usr/bin/bash" }, undefined, "bash", "/usr/bin/bash"],
    ["linux", { SHELL: "/usr/bin/bash" }, "bash", "bash", "/usr/bin/bash"],
    ["linux", { SHELL: "/usr/bin/fish" }, undefined, "sh", "/bin/sh"],
    ["linux", { SHELL: "/tmp/a=b/bash" }, undefined, "sh", "/bin/sh"],
    ["linux", { SHELL: "/tmp/a=b/bash" }, "bash", "bash", "bash"],
    ["linux", {}, undefined, "sh", "/bin/sh"],
  ] as const)(
    "on %s with %j, asked for %s, is %s at %s",
    (platform, env, requested, name, path) => {
      assert.deepEqual(CommandRunner.resolveCommandShell(platform, env, requested), { name, path });
    },
  );
});

// A Windows wrapper that ended leaves what it started running under a dead parent pid.
describe.runIf(isWindowsHost)("Windows only", () => {
  // Windows numbers processes in fours, so none has the id 3.
  it.each([
    ["no process has", "3", new RegExp(`^${ENDED_IDENTITY}$`)],
    ["this PowerShell has", "$PID", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/],
  ] as const)(
    "prints after a launch's pid, for an id %s, what it reads there",
    (_, pid, printed) => {
      const output = NodeChildProcess.execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", CommandRunner.windowsStartOrEnded(pid)],
        { encoding: "utf8" },
      );
      assert.match(output.trim(), printed);
    },
  );

  it.layer(layerTest, { excludeTestServices: true })("a Windows command's console", (it) => {
    // Send returns once the command's own handler has the event, and takes it so the command goes on.
    // No API sends a close event, which ends every process in its console with STATUS_CONTROL_C_EXIT;
    // Close ends the others the same way. Windows PowerShell compiles this as C# 5.
    const consoleApi = [
      "Add-Type -Namespace T3Test -Name Console -MemberDefinition '",
      '[DllImport("kernel32.dll")] private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);',
      "public delegate bool Handler(uint ctrlEvent);",
      '[DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(Handler handler, bool add);',
      "private static readonly System.Threading.ManualResetEvent got = new System.Threading.ManualResetEvent(false);",
      "private static uint wanted;",
      "private static readonly Handler take = ctrlEvent => { if (ctrlEvent != wanted) return false; got.Set(); return true; };",
      "public static bool Send(uint ctrlEvent) { wanted = ctrlEvent; return SetConsoleCtrlHandler(null, false) && SetConsoleCtrlHandler(take, true) && GenerateConsoleCtrlEvent(ctrlEvent, 0) && got.WaitOne(60000); }",
      '[DllImport("kernel32.dll")] private static extern uint GetConsoleProcessList(uint[] processes, uint count);',
      '[DllImport("kernel32.dll")] private static extern System.IntPtr OpenProcess(uint access, bool inherit, uint id);',
      '[DllImport("kernel32.dll")] private static extern bool TerminateProcess(System.IntPtr process, uint code);',
      "public static uint Close() { var processes = new uint[64]; var count = GetConsoleProcessList(processes, 64); if (count > 64) return 0; var self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id; for (uint i = 0; i < count; i++) { if (processes[i] != self && !TerminateProcess(OpenProcess(1, false, processes[i]), 0xC000013A)) return 0; } return count; }",
      "'",
    ].join("\n");
    it.effect.each([
      ["Ctrl+C", "command-win-ctrl-c", 0],
      ["Ctrl+Break", "command-win-ctrl-break", 1],
    ] as const)("records the exit status of a command whose console gets %s", ([, name, event]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              command: [
                consoleApi,
                `if (-not [T3Test.Console]::Send(${event})) { exit 90 }`,
                "exit 3",
              ].join("\n"),
            });
            yield* nextWake(chat.threadId);
            const row = yield* commandRow(started.taskId);
            assert.equal(row?.status, "exited");
            assert.equal(row?.exit_code, 3);
          }),
        );
      }),
    );

    it.effect("records the exit status of a command whose console closes", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-win-console-closed");
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              // Its console holds cmd and this PowerShell, so a count below 2 means Close ended nothing.
              command: [
                consoleApi,
                "if ([T3Test.Console]::Close() -lt 2) { exit 93 }",
                "exit 94",
              ].join("\n"),
            });
            yield* nextWake(chat.threadId);
            const row = yield* commandRow(started.taskId);
            assert.equal(row?.status, "exited");
            // cmd's own STATUS_CONTROL_C_EXIT, as 0xC000013A reads in an Int32.
            assert.equal(row?.exit_code, -1073741510);
          }),
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("a Windows command's bash", (it) => {
    const system = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const powershellFolder = NodePath.join(system, "WindowsPowerShell", "v1.0");
    const installFolders = ["PROGRAMFILES", "PROGRAMW6432", "PROGRAMFILES(X86)", "LOCALAPPDATA"];
    // WSL's bash has no cygpath, and prints /usr/bin/node or /mnt/c/... for node. Git Bash shows
    // a HOME under TEMP as /tmp/..., so the home is compared as a Windows path.
    const nodeAndHome = "'command -v node; cygpath -w $HOME'";
    const isFolder = (printed: string | undefined, folder: string) =>
      NodeFS.realpathSync.native(printed ?? "").toLowerCase() ===
      NodeFS.realpathSync.native(folder).toLowerCase();
    const without = (env: Readonly<Record<string, string>>, names: ReadonlyArray<string>) =>
      Object.fromEntries(
        Object.entries(env).filter(([name]) => !names.includes(name.toUpperCase())),
      );
    const withNodeAndHome = ({
      inherited,
      workspace,
      otherBash,
    }: {
      readonly inherited: Readonly<Record<string, string>>;
      readonly workspace: string;
      readonly otherBash: string;
    }) => ({
      ...without(inherited, ["PATH", "HOME"]),
      HOME: workspace,
      PATH: [
        otherBash,
        NodePath.dirname(process.execPath),
        Object.entries(inherited).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "",
      ].join(";"),
    });
    const runBash = (
      name: string,
      input: { readonly command: string; readonly shell?: "bash" },
      env: (setup: {
        readonly inherited: Readonly<Record<string, string>>;
        readonly workspace: string;
        /** Not Git Bash, and first on PATH, as System32's WSL bash.exe often is. */
        readonly otherBash: string;
        /** A folder that does not exist. */
        readonly nowhere: string;
        /** Install variables that name no Git. */
        readonly noInstalls: Record<string, string>;
      }) => Record<string, string>,
    ) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const otherBash = NodePath.join(chat.workspace, "other-bash");
        NodeFS.mkdirSync(otherBash);
        NodeFS.copyFileSync(
          NodePath.join(system, "whoami.exe"),
          NodePath.join(otherBash, "bash.exe"),
        );
        const nowhere = NodePath.join(chat.workspace, "nowhere");
        const noInstalls = {
          ProgramFiles: nowhere,
          ProgramW6432: nowhere,
          "ProgramFiles(x86)": nowhere,
          LOCALAPPDATA: nowhere,
        };
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), input)
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provide(
            providerShell((_cwd, inherited) =>
              Effect.succeed(
                env({ inherited, workspace: chat.workspace, otherBash, nowhere, noInstalls }),
              ),
            ),
          ),
        );
        return {
          row: yield* commandRow(started.taskId),
          lines: NodeFS.readFileSync(started.logPath, "utf8").trim().split(/\r?\n/),
          workspace: chat.workspace,
        };
      });

    it.effect(
      "runs Git Bash for bash and sh, with or without .exe, which see the Windows home and node and take the command's arguments and input",
      () =>
        Effect.gen(function* () {
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-bash",
            {
              command: [
                `bash -c ${nodeAndHome}`,
                `sh -c ${nodeAndHome}`,
                `bash.exe -c ${nodeAndHome}`,
                "bash -c 'echo $1 $2' zero -- one",
                "'piped' | sh.exe -c 'cat; echo to-stderr >&2; exit 7'",
              ].join("; "),
            },
            withNodeAndHome,
          );
          assert.lengthOf(lines, 9);
          for (const [node, printedHome] of [
            lines.slice(0, 2),
            lines.slice(2, 4),
            lines.slice(4, 6),
          ]) {
            assert.match(node ?? "", /^\/[a-z]\/.+\/node(\.exe)?$/i);
            assert.isTrue(isFolder(printedHome, workspace), `${printedHome} is not the workspace`);
          }
          // Every argument as written, then plain lines, not PowerShell error records, and Git
          // Bash's own exit code.
          assert.deepEqual(lines.slice(6), ["-- one", "piped", "to-stderr"]);
          assert.equal(row?.exit_code, 7);
        }),
    );

    // Through PowerShell's `bash -c`, this grep lost its file and waited on the console for input.
    it.effect(
      "runs a bash command in Git Bash as written, double quotes included, in its cwd, with no input",
      () =>
        Effect.gen(function* () {
          const { row, lines, workspace } = yield* runBash(
            "command-win-shell-bash",
            {
              shell: "bash",
              command: [
                "printf '# pass 1\\n# fail 2\\nok 3\\n' > results.txt",
                'grep -E "^# (pass|fail)" results.txt',
                `echo "$(printf '%s' "a \\"b\\"")" 'c d' \\\\`,
                "cat",
                'echo "cat: $?"',
                'cygpath -w "$PWD"',
                "command -v node",
                "exit 5",
              ].join("\n"),
            },
            withNodeAndHome,
          );
          assert.deepEqual(lines.slice(0, 4), ["# pass 1", "# fail 2", 'a "b" c d \\', "cat: 0"]);
          assert.isTrue(isFolder(lines[4], workspace), `${lines[4]} is not the workspace`);
          assert.match(lines[5] ?? "", /^\/[a-z]\/.+\/node(\.exe)?$/i);
          assert.equal(row?.exit_code, 5);
        }),
    );

    it.effect(
      "finds Git Bash through a git that only the command's PATH names, in any case and whatever GIT_EXEC_PATH says, and leaves git to it",
      () =>
        Effect.gen(function* () {
          const git = NodeChildProcess.execFileSync("where.exe", ["git"], { encoding: "utf8" })
            .split(/\r?\n/)[0]!
            .trim();
          let calls = "";
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-shim",
            { command: "git --version; bash -c 'cygpath -w $HOME'" },
            ({ inherited, workspace, otherBash, nowhere, noInstalls }) => {
              // A launcher outside the install, as a package manager's shim is.
              const shim = NodePath.join(workspace, "git-shim");
              NodeFS.mkdirSync(shim, { recursive: true });
              calls = NodePath.join(shim, "calls.txt");
              NodeFS.writeFileSync(
                NodePath.join(shim, "git.cmd"),
                `@echo %*>>"%~dp0calls.txt"\r\n@"${git}" %*\r\n`,
              );
              return {
                ...without(inherited, ["PATH", "HOME", "GIT_EXEC_PATH", ...installFolders]),
                ...noInstalls,
                HOME: workspace,
                GIT_EXEC_PATH: nowhere,
                pAtH: [otherBash, shim, system, powershellFolder].join(";"),
              };
            },
          );
          assert.isTrue(isFolder(lines.at(-1), workspace), `${lines.at(-1)} is not the workspace`);
          // The command's own git is still the shim, not the git beside Git Bash.
          assert.deepEqual(NodeFS.readFileSync(calls, "utf8").trim().split(/\r?\n/), [
            "--exec-path",
            "--version",
          ]);
          assert.equal(row?.exit_code, 0);
        }),
    );

    it.effect(
      "stops a git that does not answer, with what it started, and finds Git Bash in the install folders",
      () =>
        Effect.gen(function* () {
          let childPidFile = "";
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-hangs",
            { command: "bash -c 'cygpath -w $HOME'" },
            ({ inherited, workspace, otherBash }) => {
              // A shim whose git never answers, in a child of the shim as git.cmd's git is.
              const shim = NodePath.join(workspace, "git-shim");
              NodeFS.mkdirSync(shim, { recursive: true });
              childPidFile = NodePath.join(shim, "child.pid");
              NodeFS.writeFileSync(
                NodePath.join(shim, "git.cmd"),
                `@powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${childPidFile}' -Value $PID; Start-Sleep 300"\r\n`,
              );
              return {
                ...without(inherited, ["PATH", "HOME"]),
                HOME: workspace,
                PATH: [otherBash, shim, system, powershellFolder].join(";"),
              };
            },
          );
          const childPid = Number.parseInt(NodeFS.readFileSync(childPidFile, "utf8"), 10);
          const left = stillRunning(childPid);
          if (left) process.kill(childPid); // still runs here
          assert.isFalse(left);
          assert.include(lines[0] ?? "", "did not answer within 10 s");
          assert.isTrue(isFolder(lines.at(-1), workspace), `${lines.at(-1)} is not the workspace`);
          assert.equal(row?.exit_code, 0);
        }),
    );

    it.effect.each([
      ["bash in PowerShell", "command-win-no-git-bash", { command: `bash -c ${nodeAndHome}` }],
      ["shell bash", "command-win-no-git-bash-shell", { command: "echo ran", shell: "bash" }],
    ] as const)("fails naming Git Bash when it finds none, for %s", ([, name, input]) =>
      Effect.gen(function* () {
        const { row, lines } = yield* runBash(
          name,
          input,
          ({ inherited, otherBash, noInstalls }) => ({
            ...without(inherited, ["PATH", ...installFolders]),
            ...noInstalls,
            PATH: [otherBash, system, powershellFolder].join(";"),
          }),
        );
        assert.include(lines.join("\n"), "bash: no Git Bash found");
        assert.equal(row?.exit_code, 127);
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })(
    "a Windows command whose wrapper ended",
    (it) => {
      it.effect.each([
        ["its task is cancelled", "command-win-cancelled", true],
        ["it is found without its wrapper", "command-win-lost", false],
      ] as const)("leaves nothing running when %s", ([, name, cancelled]) =>
        Effect.gen(function* () {
          // The commands are PowerShell: other platforms have their own wrapper, tested above.
          const chat = yield* liveChat(name);
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), {
              command:
                "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; " +
                "Set-Content -LiteralPath child.pid -Value $p.Id; Set-Content -LiteralPath ready -Value 1; Start-Sleep 300",
            }),
          );
          yield* ready;
          const childPid = Number.parseInt(
            NodeFS.readFileSync(NodePath.join(chat.workspace, "child.pid"), "utf8"),
            10,
          );
          yield* Effect.addFinalizer(() =>
            Effect.try(() => process.kill(childPid)).pipe(Effect.ignore),
          );
          // Only the wrapper, as a stop cut by a restart leaves it.
          // oxlint-disable-next-line t3code/no-raw-taskkill -- this stops the wrapper alone on purpose
          NodeChildProcess.execFileSync("taskkill", [
            "/PID",
            String((yield* commandRow(started.taskId))!.pid),
            "/F",
          ]);
          assert.isTrue(isProcessAlive(childPid));
          if (cancelled) {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
            // Run elsewhere: a Windows folder cannot be removed while a command still has it open.
            yield* withServer((runner) =>
              runner.run(callerOf(chat.threadId), { command: "exit 0", cwd: NodeOS.tmpdir() }),
            );
          } else {
            yield* withServer(() => nextWake(chat.threadId));
          }
          assert.equal((yield* commandRow(started.taskId))?.status, cancelled ? "stopped" : "lost");
          assert.isFalse(stillRunning(childPid));
        }),
      );
    },
  );
});

const SHORTAGE: MemoryShortage = {
  kind: "available",
  totalBytes: 8 * 1024 ** 3,
  availableBytes: 1024 ** 3,
  reserveBytes: 2 * 1024 ** 3,
};

/** A machine short of memory until `clear`, and again after `runShort`; each read is offered to `reads`. */
const shortMemory = Effect.gen(function* () {
  let shortage: MemoryShortage | null = SHORTAGE;
  const reads = yield* Queue.unbounded<MemoryShortage | null>();
  const read = Effect.sync(() => shortage).pipe(Effect.tap((seen) => Queue.offer(reads, seen)));
  return {
    reads,
    clear: Effect.sync(() => {
      shortage = null;
    }),
    runShort: Effect.sync(() => {
      shortage = SHORTAGE;
    }),
    on: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(MemoryAdmission.MemoryAdmission, {
          shortage: read,
          shortageOn: () => read,
        }),
      ),
  };
});

const MEMORY_WAIT =
  /^Queued until this machine has memory for it: 1 GiB of 8 GiB is available, under the 2 GiB reserve\. Its time limit counts from when it starts\.$/;

const HOUR_MS = 60 * 60_000;

/** Runs an effect on the real clock, its wall time and monotonic time each moved by `shift`. */
const shiftedClock = (shift: {
  readonly wallBehindMs: () => number;
  readonly monotonicAheadMs: () => number;
}) =>
  Effect.gen(function* () {
    const real = yield* Clock.Clock;
    const millis = () => real.currentTimeMillisUnsafe() - shift.wallBehindMs();
    const monotonic = () =>
      real.monotonicTimeNanosUnsafe() + BigInt(shift.monotonicAheadMs()) * 1_000_000n;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
      monotonicTimeNanosUnsafe: monotonic,
      monotonicTimeNanos: Effect.sync(monotonic),
      sleep: (duration) => real.sleep(duration),
    };
    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(Clock.Clock, clock));
  });

/**
 * The real clock an hour behind until `catchUp`, so a start dated after a queueing shows apart
 * from it. Never ahead: a wrapper dates the end it records by the real clock.
 */
const clockBehind = Effect.gen(function* () {
  let behindMs = HOUR_MS;
  return {
    catchUp: Effect.sync(() => {
      behindMs = 0;
    }),
    on: yield* shiftedClock({ wallBehindMs: () => behindMs, monotonicAheadMs: () => 0 }),
  };
});

/** The real clock, its monotonic time an hour ahead after `leap`. */
const monotonicLeap = Effect.gen(function* () {
  let aheadMs = 0;
  return {
    leap: Effect.sync(() => {
      aheadMs = HOUR_MS;
    }),
    on: yield* shiftedClock({ wallBehindMs: () => 0, monotonicAheadMs: () => aheadMs }),
  };
});

const START_COMMAND = "command:command-task-start:";

/** Which of `taskIds` started off the queue, in the order they started. */
const startOrder = (taskIds: ReadonlyArray<string>) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_events
      WHERE command_id IN ${sql.in(taskIds.map((taskId) => `${START_COMMAND}${taskId}`))}
      GROUP BY command_id ORDER BY MIN(sequence)
    `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.command_id.slice(START_COMMAND.length))));

it.layer(layerTest, { excludeTestServices: true })("a command waiting for memory", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "starts nothing and reads no agent's environment while memory is short, says so in its task, then starts the waiting commands in order, each time limit counted from its start",
    () =>
      Effect.gen(function* () {
        const first = yield* liveChat("command-memory-first");
        const second = yield* liveChat("command-memory-second");
        const memory = yield* shortMemory;
        const clock = yield* clockBehind;
        let environmentReads = 0;
        const [one, two, queued] = yield* withServer((runner) =>
          Effect.gen(function* () {
            const one = yield* runner.run(callerOf(first.threadId), {
              command: "echo first",
              timeoutMinutes: 5,
            });
            const two = yield* runner.run(callerOf(second.threadId), { command: "echo second" });
            // A pass that read the shortage after both were queued started neither.
            yield* Queue.clear(memory.reads);
            yield* Queue.take(memory.reads);
            const queued = (yield* commandRow(one.taskId))!;
            assert.equal(queued.status, "queued");
            assert.isNull(queued.pid);
            assert.isFalse(NodeFS.existsSync(NodePath.join(NodePath.dirname(one.logPath), "pid")));
            assert.equal((yield* commandRow(two.taskId))?.status, "queued");
            const waiting = yield* taskOf(first.threadId, one.taskId);
            assert.equal(waiting?.status, "pending");
            assert.match(waiting?.progress ?? "", MEMORY_WAIT);
            assert.equal(environmentReads, 0);
            yield* clock.catchUp;
            yield* memory.clear;
            yield* wakesOf([first.threadId, second.threadId]);
            return [one, two, queued] as const;
          }),
        ).pipe(
          memory.on,
          clock.on,
          Effect.provide(
            providerShell((_cwd, inherited) =>
              Effect.sync(() => {
                environmentReads += 1;
                return inherited;
              }),
            ),
          ),
        );
        assert.deepStrictEqual(yield* startOrder([one.taskId, two.taskId]), [
          one.taskId,
          two.taskId,
        ]);
        assert.equal(environmentReads, 2);
        const ran = (yield* commandRow(one.taskId))!;
        assert.isAtLeast(Date.parse(ran.started_at) - Date.parse(queued.started_at), HOUR_MS);
        assert.equal(Date.parse(ran.deadline_at) - Date.parse(ran.started_at), 5 * 60_000);
        const task = yield* taskOf(first.threadId, one.taskId);
        assert.equal(task?.status, "completed");
        assert.notProperty(task, "progress");
        assert.match(task?.result ?? "", /Last output:\nfirst\n/);
        assert.match((yield* taskOf(second.threadId, two.taskId))?.result ?? "", /second/);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps a waiting command waiting through a restart, ahead of the ones queued after it",
    () =>
      Effect.gen(function* () {
        const first = yield* liveChat("command-memory-restart-first");
        const second = yield* liveChat("command-memory-restart-second");
        const memory = yield* shortMemory;
        const one = yield* withServer((runner) =>
          runner.run(callerOf(first.threadId), { command: "echo first" }),
        ).pipe(memory.on);
        const two = yield* withServer((runner) =>
          Effect.gen(function* () {
            const two = yield* runner.run(callerOf(second.threadId), { command: "echo second" });
            assert.equal((yield* commandRow(one.taskId))?.status, "queued");
            yield* memory.clear;
            yield* wakesOf([first.threadId, second.threadId]);
            return two;
          }),
        ).pipe(memory.on);
        assert.deepStrictEqual(yield* startOrder([one.taskId, two.taskId]), [
          one.taskId,
          two.taskId,
        ]);
        assert.match(
          (yield* taskOf(first.threadId, one.taskId))?.result ?? "",
          /Last output:\nfirst\n/,
        );
      }),
  );

  it.effect.skipIf(isWindowsHost)("never starts a waiting command whose task was cancelled", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-memory-cancelled");
      const other = yield* liveChat("command-memory-cancelled-other");
      const memory = yield* shortMemory;
      const cancelled = yield* withServer((runner) =>
        Effect.gen(function* () {
          const cancelled = yield* runner.run(callerOf(chat.threadId), {
            command: "echo > started",
          });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, cancelled.taskId));
          yield* memory.clear;
          // It starts after the cancelled one would have.
          yield* runner.run(callerOf(other.threadId), { command: "echo other" });
          yield* nextWake(other.threadId);
          return cancelled;
        }),
      ).pipe(memory.on);
      assert.isUndefined(yield* commandRow(cancelled.taskId));
      assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "started")));
      assert.equal((yield* taskOf(chat.threadId, cancelled.taskId))?.status, "cancelled");
    }),
  );

  describe.skipIf(isWindowsHost)("settled as its start is decided", () => {
    it.effect.each([
      ["its task cancelled", "command-memory-cancelled-late", "cancelled", "Cancelled."],
      [
        "its chat archived",
        "command-memory-archived-late",
        "interrupted",
        "Stopped: the chat was archived.",
      ],
    ] as const)(
      "never starts a waiting command with %s as its start was decided",
      ([why, name, status, result]) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(name);
          const other = yield* liveChat(`${name}-other`);
          const memory = yield* shortMemory;
          const threads = yield* ThreadManagement.ThreadManagementService;
          let settleAfterRead: string | undefined;
          const settled = yield* withServer((runner) =>
            Effect.gen(function* () {
              const settled = yield* runner.run(callerOf(chat.threadId), {
                command: "echo > started",
              });
              if (why === "its chat archived") yield* endTurn(chat.threadId);
              settleAfterRead = settled.taskId;
              yield* memory.clear;
              // It starts after the settled one would have.
              yield* runner.run(callerOf(other.threadId), { command: "echo other" });
              yield* nextWake(other.threadId);
              return settled;
            }),
          ).pipe(
            memory.on,
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              ...threads,
              // Its start reads its task still waiting, and the cancel or the archive lands right after.
              getThreadRecords: (threadId, fields, filter) =>
                threads.getThreadRecords(threadId, fields, filter).pipe(
                  Effect.tap(() => {
                    const taskId = settleAfterRead;
                    if (taskId === undefined || filter?.subagentIds?.[0] !== taskId) {
                      return Effect.void;
                    }
                    settleAfterRead = undefined;
                    return threads.dispatch(
                      why === "its chat archived"
                        ? archiveOf(threadId)
                        : cancellationOf(threadId, taskId),
                    );
                  }),
                ),
            }),
          );
          assert.isUndefined(settleAfterRead);
          assert.isUndefined(yield* commandRow(settled.taskId));
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "started")));
          const task = yield* taskOf(chat.threadId, settled.taskId);
          assert.equal(task?.status, status);
          assert.equal(task?.result, result);
        }),
    );
  });

  it.effect.skipIf(isWindowsHost)(
    "fails the task of a waiting command whose server stopped as it started it, and never starts it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-memory-cut-start");
        const other = yield* liveChat("command-memory-cut-start-other");
        const memory = yield* shortMemory;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const taskStarted = yield* Deferred.make<void>();
        const cut = yield* withServer((runner) =>
          Effect.gen(function* () {
            const cut = yield* runner.run(callerOf(chat.threadId), { command: "echo > started" });
            yield* memory.clear;
            yield* Deferred.await(taskStarted);
            return cut;
          }),
        ).pipe(
          memory.on,
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            // The server stops once its task runs, before its command does.
            dispatch: (command) =>
              command.type === "delegated_task.command.start"
                ? threads
                    .dispatch(command)
                    .pipe(
                      Effect.andThen(Deferred.succeed(taskStarted, undefined)),
                      Effect.andThen(Effect.never),
                    )
                : threads.dispatch(command),
          }),
        );
        yield* memory.runShort;
        // Its request waits until the next server has adopted what this one left.
        yield* withServer((runner) =>
          runner.run(callerOf(other.threadId), { command: "echo other" }),
        ).pipe(memory.on);
        assert.isUndefined(yield* commandRow(cut.taskId));
        assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "started")));
        const task = yield* taskOf(chat.threadId, cut.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "CodeShip stopped before this command started. Run it again.");
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps a waiting command queued when memory runs short again while it reads its agent's environment",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-memory-short-again");
        const memory = yield* shortMemory;
        const environmentRead = yield* Deferred.make<void>();
        const started = yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), { command: "echo ran" });
            yield* memory.clear;
            yield* Deferred.await(environmentRead);
            // The check after the read, then the next pass's: the pass that read ended unstarted.
            yield* Queue.take(memory.reads);
            yield* Queue.take(memory.reads);
            const waiting = (yield* commandRow(started.taskId))!;
            assert.equal(waiting.status, "queued");
            assert.isNull(waiting.pid);
            yield* memory.clear;
            yield* nextWake(chat.threadId);
            return started;
          }),
        ).pipe(
          memory.on,
          Effect.provide(
            providerShell((_cwd, inherited) =>
              Effect.gen(function* () {
                if (yield* Deferred.isDone(environmentRead)) return inherited;
                // Another process took the memory while the provider read its settings.
                yield* memory.runShort;
                yield* Queue.clear(memory.reads);
                yield* Deferred.succeed(environmentRead, undefined);
                return inherited;
              }),
            ),
          ),
        );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        assert.match(task?.result ?? "", /Last output:\nran\n/);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "hands a waiting command that cannot start its failure until its task takes it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-memory-end-retried");
        const memory = yield* shortMemory;
        // The first hand-over of its end is lost.
        const ends = yield* losingEnds(1);
        let starting = false;
        const failed = yield* withServer((runner) =>
          Effect.gen(function* () {
            const failed = yield* runner.run(callerOf(chat.threadId), { command: "echo ran" });
            starting = true;
            yield* memory.clear;
            yield* nextWake(chat.threadId);
            return failed;
          }),
        ).pipe(
          memory.on,
          Effect.provide(
            // Only its start's read fails: one with its request would refuse the request instead.
            providerShell((_cwd, inherited) =>
              starting
                ? Effect.fail(
                    new ProviderDriverError({
                      driver,
                      instanceId,
                      detail: "settings.json is not JSON",
                    }),
                  )
                : Effect.succeed(inherited),
            ),
          ),
          ends.on,
        );
        assert.equal(ends.attempts(), 2);
        assert.isUndefined(yield* commandRow(failed.taskId));
        const task = yield* taskOf(chat.threadId, failed.taskId);
        assert.equal(task?.status, "failed");
        assert.match(
          task?.result ?? "",
          /^Could not start the command: .*settings\.json is not JSON/,
        );
      }),
  );

  it.effect.each([
    // Its first telling is lost, and the next pass tells it again.
    ["archived", "command-memory-archived", 1],
    // A deleted chat records nothing, so its task needs no telling once it is gone.
    ["deleted", "command-memory-deleted", 0],
  ] as const)(
    "tells a waiting command's task that its chat was %s, until nothing waits on it",
    ([why, name, lost]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const other = yield* liveChat(`${name}-other`);
        const memory = yield* shortMemory;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const ends = yield* losingEnds(lost);
        const waiting = yield* withServer((runner) =>
          Effect.gen(function* () {
            const waiting = yield* runner.run(callerOf(chat.threadId), { command: "echo started" });
            yield* endTurn(chat.threadId);
            yield* threads.dispatch(
              why === "deleted" ? deletionOf(chat.threadId) : archiveOf(chat.threadId),
            );
            yield* Deferred.await(ends.told);
            // Its request takes the lock the task was told under.
            yield* runner.run(callerOf(other.threadId), { command: "echo other" });
            return waiting;
          }),
        ).pipe(memory.on, ends.on);
        assert.equal(ends.attempts(), lost + 1);
        assert.isUndefined(yield* commandRow(waiting.taskId));
        if (why === "archived") {
          assert.equal(
            (yield* taskOf(chat.threadId, waiting.taskId))?.result,
            "Stopped: the chat was archived.",
          );
        }
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "reads memory for a waiting command again only once the shortage it found is a recheck old",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-memory-recheck");
        const closing = yield* liveChat("command-memory-recheck-closing");
        const memory = yield* shortMemory;
        const clock = yield* monotonicLeap;
        const threads = yield* ThreadManagement.ThreadManagementService;
        // The closed chat's task is told again on each pass, which marks the passes.
        const ends = yield* losingEnds(2);
        const ran = yield* withServer(
          (runner) =>
            Effect.gen(function* () {
              const ran = yield* runner.run(callerOf(chat.threadId), { command: "echo ran" });
              yield* runner.run(callerOf(closing.threadId), { command: "echo closing" });
              // Each request read memory, and the first pass after them found the shortage.
              for (let read = 0; read < 3; read++) yield* Queue.take(memory.reads);
              yield* endTurn(closing.threadId);
              yield* threads.dispatch(archiveOf(closing.threadId));
              // The archive told it first; two passes followed, the first of them whole.
              for (let told = 0; told < 3; told++) yield* Queue.take(ends.tries);
              assert.equal(yield* Queue.size(memory.reads), 0);
              yield* memory.clear;
              yield* clock.leap;
              yield* nextWake(chat.threadId);
              return ran;
            }),
          Duration.hours(1),
        ).pipe(memory.on, clock.on, ends.on);
        assert.match((yield* taskOf(chat.threadId, ran.taskId))?.result ?? "", /ran/);
      }),
  );

  it.effect(
    "tells a waiting command's task that its chat was archived while no server ran, until it takes it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-memory-archived-restart");
        const other = yield* liveChat("command-memory-archived-restart-other");
        const memory = yield* shortMemory;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const waiting = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo started" }),
        ).pipe(memory.on);
        yield* endTurn(chat.threadId);
        yield* threads.dispatch(archiveOf(chat.threadId));
        // The next server's adoption tells it first, and that telling is lost.
        const ends = yield* losingEnds(1);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Deferred.await(ends.told);
            // Its request takes the lock the task was told under.
            yield* runner.run(callerOf(other.threadId), { command: "echo other" });
          }),
        ).pipe(memory.on, ends.on);
        assert.equal(ends.attempts(), 2);
        assert.isUndefined(yield* commandRow(waiting.taskId));
        assert.equal(
          (yield* taskOf(chat.threadId, waiting.taskId))?.result,
          "Stopped: the chat was archived.",
        );
      }),
  );
});
