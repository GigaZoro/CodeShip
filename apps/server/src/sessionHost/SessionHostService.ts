// @effect-diagnostics nodeBuiltinImport:off -- Spawns detached `__session-host` brokers outside Effect scopes so they survive planned server restarts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ThreadId } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { probeProcess } from "@t3tools/shared/processProbe";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  compareIdentity,
  ENDED_IDENTITY,
  linuxIdentity,
  timeIdentity,
} from "../commandRunner/processIdentity.ts";
import * as ServerConfig from "../config.ts";
import { escapePowerShellStringLiteral } from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readProcessStartedAt } from "../serverRuntimeState.ts";
import { DetachedStdioHandle, type DetachedAttachedInfo } from "./DetachedStdioHandle.ts";
import {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_BUFFER_FRAMES,
  DEFAULT_ORPHAN_TTL_MS,
  ensurePrivateSocketDirectory,
  resolveSessionHostSocketPath,
  type SessionHostConfig,
  type SessionHostDriver,
  type SessionHostStatus,
} from "./protocol.ts";

const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_CONNECT_RETRY_MS = 25;
const ACK_FLUSH_INTERVAL_MS = 500;
const SW_HIDE = 0;

class SessionHostError extends Data.TaggedError("SessionHostError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

interface SessionHostRow {
  readonly id: string;
  readonly provider_session_id: string;
  readonly provider_thread_id: string | null;
  readonly thread_id: string;
  readonly driver: string;
  readonly socket_path: string;
  readonly auth_token: string;
  readonly broker_pid: number | null;
  readonly broker_identity_json: string | null;
  readonly child_pid: number | null;
  readonly last_acked_seq: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SessionHostRecord {
  readonly id: string;
  readonly providerSessionId: string;
  readonly providerThreadId: string | null;
  readonly threadId: ThreadId;
  readonly driver: SessionHostDriver;
  readonly socketPath: string;
  readonly authToken: string;
  readonly brokerPid: number | null;
  readonly brokerIdentity: string | null;
  readonly childPid: number | null;
  readonly lastAckedSeq: number;
  readonly status: SessionHostStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpawnSessionHostInput {
  readonly providerSessionId: string;
  readonly providerThreadId?: string | null;
  readonly threadId: ThreadId;
  readonly driver: SessionHostDriver;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly orphanTtlMs?: number;
  readonly maxBufferBytes?: number;
  readonly maxBufferFrames?: number;
  readonly onStderr?: (chunk: string) => void;
}

export interface DetachedHostSummary {
  readonly id: string;
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly driver: SessionHostDriver;
  readonly lastAckedSeq: number;
}

export type ProbedDetachedHost =
  | {
      readonly status: "alive";
      readonly record: SessionHostRecord;
    }
  | {
      readonly status: "dead";
      readonly record: SessionHostRecord;
      readonly reason: string;
    };

export type ReattachedDetachedHost =
  | {
      readonly status: "reattached";
      readonly record: SessionHostRecord;
      readonly handle: DetachedStdioHandle;
      readonly attachedInfo: DetachedAttachedInfo;
    }
  | {
      readonly status: "dead";
      readonly record: SessionHostRecord;
      readonly reason: string;
    };

export interface SessionHostServiceShape {
  readonly spawn: (
    input: SpawnSessionHostInput,
  ) => Effect.Effect<DetachedStdioHandle, SessionHostError>;
  readonly spawnChildProcessHandle: (input: SpawnSessionHostInput) => Effect.Effect<
    {
      readonly handle: DetachedStdioHandle;
      readonly childProcess: ChildProcessSpawner.ChildProcessHandle;
    },
    SessionHostError
  >;
  readonly reattach: (sessionHostId: string) => Effect.Effect<
    {
      readonly record: SessionHostRecord;
      readonly handle: DetachedStdioHandle;
      readonly attachedInfo: DetachedAttachedInfo;
    },
    SessionHostError
  >;
  readonly probeDetachedForUpdate: () => Effect.Effect<ReadonlyArray<ProbedDetachedHost>>;
  readonly reattachAllDetachedForUpdate: () => Effect.Effect<ReadonlyArray<ReattachedDetachedHost>>;
  readonly listDetachedForUpdate: () => Effect.Effect<ReadonlyArray<SessionHostRecord>>;
  readonly detachAllForUpdate: () => Effect.Effect<ReadonlyArray<DetachedHostSummary>>;
  readonly isProviderSessionDetachedForUpdate: (
    providerSessionId: string,
  ) => Effect.Effect<boolean>;
  readonly isThreadDetachedForUpdate: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly getActiveHandleByProviderSession: (
    providerSessionId: string,
  ) => Effect.Effect<DetachedStdioHandle | undefined>;
  readonly getActiveHandleByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<DetachedStdioHandle | undefined>;
  readonly updateProviderThreadId: (
    providerSessionId: string,
    providerThreadId: string,
  ) => Effect.Effect<void>;
  readonly markDead: (sessionHostId: string) => Effect.Effect<void>;
  readonly terminate: (sessionHostId: string, signal?: NodeJS.Signals) => Effect.Effect<void>;
  readonly terminateByProviderSession: (
    providerSessionId: string,
    signal?: NodeJS.Signals,
  ) => Effect.Effect<void>;
  readonly terminateByThread: (threadId: ThreadId, signal?: NodeJS.Signals) => Effect.Effect<void>;
}

export class SessionHostService extends Context.Service<
  SessionHostService,
  SessionHostServiceShape
>()("t3/sessionHost/SessionHostService") {}

interface ActiveTrackedHost {
  readonly id: string;
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly driver: SessionHostDriver;
  readonly handle: DetachedStdioHandle;
  readonly ackFiber: { current: Fiber.Fiber<void, never> | null };
  readonly unit: string | null;
}

function rowToRecord(row: SessionHostRow): SessionHostRecord {
  let brokerIdentity: string | null = null;
  if (row.broker_identity_json !== null) {
    try {
      const parsed = JSON.parse(row.broker_identity_json) as { readonly identity?: unknown };
      if (typeof parsed?.identity === "string") {
        brokerIdentity = parsed.identity;
      }
    } catch {
      brokerIdentity = row.broker_identity_json;
    }
  }
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    providerThreadId: row.provider_thread_id,
    threadId: ThreadId.make(row.thread_id),
    driver: row.driver as SessionHostDriver,
    socketPath: row.socket_path,
    authToken: row.auth_token,
    brokerPid: row.broker_pid,
    brokerIdentity,
    childPid: row.child_pid,
    lastAckedSeq: row.last_acked_seq,
    status: row.status as SessionHostStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

function safeUnlinkSync(filePath: string): void {
  try {
    NodeFS.unlinkSync(filePath);
  } catch {
    // Ignore ENOENT / already cleaned up.
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const runtime = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const hostEnv = yield* HostProcess.Environment;
  const agentScopeOption = yield* Effect.serviceOption(AgentScope);
  const processRunnerOption = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);

  const cliEntry = isExecutable
    ? ""
    : NodeURL.fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
      );
  const sessionHostsDir = path.join(serverConfig.stateDir, "session-hosts");
  const isWindows = platform === "win32";

  const activeById = new Map<string, ActiveTrackedHost>();
  const activeByProviderSession = new Map<string, ActiveTrackedHost>();
  const detachedProviderSessions = new Set<string>();
  const detachedThreads = new Set<ThreadId>();

  const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

  const persistAckSeq = (id: string, seq: number) =>
    nowIso().pipe(
      Effect.flatMap(
        (updatedAt) =>
          sql`
            UPDATE session_hosts
            SET last_acked_seq = MAX(last_acked_seq, ${seq}), updated_at = ${updatedAt}
            WHERE id = ${id}
          `,
      ),
      Effect.asVoid,
      Effect.ignore({ log: true }),
    );

  const updateRowStatus = (id: string, status: SessionHostStatus, lastAckedSeq?: number) =>
    nowIso().pipe(
      Effect.flatMap((updatedAt) =>
        lastAckedSeq === undefined
          ? sql`
              UPDATE session_hosts
              SET status = ${status}, updated_at = ${updatedAt}
              WHERE id = ${id}
            `
          : sql`
              UPDATE session_hosts
              SET status = ${status},
                  last_acked_seq = MAX(last_acked_seq, ${lastAckedSeq}),
                  updated_at = ${updatedAt}
              WHERE id = ${id}
            `,
      ),
      Effect.asVoid,
      Effect.ignore({ log: true }),
    );

  const clearTrackedHost = (tracked: ActiveTrackedHost) => {
    if (tracked.ackFiber.current !== null) {
      const fiber = tracked.ackFiber.current;
      tracked.ackFiber.current = null;
      fiber.interruptUnsafe();
    }
    if (activeById.get(tracked.id) === tracked) {
      activeById.delete(tracked.id);
    }
    if (activeByProviderSession.get(tracked.providerSessionId) === tracked) {
      activeByProviderSession.delete(tracked.providerSessionId);
    }
  };

  const trackHandle = (
    id: string,
    providerSessionId: string,
    threadId: ThreadId,
    driver: SessionHostDriver,
    handle: DetachedStdioHandle,
    unit: string | null,
    runFork: <E>(effect: Effect.Effect<void, E>) => Fiber.Fiber<void, never>,
  ): ActiveTrackedHost => {
    const tracked: ActiveTrackedHost = {
      id,
      providerSessionId,
      threadId,
      driver,
      handle,
      ackFiber: { current: null },
      unit,
    };
    activeById.set(id, tracked);
    activeByProviderSession.set(providerSessionId, tracked);

    handle.events.once("exit", () => {
      if (handle.detachingForUpdate) return;
      clearTrackedHost(tracked);
      runFork(updateRowStatus(id, "exited", handle.lastAckedSeq));
      if (unit !== null && Option.isSome(agentScopeOption)) {
        runFork(agentScopeOption.value.stop(unit).pipe(Effect.ignore));
      }
    });

    return tracked;
  };

  const scheduleAckFlush = (
    tracked: ActiveTrackedHost,
    seq: number,
    runFork: <E>(effect: Effect.Effect<void, E>) => Fiber.Fiber<void, never>,
  ) => {
    if (tracked.ackFiber.current !== null) return;
    tracked.ackFiber.current = runFork(
      Effect.sleep(Duration.millis(ACK_FLUSH_INTERVAL_MS)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            tracked.ackFiber.current = null;
            return persistAckSeq(tracked.id, Math.max(seq, tracked.handle.lastAckedSeq));
          }),
        ),
        Effect.ignoreCause,
      ),
    );
  };

  const identityOfBroker = Effect.fn("SessionHostService.identityOfBroker")(function* (
    pid: number,
  ): Effect.fn.Return<string | undefined> {
    if (platform === "linux") {
      const read = yield* Effect.all([
        fs.readFileString(`/proc/${pid}/stat`),
        fs.readFileString("/proc/sys/kernel/random/boot_id"),
      ]).pipe(Effect.option);
      return Option.isSome(read) ? linuxIdentity(read.value[0], read.value[1]) : undefined;
    }
    if (Option.isNone(processRunnerOption)) {
      return undefined;
    }
    const startedAt = yield* readProcessStartedAt(pid).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunnerOption.value),
    );
    return startedAt === undefined ? undefined : timeIdentity(startedAt);
  });

  const rebootedSince = (createdAtIso: string) =>
    DateTime.now.pipe(
      Effect.map(
        (now) => DateTime.toEpochMillis(now) - NodeOS.uptime() * 1_000 > Date.parse(createdAtIso),
      ),
    );

  const verifyBrokerIdentity = Effect.fn("SessionHostService.verifyBrokerIdentity")(function* (
    record: SessionHostRecord,
  ): Effect.fn.Return<
    { readonly alive: true } | { readonly alive: false; readonly reason: string }
  > {
    if (record.brokerPid === null || record.brokerPid <= 0) {
      return { alive: false, reason: "missing_broker_pid" };
    }
    if (yield* rebootedSince(record.createdAt)) {
      return { alive: false, reason: "host_rebooted" };
    }
    const probe = probeProcess(record.brokerPid);
    if (probe.state === "gone") {
      return { alive: false, reason: `broker_gone:${probe.code}` };
    }
    if (record.brokerIdentity === ENDED_IDENTITY) {
      return { alive: false, reason: "broker_ended" };
    }
    if (record.brokerIdentity !== null) {
      const current = yield* identityOfBroker(record.brokerPid);
      const verdict = compareIdentity(record.brokerIdentity, current);
      if (verdict === "other") {
        return { alive: false, reason: "broker_pid_reused" };
      }
    }
    return { alive: true };
  });

  const launchDetachedBrokerProcess = Effect.fn("SessionHostService.launchDetachedBrokerProcess")(
    function* (
      configPath: string,
      cwd: string,
    ): Effect.fn.Return<{ readonly unit: string | null }, SessionHostError> {
      const brokerArgs = [...(cliEntry ? [cliEntry] : []), "__session-host", configPath];
      const brokerEnv: Record<string, string> = {
        ...sanitizeEnv(hostEnv),
        ELECTRON_RUN_AS_NODE: "1",
      };

      if (!isWindows) {
        const scoped = Option.isSome(agentScopeOption)
          ? yield* agentScopeOption.value
              .wrap({
                command: runtime,
                args: brokerArgs,
                name: "session-host",
                env: brokerEnv,
                cwd,
                survivesRestart: true,
              })
              .pipe(
                Effect.orElseSucceed(() => ({
                  command: runtime,
                  args: brokerArgs,
                  unit: undefined,
                })),
              )
          : { command: runtime, args: brokerArgs, unit: undefined };

        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              const child = NodeChildProcess.spawn(scoped.command, [...scoped.args], {
                cwd,
                env: brokerEnv,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
              });
              const onError = (error: Error) => {
                reject(error);
              };
              const onSpawn = () => {
                child.removeListener("error", onError);
                child.unref();
                resolve();
              };
              child.once("error", onError);
              child.once("spawn", onSpawn);
            }),
          catch: (cause) =>
            new SessionHostError({
              detail: `Failed to spawn detached session host broker: ${String(cause)}`,
              cause,
            }),
        });

        return { unit: scoped.unit ?? null };
      }

      // On Windows, prefer Win32_Process.Create so the broker lives outside any desktop Job Object.
      if (Option.isSome(processRunnerOption)) {
        const commandLine = [runtime, ...brokerArgs].map(quoteWindowsArg).join(" ");
        const envBase64 = Buffer.from(
          Object.entries(brokerEnv)
            .map(([key, value]) => `${key}=${value}`)
            .join("\0"),
          "utf8",
        ).toString("base64");
        const created = yield* processRunnerOption.value
          .run({
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split([char]0); $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $entries; ShowWindow = [uint16]${SW_HIDE} }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${escapePowerShellStringLiteral(commandLine)}; CurrentDirectory = ${escapePowerShellStringLiteral(cwd)}; ProcessStartupInformation = $startup }; if ($r.ReturnValue -ne 0) { exit 1 }`,
            ],
            stdin: envBase64,
            timeout: Duration.seconds(15),
            maxOutputBytes: 4_096,
          })
          .pipe(Effect.option);
        if (Option.isSome(created) && created.value.code === 0) {
          return { unit: null };
        }
      }

      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            const child = NodeChildProcess.spawn(runtime, brokerArgs, {
              cwd,
              env: brokerEnv,
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            });
            const onError = (error: Error) => reject(error);
            const onSpawn = () => {
              child.removeListener("error", onError);
              child.unref();
              resolve();
            };
            child.once("error", onError);
            child.once("spawn", onSpawn);
          }),
        catch: (cause) =>
          new SessionHostError({
            detail: `Failed to spawn detached Windows session host broker: ${String(cause)}`,
            cause,
          }),
      });
      return { unit: null };
    },
  );

  const connectWithRetry = Effect.fn("SessionHostService.connectWithRetry")(function* (
    handle: DetachedStdioHandle,
    readyFilePath: string,
    afterSeq: number,
  ): Effect.fn.Return<DetachedAttachedInfo, SessionHostError> {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + BROKER_START_TIMEOUT_MS;
    let lastError: unknown;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (NodeFS.existsSync(readyFilePath) || isWindows) {
        const attempt = yield* Effect.tryPromise({
          try: () => handle.connectSocket(afterSeq),
          catch: (cause) =>
            new SessionHostError({
              detail: `Connect attempt to detached session host ${handle.sessionHostId} failed: ${String(cause)}`,
              cause,
            }),
        }).pipe(Effect.result);
        if (attempt._tag === "Success") {
          safeUnlinkSync(readyFilePath);
          return attempt.success;
        }
        lastError = attempt.failure;
      }
      yield* Effect.sleep(Duration.millis(BROKER_CONNECT_RETRY_MS));
    }
    return yield* new SessionHostError({
      detail: `Timed out waiting for detached session host ${handle.sessionHostId} to become ready: ${String(lastError ?? "socket not ready")}`,
      cause: lastError,
    });
  });

  const insertHostRow = (input: {
    readonly id: string;
    readonly providerSessionId: string;
    readonly providerThreadId: string | null;
    readonly threadId: ThreadId;
    readonly driver: SessionHostDriver;
    readonly socketPath: string;
    readonly authToken: string;
    readonly brokerPid: number | null;
    readonly brokerIdentity: string | null;
    readonly childPid: number | null;
    readonly status: SessionHostStatus;
  }) =>
    nowIso().pipe(
      Effect.flatMap((timestamp) => {
        const identityJson =
          input.brokerIdentity === null ? null : JSON.stringify({ identity: input.brokerIdentity });
        return sql`
          INSERT OR REPLACE INTO session_hosts (
            id,
            provider_session_id,
            provider_thread_id,
            thread_id,
            driver,
            socket_path,
            auth_token,
            broker_pid,
            broker_identity_json,
            child_pid,
            last_acked_seq,
            status,
            created_at,
            updated_at
          ) VALUES (
            ${input.id},
            ${input.providerSessionId},
            ${input.providerThreadId},
            ${input.threadId},
            ${input.driver},
            ${input.socketPath},
            ${input.authToken},
            ${input.brokerPid},
            ${identityJson},
            ${input.childPid},
            0,
            ${input.status},
            ${timestamp},
            ${timestamp}
          )
        `;
      }),
      Effect.asVoid,
    );

  const prepareSpawnArtifacts = (input: SpawnSessionHostInput) => {
    const id = NodeCrypto.randomUUID();
    const authToken = NodeCrypto.randomBytes(32).toString("hex");
    const socketPath = resolveSessionHostSocketPath(serverConfig.stateDir, id, platform);
    const configPath = NodePath.join(sessionHostsDir, `cfg-${id}.json`);
    const readyFilePath = NodePath.join(sessionHostsDir, `ready-${id}.json`);

    NodeFS.mkdirSync(sessionHostsDir, { recursive: true, mode: 0o700 });
    if (!isWindows) ensurePrivateSocketDirectory(NodePath.dirname(socketPath));
    const config: SessionHostConfig = {
      id,
      platform,
      socketPath,
      authToken,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      env: sanitizeEnv(input.env),
      orphanTtlMs: input.orphanTtlMs ?? DEFAULT_ORPHAN_TTL_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      maxBufferFrames: input.maxBufferFrames ?? DEFAULT_MAX_BUFFER_FRAMES,
      readyFilePath,
      jsonRpc: input.driver === "codex",
    };
    NodeFS.writeFileSync(configPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { id, authToken, socketPath, configPath, readyFilePath };
  };

  const runForkWithContext = Effect.runForkWith(yield* Effect.context<never>());
  const runFork = <E>(effect: Effect.Effect<void, E>): Fiber.Fiber<void, never> =>
    runForkWithContext(effect.pipe(Effect.ignoreCause));

  const spawn: SessionHostServiceShape["spawn"] = Effect.fn("SessionHostService.spawn")(function* (
    input: SpawnSessionHostInput,
  ) {
    const { id, authToken, socketPath, configPath, readyFilePath } = yield* Effect.try({
      try: () => prepareSpawnArtifacts(input),
      catch: (cause) =>
        new SessionHostError({
          detail: `Failed to write detached session host config: ${String(cause)}`,
          cause,
        }),
    });

    const { unit } = yield* launchDetachedBrokerProcess(configPath, input.cwd).pipe(
      Effect.tapError(() => Effect.sync(() => safeUnlinkSync(configPath))),
    );

    let trackedRef: ActiveTrackedHost | undefined;
    const handle = DetachedStdioHandle.createPending({
      sessionHostId: id,
      socketPath,
      authToken,
      initialAfterSeq: 0,
      ...(input.onStderr !== undefined ? { onStderr: input.onStderr } : {}),
      onAckSeq: (seq) => {
        if (trackedRef !== undefined) {
          scheduleAckFlush(trackedRef, seq, runFork);
        }
      },
    });
    trackedRef = trackHandle(
      id,
      input.providerSessionId,
      input.threadId,
      input.driver,
      handle,
      unit,
      runFork,
    );

    const attached = yield* connectWithRetry(handle, readyFilePath, 0).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          clearTrackedHost(trackedRef!);
          safeUnlinkSync(configPath);
          safeUnlinkSync(readyFilePath);
        }),
      ),
    );

    yield* insertHostRow({
      id,
      providerSessionId: input.providerSessionId,
      providerThreadId: input.providerThreadId ?? null,
      threadId: input.threadId,
      driver: input.driver,
      socketPath,
      authToken,
      brokerPid: attached.brokerPid,
      brokerIdentity: attached.brokerIdentity,
      childPid: attached.childPid,
      status: attached.exited ? "exited" : "running",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionHostError({
            detail: `Failed to persist detached session host ${id}: ${String(cause)}`,
            cause,
          }),
      ),
    );

    return handle;
  });

  const spawnChildProcessHandle: SessionHostServiceShape["spawnChildProcessHandle"] = Effect.fn(
    "SessionHostService.spawnChildProcessHandle",
  )(function* (input: SpawnSessionHostInput) {
    const handle = yield* spawn(input);
    return {
      handle,
      childProcess: handle.asChildProcessHandle(),
    };
  });

  const listDetachedForUpdate: SessionHostServiceShape["listDetachedForUpdate"] = Effect.fn(
    "SessionHostService.listDetachedForUpdate",
  )(function* () {
    const rows = yield* sql<SessionHostRow>`
      SELECT
        id,
        provider_session_id,
        provider_thread_id,
        thread_id,
        driver,
        socket_path,
        auth_token,
        broker_pid,
        broker_identity_json,
        child_pid,
        last_acked_seq,
        status,
        created_at,
        updated_at
      FROM session_hosts
      WHERE status = 'detached_for_update'
      ORDER BY created_at ASC
    `.pipe(Effect.orElseSucceed(() => [] as Array<SessionHostRow>));
    return rows.map(rowToRecord);
  });

  const probeDetachedForUpdate: SessionHostServiceShape["probeDetachedForUpdate"] = Effect.fn(
    "SessionHostService.probeDetachedForUpdate",
  )(function* () {
    const records = yield* listDetachedForUpdate();
    const results: Array<ProbedDetachedHost> = [];
    for (const record of records) {
      const verdict = yield* verifyBrokerIdentity(record);
      if (!verdict.alive) {
        yield* updateRowStatus(record.id, "dead");
        results.push({ status: "dead", record, reason: verdict.reason });
      } else {
        results.push({ status: "alive", record });
      }
    }
    return results;
  });

  const reattach: SessionHostServiceShape["reattach"] = Effect.fn("SessionHostService.reattach")(
    function* (sessionHostId: string) {
      const rows = yield* sql<SessionHostRow>`
        SELECT
          id,
          provider_session_id,
          provider_thread_id,
          thread_id,
          driver,
          socket_path,
          auth_token,
          broker_pid,
          broker_identity_json,
          child_pid,
          last_acked_seq,
          status,
          created_at,
          updated_at
        FROM session_hosts
        WHERE id = ${sessionHostId}
        LIMIT 1
      `.pipe(
        Effect.mapError(
          (cause) =>
            new SessionHostError({
              detail: `Failed to read session host ${sessionHostId}: ${String(cause)}`,
              cause,
            }),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new SessionHostError({
          detail: `Session host ${sessionHostId} not found.`,
        });
      }
      const record = rowToRecord(row);
      const verdict = yield* verifyBrokerIdentity(record);
      if (!verdict.alive) {
        yield* updateRowStatus(record.id, "dead");
        return yield* new SessionHostError({
          detail: `Session host ${sessionHostId} is no longer alive (${verdict.reason}).`,
        });
      }

      // The attach message carries the auth token, so never send it to a socket another user
      // could have planted.
      if (!isWindows) {
        yield* Effect.try({
          try: () => ensurePrivateSocketDirectory(NodePath.dirname(record.socketPath)),
          catch: (cause) =>
            new SessionHostError({
              detail: `Refusing to reattach session host ${record.id}: ${String(cause)}`,
              cause,
            }),
        }).pipe(Effect.tapError(() => updateRowStatus(record.id, "dead")));
      }

      let trackedRef: ActiveTrackedHost | undefined;
      const handle = DetachedStdioHandle.createPending({
        sessionHostId: record.id,
        socketPath: record.socketPath,
        authToken: record.authToken,
        initialAfterSeq: record.lastAckedSeq,
        onAckSeq: (seq) => {
          if (trackedRef !== undefined) {
            scheduleAckFlush(trackedRef, seq, runFork);
          }
        },
      });
      trackedRef = trackHandle(
        record.id,
        record.providerSessionId,
        record.threadId,
        record.driver,
        handle,
        null,
        runFork,
      );

      const attachedInfo = yield* Effect.tryPromise({
        try: () => handle.connectSocket(record.lastAckedSeq),
        catch: (cause) =>
          new SessionHostError({
            detail: `Failed to reattach to session host ${record.id}: ${String(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            clearTrackedHost(trackedRef!);
            yield* updateRowStatus(record.id, "dead");
          }),
        ),
      );

      // A frame the old server never consumed that the ring buffer already dropped is lost
      // output; adopting the process anyway would leave the run waiting on it forever.
      const missedFrames = attachedInfo.oldestSeq - (record.lastAckedSeq + 1);
      if (missedFrames > 0) {
        yield* Effect.promise(() => handle.terminate());
        clearTrackedHost(trackedRef);
        yield* updateRowStatus(record.id, "dead");
        return yield* new SessionHostError({
          detail: `Session host ${record.id} dropped ${missedFrames} unread output frames while detached.`,
        });
      }

      yield* updateRowStatus(record.id, attachedInfo.exited ? "exited" : "running");

      return { record, handle, attachedInfo };
    },
  );

  const reattachAllDetachedForUpdate: SessionHostServiceShape["reattachAllDetachedForUpdate"] =
    Effect.fn("SessionHostService.reattachAllDetachedForUpdate")(function* () {
      const probed = yield* probeDetachedForUpdate();
      const results: Array<ReattachedDetachedHost> = [];
      for (const entry of probed) {
        if (entry.status === "dead") {
          results.push(entry);
          continue;
        }
        const attached = yield* reattach(entry.record.id).pipe(Effect.result);
        if (attached._tag === "Failure") {
          results.push({
            status: "dead",
            record: entry.record,
            reason: attached.failure.detail,
          });
        } else {
          results.push({
            status: "reattached",
            record: attached.success.record,
            handle: attached.success.handle,
            attachedInfo: attached.success.attachedInfo,
          });
        }
      }
      return results;
    });

  const detachAllForUpdate: SessionHostServiceShape["detachAllForUpdate"] = Effect.fn(
    "SessionHostService.detachAllForUpdate",
  )(function* () {
    const trackedHosts = [...activeById.values()];
    const summaries: Array<DetachedHostSummary> = [];

    for (const tracked of trackedHosts) {
      if (tracked.handle.exited) {
        clearTrackedHost(tracked);
        yield* updateRowStatus(tracked.id, "exited", tracked.handle.lastAckedSeq);
        continue;
      }
      detachedProviderSessions.add(tracked.providerSessionId);
      detachedThreads.add(tracked.threadId);
      tracked.handle.markDetachingForUpdate();
      const lastAckedSeq = yield* Effect.promise(() => tracked.handle.detach());
      clearTrackedHost(tracked);
      yield* updateRowStatus(tracked.id, "detached_for_update", lastAckedSeq);
      summaries.push({
        id: tracked.id,
        providerSessionId: tracked.providerSessionId,
        threadId: tracked.threadId,
        driver: tracked.driver,
        lastAckedSeq,
      });
    }

    return summaries;
  });

  const isProviderSessionDetachedForUpdate: SessionHostServiceShape["isProviderSessionDetachedForUpdate"] =
    (providerSessionId) => Effect.sync(() => detachedProviderSessions.has(providerSessionId));

  const isThreadDetachedForUpdate: SessionHostServiceShape["isThreadDetachedForUpdate"] = (
    threadId,
  ) => Effect.sync(() => detachedThreads.has(threadId));

  const getActiveHandleByProviderSession: SessionHostServiceShape["getActiveHandleByProviderSession"] =
    (providerSessionId) =>
      Effect.sync(() => activeByProviderSession.get(providerSessionId)?.handle);

  const getActiveHandleByThread: SessionHostServiceShape["getActiveHandleByThread"] = (threadId) =>
    Effect.sync(() => {
      for (const tracked of activeById.values()) {
        if (tracked.threadId === threadId) return tracked.handle;
      }
      return undefined;
    });

  const updateProviderThreadId: SessionHostServiceShape["updateProviderThreadId"] = Effect.fn(
    "SessionHostService.updateProviderThreadId",
  )(function* (providerSessionId: string, providerThreadId: string) {
    const updatedAt = yield* nowIso();
    yield* sql`
      UPDATE session_hosts
      SET provider_thread_id = ${providerThreadId}, updated_at = ${updatedAt}
      WHERE provider_session_id = ${providerSessionId}
    `.pipe(Effect.asVoid, Effect.ignore({ log: true }));
  });

  const markDead: SessionHostServiceShape["markDead"] = (sessionHostId) =>
    updateRowStatus(sessionHostId, "dead");

  const terminate: SessionHostServiceShape["terminate"] = Effect.fn("SessionHostService.terminate")(
    function* (sessionHostId: string, signal?: NodeJS.Signals) {
      const tracked = activeById.get(sessionHostId);
      if (tracked !== undefined) {
        detachedProviderSessions.delete(tracked.providerSessionId);
        detachedThreads.delete(tracked.threadId);
        clearTrackedHost(tracked);
        yield* Effect.promise(() => tracked.handle.terminate(signal));
        yield* updateRowStatus(sessionHostId, "exited", tracked.handle.lastAckedSeq);
        if (tracked.unit !== null && Option.isSome(agentScopeOption)) {
          yield* agentScopeOption.value.stop(tracked.unit).pipe(Effect.ignore);
        }
        return;
      }

      // If not currently attached in memory, connect briefly and send terminate if still alive.
      const rows = yield* sql<SessionHostRow>`
      SELECT
        id,
        provider_session_id,
        provider_thread_id,
        thread_id,
        driver,
        socket_path,
        auth_token,
        broker_pid,
        broker_identity_json,
        child_pid,
        last_acked_seq,
        status,
        created_at,
        updated_at
      FROM session_hosts
      WHERE id = ${sessionHostId}
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => [] as Array<SessionHostRow>));
      const row = rows[0];
      if (row === undefined) return;
      const record = rowToRecord(row);
      const verdict = yield* verifyBrokerIdentity(record);
      if (verdict.alive) {
        yield* Effect.tryPromise(async () => {
          const handle = await DetachedStdioHandle.connect({
            sessionHostId: record.id,
            socketPath: record.socketPath,
            authToken: record.authToken,
            initialAfterSeq: record.lastAckedSeq,
          });
          await handle.terminate(signal);
        }).pipe(Effect.ignore);
      }
      yield* updateRowStatus(sessionHostId, "exited");
    },
  );

  const terminateByProviderSession: SessionHostServiceShape["terminateByProviderSession"] =
    Effect.fn("SessionHostService.terminateByProviderSession")(function* (
      providerSessionId: string,
      signal?: NodeJS.Signals,
    ) {
      const tracked = activeByProviderSession.get(providerSessionId);
      if (tracked !== undefined) {
        yield* terminate(tracked.id, signal);
        return;
      }
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM session_hosts
        WHERE provider_session_id = ${providerSessionId}
          AND status IN ('running', 'detached_for_update')
      `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly id: string }>));
      for (const row of rows) {
        yield* terminate(row.id, signal);
      }
    });

  const terminateByThread: SessionHostServiceShape["terminateByThread"] = Effect.fn(
    "SessionHostService.terminateByThread",
  )(function* (threadId: ThreadId, signal?: NodeJS.Signals) {
    const ids = new Set<string>();
    for (const tracked of activeById.values()) {
      if (tracked.threadId === threadId) {
        ids.add(tracked.id);
      }
    }
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM session_hosts
      WHERE thread_id = ${threadId}
        AND status IN ('running', 'detached_for_update')
    `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly id: string }>));
    for (const row of rows) {
      ids.add(row.id);
    }
    for (const id of ids) {
      yield* terminate(id, signal);
    }
  });

  return {
    spawn,
    spawnChildProcessHandle,
    reattach,
    probeDetachedForUpdate,
    reattachAllDetachedForUpdate,
    listDetachedForUpdate,
    detachAllForUpdate,
    isProviderSessionDetachedForUpdate,
    isThreadDetachedForUpdate,
    getActiveHandleByProviderSession,
    getActiveHandleByThread,
    updateProviderThreadId,
    markDead,
    terminate,
    terminateByProviderSession,
    terminateByThread,
  } satisfies SessionHostServiceShape;
});

export const layer = Layer.effect(SessionHostService, make);
