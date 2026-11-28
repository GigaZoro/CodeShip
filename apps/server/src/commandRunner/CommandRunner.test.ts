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
  type ThreadId,
} from "@t3tools/contracts/baseSchemas";
import type { MemoryShortage } from "@t3tools/contracts/hostMemory";
import type { OrchestratorMcpRunCommandInput } from "@t3tools/contracts/orchestratorMcp";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
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
import { isDarwinHost, isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { WindowsJobHost, windowsJobName } from "@t3tools/shared/windowsJob";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CpuAdmission from "../resourceTelemetry/CpuAdmission.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
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
import { readProcessStartedAt } from "../serverRuntimeState.ts";
import * as CommandRunner from "./CommandRunner.ts";
import { timeIdentity } from "./processIdentity.ts";

vi.mock("node:os", { spy: true });

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
/** Fails the Windows launch, after its scripts are written, and hands over the launcher's input. */
const refuseWindowsLaunch = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  launcher: Deferred.Deferred<ProcessRunner.ProcessRunInput>,
): ProcessRunner.ProcessRunner["Service"] => ({
  run: (input) =>
    !input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))
      ? processRunner.run(input)
      : Deferred.succeed(launcher, input).pipe(
          Effect.as({
            stdout: "",
            stderr: "Win32_Process.Create returned 9",
            code: ChildProcessSpawner.ExitCode(1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        ),
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
                  then === "fail"
                    ? Effect.succeed({
                        stdout: "",
                        stderr: "",
                        code: ChildProcessSpawner.ExitCode(1),
                        timedOut: false,
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        stdoutInvalidUtf8: false,
                        stderrInvalidUtf8: false,
                      })
                    : processRunner.run(input),
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
/** A server whose state folder's name starts with `prefix`. */
const layerTestIn = (prefix: string) =>
  Layer.mergeAll(
    layerThreads,
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
    providerShell(),
    ProcessRunner.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
    NodeCrypto.layer,
    MemoryAdmission.layerTest(),
    CpuAdmission.layerTest(),
  ).pipe(
    Layer.provideMerge(layerOrchestration),
    // As the server spawns: each detached group stays held until its spawn's scope closes.
    Layer.provideMerge(layerHeldProcessGroups.pipe(Layer.provideMerge(NodeServices.layer))),
  );
const layerTest = layerTestIn("t3-command-runner-");

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

/** A caller that may use task_cancel. */
const orchestratorOf = (threadId: ThreadId): McpThreadInvocationScope => ({
  ...callerOf(threadId),
  capabilities: new Set(["orchestration"]),
});

/** The MCP service over this server's runner, as task_cancel reaches it. */
const mcpOver = (runner: CommandRunner.CommandRunner["Service"]) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CommandRunner.CommandRunner, runner),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(PeerLinks.PeerLinks)({}),
        Layer.mock(MemoryAdmission.MemoryAdmission)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      ),
    ),
  );

/**
 * Resolves once `file` exists, from its state rather than folder events: on macOS a file made just
 * after `fs.watch` returns can raise none, and a sandbox refuses the watch.
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

describe("stripAnsi and decodeTail", () => {
  it("strips CSI, OSC, and 2-byte ESC sequences without altering plain text", () => {
    const input = [
      "\u001b[1;38;5;208mWARN\u001b[0m: \u001b[?25lcheck\u001b[?25h",
      "\u001b]0;window title\u0007title stripped",
      "\u001b]8;;https://example.test/docs\u001b\\docs link\u001b]8;;\u001b\\",
      "\u001b7saved\u001b8 \u001bMup \u001bcreset \u001b(Bascii",
    ].join("\n");
    assert.equal(
      CommandRunner.stripAnsi(input),
      "WARN: check\ntitle stripped\ndocs link\nsaved up reset ascii",
    );
  });

  it("normalizes CRLF and collapses in-place carriage-return progress bars", () => {
    assert.equal(CommandRunner.stripAnsi("one\r\ntwo\r\n"), "one\ntwo\n");
    assert.equal(
      CommandRunner.stripAnsi("step 1\rstep 2\rstep 3\nnext\r\ndone 10%\rdone 100%\r"),
      "step 3\nnext\ndone 100%",
    );
    assert.equal(
      CommandRunner.stripAnsi("\u001b[33m10%\u001b[0m\r\u001b[2K\u001b[32m100%\u001b[0m\r\n"),
      "100%\n",
    );
  });

  it("recovers clean text from a dense ANSI tail within maxChars", () => {
    const lines = Array.from(
      { length: 60 },
      (_, index) =>
        `\u001b[38;2;100;200;255m\u001b[1mPASS\u001b[0m \u001b[2mtest-${String(index).padStart(2, "0")}\u001b[0m`,
    ).join("\n");
    const bytes = new TextEncoder().encode(`partial-before-seek\n${lines}\n`);
    const tail = CommandRunner.decodeTail(bytes, true, CommandRunner.RESULT_SUCCESS_TAIL_CHARS);
    assert.isAtMost(tail.length, CommandRunner.RESULT_SUCCESS_TAIL_CHARS);
    assert.notInclude(tail, "\u001b");
    assert.include(tail, "PASS test-00");
    assert.include(tail, "PASS test-59");
  });

  it("strips 8-bit CSI and line-bounded OSC and DCS/SOS/PM/APC without swallowing diagnostic lines", () => {
    assert.equal(CommandRunner.stripAnsi("\u009b31mred"), "red");
    assert.equal(CommandRunner.stripAnsi("a\u001bPq#0;2;0;0;0\u001b\\b"), "ab");
    assert.equal(CommandRunner.stripAnsi("a\u001bPq#0;2;0;0;0\u009cb"), "ab");
    assert.equal(CommandRunner.stripAnsi("a\u001b_apc\u001b\\b"), "ab");

    const unterminatedOsc = CommandRunner.stripAnsi(
      "\u001b]0;t\nERROR line 1\nERROR line 2\n\u0007end",
    );
    assert.include(unterminatedOsc, "ERROR line 1");
    assert.include(unterminatedOsc, "ERROR line 2");

    const st8BitOsc = CommandRunner.stripAnsi("\u001b]0;t\u009cvisible\nnext\u0007z");
    assert.include(st8BitOsc, "visible\nnext");
    assert.isTrue(st8BitOsc.startsWith("visible\nnext"));

    const unterminatedDcs = CommandRunner.stripAnsi("a\u001bPunterminated\nERROR line\n\u001b\\b");
    assert.include(unterminatedDcs, "ERROR line");
  });

  it("keeps a truncated first line prefixed with an ellipsis when dropping it would discard over half of maxChars", () => {
    const encoder = new TextEncoder();
    const longError = encoder.encode(`${"E".repeat(5000)}\nlast`);
    const tail = CommandRunner.decodeTail(
      longError,
      false,
      CommandRunner.RESULT_FAILURE_TAIL_CHARS,
    );
    assert.equal(tail.length, CommandRunner.RESULT_FAILURE_TAIL_CHARS);
    assert.isTrue(tail.startsWith("…E"));
    assert.isTrue(tail.endsWith("EEE\nlast"));

    const cutLongError = encoder.encode(`${"E".repeat(8187)}\nlast`);
    for (const limit of [
      CommandRunner.RESULT_FAILURE_TAIL_CHARS,
      CommandRunner.RESULT_SUCCESS_TAIL_CHARS,
    ]) {
      const cutTail = CommandRunner.decodeTail(cutLongError, true, limit);
      assert.isAtMost(cutTail.length, limit);
      assert.isTrue(cutTail.startsWith("…E"));
      assert.isTrue(cutTail.endsWith("\nlast"));
    }

    assert.equal(
      CommandRunner.decodeTail(
        encoder.encode("partial\nok"),
        true,
        CommandRunner.RESULT_FAILURE_TAIL_CHARS,
      ),
      "ok",
    );

    const cutNoNewline = CommandRunner.decodeTail(
      encoder.encode("E".repeat(5000)),
      true,
      CommandRunner.RESULT_FAILURE_TAIL_CHARS,
    );
    assert.isAtMost(cutNoNewline.length, CommandRunner.RESULT_FAILURE_TAIL_CHARS);
    assert.isTrue(cutNoNewline.startsWith("…E"));

    assert.equal(
      CommandRunner.decodeTail(
        encoder.encode("partial\n   "),
        true,
        CommandRunner.RESULT_FAILURE_TAIL_CHARS,
      ),
      "…partial",
    );

    // A short partial first line (<= 50% of budget) still drops cleanly at the next line boundary.
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
    const shortPartial = CommandRunner.decodeTail(encoder.encode(lines), false, 120);
    assert.isFalse(shortPartial.startsWith("…"));
    assert.isAtMost(shortPartial.length, 120);
    assert.isTrue(shortPartial.startsWith("line-"));
  });

  it("avoids broken UTF-8 sequences and lone UTF-16 surrogates when slicing", () => {
    const encoder = new TextEncoder();
    for (const sample of ["é", "✓", "🚀"]) {
      const repeated = encoder.encode(sample.repeat(20));
      for (let cutOffset = 1; cutOffset < 5; cutOffset += 1) {
        const sliced = CommandRunner.decodeTail(repeated.subarray(cutOffset), true, 100);
        assert.notInclude(sliced, "\uFFFD");
        assert.isTrue(sliced.length > 0);
        assert.equal(Buffer.from(sliced, "utf8").toString("utf8"), sliced);
      }
    }
    const astral = encoder.encode(`a${"🚀".repeat(1000)}z`);
    for (const limit of [1535, 1536, 4095, 4096]) {
      const sliced = CommandRunner.decodeTail(astral, false, limit);
      assert.isAtMost(sliced.length, limit);
      assert.notInclude(sliced, "\uFFFD");
      assert.equal(Buffer.from(sliced, "utf8").toString("utf8"), sliced);
      assert.isTrue(sliced.endsWith("🚀z"));
    }
  });
});

const commandRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly status: string;
      readonly exit_code: number | null;
      readonly pid: number | null;
      readonly directory: string;
      readonly process_identity: string | null;
      readonly windows_created_at: string | null;
      readonly started_at: string;
      readonly deadline_at: string;
      readonly delivered_at: string | null;
      readonly reported_at: string | null;
      readonly last_alive_at: string | null;
      readonly probe_error: string | null;
      readonly lost_reason: string | null;
      readonly lost_output: string | null;
      readonly exit_status_error: string | null;
      readonly stop_leftovers: string | null;
    }>`
      SELECT status, exit_code, pid, directory, process_identity, started_at, deadline_at,
        delivered_at, last_alive_at, probe_error, lost_reason, lost_output, reported_at,
        windows_created_at, exit_status_error, stop_leftovers
      FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

const observeDelivery =
  (
    taskId: string,
    delivered: Deferred.Deferred<void>,
    field: "pid" | "lost_reason" | "reported_at" | "delivered_at" = "delivered_at",
  ): Statement.Transformer =>
  (statement, sql) => {
    const [query, params] = statement.compile();
    if (
      !query.includes("UPDATE command_runs") ||
      !query.includes(`${field} =`) ||
      params.at(-1) !== taskId ||
      params[{ pid: 0, lost_reason: 9, delivered_at: 6, reported_at: 12 }[field]] === null
    )
      return Effect.succeed(statement);
    return statement.pipe(
      Effect.provideService(Statement.CurrentTransformer, undefined),
      Effect.orDie,
      Effect.andThen(Deferred.succeed(delivered, undefined)),
      Effect.as(sql`SELECT 1 WHERE 0`),
    );
  };

/** A run request with a key of its own, as every caller sends one. */
let requestCount = 0;
const keyed = (
  input: Omit<OrchestratorMcpRunCommandInput, "clientRequestId">,
): OrchestratorMcpRunCommandInput => ({ ...input, clientRequestId: `request-${++requestCount}` });

/** What the record holds when its server stops between starting it and recording the pid. */
const forgetPid = (taskId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE command_runs SET pid = NULL, process_identity = NULL, windows_created_at = NULL, last_alive_at = NULL
      WHERE task_id = ${taskId}
    `,
  );

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

/** A recorded start that differs from the real one, standing for a process that took the pid. */
const recordOtherStart = (taskId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        UPDATE command_runs SET process_identity = CASE WHEN process_identity LIKE 'boot:%'
          THEN process_identity || '0' ELSE 'time:0' END
        WHERE task_id = ${taskId}
      `,
    ),
  );
const taskOf = (threadId: ThreadId, taskId: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map((projection) => projection.subagents.find((task) => task.id === taskId)),
  );

/** A chat whose run is live, in its own folder, whose commands are stopped when the test ends. */
const liveChat = (name: string) =>
  Effect.gen(function* () {
    const workspace = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${name}-`)),
    );
    const parent = yield* seedLiveParent({ name, driver, modelSelection, worktreePath: workspace });
    const sql = yield* SqlClient.SqlClient;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    yield* Effect.addFinalizer(() =>
      sql<{
        readonly pid: number | null;
        readonly directory: string;
      }>`
        SELECT pid, directory FROM command_runs WHERE thread_id = ${parent.threadId}
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => {
            if (isWindowsHost) {
              return Effect.gen(function* () {
                const identity = yield* Effect.try(() =>
                  NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8")
                    .trim()
                    .split(/\s+/),
                ).pipe(Effect.orElseSucceed(() => [] as string[]));
                if (identity.length !== 2) return;
                yield* processRunner.run({
                  command: yield* yield* WindowsJobHost,
                  args: [
                    "stop",
                    windowsJobName(NodePath.basename(row.directory)),
                    ...identity.map((value) => value.replace(/^ft:/, "")),
                  ],
                  timeout: Duration.minutes(2),
                });
              }).pipe(Effect.ignore);
            }
            const holder = NodePath.join(row.directory, "group-holder");
            return Effect.gen(function* () {
              if (!isFifoHolderHeld(holder)) return;
              const pid =
                row.pid ??
                Number(
                  (yield* Effect.try(() =>
                    NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8"),
                  ))
                    .trim()
                    .split(/\s+/)[0],
                );
              if (Number.isSafeInteger(pid) && pid > 1) {
                yield* Effect.try(() => {
                  // oxlint-disable-next-line t3code/no-raw-process-group-signal -- its holder keeps the number
                  signalProcessGroup(pid, "SIGKILL");
                });
              }
            }).pipe(
              Effect.ignore,
              Effect.andThen(Effect.try(() => releaseFifoHolder(holder)).pipe(Effect.ignore)),
            );
          }),
        ),
        Effect.ignore,
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
const losingEnds = (lost: number, parentThreadId?: ThreadId) =>
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
              if (
                command.type !== "delegated_task.command.complete" ||
                (parentThreadId !== undefined && command.parentThreadId !== parentThreadId)
              ) {
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
/** Polls until the test writes `go`, or exits once teardown removes the workspace. */
const WAIT_FOR_GO = 'until [ -e go ]; do [ -d "$PWD" ] || exit 0; sleep 0.05; done';
/** Once `go` exists it kills its wrapper, leaving no exit status, then writes `orphaned`. */
const ORPHANING_COMMAND = `echo orphaning; ${STOP_NOTING_CHILD} ${WAIT_FOR_GO}; kill -9 $PPID; echo > orphaned; wait`;

// Tests of sh, kill and process groups skip on Windows, which lacks them. Its wrapper's stop and lost paths are
// tested in "a Windows command whose wrapper ended".

// Real processes and the real clock: the runner watches commands on a wall-clock interval.
it.layer(layerTest, { excludeTestServices: true })("a command run apart from its agent", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "retains the systemd owner when the server loses launch reconciliation after execution",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("scope-before-launch");
        const sql = yield* SqlClient.SqlClient;
        const agentScope = yield* AgentScope;
        const unit = "t3code-command-before-launch.scope";
        const stops = yield* Queue.unbounded<string>();
        const delivered = yield* Deferred.make<void>();
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(chat.workspace, "hold")]);
        yield* sql`CREATE TEMP TRIGGER reject_launch_reconcile BEFORE UPDATE ON command_runs WHEN NEW.pid IS NOT NULL BEGIN SELECT RAISE(FAIL, 'server stopped before launch reconciliation'); END`;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "cat hold",
            }),
          ),
        ).pipe(
          Effect.provideService(AgentScope, {
            ...agentScope,
            wrap: (input) =>
              agentScope.wrap(input).pipe(Effect.map((wrapped) => ({ ...wrapped, unit }))),
          }),
        );
        const pidFile = NodePath.join(NodePath.dirname(first.logPath), "pid");
        yield* awaitFile(pidFile);
        const [row] = yield* sql<{
          readonly unit: string | null;
          readonly pid: number | null;
        }>`SELECT unit, pid FROM command_runs WHERE task_id = ${first.taskId}`;
        assert.equal(row?.unit, unit);
        assert.isNull(row?.pid);
        yield* sql`DROP TRIGGER reject_launch_reconcile`;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
        yield* withServer(() =>
          Effect.gen(function* () {
            assert.equal(yield* Queue.take(stops), unit);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provideService(AgentScope, {
            ...agentScope,
            stopCommand: (name) => Queue.offer(stops, name).pipe(Effect.as(true)),
          }),
        );
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "a paused POSIX wrapper cannot run after restart cancels its gate",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("posix-native-gate");
        const agentScope = yield* AgentScope;
        let releasePath = "";
        const release = Effect.try(() => {
          if (releasePath === "") return;
          const descriptor = NodeFS.openSync(
            releasePath,
            NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            NodeFS.writeSync(descriptor, "go\n");
          } finally {
            NodeFS.closeSync(descriptor);
            releasePath = "";
          }
        });
        yield* Effect.gen(function* () {
          const first = yield* withServer((runner) =>
            runner.run(
              callerOf(chat.threadId),
              keyed({
                command: "echo ran > ran",
              }),
            ),
          ).pipe(
            Effect.provideService(AgentScope, {
              ...agentScope,
              wrap: (input) =>
                Effect.gen(function* () {
                  const wrapperAt = input.args.indexOf("t3-command");
                  const directory = NodePath.dirname(input.args[wrapperAt + 3]!);
                  releasePath = NodePath.join(directory, "release");
                  NodeChildProcess.execFileSync("mkfifo", [releasePath]);
                  const args = [...input.args];
                  args[wrapperAt - 1] =
                    'printf "ready\\n" > "${3%/*}/paused"; IFS= read -r go < "${3%/*}/release"\n' +
                    args[wrapperAt - 1];
                  return yield* agentScope.wrap({ ...input, args });
                }),
            }),
          );
          const directory = NodePath.dirname(first.logPath);
          yield* awaitFile(NodePath.join(directory, "paused"));
          yield* forgetPid(first.taskId);
          yield* withServer(() => nextWake(chat.threadId));
          assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
          yield* release;
          yield* awaitFile(NodePath.join(directory, "exit-status"));
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
        }).pipe(Effect.ensuring(release.pipe(Effect.ignore)));
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps running through a restart and wakes its chat once with its end",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-survives");
        // The child's stdout stays open until liveChat stops the group after delivery.
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(chat.workspace, "child-input")]);
        const started = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: `cat child-input & ${WAIT_FOR_GO}; echo checked; exit 3`,
              label: "Checks",
            }),
          ),
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
            .run(callerOf(chat.threadId), keyed({ command: "echo second" }))
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        assert.equal((yield* taskOf(chat.threadId, next.taskId))?.status, "completed");
        const row = yield* commandRow(started.taskId);
        assert.equal(row?.status, "exited");
        assert.isNotNull(row?.delivered_at);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "delivers an end that came while no server was running and bounds a pre-upgrade log",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-ends-while-down");
        const started = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: `${WAIT_FOR_GO}; echo built`,
            }),
          ),
        );
        const statusFile = NodePath.join(NodePath.dirname(started.logPath), "exit-status");
        const ended = awaitFile(statusFile);
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
        yield* ended;
        // A pre-upgrade wrapper appended directly to this file while the server was down.
        NodeFS.writeFileSync(started.logPath, Buffer.alloc(9 * 1024 * 1024, "x"));
        NodeFS.appendFileSync(started.logPath, "\nbuilt\n");
        // The status file is written as it ends, so its time is the end, not the next server's start.
        const startedAt = Date.parse((yield* commandRow(started.taskId))!.started_at);
        const endedAtSeconds = (startedAt + 42_000) / 1000;
        NodeFS.utimesSync(statusFile, endedAtSeconds, endedAtSeconds);
        yield* withServer(() => nextWake(chat.threadId));
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        assert.match(
          task?.result ?? "",
          /^Exited with code 0 after 42s\.\nLast output:\n…x+\nbuilt\n/,
        );
        assert.isBelow(NodeFS.statSync(started.logPath).size, 8 * 1024 * 1024);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "adopts a command whose server stopped before it recorded the pid",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-pid-unrecorded");
        const running = awaitFile(NodePath.join(chat.workspace, "running"));
        const started = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: `echo > running; ${WAIT_FOR_GO}; echo adopted`,
            }),
          ),
        );
        // Its wrapper writes pid and claims launch-started before running the command; wait for
        // the command itself so the restart adopts it rather than racing launch-pending.
        yield* running;
        yield* forgetPid(started.taskId);
        yield* withServer(() =>
          Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")).pipe(
            Effect.andThen(nextWake(chat.threadId)),
          ),
        );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.match(
          task?.result ?? "",
          /^Exited with code 0 after .+\.\nLast output:\nadopted\n/,
          JSON.stringify(yield* commandRow(started.taskId)),
        );
        assert.isNotNull((yield* commandRow(started.taskId))?.pid);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps the exact tail of a large command log while the server is down",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-log-trimmed");
        const input = NodePath.join(chat.workspace, "input");
        NodeChildProcess.execFileSync("mkfifo", [input]);
        const started = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({ command: "cat input && echo last-line >&2" }),
          ),
        );
        const output = Array.from(
          { length: 9 * 1024 },
          (_, line) => `${String(line).padEnd(1023, "x")}\n`,
        ).join("");
        yield* Effect.promise(() => NodeFS.promises.writeFile(input, output));
        yield* awaitFile(NodePath.join(NodePath.dirname(started.logPath), "exit-status"));
        const log = NodeFS.readFileSync(started.logPath, "utf8");
        assert.isBelow(log.length, 8 * 1024 * 1024);
        const marker = "[CodeShip removed earlier output to keep this log small]\n";
        assert.isTrue(log.startsWith(marker));
        const tail = log.slice(marker.length);
        assert.isAtLeast(tail.length, 4 * 1024 * 1024);
        assert.isTrue(`${output}last-line\n`.endsWith(tail));

        yield* withServer(() => nextWake(chat.threadId));
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        assert.include(task?.result ?? "", `last-line\nFull output: ${started.logPath}`);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "strips ANSI sequences and collapses carriage-return progress in Last output while keeping raw disk logs",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-ansi-tail");
        const raw = [
          "\u001b]0;build-title\u0007\u001b[32mPASS\u001b[0m suite-a",
          "\u001b[33mDownloading 10%\u001b[0m\r\u001b[2K\u001b[33mDownloading 50%\u001b[0m\r\u001b[2K\u001b[32mDownloading 100%\u001b[0m",
          "\u001b]8;;https://example.test\u001b\\report\u001b]8;;\u001b\\ \u001b7saved\u001b8\u001b(B",
        ].join("\n");
        const fixture = NodePath.join(chat.workspace, "raw.log");
        NodeFS.writeFileSync(fixture, `${raw}\n`, "utf8");
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), keyed({ command: "cat raw.log" }))
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        const result = task?.result ?? "";
        assert.match(
          result,
          /^Exited with code 0 after .+\.\nLast output:\nPASS suite-a\nDownloading 100%\nreport saved\nFull output: /,
        );
        assert.notInclude(result, "\u001b");
        assert.notInclude(result, "Downloading 10%");
        assert.equal(NodeFS.readFileSync(started.logPath, "utf8"), `${raw}\n`);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "caps clean exit 0 tails to 1536 chars while preserving up to 4096 chars on non-zero failure",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-tail-caps");
        const lines = Array.from(
          { length: 120 },
          (_, index) =>
            `\u001b[36mline-${String(index).padStart(3, "0")}\u001b[0m ${"x".repeat(40)}`,
        ).join("\n");
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "many.log"), `${lines}\n`, "utf8");
        const [passed, failed] = yield* withServer((runner) =>
          Effect.gen(function* () {
            const ok = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "cat many.log" }),
            );
            yield* nextWake(chat.threadId);
            const bad = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: "cat many.log; exit 2",
              }),
            );
            yield* nextWake(chat.threadId);
            return [ok, bad] as const;
          }),
        );
        const extractTail = (result: string) => {
          const match = /\nLast output:\n([\s\S]*)\nFull output: /.exec(result);
          assert.isNotNull(match);
          return match[1]!;
        };
        const okTask = yield* taskOf(chat.threadId, passed.taskId);
        assert.equal(okTask?.status, "completed");
        const okTail = extractTail(okTask?.result ?? "");
        assert.isAtMost(okTail.length, CommandRunner.RESULT_SUCCESS_TAIL_CHARS);
        assert.isAbove(okTail.length, 1000);
        assert.include(okTail, "line-119 ");
        assert.notInclude(okTail, "\u001b");

        const badTask = yield* taskOf(chat.threadId, failed.taskId);
        assert.equal(badTask?.status, "failed");
        const badTail = extractTail(badTask?.result ?? "");
        assert.isAbove(badTail.length, CommandRunner.RESULT_SUCCESS_TAIL_CHARS);
        assert.isAtMost(badTail.length, CommandRunner.RESULT_FAILURE_TAIL_CHARS);
        assert.isAbove(badTail.length, 3500);
        assert.include(badTail, "line-119 ");
        assert.notInclude(badTail, "\u001b");
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps valid UTF-8 in Last output when a large multi-byte log is sliced",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-utf8-tail");
        // Leading ASCII offsets the 8 KB seek into the middle of a 4-byte UTF-8 character.
        const payload = `a${"🚀".repeat(3000)}`;
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "utf8.log"), payload, "utf8");
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), keyed({ command: "cat utf8.log" }))
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "completed");
        const match = /\nLast output:\n([\s\S]*)\nFull output: /.exec(task?.result ?? "");
        assert.isNotNull(match);
        const tail = match[1]!;
        assert.isAtMost(tail.length, CommandRunner.RESULT_SUCCESS_TAIL_CHARS);
        assert.notInclude(tail, "\uFFFD");
        assert.equal(Buffer.from(tail, "utf8").toString("utf8"), tail);
        assert.isTrue(tail.endsWith("🚀🚀🚀"));
      }),
  );

  describe.runIf(isLinuxHost)("Linux process identity", () => {
    it.effect("still stops a command after a step of the wall clock moved what ps reports", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-clock-step");
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
        );
        yield* awaitFile(NodePath.join(chat.workspace, "ready"));
        yield* hideHolder(NodePath.dirname(started.logPath));
        assert.match((yield* commandRow(started.taskId))!.process_identity!, /^boot:/);
        yield* (yield* Orchestrator.OrchestratorV2).dispatch(
          cancellationOf(chat.threadId, started.taskId),
        );
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(started.taskId, delivered),
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              input.command === "ps"
                ? processRunner
                    .run(input)
                    .pipe(
                      Effect.map((result) => ({ ...result, stdout: "Sat Jan  1 00:00:00 2000\n" })),
                    )
                : processRunner.run(input),
          }),
        );
        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
      }),
    );

    it.effect(
      "reports a command lost when a later kernel identity read finds another process under its pid",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-unconfirmed-identity");
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* awaitFile(NodePath.join(chat.workspace, "ready"));
          // Only once no holder keeps the number can another process have taken the pid.
          yield* hideHolder(NodePath.dirname(started.logPath));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE command_runs SET process_identity = process_identity || '0' WHERE task_id = ${started.taskId}`;
          const fs = yield* FileSystem.FileSystem;
          const delivered = yield* Deferred.make<void>();
          let reads = 0;
          yield* withServer(() => Deferred.await(delivered)).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) => {
                if (/^\/proc\/\d+\/stat$/.test(file) && ++reads === 1)
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "readFileString",
                      pathOrDescriptor: file,
                    }),
                  );
                return fs.readFileString(file, encoding);
              },
            }),
          );
          assert.equal((yield* commandRow(started.taskId))?.lost_reason, "pid-reused");
          assert.isAbove(reads, 1);
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );
  });

  it.effect.each([
    ["/t3-agent-tools", true, "command-agent-shell"],
    ["", true, "command-agent-shell-empty-path"],
    ["/t3-agent-tools", false, "command-agent-shell-no-host-path"],
    ["", false, "command-agent-shell-empty-path-no-host-path"],
  ] as const)(
    "gives a command what its agent's own shell commands get, shell options only to the command, PATH %j, host PATH %s",
    ([PATH, hostHasPath, name]) =>
      Effect.gen(function* () {
        // Windows names ignore case, so its host PATH may be spelled Path.
        const hostWithoutPath = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            isWindowsHost ? key.toLowerCase() !== "path" : key !== "PATH",
          ),
        );
        const chat = yield* liveChat(name);
        NodeFS.mkdirSync(NodePath.join(chat.workspace, "sub"));
        const started = yield* withServer((runner) =>
          runner
            .run(
              callerOf(chat.threadId),
              keyed({
                // The command runs in the host's shell: PowerShell on Windows, sh elsewhere.
                command: isWindowsHost
                  ? '$removed = if (Test-Path Env:HOST_REMOVED) { $env:HOST_REMOVED } else { "removed" }; [Console]::WriteLine(($env:AGENT_SETTING, $env:T3CODE_THREAD_ID, $env:HOST_KEPT, $removed -join " ")); [Console]::WriteLine($env:PATH); [Console]::WriteLine($env:SHELLOPTS); exit 7'
                  : 'printf "%s %s %s %s\\n%s\\n%s\\n" "$AGENT_SETTING" "$T3CODE_THREAD_ID" "$HOST_KEPT" "${HOST_REMOVED-removed}" "$PATH" "$SHELLOPTS"; exit 7',
                cwd: "sub",
              }),
            )
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provide(
            providerShell((cwd, { HOST_REMOVED: _removed, ...inherited }) =>
              // A PATH without the wrapper's own tools, which it still needs to record the end.
              // Neither sh nor PowerShell (-NoProfile) reads startup files that could add to it.
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
        ).split(/\r?\n/);
        // Read for the chat's folder, as the agent's own settings were, though it ran below it.
        assert.equal(started.shell, isWindowsHost ? "powershell" : "sh");
        assert.equal(seen, `set for ${chat.workspace} ${chat.threadId} kept removed`);
        assert.equal(commandPath, PATH);
        assert.match(shellOptions ?? "", /errexit/);
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "failed");
        assert.match(task?.result ?? "", /^Exited with code 7 after /);
      }),
  );

  it.effect(
    "starts a Windows command from a hidden wrapper, with the host environment under its agent's in Unicode, each name once, writing no value and reading none to start",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-environment");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const refused = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), keyed({ command: "Write-Output started" }))
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
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
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
          Effect.provideService(HostProcess.Environment, {
            Path: "C:\\host",
            HOST_ONLY: "kept",
            HOST_REMOVED: "removed by its settings",
            SystemRoot: "C:\\Windows",
            T3CODE_AUTH_TOKEN: "server only",
          }),
        );
        assert.include(
          (yield* taskOf(chat.threadId, refused.taskId))?.result ?? "",
          "Win32_Process.Create returned 9",
        );
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
        // It works in its own folder and gives the command its cwd ("a Windows command's folder").
        assert.include(launcherScript, `CurrentDirectory = '${NodePath.dirname(runPath)}'`);
        assert.include(
          NodeFS.readFileSync(runPath, "utf8"),
          `$start.WorkingDirectory = '${chat.workspace}'`,
        );
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
          runner.run(callerOf(chat.threadId), keyed({ command, shell: "bash" })),
        ).pipe(
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
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
        runner.run(callerOf(chat.threadId), keyed({ command: "true" })),
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
              const request = keyed({ command: ORPHANING_COMMAND });
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: LOSING_COMMAND }),
            );
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
              const started = yield* runner.run(
                callerOf(chat.threadId),
                keyed({
                  // As ORPHANING_COMMAND, with a log too large once `go` exists.
                  command: `${STOP_NOTING_CHILD} ${WAIT_FOR_GO}; head -c 9000000 /dev/zero | tr '\\0' x; echo; kill -9 $PPID; echo > orphaned; wait`,
                }),
              );
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
              .run(
                callerOf(chat.threadId),
                keyed({
                  command: `${WAIT_FOR_GO}; echo watched`,
                }),
              )
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
          runner.run(callerOf(chat.threadId), keyed({ command: "echo started" })).pipe(Effect.flip),
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
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const fs = yield* FileSystem.FileSystem;
      const starting = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      // Its first process lookup is the one that names the command it just started.
      let spawning = false;
      const holdRead = awaitFile(NodePath.join(chat.workspace, "ready")).pipe(
        Effect.andThen(Deferred.succeed(starting, undefined)),
        Effect.andThen(Deferred.await(proceed)),
      );
      const started = yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = yield* runner
            .run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` }))
            .pipe(Effect.forkChild);
          yield* Deferred.await(starting);
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.dispatch(deletionOf(chat.threadId))),
          );
          yield* Deferred.succeed(proceed, undefined);
          const result = yield* Fiber.join(request);
          yield* awaitFile(NodePath.join(chat.workspace, "stopped"));
          return result;
        }),
      ).pipe(
        Effect.provideService(AgentScope, {
          ...agentScope,
          wrap: (input) =>
            Effect.sync(() => {
              spawning = true;
            }).pipe(Effect.andThen(agentScope.wrap(input))),
        }),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (!spawning || input.command !== "ps") return processRunner.run(input);
            spawning = false;
            return holdRead.pipe(Effect.andThen(processRunner.run(input)));
          },
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) => {
            if (!spawning || !/^\/proc\/\d+\/stat$/.test(file))
              return fs.readFileString(file, encoding);
            spawning = false;
            return holdRead.pipe(Effect.andThen(fs.readFileString(file, encoding)));
          },
        }),
      );
      assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
    }),
  );

  it.effect("returns the same task when concurrent retries share a clientRequestId", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("concurrent-retry");
      const request = {
        command: "echo concurrent",
        cwd: chat.workspace,
        clientRequestId: "concurrent-retry",
      };
      const baseFs = yield* FileSystem.FileSystem;
      const bothRead = yield* Deferred.make<void>();
      let arrivals = 0;
      const [first, second] = yield* withServer((runner) =>
        Effect.all(
          [
            runner.run(callerOf(chat.threadId), request),
            runner.run(callerOf(chat.threadId), request),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.tap(() => nextWake(chat.threadId))),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...baseFs,
          stat: (target) =>
            Effect.gen(function* () {
              // Hold both callers after getThreadRecords and before admission so both
              // observe an empty parent.subagents snapshot before either records the task.
              if (target === chat.workspace && arrivals < 2) {
                arrivals += 1;
                if (arrivals === 2) yield* Deferred.succeed(bothRead, undefined);
                else yield* Deferred.await(bothRead);
              }
              return yield* baseFs.stat(target);
            }),
        }),
      );
      assert.equal(second.taskId, first.taskId);
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
          runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provideService(AgentScope, {
            ...unstartable,
            wrap: ({ args }) => Effect.succeed({ command: "/nonexistent/t3-shell", args }),
          }),
        );
        assert.match(
          (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
          /^Could not start the command: /,
        );
        const retried = yield* withServer((runner) => runner.run(callerOf(chat.threadId), request));
        assert.equal(retried.taskId, first.taskId);
        const projection = yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
        );
        const tasks = projection.subagents.filter((task) => task.command !== undefined);
        assert.deepEqual(
          tasks.map((task) => task.status),
          ["failed"],
        );
        assert.equal((yield* commandRow(tasks[0]!.id))?.status, "unstarted");
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: `${STOP_NOTING_CHILD} wait`,
              }),
            );
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
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
            }),
          ),
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
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(started.taskId, delivered),
          ),
        );
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
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* ready;
          const run = (yield* commandRow(started.taskId))!;
          yield* hideHolder(run.directory);
          const pidFile = NodePath.join(run.directory, "pid");
          const named = NodeFS.readFileSync(pidFile, "utf8");
          NodeFS.unlinkSync(pidFile);
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.writeFileSync(pidFile, named)).pipe(
              Effect.andThen(
                sql`UPDATE command_runs SET delivered_at = started_at WHERE task_id = ${started.taskId}`,
              ),
              Effect.ignore,
            ),
          );
          yield* sql`
          UPDATE command_runs SET process_identity = NULL WHERE task_id = ${started.taskId}
        `;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          yield* withServer((runner) => nextPass(runner, chat.threadId));

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
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* ready;
          const run = (yield* commandRow(started.taskId))!;
          yield* forgetPid(started.taskId);
          // A later step of the wall clock moves the start ps reports past when it wrote its pid.
          NodeFS.utimesSync(NodePath.join(run.directory, "pid"), 946_684_800, 946_684_800);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          const delivered = yield* Deferred.make<void>();
          yield* withServer(() => Deferred.await(delivered)).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
          );

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
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
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
          // Legacy pid-only file written well before the decoy started.
          NodeFS.writeFileSync(pidFile, `${decoy.pid}\n`);
          NodeFS.utimesSync(pidFile, 946_684_800, 946_684_800);
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
          const delivered = yield* Deferred.make<void>();
          yield* withServer(() => Deferred.await(delivered)).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
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
          const chat = yield* liveChat("command-boot-clock-step");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* ready;
          // So that only its identity tells the runner the group is still the command's.
          yield* hideHolder((yield* commandRow(started.taskId))!.directory);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          const fileSystem = yield* FileSystem.FileSystem;
          const delivered = yield* Deferred.make<void>();
          // A start on the wall clock adds the boot time, which every step of that clock moves.
          yield* withServer(() => Deferred.await(delivered)).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
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
          runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
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
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(started.taskId, delivered),
          ),
        );

        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
      }),
    );
  });

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
    it.effect.skipIf(!holdsGroups)(
      "keeps a held command running when a start read disagrees with its record",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-held-other-identity");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* ready;
          yield* recordOtherStart(started.taskId);
          // A full pass waits until the server has adopted and checked what the earlier one left.
          yield* withServer((runner) => nextPass(runner, chat.threadId));
          assert.equal((yield* commandRow(started.taskId))?.status, "running");
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );

    it.effect(
      "reports a command lost when a later start read finds another process under its pid",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-later-start-read");
          const ready = awaitFile(NodePath.join(chat.workspace, "ready"));
          const started = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
          );
          yield* ready;
          // Only once no holder keeps the number can another process have taken the pid.
          yield* hideHolder(NodePath.dirname(started.logPath));
          yield* recordOtherStart(started.taskId);
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
            runner.run(callerOf(chat.threadId), keyed({ command: `${STOP_NOTING_CHILD} wait` })),
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
          const delivered = yield* Deferred.make<void>();
          yield* withServer(() => Deferred.await(delivered)).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
          );

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
            runner.run(
              callerOf(chat.threadId),
              keyed({
                command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
              }),
            ),
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
const LOSING_COMMAND = `${WAIT_FOR_GO}; kill -9 $PPID`;
const go = (chat: { readonly workspace: string }) =>
  NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");

/**
 * Resolves once a pass that began after the call has ended, its wave noted. A pass wakes a command's
 * chat before it notes its wave, and run() waits for the pass under way, so the second command
 * starts only after the pass that saw the first one end; at a server's start none is under way.
 */
const nextPass = (runner: CommandRunner.CommandRunner["Service"], threadId: ThreadId) => {
  const runToEnd = Effect.suspend(() =>
    runner.run(callerOf(threadId), keyed({ command: "true" })),
  ).pipe(Effect.andThen(nextWake(threadId)));
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
              runner.run(callerOf(chat.threadId), keyed({ command: LOSING_COMMAND })),
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
              runner.run(callerOf(chat.threadId), keyed({ command: LOSING_COMMAND })),
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
            runner.run(callerOf(chat.threadId), keyed({ command: LOSING_COMMAND })),
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: LOSING_COMMAND,
              }),
            );
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
              const started = yield* runner.run(
                callerOf(chat.threadId),
                keyed({
                  command: LOSING_COMMAND,
                }),
              );
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

/** A process as a test command records it: its PID and creation FILETIME (UTC). */
interface RecordedProcess {
  readonly pid: number;
  readonly created: string;
}

// PowerShell that records the process `$p` as `readRecordedProcess` reads it.
const recordProcess = (file: string, process: string) =>
  `Set-Content -LiteralPath '${file}' -Value ('{0} {1}' -f ${process}.Id, ${process}.StartTime.ToFileTimeUtc())`;

const readRecordedProcess = (file: string): RecordedProcess => {
  const match = /^(\d+) (\d+)$/.exec(NodeFS.readFileSync(file, "utf8").trim());
  if (!match) throw new Error(`${file} does not record a process as "<pid> <creation time>"`);
  return { pid: Number.parseInt(match[1]!, 10), created: match[2]! };
};

// A synchronous probe blocks the event loop, so no test timeout can end one that hangs.
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Whether the recorded process is still running once it has had `waitMs` to end after being
 * stopped; a survivor is stopped. Windows reuses a PID soon after its process ends, so the
 * creation time tells the recorded process from a later one with its PID.
 */
const survived = ({ pid, created }: RecordedProcess, waitMs = 10_000) =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($p -and $p.StartTime.ToFileTimeUtc() -eq ${created} -and -not $p.WaitForExit(${waitMs})) { $p.Kill(); 'alive' } else { 'gone' }`,
    ],
    { encoding: "utf8", timeout: waitMs + PROBE_TIMEOUT_MS },
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

describe.runIf(isDarwinHost)("macOS idle-sleep assertion", () => {
  it.live("caffeinate holds until the watched command ends, then exits by itself", () =>
    Effect.promise(async () => {
      const watched = NodeChildProcess.spawn("/bin/sleep", ["60"], { stdio: "ignore" });
      const [file, args] = CommandRunner.macKeepAwakeCommand(watched.pid ?? 0);
      const awake = NodeChildProcess.spawn(file, [...args], { stdio: "ignore" });
      const ended = new Promise<void>((resolve) => awake.once("exit", () => resolve()));
      assert.isNull(awake.exitCode);
      watched.kill("SIGKILL");
      await ended;
      assert.isNotNull(awake.exitCode ?? awake.signalCode);
    }),
  );
});

const processOutput = (stdout = "") => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** A WMI boundary with explicit launch/probe barriers and no operating-system processes. */
const windowsTicks = (milliseconds: number) =>
  String(BigInt(milliseconds) * 10_000n + 116_444_736_000_000_000n);

const fixtureWindowsIdentity = (entry: { identity: number; ticks?: number }) =>
  String(BigInt(windowsTicks(entry.identity)) + BigInt(entry.ticks ?? 0));

const windowsFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const probes = yield* Queue.unbounded<void>();
  const reads = yield* Queue.unbounded<string>();
  const renamed = yield* Queue.unbounded<string>();
  const stopped = yield* Queue.unbounded<{
    readonly pid: number;
    readonly identity: number | undefined;
  }>();
  const processes = new Map<
    number,
    { identity: number; ticks?: number; alive: boolean; directory: string }
  >();
  const jobs = new Map<string, { pid: number; identity: number; ticks?: number }>();
  const groups = new Set<number>();
  const groupSignals: Array<string | number | undefined> = [];
  let nextPid = 2_147_483_000;
  const clock = yield* Clock.Clock;
  const fixture = {
    now: yield* Clock.currentTimeMillis,
    probes,
    reads,
    renamed,
    stopped,
    processes,
    jobs,
    groups,
    groupSignals,
    stopRequests: [] as Array<ReadonlyArray<string>>,
    /** The pid and FILETIME pairs each stop of a command without a job started from. */
    treeStops: [] as Array<ReadonlyArray<string>>,
    /** What the host prints after it stops the processes a stop without a job starts from. */
    treeStop: (_roots: ReadonlyArray<string>): Effect.Effect<string> => Effect.succeed(""),
    unavailable: false,
    failGate: false,
    /** Its launches leave a wrapper whose startup stalls before it reaches its gate. */
    stalledWrapper: false,
    failRead: "",
    launches: 0,
    kills: 0,
    stopError: "",
    probeCalls: 0,
    beforeProbe: Effect.void as Effect.Effect<void>,
    sleep: (duration: Duration.Duration) => clock.sleep(duration),
    signalGroup: (pid: number, signal: string | number | undefined) => {
      if (!groups.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0) groups.delete(pid);
    },
    launch: (_input: ProcessRunner.ProcessRunInput, directory: string) =>
      Effect.gen(function* () {
        const pid = nextPid++;
        const identity = DateTime.toEpochMillis(yield* DateTime.now);
        processes.set(pid, { identity, alive: true, directory });
        groups.add(pid);
        jobs.set(NodePath.basename(directory), { pid, identity });
        NodeFS.writeFileSync(
          NodePath.join(directory, "pid"),
          `${pid} ft:${windowsTicks(identity)}`,
        );
        if (!fixture.stalledWrapper)
          NodeFS.renameSync(
            NodePath.join(directory, "launch-pending"),
            NodePath.join(directory, "launch-started"),
          );
        return processOutput(`${pid} ft:${windowsTicks(identity)}`);
      }) as Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  };
  const bootedAt = fixture.now - 86_400_000;
  const uptime = vi
    .spyOn(NodeOS, "uptime")
    .mockImplementation(() => (fixture.now - bootedAt) / 1_000);
  yield* Effect.addFinalizer(() => Effect.sync(() => uptime.mockRestore()));
  const originalKill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && processes.has(-pid)) {
      groupSignals.push(signal);
      fixture.signalGroup(-pid, signal);
      return true;
    }
    const known = processes.get(pid);
    if (known === undefined) return originalKill(pid, signal);
    assert.equal(signal, 0);
    if (!known.alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
  const ioError = (method: string) =>
    new PlatformError.PlatformError(
      new PlatformError.SystemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method,
      }),
    );
  const layer = Layer.mergeAll(
    Layer.succeed(Clock.Clock, {
      currentTimeMillis: Effect.sync(() => fixture.now),
      currentTimeMillisUnsafe: () => fixture.now,
      currentTimeNanos: Effect.sync(() => BigInt(fixture.now) * 1_000_000n),
      currentTimeNanosUnsafe: () => BigInt(fixture.now) * 1_000_000n,
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: (duration) => fixture.sleep(duration),
    }),
    Layer.succeed(HostProcess.Platform, "win32"),
    Layer.succeed(WindowsJobHost, Effect.succeed("job-host.exe")),
    Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      readFileString: (file, ...args) =>
        Effect.gen(function* () {
          yield* Queue.offer(reads, file);
          if (NodePath.basename(file) === fixture.failRead) return yield* ioError("readFileString");
          return yield* fs.readFileString(file, ...args);
        }),
      rename: (from, to) =>
        Effect.gen(function* () {
          if (fixture.failGate && NodePath.basename(from) === "launch-pending")
            return yield* ioError("rename");
          yield* fs.rename(from, to);
          yield* Queue.offer(renamed, to);
        }),
    }),
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          const script = input.args.join(" ");
          if (input.command === "job-host.exe" && input.args[0] === "stop") {
            fixture.stopRequests.push(input.args);
            const member = jobs.get(input.args[1]!.split(".").at(-1)!);
            if (member === undefined) return processOutput();
            const entry = processes.get(member.pid)!;
            const original =
              fixtureWindowsIdentity(entry) === fixtureWindowsIdentity(member) &&
              entry.alive &&
              (input.args.length === 2 ||
                (Number(input.args[2]) === member.pid &&
                  input.args[3] === fixtureWindowsIdentity(member)));
            if (original && NodeFS.existsSync(NodePath.join(entry.directory, "exit-status")))
              entry.alive = false;
            if (entry.alive && original) fixture.kills++;
            if (fixture.stopError !== "") {
              yield* Queue.offer(stopped, member);
              return {
                ...processOutput(),
                code: ChildProcessSpawner.ExitCode(1),
                stderr: fixture.stopError,
              };
            }
            if (original) entry.alive = false;
            yield* Queue.offer(stopped, member);
            return processOutput();
          }
          if (script.includes("Win32_Process -MethodName Create")) {
            fixture.launches++;
            const wrapper = /-File "(.+run\.ps1)"/.exec(script)?.[1];
            assert.isDefined(wrapper);
            return yield* fixture.launch(input, NodePath.dirname(wrapper!));
          }
          if (input.command === "job-host.exe" && input.args[0] === "stop-tree") {
            const roots = input.args.slice(1);
            fixture.treeStops.push(roots);
            for (let at = 0; at < roots.length; at += 2) {
              const pid = Number(roots[at]);
              const identity = Number(
                (BigInt(roots[at + 1]!) - 116_444_736_000_000_000n) / 10_000n,
              );
              const entry = processes.get(pid);
              if (entry !== undefined && roots[at + 1] === fixtureWindowsIdentity(entry)) {
                fixture.kills++;
                entry.alive = false;
              }
              yield* Queue.offer(stopped, { pid, identity });
            }
            return processOutput(yield* fixture.treeStop(roots));
          }
          const probe =
            input.command === "ps"
              ? /-p (\d+)/.exec(script)
              : input.command === "job-host.exe"
                ? /identity (\d+)/.exec(script)
                : /(?:Get-Process -Id |ProcessId = )(\d+)/.exec(script);
          assert.isNotNull(probe, script);
          fixture.probeCalls++;
          yield* Queue.offer(probes, undefined);
          yield* fixture.beforeProbe;
          if (fixture.unavailable)
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            });
          return processOutput(
            input.command === "ps"
              ? DateTime.toDateUtc(DateTime.makeUnsafe(processes.get(Number(probe![1]))!.identity))
                  .toUTCString()
                  .replace(" GMT", "")
              : input.command === "job-host.exe" && input.args.length > 2
                ? `${fixtureWindowsIdentity(processes.get(Number(probe![1]))!)} ${
                    input.args[2] ===
                    NodePath.join(processes.get(Number(probe![1]))!.directory, "run.ps1")
                      ? "named"
                      : "other"
                  }`
                : script.includes("Get-CimInstance") || input.command === "job-host.exe"
                  ? fixtureWindowsIdentity(processes.get(Number(probe![1]))!)
                  : DateTime.formatIso(
                      DateTime.makeUnsafe(processes.get(Number(probe![1]))!.identity),
                    ),
          );
        }),
    }),
  );
  return { ...fixture, state: fixture, layer };
});

it.layer(layerTest, { excludeTestServices: true })("launch reconciliation", (it) => {
  it.effect(
    "does not blame executable policy for an unrelated nonzero Windows launcher result",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-host-policy");
        const fixture = yield* windowsFixture;
        fixture.state.launch = () =>
          Effect.succeed({
            ...processOutput(),
            code: ChildProcessSpawner.ExitCode(1),
            stderr: "Win32_Process.Create returned 2",
          });
        const result = yield* withServer((runner) =>
          runner
            .run(
              callerOf(chat.threadId),
              keyed({
                command: "echo policy",
              }),
            )
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(Effect.provide(fixture.layer));
        const message = (yield* taskOf(chat.threadId, result.taskId))?.result ?? "";
        assert.include(message, "Win32_Process.Create returned 2");
        assert.notInclude(message, "AppLocker or WDAC");
      }),
  );

  it.effect.each(["cancelled", "already stopped"] as const)(
    "closes a pending gate during restart cleanup for a task %s before late Create",
    (state) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`restart-pending-${state}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo late Create" })),
        ).pipe(Effect.provide(fixture.layer));
        const directory = NodePath.dirname(first.logPath);
        yield* forgetPid(first.taskId);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        NodeFS.renameSync(
          NodePath.join(directory, "launch-started"),
          NodePath.join(directory, "launch-pending"),
        );
        fixture.jobs.clear();
        fixture.processes.get(2147483000)!.alive = false;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
        const sql = yield* SqlClient.SqlClient;
        if (state === "already stopped")
          yield* sql`UPDATE command_runs SET status = 'stopped' WHERE task_id = ${first.taskId}`;
        const delivered = yield* Deferred.make<void>();
        const adoptedGate = yield* Deferred.make<boolean>();
        yield* withServer(() =>
          Effect.gen(function* () {
            if (state === "cancelled") assert.isTrue(yield* Deferred.await(adoptedGate));
            yield* Deferred.await(delivered);
            assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
            // The delayed host publishes identity before its wrapper competes for the gate.
            NodeFS.writeFileSync(
              NodePath.join(directory, "pid"),
              `2147483000 ft:${windowsTicks(fixture.now)}`,
            );
            assert.throws(() =>
              NodeFS.renameSync(
                NodePath.join(directory, "launch-pending"),
                NodePath.join(directory, "launch-started"),
              ),
            );
            assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "launch-started")));
            assert.equal((yield* commandRow(first.taskId))?.status, "stopped");
            assert.lengthOf(fixture.stopRequests, 0);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) => {
            if (args[0].compile()[0].includes("SELECT task_id FROM command_runs"))
              return Deferred.succeed(
                adoptedGate,
                NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")),
              ).pipe(Effect.as(args[0]));
            return observeDelivery(first.taskId, delivered)(...args);
          }),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect(
    "reports pending command cleanup through task_cancel before a failed stop can finish",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("mcp-cancel-command-cleanup");
        const fixture = yield* windowsFixture;
        fixture.state.stopError = "injected stop access denied";
        const reported = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        let taskId: string | undefined;
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const scope = orchestratorOf(chat.threadId);
            const started = yield* runner.run(scope, keyed({ command: "echo held cleanup" }));
            taskId = started.taskId;
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            const cancelled = yield* mcp.cancelTask(scope, {
              taskId: NodeId.make(taskId),
              reason: "requested stop",
            });
            assert.equal(cancelled.status, "cancelled");
            assert.equal(cancelled.cleanup, "pending");
            yield* Queue.take(fixture.stopped);
            yield* Deferred.await(reported);
            const task = yield* taskOf(chat.threadId, taskId);
            assert.include(task?.result ?? "", "cleanup is still pending");
            assert.include(task?.result ?? "", "Reason: requested stop");
            assert.notEqual(task?.completionDelivery?.state, "disposed");
            yield* nextWake(chat.threadId);
            assert.equal(fixture.state.stopError, "injected stop access denied");
            assert.isNull((yield* commandRow(taskId))?.delivered_at);
            fixture.state.stopError = "";
            yield* Deferred.await(delivered);
          }).pipe(Effect.provide(mcpOver(runner))),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            taskId === undefined
              ? Effect.succeed(args[0])
              : args[0].compile()[1][6] == null
                ? observeDelivery(taskId, reported, "reported_at")(...args)
                : observeDelivery(taskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect("reports through task_cancel that the cancelled command was stopped", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("mcp-cancel-command-stopped");
      const fixture = yield* windowsFixture;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const scope = orchestratorOf(chat.threadId);
          const { taskId } = yield* runner.run(scope, keyed({ command: "echo stopped" }));
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const cancelled = yield* mcp.cancelTask(scope, {
            taskId: NodeId.make(taskId),
            reason: "done with it",
          });
          assert.equal(cancelled.status, "cancelled");
          assert.equal(cancelled.cleanup, "stopped");
          const task = yield* taskOf(chat.threadId, taskId);
          assert.equal(task?.status, "cancelled");
          assert.match(
            task?.result ?? "",
            /^Cancelled and stopped after .+\.\nReason: done with it\n/,
          );
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
          assert.equal(fixture.state.kills, 1);
        }).pipe(Effect.provide(mcpOver(runner))),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reports through task_cancel the exit of a command that ended before the cancel", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("mcp-cancel-command-exited");
      const fixture = yield* windowsFixture;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const scope = orchestratorOf(chat.threadId);
          const { taskId, logPath } = yield* runner.run(scope, keyed({ command: "echo exited" }));
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(logPath), "exit-status"), "3");
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const cancelled = yield* mcp.cancelTask(scope, { taskId: NodeId.make(taskId) });
          assert.equal(cancelled.status, "failed");
          assert.isUndefined(cancelled.cleanup);
          const row = yield* commandRow(taskId);
          assert.equal(row?.status, "exited");
          assert.equal(row?.exit_code, 3);
          assert.match(
            (yield* taskOf(chat.threadId, taskId))?.result ?? "",
            /^Exited with code 3 /,
          );
        }).pipe(Effect.provide(mcpOver(runner))),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reports through task_cancel a command cancelled before its launch started", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("mcp-cancel-before-launch");
      const fixture = yield* windowsFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      // The launcher is held, as a slow host would be; its wrapper then stalls before the gate.
      fixture.state.stalledWrapper = true;
      fixture.state.launch = (input, directory) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(create(input, directory)),
        );
      let taskId: string | undefined;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const scope = orchestratorOf(chat.threadId);
          const request = { command: "echo never", clientRequestId: "cancel-before-launch" };
          const launch = yield* runner.run(scope, request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          taskId = (yield* runner.run(scope, request)).taskId;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const cancelled = yield* mcp.cancelTask(scope, {
            taskId: NodeId.make(taskId),
            reason: "not needed",
          });
          assert.equal(cancelled.status, "cancelled");
          assert.equal(cancelled.cleanup, "never-started");
          const task = yield* taskOf(chat.threadId, taskId);
          assert.match(
            task?.result ?? "",
            /^Cancelled before the command started\.\nReason: not needed\n/,
          );
          // Its launcher may still publish a process, so its cleanup waits for the launch.
          assert.isNull((yield* commandRow(taskId))?.delivered_at);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(launch);
          yield* Deferred.await(delivered);
          assert.equal(fixture.state.kills, 1);
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
        }).pipe(Effect.provide(mcpOver(runner))),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          taskId === undefined
            ? Effect.succeed(args[0])
            : observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      );
    }),
  );

  it.effect("stops the job of a command cancelled before its stalled wrapper took the gate", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("mcp-cancel-stalled-wrapper");
      const fixture = yield* windowsFixture;
      fixture.state.stalledWrapper = true;
      const delivered = yield* Deferred.make<void>();
      let taskId: string | undefined;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const scope = orchestratorOf(chat.threadId);
          taskId = (yield* runner.run(scope, keyed({ command: "echo never" }))).taskId;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const cancelled = yield* mcp.cancelTask(scope, { taskId: NodeId.make(taskId) });
          assert.equal(cancelled.cleanup, "never-started");
          assert.match(
            (yield* taskOf(chat.threadId, taskId))?.result ?? "",
            /^Cancelled before the command started\./,
          );
          yield* Deferred.await(delivered);
          assert.equal(fixture.state.kills, 1);
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
        }).pipe(Effect.provide(mcpOver(runner))),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          taskId === undefined
            ? Effect.succeed(args[0])
            : observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("stops the job a host published before a restart once cleanup closes its gate", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("restart-published-cancelled");
      const fixture = yield* windowsFixture;
      fixture.state.stalledWrapper = true;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo published" })),
      ).pipe(Effect.provide(fixture.layer));
      // The server stopped before it recorded what the host published.
      yield* forgetPid(first.taskId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
      const directory = NodePath.dirname(first.logPath);
      assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
      assert.equal(fixture.state.kills, 1);
      assert.isFalse(fixture.processes.get(2147483000)!.alive);
    }),
  );

  it.effect(
    "reports a cancelled command whose pid file cannot be read and stops its job once it can",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("restart-pid-unreadable-cancelled");
        const fixture = yield* windowsFixture;
        fixture.state.stalledWrapper = true;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo published" })),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
        fixture.state.failRead = "pid";
        const reported = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(reported);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            assert.equal(fixture.state.kills, 0);
            fixture.state.failRead = "";
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          // A delivery also records its report, so it is matched first.
          Effect.provideService(Statement.CurrentTransformer, (statement, sql, context, span) =>
            observeDelivery(first.taskId, delivered)(statement, sql, context, span).pipe(
              Effect.flatMap((next) =>
                observeDelivery(first.taskId, reported, "reported_at")(next, sql, context, span),
              ),
            ),
          ),
          Effect.provide(fixture.layer),
        );
        assert.equal(fixture.state.kills, 1);
        assert.isFalse(fixture.processes.get(2147483000)!.alive);
      }),
  );

  it.effect("adopts an earlier server's commands after a failed try, so a cancel stops them", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("adopt-after-failed-try");
      const fixture = yield* windowsFixture;
      const { taskId } = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo left running" })),
      ).pipe(Effect.provide(fixture.layer));
      const retried = yield* Deferred.make<void>();
      let scans = 0;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          // The try after the failed one, which the cancel waits for.
          yield* Deferred.await(retried).pipe(Effect.timeout("10 seconds"));
          const cleanup = yield* runner.cancel({
            parentThreadId: chat.threadId,
            taskId: NodeId.make(taskId),
            reason: undefined,
          });
          assert.equal(cleanup, "stopped");
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
          assert.equal((yield* taskOf(chat.threadId, taskId))?.status, "cancelled");
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement, sql) => {
          if (!statement.compile()[0].includes("FROM command_runs WHERE delivered_at IS NULL"))
            return Effect.succeed(statement);
          scans += 1;
          return scans === 1
            ? Effect.succeed(sql`SELECT * FROM command_runs_unreadable`)
            : Deferred.succeed(retried, undefined).pipe(Effect.as(statement));
        }),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("leaves a delivered command's result to a cancel that comes after it", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("cancel-after-delivery");
      const fixture = yield* windowsFixture;
      const delivered = yield* Deferred.make<void>();
      let taskId = "";
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo delivered" }),
          );
          taskId = result.taskId;
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* Deferred.await(delivered);
          const cleanup = yield* runner.cancel({
            parentThreadId: chat.threadId,
            taskId: NodeId.make(taskId),
            reason: undefined,
          });
          assert.isUndefined(cleanup);
          const task = yield* taskOf(chat.threadId, taskId);
          assert.equal(task?.status, "completed");
          assert.match(task?.result ?? "", /^Exited with code 0 /);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect(
    "keeps a Windows command by its full creation time when the clock steps past its boot",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-clock-step");
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo clock step" })),
        ).pipe(Effect.provide(fixture.layer));
        // By its uptime the machine booted a second ago, after the clock says the command started.
        vi.mocked(NodeOS.uptime).mockReturnValue(1);
        fixture.state.now += 60_000;
        const judged = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(judged);
            assert.isNull((yield* commandRow(result.taskId))?.lost_reason);
            yield* Orchestrator.OrchestratorV2.pipe(
              Effect.flatMap((orchestrator) =>
                orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
              ),
            );
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            args[0].compile()[1][6] == null
              ? observeDelivery(result.taskId, judged, "pid")(...args)
              : observeDelivery(result.taskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
        );
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.status, "stopped");
        assert.isNull(row?.lost_reason);
        assert.isFalse(fixture.processes.get(2147483000)!.alive);
        assert.equal(fixture.state.kills, 1);
      }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "reports %s before a legacy cleanup identity probe is released",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`report-held-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo held cleanup",
              timeoutMinutes: 1,
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const release = yield* Deferred.make<void>();
        const reported = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        fixture.state.beforeProbe = Deferred.await(release);
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            if (reason === "deadline") fixture.state.now += 60_000;
            else
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId)),
                ),
              );
            yield* Deferred.await(reported);
            if (reason === "deadline") {
              yield* nextWake(chat.threadId);
              assert.include(
                (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
                "cleanup is still pending",
              );
            }
            assert.isTrue(fixture.processes.get(2147483000)!.alive);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            args[0].compile()[1][6] == null
              ? observeDelivery(first.taskId, reported, "reported_at")(...args)
              : observeDelivery(first.taskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
      }),
  );

  it.effect.each(["job", "root", "main"] as const)(
    "stops a legacy Windows command through its millisecond identity: %s",
    (owner) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-milliseconds-${owner}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo legacy" })),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        // The job's pid file names the millisecond; the others hold it in their record.
        const recorded = owner === "job" ? null : timeIdentity(fixture.now);
        yield* sql`UPDATE command_runs SET windows_created_at = NULL, process_identity = ${recorded}, status = 'stopped', unit = CASE WHEN ${owner} = 'job' THEN unit ELSE NULL END WHERE task_id = ${result.taskId}`;
        const directory = NodePath.dirname(result.logPath);
        const pidFile = NodePath.join(directory, "pid");
        if (owner === "job") NodeFS.writeFileSync(pidFile, `2147483000 ${fixture.now}`);
        else if (owner === "root") NodeFS.unlinkSync(pidFile);
        else {
          // A launch from before launch gates: a bare pid file and no gate.
          NodeFS.writeFileSync(pidFile, "2147483000");
          NodeFS.utimesSync(pidFile, (fixture.now + 10) / 1_000, (fixture.now + 10) / 1_000);
          NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        }
        // The live process's creation time is finer than the millisecond its record holds.
        const entry = fixture.processes.get(2147483000)!;
        entry.ticks = 4_321;
        const member = [...fixture.jobs.values()].find((job) => job.pid === 2147483000)!;
        member.ticks = 4_321;
        const createdAt = fixtureWindowsIdentity(entry);
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
        assert.isFalse(entry.alive);
        assert.equal(fixture.state.kills, 1);
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.windows_created_at, createdAt);
        assert.isNotNull(row?.delivered_at);
        if (owner === "job")
          assert.deepEqual(fixture.stopRequests[0]?.slice(2), ["2147483000", createdAt]);
        else assert.deepEqual(fixture.stopRequests, []);
      }),
  );

  it.effect(
    "leaves running a process its legacy Windows record's millisecond names but that is not its wrapper",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-legacy-millisecond-replacement");
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo legacy", timeoutMinutes: 1 })),
        ).pipe(Effect.provide(fixture.layer));
        // An older launcher read the creation time by pid after its wrapper could have ended, so its
        // record can hold the time of the process Windows gave that pid next.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET windows_created_at = NULL, process_identity = ${timeIdentity(fixture.now)}, unit = NULL WHERE task_id = ${result.taskId}`;
        const directory = NodePath.dirname(result.logPath);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        const entry = fixture.processes.get(2147483000)!;
        entry.directory = NodePath.join(NodePath.dirname(directory), "another-command");
        fixture.state.now += 60_000;
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
        assert.include(
          (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
          "could not prove that process 2147483000 was this command's, so it did not stop it",
        );
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.lost_reason, "unproven");
        assert.isNull(row?.windows_created_at);
        assert.isTrue(entry.alive);
        assert.equal(fixture.state.kills, 0);
      }),
  );

  it.effect.each(["deadline", "overdue", "cancellation"] as const)(
    "leaves a legacy Windows command it cannot identify running and says so at its %s",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-unproven-${reason}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo legacy", timeoutMinutes: 1 })),
        ).pipe(Effect.provide(fixture.layer));
        // A launch window holds the live process's start, which a later process's could match.
        const window = `window:${fixture.now - 1_000}:${fixture.now + 1_000}`;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET windows_created_at = NULL, process_identity = ${window}, unit = NULL WHERE task_id = ${result.taskId}`;
        const directory = NodePath.dirname(result.logPath);
        const pidFile = NodePath.join(directory, "pid");
        NodeFS.writeFileSync(pidFile, "2147483000");
        NodeFS.utimesSync(pidFile, (fixture.now + 10) / 1_000, (fixture.now + 10) / 1_000);
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        if (reason === "overdue") fixture.state.now += 60_000;
        const judged = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(judged);
            if (reason === "deadline") fixture.state.now += 60_000;
            if (reason === "cancellation")
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
                ),
              );
            else {
              yield* nextWake(chat.threadId);
              const text = (yield* taskOf(chat.threadId, result.taskId))?.result ?? "";
              assert.include(
                text,
                "could not prove that process 2147483000 was this command's, so it did not stop it",
              );
              assert.notInclude(text, "cleanup is still pending");
            }
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            args[0].compile()[1][6] == null
              ? observeDelivery(result.taskId, judged, "lost_reason")(...args)
              : observeDelivery(result.taskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
        );
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.lost_reason, "unproven");
        assert.equal(row?.status, reason === "cancellation" ? "stopped" : "timed_out");
        assert.isNotNull(row?.delivered_at);
        assert.isTrue(fixture.processes.get(2147483000)!.alive);
        assert.equal(fixture.state.kills, 0);
        assert.deepEqual(fixture.stopRequests, []);
      }),
  );

  it.effect(
    "uses the runner's captured platform when recovering a bare legacy Windows pid file from a different fiber context",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-legacy-platform-captured");
        const fixture = yield* windowsFixture;
        // Pick a non-whole-second timestamp so a mistaken `ps` branch (whole seconds) would round
        // startedAt below row.started_at and misclassify the live process as pid-reused.
        fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000 + 500;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo legacy", timeoutMinutes: 1 })),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET windows_created_at = NULL, process_identity = ${timeIdentity(fixture.state.now)}, unit = NULL WHERE task_id = ${result.taskId}`;
        const directory = NodePath.dirname(result.logPath);
        const pidFile = NodePath.join(directory, "pid");
        NodeFS.writeFileSync(pidFile, "2147483000");
        NodeFS.utimesSync(
          pidFile,
          (fixture.state.now + 10) / 1_000,
          (fixture.state.now + 10) / 1_000,
        );
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        fixture.state.now += 60_000;
        const delivered = yield* Deferred.make<void>();
        const runnerLayer = Layer.fresh(CommandRunner.layer).pipe(
          Layer.provideMerge(fixture.layer),
        );
        yield* Effect.gen(function* () {
          const runner = yield* CommandRunner.CommandRunner;
          yield* runner.start().pipe(Effect.provideService(HostProcess.Platform, "linux"));
          yield* Deferred.await(delivered);
        }).pipe(
          Effect.scoped,
          Effect.provide(runnerLayer),
          Effect.provideService(CommandRunner.WatchInterval, Duration.millis(50)),
          Effect.provideService(CommandRunner.ShortageRecheck, Duration.zero),
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
        );
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.status, "timed_out");
        assert.isNull(row?.lost_reason);
        assert.isFalse(fixture.processes.get(2147483000)!.alive);
        assert.equal(fixture.state.kills, 1);
      }),
  );

  it.effect("keeps a replacement job alive when restart cleanup stops the recorded child", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-replaced-job");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
      ).pipe(Effect.provide(fixture.layer));
      const row = (yield* commandRow(result.taskId))!;
      const directory = NodePath.dirname(result.logPath);
      const replacement = { pid: 2147483001, identity: fixture.now + 500 };
      fixture.jobs.set(NodePath.basename(directory), replacement);
      fixture.processes.set(replacement.pid, {
        identity: replacement.identity,
        directory,
        alive: true,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE command_runs SET status = 'stopped' WHERE task_id = ${result.taskId}`;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(result.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
      assert.isTrue(fixture.processes.get(replacement.pid)!.alive);
      assert.deepEqual(fixture.stopRequests[0]?.slice(2), [
        String(row.pid),
        row.windows_created_at!,
      ]);
    }),
  );

  it.effect("cancels a pending POSIX gate before a paused launcher can run", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-no-spawn");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(
          callerOf(chat.threadId),
          keyed({
            command: "echo never started",
            timeoutMinutes: 1,
          }),
        ),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* forgetPid(first.taskId);
      yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
      NodeFS.unlinkSync(NodePath.join(NodePath.dirname(first.logPath), "pid"));
      NodeFS.renameSync(
        NodePath.join(NodePath.dirname(first.logPath), "launch-started"),
        NodePath.join(NodePath.dirname(first.logPath), "launch-pending"),
      );
      fixture.processes.get(2147483000)!.alive = false;
      fixture.state.now += 6_000;
      yield* withServer(() => nextWake(chat.threadId)).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(fixture.layer),
      );
      assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
      assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "failed");
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(NodePath.dirname(first.logPath), "launch-cancelled")),
      );
    }),
  );

  it.effect(
    "keeps a POSIX launcher that took the gate unresolved past five seconds until it publishes its pid",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("posix-late-pid");
        const fixture = yield* windowsFixture;
        fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo late identity",
              timeoutMinutes: 1,
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* forgetPid(first.taskId);
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const pidFile = NodePath.join(NodePath.dirname(first.logPath), "pid");
        const pidText = NodeFS.readFileSync(pidFile, "utf8");
        NodeFS.unlinkSync(pidFile);
        fixture.state.now += 6_000;
        const fs = yield* FileSystem.FileSystem;
        const missing = yield* Deferred.make<void>();
        const publish = yield* Deferred.make<void>();
        const adopted = yield* Deferred.make<void>();
        let held = true;
        const missingPid = Deferred.succeed(missing, undefined).pipe(
          Effect.andThen(Deferred.await(publish)),
          Effect.andThen(
            Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                }),
              ),
            ),
          ),
        );
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(missing);
            NodeFS.writeFileSync(pidFile, pidText);
            held = false;
            yield* Deferred.succeed(publish, undefined);
            yield* Deferred.await(adopted);
            assert.equal((yield* commandRow(first.taskId))?.status, "running");
            assert.isTrue(fixture.groups.has(2147483000));
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(first.logPath), "exit-status"),
              "0",
            );
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, adopted, "pid"),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, ...args) =>
              file === pidFile && held ? missingPid : fs.readFileString(file, ...args),
            stat: (file) => (file === pidFile && held ? missingPid : fs.stat(file)),
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(publish, undefined)),
        );
      }),
  );

  it.effect.each([
    "observed replacement",
    "one second replacement",
    "recorded replacement",
    "recorded reboot",
    "systemd unit",
  ] as const)("never signals a replacement POSIX group after its leader exits: %s", (evidence) =>
    Effect.gen(function* () {
      const chat = yield* liveChat(`posix-group-${evidence}`);
      const fixture = yield* windowsFixture;
      fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000;
      const observed = evidence === "observed replacement" || evidence === "one second replacement";
      const first = yield* withServer((runner) =>
        runner.run(
          callerOf(chat.threadId),
          keyed({
            command: "echo original group",
          }),
        ),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      const reason =
        evidence === "recorded replacement"
          ? "pid-reused"
          : evidence === "recorded reboot"
            ? "rebooted"
            : null;
      const unit = evidence === "systemd unit" ? "original.scope" : null;
      yield* sql`UPDATE command_runs SET unit = ${unit}, lost_reason = ${reason},
        status = ${observed ? "running" : "stopped"}
        WHERE task_id = ${first.taskId}`;
      const entry = fixture.processes.get(2147483000)!;
      entry.identity += evidence === "one second replacement" ? 1_000 : 5_000;
      if (evidence === "observed replacement")
        fixture.state.beforeProbe = Effect.sync(() => {
          entry.alive = false;
        });
      else if (!observed) entry.alive = false;
      const delivered = yield* Deferred.make<void>();
      const agentScope = yield* AgentScope;
      const units: string[] = [];
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provideService(AgentScope, {
          ...agentScope,
          stopCommand: (name) =>
            Effect.sync(() => {
              units.push(name);
              return true;
            }),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(fixture.layer),
      );
      assert.isTrue(fixture.groups.has(2147483000));
      assert.deepEqual(fixture.groupSignals, []);
      assert.deepEqual(units, unit === null ? [] : [unit]);
      assert.equal(
        (yield* commandRow(first.taskId))?.lost_reason,
        observed ? "pid-reused" : reason,
      );
    }),
  );

  it.effect("retains replacement evidence when cancellation changes the probed row", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("posix-reuse-cancel-race");
      const fixture = yield* windowsFixture;
      fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
      const entry = fixture.processes.get(2147483000)!;
      entry.identity += 5_000;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const proof = yield* Deferred.make<void>();
      const reported = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let probes = 0;
      fixture.state.beforeProbe = Effect.gen(function* () {
        if (++probes === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        } else yield* Deferred.await(proof);
        entry.alive = false;
      });
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* Deferred.await(entered);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
          yield* Deferred.await(reported);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(proof);
          yield* Deferred.await(delivered);
          assert.isTrue(fixture.groups.has(2147483000));
          assert.deepEqual(fixture.groupSignals, []);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) => {
          const [statement, client] = args;
          const [query, params] = statement.compile();
          if (
            query.includes("UPDATE command_runs") &&
            params.at(-1) === first.taskId &&
            params[6] === null &&
            params[9] === "pid-reused"
          )
            return statement.pipe(
              Effect.provideService(Statement.CurrentTransformer, undefined),
              Effect.orDie,
              Effect.andThen(Deferred.succeed(proof, undefined)),
              Effect.as(client`SELECT 1 WHERE 0`),
            );
          return params[6] === null
            ? observeDelivery(first.taskId, reported, "reported_at")(...args)
            : observeDelivery(first.taskId, delivered)(...args);
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Deferred.succeed(proof, undefined)),
      );
    }),
  );

  it.effect("revalidates the POSIX owner before escalating a group stop", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("posix-reuse-grace");
      const fixture = yield* windowsFixture;
      fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE command_runs SET unit = NULL, status = 'stopped' WHERE task_id = ${first.taskId}`;
      const grace = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const sleep = fixture.state.sleep;
      fixture.state.sleep = (duration) =>
        Duration.toMillis(duration) === 5_000
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(grace)))
          : sleep(duration);
      fixture.state.signalGroup = (pid, signal) => {
        if (signal === "SIGKILL") fixture.groups.delete(pid);
      };
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* Deferred.await(entered);
          fixture.processes.get(2147483000)!.identity += 5_000;
          yield* Deferred.succeed(grace, undefined);
          yield* Deferred.await(delivered);
          assert.isTrue(fixture.groups.has(2147483000));
          assert.notInclude(fixture.groupSignals, "SIGKILL");
          assert.equal((yield* commandRow(first.taskId))?.lost_reason, "pid-reused");
        }),
      ).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(grace, undefined)),
      );
    }),
  );

  it.effect.each(["SIGTERM", "probe", "SIGKILL", "still populated"] as const)(
    "keeps POSIX cleanup watched after a failed group stop: %s",
    (failure) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`posix-stop-${failure}`);
        const fixture = yield* windowsFixture;
        fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET unit = NULL, status = 'stopped' WHERE task_id = ${first.taskId}`;
        const attempts = yield* Queue.unbounded<void>();
        const delivered = yield* Deferred.make<void>();
        let failing = true;
        const target =
          failure === "probe" ? 0 : failure === "still populated" ? "SIGKILL" : failure;
        fixture.state.signalGroup = (pid, signal) => {
          if (!fixture.groups.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
          if (failing && signal === target) {
            Queue.offerUnsafe(attempts, undefined);
            if (failure !== "still populated")
              throw Object.assign(new Error("signal failed"), { code: "EIO" });
          }
          if (!failing && signal !== 0) fixture.groups.delete(pid);
        };
        const sleep = fixture.state.sleep;
        fixture.state.sleep = (duration) =>
          Duration.toMillis(duration) === 5_000 ? Effect.void : sleep(duration);
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(attempts);
            yield* Queue.take(attempts);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            assert.isTrue(fixture.groups.has(2147483000));
            failing = false;
            yield* Deferred.await(delivered);
            assert.isFalse(fixture.groups.has(2147483000));
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect.each([null, "pid-reused"] as const)(
    "retains command cleanup until its systemd scope is empty, loss %s",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`unit-stop-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo scoped" })),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        const unit = "t3code-command-owned.scope";
        yield* sql`UPDATE command_runs SET unit = ${unit}, lost_reason = ${reason}, status = 'stopped' WHERE task_id = ${first.taskId}`;
        fixture.processes.get(2147483000)!.alive = false;
        const attempts = yield* Queue.unbounded<string>();
        const delivered = yield* Deferred.make<void>();
        const agentScope = yield* AgentScope;
        let populated = true;
        const stop = (name: string) => Queue.offer(attempts, name).pipe(Effect.asVoid);
        yield* withServer(() =>
          Effect.gen(function* () {
            assert.equal(yield* Queue.take(attempts), unit);
            assert.equal(yield* Queue.take(attempts), unit);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            assert.isTrue(fixture.groups.has(2147483000));
            populated = false;
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provideService(AgentScope, {
            ...agentScope,
            stop,
            stopCommand: (name) =>
              stop(name).pipe(
                Effect.map(() => {
                  if (!populated) fixture.groups.delete(2147483000);
                  return !populated;
                }),
              ),
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provide(fixture.layer),
        );
        assert.isFalse(fixture.groups.has(2147483000));
        assert.deepEqual(fixture.groupSignals, []);
      }),
  );

  it.effect("adopts the POSIX wrapper's published identity despite rounded ps wall time", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("posix-published-identity");
      const fixture = yield* windowsFixture;
      fixture.state.now = Math.floor(fixture.state.now / 1_000) * 1_000 + 116;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo adopted identity" })),
      ).pipe(Effect.provide(fixture.layer));
      yield* forgetPid(first.taskId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
      const entry = fixture.processes.get(2147483000)!;
      entry.identity = Math.floor(fixture.state.now / 1_000) * 1_000 - 1_000;
      const published = DateTime.toDateUtc(DateTime.makeUnsafe(entry.identity))
        .toUTCString()
        .replace(" GMT", "");
      const directory = NodePath.dirname(first.logPath);
      NodeFS.writeFileSync(NodePath.join(directory, "pid"), `2147483000\nps:${published}\n`);
      const adopted = yield* Deferred.make<void>();
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* Deferred.await(adopted);
          const row = yield* commandRow(first.taskId);
          assert.equal(row?.status, "running");
          assert.equal(row?.process_identity, timeIdentity(entry.identity));
          assert.deepEqual(fixture.groupSignals, []);
          NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
        }),
      ).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, adopted, "pid"),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect.each([
    ["linux", "running"],
    ["linux", "timed_out"],
    ["win32", "running"],
    ["win32", "timed_out"],
  ] as const)(
    "retires a legacy launch with no ownership evidence at its deadline on %s, %s",
    ([platform, status]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`legacy-unowned-${platform}-${status}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo legacy ownership",
              timeoutMinutes: 1,
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET unit = NULL, status = ${status} WHERE task_id = ${first.taskId}`;
        const directory = NodePath.dirname(first.logPath);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        fixture.state.now += 60_000;
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* nextWake(chat.threadId);
            const task = yield* taskOf(chat.threadId, first.taskId);
            assert.include(task?.result ?? "", "ownership could not be established");
            assert.notInclude(task?.result ?? "", "cleanup is still pending");
            yield* Deferred.await(delivered);
            const row = yield* commandRow(first.taskId);
            assert.equal(row?.lost_reason, "no-pid");
            assert.isNotNull(row?.reported_at);
            assert.isNotNull(row?.delivered_at);
            assert.isTrue(fixture.processes.get(2147483000)!.alive);
            assert.deepEqual(fixture.groupSignals, []);
            assert.equal(fixture.state.kills, 0);
            assert.deepEqual(fixture.stopRequests, []);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect.each(["gone", "pid-reused"] as const)(
    "settles a legacy pid-only command proven %s",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo old wrapper",
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* forgetPid(first.taskId);
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const directory = NodePath.dirname(first.logPath);
        const file = NodePath.join(directory, "pid");
        NodeFS.writeFileSync(file, "2147483000");
        NodeFS.utimesSync(file, fixture.state.now / 1_000, fixture.state.now / 1_000);
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        const entry = fixture.processes.get(2147483000)!;
        if (reason === "gone") entry.alive = false;
        else entry.identity += 500;
        yield* withServer(() => nextWake(chat.threadId)).pipe(Effect.provide(fixture.layer));
        const row = yield* commandRow(first.taskId);
        assert.equal(row?.lost_reason, reason);
        assert.equal(row?.pid, 2147483000);
        assert.equal(fixture.state.kills, 0);
        assert.equal(entry.alive, reason === "pid-reused");
      }),
  );

  it.effect("delivers a stopped legacy command whose pid was reused after its exit", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-legacy-stopped-exit");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(
          callerOf(chat.threadId),
          keyed({
            command: "echo old stopped wrapper",
          }),
        ),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* forgetPid(first.taskId);
      yield* sql`UPDATE command_runs SET unit = NULL, status = 'stopped' WHERE task_id = ${first.taskId}`;
      const directory = NodePath.dirname(first.logPath);
      NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
      NodeFS.writeFileSync(NodePath.join(directory, "pid"), "2147483000");
      const exit = NodePath.join(directory, "exit-status");
      NodeFS.writeFileSync(exit, "0");
      NodeFS.utimesSync(exit, fixture.state.now / 1_000, fixture.state.now / 1_000);
      fixture.processes.get(2147483000)!.identity += 500;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
      assert.isNotNull((yield* commandRow(first.taskId))?.delivered_at);
      assert.isTrue(fixture.processes.get(2147483000)!.alive);
      assert.equal(fixture.state.kills, 0);
    }),
  );

  it.effect(
    "serializes log trimming and cleanup when a running check settles an ended command",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-trim-race");
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo large direct log" })),
        ).pipe(Effect.provide(fixture.layer));
        const directory = NodePath.dirname(first.logPath);
        NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
        NodeFS.writeFileSync(first.logPath, Buffer.alloc(9 * 1024 * 1024, "x"));
        NodeFS.appendFileSync(first.logPath, "\nbuilt\n");
        const fs = yield* FileSystem.FileSystem;
        const trimming = yield* Deferred.make<void>();
        const releaseTrim = yield* Deferred.make<void>();
        const watchTicks = yield* Queue.unbounded<void>();
        const baseSleep = fixture.state.sleep;
        let pausedAtTrim = false;
        fixture.state.sleep = (duration) =>
          (Duration.toMillis(duration) === 50 && pausedAtTrim
            ? Queue.offer(watchTicks, undefined).pipe(Effect.asVoid)
            : Effect.void
          ).pipe(Effect.andThen(baseSleep(duration)));
        let trimOpens = 0;
        const holdingFs: FileSystem.FileSystem = {
          ...fs,
          open: (target, options) =>
            fs.open(target, options).pipe(
              Effect.map((file) => {
                if (target !== first.logPath || options?.flag !== "r+") return file;
                trimOpens += 1;
                if (trimOpens !== 1) return file;
                return new Proxy(file, {
                  get(targetFile, prop, receiver) {
                    if (prop === "truncate") {
                      return (...args: Parameters<FileSystem.File["truncate"]>) =>
                        Deferred.succeed(trimming, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseTrim)),
                          Effect.andThen(targetFile.truncate(...args)),
                        );
                    }
                    const value = Reflect.get(targetFile, prop, receiver);
                    return typeof value === "function" ? value.bind(targetFile) : value;
                  },
                });
              }),
            ),
        };
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(trimming);
            pausedAtTrim = true;
            // Wait for multiple watch/queue schedule sleeps while the first trim is held.
            for (let tick = 0; tick < 4; tick++) yield* Queue.take(watchTicks);
            yield* Deferred.succeed(releaseTrim, undefined);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, holdingFs),
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
        assert.equal(trimOpens, 1);
        assert.equal(fixture.state.stopRequests.length, 1);
        const task = yield* taskOf(chat.threadId, first.taskId);
        assert.equal(task?.status, "completed");
        assert.match(task?.result ?? "", /Last output:\n…x+\nbuilt\n/);
        assert.isBelow(NodeFS.statSync(first.logPath).size, 8 * 1024 * 1024);
      }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "enforces %s after the same task's identity probe is held",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-held-probe-${reason}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo held identity",
              timeoutMinutes: 1,
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        fixture.state.beforeProbe = Deferred.await(release);
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            if (reason === "deadline") fixture.state.now += 60_000;
            else
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
                ),
              );
            yield* Queue.take(fixture.stopped).pipe(
              Effect.repeat({
                until: (stop) => stop.identity === fixture.processes.get(2147483000)!.identity,
              }),
            );
            assert.isFalse(fixture.processes.get(2147483000)!.alive);
            assert.equal(
              (yield* commandRow(result.taskId))?.status,
              reason === "deadline" ? "timed_out" : "stopped",
            );
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
      }),
  );

  it.effect("closes the pending gate at the deadline while its launcher is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-held-deadline");
      const fixture = yield* windowsFixture;
      const entered = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      let ran = false;
      fixture.state.launch = (input, directory) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, directory);
          yield* Deferred.await(release);
          if (NodeFS.existsSync(NodePath.join(directory, "launch-pending"))) {
            ran = true;
            return yield* create(input, directory);
          }
          return processOutput();
        });
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = {
            command: "echo held",
            timeoutMinutes: 1,
            clientRequestId: "held-deadline",
          };
          const pending = yield* runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.forkChild);
          const directory = yield* Deferred.await(entered);
          const task = yield* runner.run(callerOf(chat.threadId), request);
          fixture.state.now += 60_000;
          yield* Queue.take(fixture.renamed).pipe(
            Effect.repeat({
              while: (file) => file !== NodePath.join(directory, "launch-cancelled"),
            }),
          );
          assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
          yield* nextWake(chat.threadId);
          assert.equal((yield* commandRow(task.taskId))?.status, "timed_out");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          assert.isFalse(ran);
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect.each(["500 ms", "one FILETIME tick"] as const)(
    "revalidates cached identity when a pid is replaced between live observations: %s",
    (difference) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-cache-reused-${difference}`);
        const fixture = yield* windowsFixture;
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const result = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo original" }),
            );
            const entry = fixture.processes.get(2147483000)!;
            if (difference === "500 ms") entry.identity += 500;
            else entry.ticks = 1;
            assert.equal(
              (yield* commandRow(result.taskId))?.windows_created_at,
              windowsTicks(fixture.now),
            );
            fixture.state.now += 60_000;
            yield* nextWake(chat.threadId);
            const row = yield* commandRow(result.taskId);
            assert.equal(row?.lost_reason, "pid-reused");
            assert.isTrue(fixture.processes.get(2147483000)!.alive);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect.each(["linux", "win32"] as const)(
    "recovers the pid from a legacy file with an already-published exit on %s",
    (platform) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-exit-${platform}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo legacy",
            }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const directory = NodePath.dirname(first.logPath);
        NodeFS.writeFileSync(NodePath.join(directory, "pid"), "2147483000");
        NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
        fixture.processes.get(2147483000)!.alive = false;
        yield* withServer(() => nextWake(chat.threadId)).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provide(fixture.layer),
        );
        assert.equal((yield* commandRow(first.taskId))?.pid, 2147483000);
        assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
      }),
  );

  it.effect("continues watching after the first wave query fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-first-watch-error");
      const fixture = yield* windowsFixture;
      const failed = yield* Deferred.make<void>();
      let injected = false;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          yield* Deferred.await(failed);
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo survives" }),
          );
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement, sql) => {
          if (injected || !statement.compile()[0].includes("WHERE loss_unplaced = 1"))
            return Effect.succeed(statement);
          injected = true;
          return Deferred.succeed(failed, undefined).pipe(
            Effect.as(sql`SELECT * FROM injected_missing_wave_table`),
          );
        }),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("returns a failed launch task while its recovery probe is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-return-before-recovery");
      const fixture = yield* windowsFixture;
      const release = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      fixture.state.beforeProbe = Deferred.await(release);
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                timeoutMs: 120_000,
              }),
            ),
          ),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo started" }),
          );
          yield* Queue.take(fixture.probes);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* Deferred.succeed(release, undefined);
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("refuses a later POSIX holder when launch identity was not recorded", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-reused");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      const laterAlive = DateTime.formatIso(DateTime.makeUnsafe(fixture.state.now + 300_000));
      yield* sql`UPDATE command_runs SET process_identity = NULL, unit = NULL, last_alive_at = ${laterAlive} WHERE task_id = ${result.taskId}`;
      const pidFile = NodePath.join(NodePath.dirname(result.logPath), "pid");
      NodeFS.writeFileSync(pidFile, "2147483000");
      NodeFS.utimesSync(pidFile, fixture.state.now / 1_000, fixture.state.now / 1_000);
      const entry = fixture.processes.get(2147483000)!;
      entry.identity += 10_000;
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* nextWake(chat.threadId);
          const row = yield* commandRow(result.taskId);
          assert.equal(row?.lost_reason, "pid-reused");
          assert.isNull(row?.process_identity);
          assert.isTrue(entry.alive);
          assert.equal(fixture.state.kills, 0);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(fixture.layer));
    }),
  );

  it.effect("trims POSIX logs while identity remains unavailable", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-trim");
      const fixture = yield* windowsFixture;
      const fs = yield* FileSystem.FileSystem;
      const trimmed = yield* Deferred.make<void>();
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
      ).pipe(Effect.provide(fixture.layer));
      fixture.state.unavailable = true;
      NodeFS.writeFileSync(result.logPath, Buffer.alloc(9_000_000, "x"));
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* Deferred.await(trimmed);
          assert.isBelow(NodeFS.statSync(result.logPath).size, 8 * 1024 * 1024);
          assert.equal((yield* commandRow(result.taskId))?.status, "running");
          assert.isTrue(fixture.processes.get(2147483000)!.alive);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
        }),
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map(
                (file) =>
                  new Proxy(file, {
                    get: (target, key) =>
                      key === "truncate"
                        ? (...args: Parameters<typeof file.truncate>) =>
                            file
                              .truncate(...args)
                              .pipe(Effect.tap(() => Deferred.succeed(trimmed, undefined)))
                        : Reflect.get(target, key, target),
                  }),
              ),
            ),
        }),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("logs a repeated stop failure once with its stderr and retries delivery", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-stderr");
      const fixture = yield* windowsFixture;
      const delivered = yield* Deferred.make<void>();
      let taskId = "";
      fixture.state.stopError = "injected stop access denied";
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        if (String(message).includes("command-runner.check-failed")) warnings.push(message);
      });
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo deadline",
              timeoutMinutes: 1,
            }),
          );
          taskId = result.taskId;
          fixture.state.now += 60_000;
          for (let pass = 0; pass < 4; pass++) yield* Queue.take(fixture.stopped);
          assert.equal(warnings.length, 1);
          assert.include(JSON.stringify(warnings), "injected stop access denied");
          assert.isNull((yield* commandRow(result.taskId))?.delivered_at);
          yield* nextWake(chat.threadId);
          assert.include(
            (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
            "cleanup is still pending",
          );
          fixture.state.stopError = "";
          yield* Deferred.await(delivered);
          assert.equal((yield* commandRow(result.taskId))?.status, "timed_out");
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(
          Layer.merge(fixture.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    }),
  );

  it.effect("persists cancellation once while a started launch response is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-write-once");
      const fixture = yield* windowsFixture;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      fixture.state.stopError = "hold cleanup";
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.tap(() => Deferred.await(release)),
        );
      yield* sql`CREATE TEMP TABLE cancellation_writes (task_id TEXT)`;
      yield* sql`CREATE TEMP TRIGGER count_cancellation_writes AFTER UPDATE ON command_runs
        WHEN NEW.status = 'stopped' AND OLD.status <> 'stopped'
        BEGIN INSERT INTO cancellation_writes VALUES (NEW.task_id); END`;
      let taskId = "";
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo held", clientRequestId: "stop-write-once" };
          const launch = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const task = yield* runner.run(callerOf(chat.threadId), request);
          taskId = task.taskId;
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, taskId)),
            ),
          );
          for (let pass = 0; pass < 4; pass++) yield* Queue.take(fixture.stopped);
          const writes =
            yield* sql`SELECT task_id FROM cancellation_writes WHERE task_id = ${taskId}`;
          assert.lengthOf(writes, 1);
          fixture.state.stopError = "";
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(launch);
          yield* Deferred.await(delivered);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      );
    }),
  );

  it.effect("checks healthy commands without starting an identity process on every pass", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-probe-budget");
      const fixture = yield* windowsFixture;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo watched" }),
          );
          for (let pass = 0; pass < 20; pass++) {
            yield* Queue.take(fixture.reads).pipe(
              Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
            );
          }
          assert.equal(fixture.state.probeCalls, 0);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("enforces a deadline while the identity probe is unavailable", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-deadline-probe");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), keyed({ command: "echo timed", timeoutMinutes: 1 })),
      ).pipe(Effect.provide(fixture.layer));
      fixture.state.unavailable = true;
      fixture.state.now += 60_000;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* nextWake(chat.threadId);
          yield* Deferred.await(delivered);
          assert.equal((yield* commandRow(result.taskId))?.status, "timed_out");
          assert.equal(fixture.state.probeCalls, 0);
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
        }),
      ).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(result.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("allows new launches while a restart identity probe is held", () =>
    Effect.gen(function* () {
      const prior = yield* liveChat("launch-restart-held");
      const next = yield* liveChat("launch-restart-new");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(prior.threadId), keyed({ command: "echo prior" })),
      ).pipe(Effect.provide(fixture.layer));
      const release = yield* Deferred.make<void>();
      fixture.state.beforeProbe = Deferred.await(release);
      yield* withServer((runner) =>
        Effect.gen(function* () {
          yield* Queue.take(fixture.probes);
          const started = yield* runner.run(
            callerOf(next.threadId),
            keyed({ command: "echo new" }),
          );
          assert.equal(fixture.state.launches, 2);
          for (const result of [first, started])
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(result.logPath), "exit-status"),
              "0",
            );
          yield* Deferred.succeed(release, undefined);
          yield* wakesOf([prior.threadId, next.threadId]);
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("closes a held launch gate even when persisting cancellation fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-write-error");
      const fixture = yield* windowsFixture;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let taskId = "";
      let ran = false;
      fixture.state.launch = (_input, directory) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, directory);
          yield* Deferred.await(release);
          ran = NodeFS.existsSync(NodePath.join(directory, "launch-pending"));
          return processOutput();
        });
      yield* sql`CREATE TEMP TRIGGER reject_stop BEFORE UPDATE ON command_runs WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(FAIL, 'injected stop write failure'); END`;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo never", clientRequestId: "stop-write" };
          const pending = yield* runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const retry = yield* runner.run(callerOf(chat.threadId), request);
          taskId = retry.taskId;
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, retry.taskId)),
            ),
          );
          yield* Queue.take(fixture.renamed).pipe(
            Effect.repeat({ until: (file) => NodePath.basename(file) === "launch-cancelled" }),
          );
          yield* sql`DROP TRIGGER reject_stop`;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          yield* Deferred.await(delivered);
          assert.isFalse(ran);
          assert.equal((yield* commandRow(retry.taskId))?.status, "stopped");
          assert.isNotNull((yield* commandRow(retry.taskId))?.delivered_at);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(sql`DROP TRIGGER IF EXISTS reject_stop`.pipe(Effect.orDie)),
      );
    }),
  );

  it.effect("uses the wrapper identity when the launcher reports a replacement 500 ms later", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-identity-disagrees");
      const fixture = yield* windowsFixture;
      const create = fixture.state.launch;
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.map((output) => {
            const entry = fixture.processes.get(2147483000)!;
            entry.identity += 500;
            return { ...output, stdout: `2147483000 ft:${windowsTicks(entry.identity)}` };
          }),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo original" }),
          );
          assert.equal(
            (yield* commandRow(result.taskId))?.process_identity,
            timeIdentity(fixture.state.now),
          );
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
            ),
          );
          yield* Queue.take(fixture.stopped);
          assert.isTrue(fixture.processes.get(2147483000)!.alive);
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "keeps a legacy launch with no evidence until its late wrapper publishes identity",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-legacy-late");
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo legacy" })),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const directory = NodePath.dirname(first.logPath);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        yield* Queue.takeAll(fixture.reads);
        yield* withServer(() =>
          Effect.gen(function* () {
            for (let pass = 0; pass < 3; pass++)
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "pid" }),
              );
            assert.equal((yield* commandRow(first.taskId))?.status, "running");
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            NodeFS.writeFileSync(
              NodePath.join(directory, "pid"),
              `2147483000 ft:${windowsTicks(fixture.state.now)}`,
            );
            yield* Queue.take(fixture.probes);
            NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("settles a defective launch and rejects NUL commands before allocating a task", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-defect");
      const fixture = yield* windowsFixture;
      fixture.state.launch = () => Effect.die(new Error("injected spawn defect"));
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const invalid = yield* runner
            .run(callerOf(chat.threadId), keyed({ command: "echo \0" }))
            .pipe(Effect.result);
          assert.equal(invalid._tag, "Failure");
          assert.equal(fixture.state.launches, 0);
          const result = yield* runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo failure" }),
          );
          yield* nextWake(chat.threadId);
          assert.equal((yield* commandRow(result.taskId))?.status, "unstarted");
          assert.equal(
            (yield* taskOf(chat.threadId, result.taskId))?.result,
            `Could not start the command: injected spawn defect\nNo output.\nFull output: ${result.logPath}`,
          );
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "cancels a held launch while other commands meet their deadlines and deliver completion",
    () =>
      Effect.gen(function* () {
        const held = yield* liveChat("launch-held");
        const deadline = yield* liveChat("launch-other-deadline");
        const completed = yield* liveChat("launch-other-completion");
        const fixture = yield* windowsFixture;
        const entered = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        const create = fixture.state.launch;
        const delivered = yield* Deferred.make<void>();
        let heldTaskId = "";
        let ran = false;
        // The launcher works in the run folder, so the held command is told by its script there.
        fixture.state.launch = (input, directory) =>
          !NodeFS.readFileSync(NodePath.join(directory, "command.ps1"), "utf8").includes(
            "echo held",
          )
            ? create(input, directory)
            : Effect.gen(function* () {
                yield* Deferred.succeed(entered, directory);
                yield* Deferred.await(release);
                if (NodeFS.existsSync(NodePath.join(directory, "launch-pending"))) {
                  ran = true;
                  return yield* create(input, directory);
                }
                return processOutput(`2147483001 ${DateTime.toEpochMillis(yield* DateTime.now)}`);
              });
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const request = { command: "echo held", clientRequestId: "held" };
            const pending = yield* runner
              .run(callerOf(held.threadId), request)
              .pipe(Effect.forkChild);
            const directory = yield* Deferred.await(entered);
            yield* Effect.gen(function* () {
              // The clock advances while the unrelated launcher stays behind its barrier.
              const due = yield* runner.run(
                callerOf(deadline.threadId),
                keyed({
                  command: "echo deadline",
                  timeoutMinutes: 1,
                }),
              );
              fixture.state.now += 60_000;
              yield* nextWake(deadline.threadId);
              assert.equal((yield* commandRow(due.taskId))?.status, "timed_out");
              const done = yield* runner.run(
                callerOf(completed.threadId),
                keyed({
                  command: "echo completed",
                }),
              );
              NodeFS.writeFileSync(
                NodePath.join(NodePath.dirname(done.logPath), "exit-status"),
                "0",
              );
              yield* nextWake(completed.threadId);
              assert.equal((yield* taskOf(completed.threadId, done.taskId))?.status, "completed");
              const same = yield* runner.run(callerOf(held.threadId), request);
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(held.threadId, same.taskId)),
                ),
              );
              yield* Queue.take(fixture.renamed).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "launch-cancelled" }),
              );
              yield* runner.run(callerOf(held.threadId), request);
              heldTaskId = same.taskId;
              const row = yield* commandRow(same.taskId);
              assert.equal(row?.status, "stopped");
              // Its launcher may still publish a process, so its cleanup waits for the launch.
              assert.isNull(row?.delivered_at);
              assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
            }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
            const result = yield* Fiber.join(pending);
            yield* Deferred.await(delivered);
            assert.isFalse(ran);
            assert.equal((yield* commandRow(result.taskId))?.status, "stopped");
            assert.equal(fixture.state.launches, 3);
            assert.equal(fixture.state.kills, 1);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            observeDelivery(heldTaskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect(
    "retries a failed gate recovery on a later tick and keeps request retries idempotent",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-gate-error");
        const fixture = yield* windowsFixture;
        fixture.state.failGate = true;
        fixture.state.launch = (input) =>
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            }),
          );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const request = { command: "echo never", clientRequestId: "gate-error" };
            const first = yield* runner.run(callerOf(chat.threadId), request);
            assert.isNull((yield* commandRow(first.taskId))?.pid);
            assert.equal(
              (yield* runner.run(callerOf(chat.threadId), request)).taskId,
              first.taskId,
            );
            fixture.state.failGate = false;
            yield* nextWake(chat.threadId);
            assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
            assert.match(
              (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
              /^Could not start the command: .*timed out/,
            );
            assert.equal(fixture.state.launches, 1);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("keeps recovery watched when its database write fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-recovery-write-error");
      const fixture = yield* windowsFixture;
      const create = fixture.state.launch;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE ON command_runs
      WHEN NEW.pid IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected recovery write failure'); END`;
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                timeoutMs: 120_000,
              }),
            ),
          ),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo recovered", clientRequestId: "write-error" };
          const first = yield* runner.run(callerOf(chat.threadId), request);
          assert.isNull((yield* commandRow(first.taskId))?.pid);
          assert.equal((yield* runner.run(callerOf(chat.threadId), request)).taskId, first.taskId);
          yield* sql`DROP TRIGGER reject_recovery`;
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(first.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          assert.equal((yield* commandRow(first.taskId))?.pid, 2147483000);
          assert.equal(fixture.state.launches, 1);
        }),
      ).pipe(
        Effect.provide(fixture.layer),
        Effect.ensuring(sql`DROP TRIGGER IF EXISTS reject_recovery`.pipe(Effect.orDie)),
      );
    }),
  );

  it.effect.each([true, false])(
    "reports a cancelled gate as unstarted and stops the wrapper it published, alive %s",
    (alive) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-cancel-wins-${alive}`);
        const fixture = yield* windowsFixture;
        fixture.state.launch = (input, directory) =>
          Effect.gen(function* () {
            const identity = DateTime.toEpochMillis(yield* DateTime.now);
            fixture.processes.set(2147483000, { identity, alive, directory });
            fixture.jobs.set(NodePath.basename(directory), { pid: 2147483000, identity });
            NodeFS.writeFileSync(
              NodePath.join(directory, "pid"),
              `2147483000 ft:${windowsTicks(identity)}`,
            );
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            });
          });
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const result = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo never" }),
            );
            yield* nextWake(chat.threadId);
            assert.equal((yield* commandRow(result.taskId))?.status, "unstarted");
            assert.match(
              (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
              /^Could not start the command:/,
            );
            // Its report comes first; its job is stopped after it, even once its wrapper ended.
            yield* Queue.take(fixture.stopped);
            assert.equal(fixture.state.kills, alive ? 1 : 0);
            assert.isFalse(fixture.processes.get(2147483000)!.alive);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect.each(["pending", "started", "cancelled"] as const)(
    "adopts a pid-null row at the %s gate boundary",
    (gate) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-restart-${gate}`);
        const fixture = yield* windowsFixture;
        fixture.state.failGate = true;
        fixture.state.launch = (input) =>
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            }),
          );
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo recovered" })),
        ).pipe(Effect.provide(fixture.layer));
        const directory = NodePath.dirname(result.logPath);
        const identity = DateTime.toEpochMillis(yield* DateTime.now);
        fixture.processes.set(2147483000, { identity, alive: true, directory });
        fixture.jobs.set(NodePath.basename(directory), { pid: 2147483000, identity });
        NodeFS.writeFileSync(
          NodePath.join(directory, "pid"),
          `2147483000 ft:${windowsTicks(identity)}`,
        );
        if (gate !== "pending")
          NodeFS.renameSync(
            NodePath.join(directory, "launch-pending"),
            NodePath.join(directory, `launch-${gate}`),
          );
        fixture.state.failGate = false;
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            if (gate === "started") {
              yield* Queue.take(fixture.probes);
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
              );
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
              );
              assert.equal((yield* commandRow(result.taskId))?.pid, 2147483000);
              NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
            }
            yield* nextWake(chat.threadId);
            assert.equal(
              (yield* commandRow(result.taskId))?.status,
              gate === "started" ? "exited" : "unstarted",
            );
            // A closed gate kept the command from running; its job host is stopped all the same.
            yield* Deferred.await(delivered);
            assert.equal(fixture.state.kills, gate === "started" ? 0 : 1);
            assert.isFalse(fixture.processes.get(2147483000)!.alive);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect.each(["identity", "pid-only"] as const)(
    "leaves a reused pid unresolved while its probe is unavailable, %s file",
    (format) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-reused-${format}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), keyed({ command: "echo original" })),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(result.taskId);
        const entry = fixture.processes.get(2147483000)!;
        entry.identity += 10_000;
        fixture.state.unavailable = true;
        if (format === "pid-only") {
          const file = NodePath.join(entry.directory, "pid");
          NodeFS.writeFileSync(file, "2147483000");
          NodeFS.utimesSync(file, fixture.state.now / 1_000, fixture.state.now / 1_000);
        }
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            yield* Queue.take(fixture.probes);
            const unresolved = yield* commandRow(result.taskId);
            assert.isNull(unresolved?.pid);
            assert.equal(unresolved?.status, "running");
            assert.equal(fixture.state.kills, 0);
            assert.isTrue(entry.alive);
            NodeFS.writeFileSync(NodePath.join(entry.directory, "exit-status"), "0");
            fixture.state.unavailable = false;
            yield* nextWake(chat.threadId);
            assert.isTrue(entry.alive);
            assert.equal(fixture.state.kills, 0);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect(
    "does not lose or stop a command before its deadline when reading its exit status fails",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-status-unreadable");
        const fixture = yield* windowsFixture;
        fixture.state.failRead = "exit-status";
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const result = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: "echo completed",
              }),
            );
            yield* Queue.take(fixture.reads);
            yield* Queue.take(fixture.reads);
            assert.equal((yield* commandRow(result.taskId))?.status, "running");
            assert.equal(fixture.state.kills, 0);
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(result.logPath), "exit-status"),
              "0",
            );
            fixture.state.failRead = "";
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "stops a command whose exit status cannot be read at a %s it meets after a restart",
    (ending) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-status-unreadable-${ending}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({ command: "echo running", timeoutMinutes: 1 }),
          ),
        ).pipe(Effect.provide(fixture.layer));
        fixture.state.failRead = "exit-status";
        const delivered = yield* Deferred.make<void>();
        if (ending === "deadline") fixture.state.now += 60_000;
        else {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId));
        }
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
        const row = yield* commandRow(result.taskId);
        assert.equal(row?.status, ending === "deadline" ? "timed_out" : "stopped");
        assert.include(row?.exit_status_error ?? "", "PermissionDenied");
        // A cancel recorded while no server ran already gave the task its result.
        if (ending === "deadline")
          assert.include(
            (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
            `Its exit status could not be read: ${row?.exit_status_error}`,
          );
        assert.equal(fixture.state.kills, 1);
        assert.isFalse(fixture.processes.get(2147483000)!.alive);
      }),
  );

  it.effect(
    "stops through task_cancel a command whose exit status cannot be read and says why",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-status-unreadable-task-cancel");
        const fixture = yield* windowsFixture;
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const scope = orchestratorOf(chat.threadId);
            const { taskId } = yield* runner.run(scope, keyed({ command: "echo running" }));
            fixture.state.failRead = "exit-status";
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            const cancelled = yield* mcp.cancelTask(scope, {
              taskId: NodeId.make(taskId),
              reason: "done with it",
            });
            assert.equal(cancelled.cleanup, "stopped");
            const row = yield* commandRow(taskId);
            assert.equal(row?.status, "stopped");
            assert.include(row?.exit_status_error ?? "", "PermissionDenied");
            assert.include(
              (yield* taskOf(chat.threadId, taskId))?.result ?? "",
              `Its exit status could not be read: ${row?.exit_status_error}`,
            );
            assert.equal(fixture.state.kills, 1);
            assert.isFalse(fixture.processes.get(2147483000)!.alive);
          }).pipe(Effect.provide(mcpOver(runner))),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect(
    "stops a command without a job with the processes it started and holds cleanup until none is left",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("legacy-stop-leftovers");
        const fixture = yield* windowsFixture;
        const scope = orchestratorOf(chat.threadId);
        const { taskId } = yield* withServer((runner) =>
          runner.run(scope, keyed({ command: "echo running" })),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${taskId}`;
        const wrapper = fixture.processes.get(2147483000)!;
        const childCreated = windowsTicks(wrapper.identity + 1);
        const leftover = `left 2147483111 ${childCreated} could not open it: Access is denied.`;
        const retry = yield* Deferred.make<void>();
        fixture.state.treeStop = (roots) =>
          roots[0] === "2147483000"
            ? Effect.succeed(`${leftover}\r\n`)
            : Deferred.await(retry).pipe(Effect.as(""));
        const delivered = yield* Deferred.make<void>();
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            const cancelled = yield* mcp.cancelTask(scope, {
              taskId: NodeId.make(taskId),
              reason: "done with it",
            });
            assert.equal(cancelled.cleanup, "pending");
            assert.isFalse(wrapper.alive);
            const held = yield* commandRow(taskId);
            assert.equal(held?.stop_leftovers, leftover);
            assert.isNull(held?.delivered_at);
            const result = (yield* taskOf(chat.threadId, taskId))?.result ?? "";
            assert.include(result, "cleanup is still pending");
            assert.include(
              result,
              "CodeShip could not stop a process the command started: process 2147483111 (could not open it: Access is denied.)",
            );
            yield* Deferred.succeed(retry, undefined);
            yield* Deferred.await(delivered);
          }).pipe(Effect.provide(mcpOver(runner))),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, observeDelivery(taskId, delivered)),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(retry, undefined)),
        );
        // The retry starts from what the first stop left, whose parent it already stopped.
        assert.deepEqual(fixture.state.treeStops, [
          ["2147483000", fixtureWindowsIdentity(wrapper)],
          ["2147483111", childCreated],
        ]);
        assert.isNull((yield* commandRow(taskId))?.stop_leftovers);
      }),
  );

  it.effect.each(["read", "stat"] as const)(
    "keeps a started command watched when its pid %s fails, then resolves without a restart",
    (operation) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`command-pid-${operation}-failure`);
        const fs = yield* FileSystem.FileSystem;
        const request = { command: "echo recovered", clientRequestId: `pid-${operation}-failure` };
        let unreadable = true;
        let launches = 0;
        const error = new PlatformError.PlatformError(
          new PlatformError.SystemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: operation,
          }),
        );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const first = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.result);
            assert.equal(first._tag, "Success", "ambiguous launch must remain an app-owned task");
            if (first._tag === "Failure") return yield* first.failure;
            assert.isNull((yield* commandRow(first.success.taskId))?.pid);
            const retried = yield* runner.run(callerOf(chat.threadId), request);
            assert.equal(retried.taskId, first.success.taskId);
            assert.equal(launches, 1);
            unreadable = false;
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(first.success.logPath), "exit-status"),
              "0",
            );
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.success.taskId))?.status, "completed");
          }),
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, ...args) =>
              unreadable && operation === "read" && NodePath.basename(file) === "pid"
                ? Effect.fail(error)
                : fs.readFileString(file, ...args),
            stat: (file) =>
              unreadable && operation === "stat" && NodePath.basename(file) === "pid"
                ? Effect.fail(error)
                : fs.stat(file),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.gen(function* () {
                if (input.command === "job-host.exe" && input.args[0] === "stop")
                  return processOutput();
                assert.isTrue(
                  input.args.some((arg) => arg.includes("Win32_Process -MethodName Create")),
                );
                launches++;
                const wrapper = /-File "(.+run\.ps1)"/.exec(input.args.join(" "))?.[1];
                assert.isDefined(wrapper);
                const directory = NodePath.dirname(wrapper!);
                NodeFS.writeFileSync(
                  NodePath.join(directory, "pid"),
                  `2147483000 ft:${windowsTicks(DateTime.toEpochMillis(yield* DateTime.now))}`,
                );
                NodeFS.renameSync(
                  NodePath.join(directory, "launch-pending"),
                  NodePath.join(directory, "launch-started"),
                );
                return yield* new ProcessRunner.ProcessTimeoutError({
                  command: input.command,
                  argumentCount: input.args.length,
                  timeoutMs: 120_000,
                });
              }),
          }),
        );
      }),
  );
});

// A Windows wrapper that ended leaves what it started running under a dead parent pid.
describe.runIf(isWindowsHost)("Windows only", () => {
  it("a survivor check takes a later process with the recorded PID for another process", () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-survivor-"));
    const file = NodePath.join(folder, "child.pid");
    let child: RecordedProcess | undefined;
    try {
      NodeChildProcess.execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; ${recordProcess(file, "$p")}`,
      ]);
      child = readRecordedProcess(file);
      // The same PID with another creation time, as when Windows has given the PID to a new process.
      assert.isFalse(survived({ pid: child.pid, created: `${BigInt(child.created) + 1n}` }, 0));
      assert.isTrue(isProcessAlive(child.pid));
      assert.isTrue(survived(child, 0));
      assert.isFalse(survived(child));
    } finally {
      if (child) survived(child, 0);
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it.layer(layerTest, { excludeTestServices: true })("Windows launch timeouts", (it) => {
    it.effect.each(["cancelled", "sharing-error"] as const)(
      "writes a %s gate failure to the command log",
      (reason) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(`command-gate-output-${reason}`);
          const processRunner = yield* ProcessRunner.ProcessRunner;
          yield* withServer((runner) =>
            Effect.gen(function* () {
              const result = yield* runner.run(
                callerOf(chat.threadId),
                keyed({
                  command: "Set-Content -LiteralPath ran -Value 1",
                }),
              );
              yield* nextWake(chat.threadId);
              const task = yield* taskOf(chat.threadId, result.taskId);
              assert.equal(task?.status, "failed");
              assert.include(
                task?.result ?? "",
                reason === "cancelled"
                  ? "Command launch was cancelled before it started"
                  : "Could not take the command start gate:",
              );
              assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
            }),
          ).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) =>
                Effect.gen(function* () {
                  if (input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))) {
                    const wrapper = /-File "(.+run\.ps1)"/.exec(input.args.join(" "))![1]!;
                    const directory = NodePath.dirname(wrapper);
                    if (reason === "cancelled")
                      NodeFS.renameSync(
                        NodePath.join(directory, "launch-pending"),
                        NodePath.join(directory, "launch-cancelled"),
                      );
                    else
                      NodeFS.writeFileSync(
                        NodePath.join(directory, "launch-started"),
                        "blocks the directory rename",
                      );
                  }
                  return yield* processRunner.run(input);
                }),
            }),
          );
        }),
    );

    it.effect(
      "fails a launch whose host ended even while its PID answers for another process",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-win-launch-host-ended");
          const processRunner = yield* ProcessRunner.ProcessRunner;
          // Create reports the PID of a host that already ended and whose PID Windows gave to
          // another process that keeps running: here the launcher itself, so no host runs.
          const reusedPid =
            "function Invoke-CimMethod { [pscustomobject]@{ ReturnValue = 0; ProcessId = $PID } }; ";
          yield* withServer((runner) =>
            Effect.gen(function* () {
              const result = yield* runner.run(
                callerOf(chat.threadId),
                keyed({
                  command: "Set-Content -LiteralPath ran -Value 1",
                }),
              );
              yield* nextWake(chat.threadId);
              const task = yield* taskOf(chat.threadId, result.taskId);
              assert.equal(task?.status, "failed");
              assert.include(
                task?.result ?? "",
                "The command host ended before publishing its pid.",
              );
              assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
            }),
          ).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) =>
                input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))
                  ? processRunner.run({
                      ...input,
                      args: input.args.map((arg) =>
                        arg.includes("Win32_Process -MethodName Create") ? reusedPid + arg : arg,
                      ),
                      // A launcher still waiting on the PID ends here, short of the 2 minute limit.
                      timeout: Duration.seconds(30),
                    })
                  : processRunner.run(input),
            }),
          );
        }),
    );

    it.effect.each([false, true])(
      "adopts a command when its launcher times out after starting it, retry %s",
      (retry) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(`command-win-launch-adopt-${retry}`);
          NodeFS.writeFileSync(
            NodePath.join(chat.workspace, "command.cjs"),
            [
              'const fs = require("node:fs");',
              'const watcher = fs.watch(".", () => { if (fs.existsSync("go")) { watcher.close(); console.log("adopted"); } });',
              'fs.appendFileSync("starts", "1");',
              'fs.writeFileSync("ready", "");',
            ].join("\n"),
          );
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const request = {
            command: `& '${process.execPath}' command.cjs`,
            clientRequestId: `launch-adopt-${retry}`,
          };
          const adopted = yield* Deferred.make<void>();
          const delivered = yield* Deferred.make<void>();

          let taskId = "";
          let launches = 0;
          const started = yield* withServer((runner) =>
            Effect.gen(function* () {
              const first = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.result);
              assert.equal(first._tag, "Success");
              if (first._tag === "Failure") return yield* first.failure;
              taskId = first.success.taskId;

              if ((yield* commandRow(taskId))?.pid === null) yield* Deferred.await(adopted);
              const row = yield* commandRow(taskId);
              assert.equal(row?.status, "running");
              assert.isAbove(row?.pid ?? 0, 0);
              assert.isString(row?.process_identity);

              if (retry) {
                const second = yield* runner.run(callerOf(chat.threadId), request);
                assert.equal(second.taskId, first.success.taskId);
                assert.equal(second.logPath, first.success.logPath);
              }
              assert.equal(launches, 1);
              assert.equal(
                NodeFS.readFileSync(NodePath.join(chat.workspace, "starts"), "utf8"),
                "1",
              );

              NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
              yield* nextWake(chat.threadId);

              yield* Deferred.await(delivered);
              return first.success;
            }),
          ).pipe(
            Effect.provideService(Statement.CurrentTransformer, (...args) => {
              const [, params] = args[0].compile();
              return params[6] == null
                ? observeDelivery(taskId, adopted, "pid")(...args)
                : observeDelivery(taskId, delivered)(...args);
            }),
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) => {
                if (!input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))) {
                  return processRunner.run(input);
                }
                launches++;
                return processRunner.run(input).pipe(
                  Effect.andThen(awaitFile(NodePath.join(chat.workspace, "ready"))),
                  Effect.andThen(
                    Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: input.command,
                        argumentCount: input.args.length,
                        timeoutMs: 120_000,
                      }),
                    ),
                  ),
                );
              },
            }),
          );
          const task = yield* taskOf(chat.threadId, started.taskId);
          assert.equal(task?.status, "completed");
          assert.include(task?.result ?? "", "adopted");
        }),
    );

    it.effect(
      "a launcher timeout before Create prevents even a late WMI request from running the command",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-win-launch-before-create");
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
          const refused = yield* withServer((runner) =>
            runner
              .run(callerOf(chat.threadId), {
                command: "Set-Content -LiteralPath ran -Value 1",
                clientRequestId: "launch-before-create",
              })
              .pipe(Effect.tap(() => nextWake(chat.threadId))),
          ).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) =>
                !input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))
                  ? processRunner.run(input)
                  : Deferred.succeed(launcher, input).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ProcessRunner.ProcessTimeoutError({
                            command: input.command,
                            argumentCount: input.args.length,
                            timeoutMs: 120_000,
                          }),
                        ),
                      ),
                    ),
            }),
          );
          assert.match(
            (yield* taskOf(chat.threadId, refused.taskId))?.result ?? "",
            /^Could not start the command: .*timed out/,
          );
          const launch = yield* Deferred.await(launcher);
          const runPath = /-File "(.+run\.ps1)"/.exec(launch.args.join(" "))?.[1];
          assert.isDefined(runPath);
          // WMI can finish Create after its caller has been killed.
          const late = yield* processRunner.run(launch);
          assert.equal(late.code, 0);
          const pid = Number.parseInt(late.stdout.trim(), 10);
          assert.isAbove(pid, 0);
          yield* awaitFile(NodePath.join(NodePath.dirname(runPath!), "exit-status"));
          // cmd publishes its status before exiting; Windows keeps its working directory open until then.
          const exited = yield* processRunner.run({
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$ErrorActionPreference = 'Stop'; $wrapper = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($wrapper) { $wrapper.WaitForExit() }; exit 0`,
            ],
            timeout: Duration.minutes(2),
          });
          assert.equal(exited.code, 0, exited.stderr);
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT status FROM command_runs WHERE thread_id = ${chat.threadId}`,
            [{ status: "unstarted" }],
          );
        }),
    );
  });

  // cmd would read %USERNAME% in its command text as the user's name.
  it.layer(layerTestIn("t3-command-runner-%USERNAME%-"), { excludeTestServices: true })(
    "a Windows command whose folder's name names a cmd variable",
    (it) => {
      it.effect("runs it and logs its output in that folder as written", () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-win-percent");
          const result = yield* withServer((runner) =>
            runner
              .run(
                callerOf(chat.threadId),
                keyed({
                  command: 'Write-Output "ran [$env:T3CODE_COMMAND_SCRIPT]"',
                }),
              )
              .pipe(Effect.tap(() => nextWake(chat.threadId))),
          );
          assert.include(result.logPath, "%USERNAME%");
          const task = yield* taskOf(chat.threadId, result.taskId);
          assert.equal(task?.status, "completed", task?.result ?? undefined);
          assert.include(NodeFS.readFileSync(result.logPath, "utf8"), "ran []");
        }),
      );
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: [
                  consoleApi,
                  `if (-not [T3Test.Console]::Send(${event})) { exit 90 }`,
                  "exit 3",
                ].join("\n"),
              }),
            );
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                // Its console holds cmd and this PowerShell, so a count below 2 means Close ended nothing.
                command: [
                  consoleApi,
                  "if ([T3Test.Console]::Close() -lt 2) { exit 93 }",
                  "exit 94",
                ].join("\n"),
              }),
            );
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

  it.layer(layerTest, { excludeTestServices: true })("a Windows command's folder", (it) => {
    // An agent may remove a worktree as soon as its command ends, and Windows refuses to remove a
    // folder some process works in, as the wrapper did while it outlived the command.
    it.effect("can be removed as soon as the command's end is delivered", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-win-folder-freed");
        // The wrapper names the folder, which Windows PowerShell must not read in the ANSI code page.
        const name = "sub-café-日本";
        const folder = NodePath.join(chat.workspace, name);
        NodeFS.mkdirSync(folder);
        yield* withServer((runner) =>
          runner
            .run(
              callerOf(chat.threadId),
              keyed({ command: "Set-Content -LiteralPath ran -Value ok", cwd: name }),
            )
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        );
        assert.strictEqual(NodeFS.readFileSync(NodePath.join(folder, "ran"), "utf8").trim(), "ok");
        NodeFS.rmSync(folder, { recursive: true });
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
            .run(callerOf(chat.threadId), keyed(input))
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
                `@powershell.exe -NoProfile -NonInteractive -Command "$p = Get-Process -Id $PID; ${recordProcess(childPidFile, "$p")}; Start-Sleep 300"\r\n`,
              );
              return {
                ...without(inherited, ["PATH", "HOME"]),
                HOME: workspace,
                PATH: [otherBash, shim, system, powershellFolder].join(";"),
              };
            },
          );
          assert.isFalse(survived(readRecordedProcess(childPidFile)));
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
            runner.run(
              callerOf(chat.threadId),
              keyed({
                command:
                  "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; " +
                  `${recordProcess("child.pid", "$p")}; Set-Content -LiteralPath ready -Value 1; Start-Sleep 300`,
              }),
            ),
          );
          yield* ready;
          const child = readRecordedProcess(NodePath.join(chat.workspace, "child.pid"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              survived(child, 0);
            }),
          );
          assert.isTrue(isProcessAlive(child.pid));
          // Only the wrapper, as a stop cut by a restart leaves it.
          NodeChildProcess.execFileSync(
            // oxlint-disable-next-line t3code/no-raw-taskkill -- this stops the wrapper alone on purpose
            "taskkill",
            ["/PID", String((yield* commandRow(started.taskId))!.pid), "/F"],
            { timeout: PROBE_TIMEOUT_MS },
          );
          const delivered = yield* Deferred.make<void>();
          if (cancelled) {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          }
          yield* withServer(() =>
            Effect.gen(function* () {
              if (!cancelled) yield* nextWake(chat.threadId);
              yield* Deferred.await(delivered);
            }),
          ).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
          );
          assert.equal((yield* commandRow(started.taskId))?.status, cancelled ? "stopped" : "lost");
          assert.isFalse(survived(child));
        }),
      );
    },
  );

  it.layer(layerTest, { excludeTestServices: true })("a Windows bash command", (it) => {
    /** The running process with `pid`, as `readRecordedProcess` reads one. */
    const runningProcess = (pid: number): RecordedProcess => ({
      pid,
      created: NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
        ],
        { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
      ).trim(),
    });
    // Git Bash runs `bash script.sh` by fork then exec, and the fork exits once the exec'd bash has
    // taken over: the script's bash names a parent that no longer exists, so no walk from the
    // command's root reaches it or the node it starts.
    const script = [
      `'${process.execPath.replaceAll("\\", "/")}' -e "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 60000)" &`,
      "cat /proc/$$/winpid > script.pid",
      "while [ ! -s child.pid ]; do sleep 0.1; done",
      "echo > ready",
      "wait",
      "",
    ].join("\n");

    it.effect.each([
      ["its task is cancelled", "command-win-bash-cancelled", "stopped"],
      ["it times out", "command-win-bash-timed-out", "timed_out"],
    ] as const)("leaves no process of the script it runs when %s", ([, name, status]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "script.sh"), script);
        const started = yield* withServer((runner) =>
          runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "bash script.sh",
              shell: "bash",
              ...(status === "timed_out" ? { timeoutMinutes: 1 } : {}),
            }),
          ),
        );
        // Whatever fails after a process is recorded, the test leaves it stopped.
        const members: Array<RecordedProcess> = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const member of members) survived(member, 0);
          }),
        );
        yield* awaitFile(NodePath.join(chat.workspace, "ready"));
        for (const file of ["script.pid", "child.pid"])
          members.push(
            runningProcess(
              Number.parseInt(NodeFS.readFileSync(NodePath.join(chat.workspace, file), "utf8"), 10),
            ),
          );
        if (status === "stopped") {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
        }
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            if (status === "timed_out") yield* nextWake(chat.threadId);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(started.taskId, delivered),
          ),
        );
        assert.equal((yield* commandRow(started.taskId))?.status, status);
        assert.deepEqual(
          members.filter((member) => survived(member)).map((member) => member.pid),
          [],
          "processes of the script still run",
        );
      }),
    );
  });
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
            const one = yield* runner.run(
              callerOf(first.threadId),
              keyed({
                command: "echo first",
                timeoutMinutes: 5,
              }),
            );
            const two = yield* runner.run(
              callerOf(second.threadId),
              keyed({ command: "echo second" }),
            );
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
          runner.run(callerOf(first.threadId), keyed({ command: "echo first" })),
        ).pipe(memory.on);
        const two = yield* withServer((runner) =>
          Effect.gen(function* () {
            const two = yield* runner.run(
              callerOf(second.threadId),
              keyed({ command: "echo second" }),
            );
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
          const cancelled = yield* runner.run(
            callerOf(chat.threadId),
            keyed({
              command: "echo > started",
            }),
          );
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, cancelled.taskId));
          yield* memory.clear;
          // It starts after the cancelled one would have.
          yield* runner.run(callerOf(other.threadId), keyed({ command: "echo other" }));
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
              const settled = yield* runner.run(
                callerOf(chat.threadId),
                keyed({
                  command: "echo > started",
                }),
              );
              if (why === "its chat archived") yield* endTurn(chat.threadId);
              settleAfterRead = settled.taskId;
              yield* memory.clear;
              // It starts after the settled one would have.
              yield* runner.run(callerOf(other.threadId), keyed({ command: "echo other" }));
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
            const cut = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo > started" }),
            );
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
          runner.run(callerOf(other.threadId), keyed({ command: "echo other" })),
        ).pipe(memory.on);
        // Its launch gate was open but no launcher ran, so the next server closes it unstarted.
        yield* withServer(() => nextWake(chat.threadId));
        assert.equal((yield* commandRow(cut.taskId))?.status, "unstarted");
        assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "started")));
        const task = yield* taskOf(chat.threadId, cut.taskId);
        assert.equal(task?.status, "failed");
        assert.match(
          task?.result ?? "",
          /^Could not start the command: the server stopped before launch completed\./,
        );
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
            const started = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo ran" }),
            );
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
        const ends = yield* losingEnds(1, chat.threadId);
        let starting = false;
        const failed = yield* withServer((runner) =>
          Effect.gen(function* () {
            const failed = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo ran" }),
            );
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
        const ends = yield* losingEnds(lost, chat.threadId);
        const waiting = yield* withServer((runner) =>
          Effect.gen(function* () {
            const waiting = yield* runner.run(
              callerOf(chat.threadId),
              keyed({ command: "echo started" }),
            );
            yield* endTurn(chat.threadId);
            yield* threads.dispatch(
              why === "deleted" ? deletionOf(chat.threadId) : archiveOf(chat.threadId),
            );
            yield* Deferred.await(ends.told);
            // Its request takes the lock the task was told under.
            const barrier = yield* runner.run(
              callerOf(other.threadId),
              keyed({ command: "echo other" }),
            );
            yield* runner.cancel({
              parentThreadId: other.threadId,
              taskId: barrier.taskId,
              reason: "cleanup",
            });
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
        const ends = yield* losingEnds(2, closing.threadId);
        const ran = yield* withServer(
          (runner) =>
            Effect.gen(function* () {
              const ran = yield* runner.run(
                callerOf(chat.threadId),
                keyed({ command: "echo ran" }),
              );
              yield* runner.run(callerOf(closing.threadId), keyed({ command: "echo closing" }));
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
          runner.run(callerOf(chat.threadId), keyed({ command: "echo started" })),
        ).pipe(memory.on);
        yield* endTurn(chat.threadId);
        yield* threads.dispatch(archiveOf(chat.threadId));
        // The next server's adoption tells it first, and that telling is lost.
        const ends = yield* losingEnds(1, chat.threadId);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Deferred.await(ends.told);
            // Its request takes the lock the task was told under.
            const barrier = yield* runner.run(
              callerOf(other.threadId),
              keyed({ command: "echo other" }),
            );
            yield* runner.cancel({
              parentThreadId: other.threadId,
              taskId: barrier.taskId,
              reason: "cleanup",
            });
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

const SATURATION: CpuAdmission.CpuSaturation = {
  busyShare: 0.99,
  nicedShare: 0.8,
  excludedShare: 0.01,
  limit: 0.95,
  cores: 12,
};

/** CPUs saturated until `clear`; each read is offered to `reads`. */
const busyCpu = Effect.gen(function* () {
  let saturation: CpuAdmission.CpuSaturation | null = SATURATION;
  const reads = yield* Queue.unbounded<CpuAdmission.CpuSaturation | null>();
  return {
    reads,
    clear: Effect.sync(() => {
      saturation = null;
    }),
    on: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(CpuAdmission.CpuAdmission, {
          saturation: Effect.sync(() => saturation).pipe(
            Effect.tap((seen) => Queue.offer(reads, seen)),
          ),
        }),
      ),
  };
});

const CPU_WAIT =
  /^Queued, waiting for CPU: the CPUs are 0\.99 busy across 12 cores, at or over the 0\.95 limit \(0\.80 niced, 0\.01 excluded from the busy share as lower-priority work\)\. Its time limit counts from when it starts\.$/;

/** A command that runs until its chat's workspace has a `go` file or is removed by teardown. */
const HOLD_COMMAND = `${WAIT_FOR_GO}; echo held`;

const release = (chat: { readonly workspace: string }) =>
  Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), ""));

it.layer(layerTest, { excludeTestServices: true })("a command waiting for CPU", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "starts nothing while the CPUs are saturated and a command runs, says so in its task, then starts once they clear, its time limit counted from its start",
    () =>
      Effect.gen(function* () {
        const holder = yield* liveChat("command-cpu-holder");
        const chat = yield* liveChat("command-cpu-waiting");
        const cpu = yield* busyCpu;
        const clock = yield* clockBehind;
        const [waiting, queued] = yield* withServer((runner) =>
          Effect.gen(function* () {
            // Nothing runs yet, so the saturated CPUs hold nothing back.
            // The clock catches up an hour, which the default time limit would not outlast.
            const held = yield* runner.run(
              callerOf(holder.threadId),
              keyed({
                command: HOLD_COMMAND,
                timeoutMinutes: 240,
              }),
            );
            assert.equal((yield* commandRow(held.taskId))?.status, "running");
            const waiting = yield* runner.run(
              callerOf(chat.threadId),
              keyed({
                command: "echo > started; echo waited",
                timeoutMinutes: 5,
              }),
            );
            // A pass that read the saturation after the request started nothing.
            yield* Queue.clear(cpu.reads);
            yield* Queue.take(cpu.reads);
            const queued = (yield* commandRow(waiting.taskId))!;
            assert.equal(queued.status, "queued");
            assert.isNull(queued.pid);
            assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "started")));
            const task = yield* taskOf(chat.threadId, waiting.taskId);
            assert.equal(task?.status, "pending");
            assert.match(task?.progress ?? "", CPU_WAIT);
            yield* clock.catchUp;
            yield* cpu.clear;
            yield* nextWake(chat.threadId);
            // The command that held the place is still running, and ends cleanly before shutdown.
            assert.equal((yield* commandRow(held.taskId))?.status, "running");
            yield* release(holder);
            yield* nextWake(holder.threadId);
            return [waiting, queued] as const;
          }),
        ).pipe(cpu.on, clock.on);
        const ran = (yield* commandRow(waiting.taskId))!;
        assert.isAtLeast(Date.parse(ran.started_at) - Date.parse(queued.started_at), HOUR_MS);
        assert.equal(Date.parse(ran.deadline_at) - Date.parse(ran.started_at), 5 * 60_000);
        const task = yield* taskOf(chat.threadId, waiting.taskId);
        assert.equal(task?.status, "completed");
        assert.notProperty(task, "progress");
        assert.match(task?.result ?? "", /Last output:\nwaited\n/);
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "starts the first queued command whatever the reading once no command of the server runs",
    () =>
      Effect.gen(function* () {
        const holder = yield* liveChat("command-cpu-starve-holder");
        const first = yield* liveChat("command-cpu-starve-first");
        const second = yield* liveChat("command-cpu-starve-second");
        const cpu = yield* busyCpu;
        const [one, two] = yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* runner.run(callerOf(holder.threadId), keyed({ command: HOLD_COMMAND }));
            const one = yield* runner.run(
              callerOf(first.threadId),
              keyed({
                command: `echo > started; ${WAIT_FOR_GO}; echo first`,
              }),
            );
            const two = yield* runner.run(
              callerOf(second.threadId),
              keyed({ command: "echo second" }),
            );
            assert.equal((yield* commandRow(one.taskId))?.status, "queued");
            assert.equal((yield* commandRow(two.taskId))?.status, "queued");
            const behind = yield* taskOf(second.threadId, two.taskId);
            assert.match(behind?.progress ?? "", /^Queued, waiting for CPU: /);
            // Nothing runs after the holder ends; the CPUs are still saturated.
            yield* release(holder);
            yield* nextWake(holder.threadId);
            // The first starts, so the second waits behind a running command again.
            yield* awaitFile(NodePath.join(first.workspace, "started"));
            assert.equal((yield* commandRow(two.taskId))?.status, "queued");
            yield* release(first);
            yield* nextWake(second.threadId);
            return [one, two] as const;
          }),
        ).pipe(cpu.on);
        assert.deepStrictEqual(yield* startOrder([one.taskId, two.taskId]), [
          one.taskId,
          two.taskId,
        ]);
        assert.equal((yield* taskOf(second.threadId, two.taskId))?.status, "completed");
      }),
  );
});
