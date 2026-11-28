// @effect-diagnostics nodeBuiltinImport:off -- Spawns detached `__session-host` brokers outside Effect scopes so they survive planned server restarts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ThreadId } from "@t3tools/contracts/baseSchemas";
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
import * as FiberSet from "effect/FiberSet";
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
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { escapePowerShellStringLiteral } from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readProcessStartedAt } from "../serverRuntimeState.ts";
import { DetachedStdioHandle, type DetachedAttachedInfo } from "./DetachedStdioHandle.ts";
import {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_BUFFER_FRAMES,
  DEFAULT_ORPHAN_TTL_MS,
  DEFAULT_TERMINATE_GRACE_MS,
  KILL_CONFIRM_MS,
  ensurePrivateSocketDirectory,
  resolveSessionHostSocketPath,
  type SessionHostConfig,
  type SessionHostDriver,
  type SessionHostStatus,
} from "./protocol.ts";

const BROKER_START_TIMEOUT_MS = 10_000;
// The broker escalates to SIGKILL after its grace period; the last second covers the exit frame's trip.
const TERMINATE_EXIT_WAIT = Duration.millis(DEFAULT_TERMINATE_GRACE_MS + KILL_CONFIRM_MS + 1_000);
const BROKER_CONNECT_RETRY_MS = 25;
const SW_HIDE = 0;
/** A server runs a few provider processes; a listing past this is left for the next sweep. */
const MAX_HOST_ROWS = 256;
/**
 * The launcher waits 5 seconds for a planned shutdown; draining the output a server already got
 * must leave it time to detach. A host that cannot drain in time is stopped and its threads
 * continue from their transcript instead.
 */
const DETACH_DRAIN_TIMEOUT = Duration.seconds(2);
/** Answers, interrupts and steers queued for the process reach it before its output is held. */
const DETACH_DELIVER_TIMEOUT = Duration.seconds(1);

class SessionHostError extends Data.TaggedError("SessionHostError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

interface SessionHostRow {
  readonly id: string;
  readonly provider_session_id: string;
  readonly provider_thread_id: string | null;
  readonly thread_id: string;
  readonly thread_ids_json: string;
  readonly driver: string;
  readonly socket_path: string;
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
  /** Every thread the process served when it was detached; the spawning thread before that. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly driver: SessionHostDriver;
  readonly socketPath: string;
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
  /** From resolveSpawnCommand: the command is a shell command line (Windows `.cmd` shims). */
  readonly shell?: boolean;
  readonly orphanTtlMs?: number;
  readonly maxBufferBytes?: number;
  readonly maxBufferFrames?: number;
  readonly onStderr?: (chunk: string) => void;
}

export interface DetachedHostSummary {
  readonly id: string;
  readonly providerSessionId: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly driver: SessionHostDriver;
  readonly lastAckedSeq: number;
}

/** What the session on a host's process does before the host is detached for an update. */
export interface DetachPreparation {
  /** Completes once everything queued for the process's threads was written to it. */
  readonly deliver: Effect.Effect<void>;
  /** Completes once every event from output the session already got is persisted. */
  readonly drain: Effect.Effect<void>;
  /** Read after the drain: the threads whose runs the next server takes over; none stops it. */
  readonly takenOverThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
}

export interface DetachAllForUpdateOptions {
  /** Undefined: no session uses the process, so it is stopped rather than detached. */
  readonly prepare?: (providerSessionId: string) => Effect.Effect<DetachPreparation | undefined>;
}

type ProbedDetachedHost =
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
  /**
   * Reattaches every host detached for an update, then ends hosts a crashed server left
   * running and forgets them.
   */
  readonly reattachAllDetachedForUpdate: () => Effect.Effect<ReadonlyArray<ReattachedDetachedHost>>;
  /**
   * Hands a host reattached at startup to the session that takes over its process. Its output
   * stays held until recovery has registered every turn on it and calls releaseOutput.
   */
  readonly takeAdoptable: (providerSessionId: string) => Effect.Effect<
    Option.Option<{
      readonly handle: DetachedStdioHandle;
      readonly childProcess: ChildProcessSpawner.ChildProcessHandle;
    }>
  >;
  readonly detachAllForUpdate: (
    options?: DetachAllForUpdateOptions,
  ) => Effect.Effect<ReadonlyArray<DetachedHostSummary>>;
  readonly isProviderSessionDetachedForUpdate: (
    providerSessionId: string,
  ) => Effect.Effect<boolean>;
  readonly isThreadDetachedForUpdate: (threadId: ThreadId) => Effect.Effect<boolean>;
  /**
   * Writes a line to the reader of the session's host after the output it already got, also while
   * output is held. False when no live host serves the session.
   */
  readonly injectOutputLine: (providerSessionId: string, line: string) => Effect.Effect<boolean>;
  /** Whether a live host runs the session's process, which a planned update can keep. */
  readonly hostsProviderSession: (providerSessionId: string) => Effect.Effect<boolean>;
  /** Ends the host's process, waits for it to exit, and forgets the host. */
  readonly terminate: (sessionHostId: string, signal?: NodeJS.Signals) => Effect.Effect<void>;
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
  const threadId = ThreadId.make(row.thread_id);
  let threadIds: ReadonlyArray<ThreadId> = [threadId];
  try {
    const parsed: unknown = JSON.parse(row.thread_ids_json);
    const listed = Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    if (listed.length > 0) threadIds = listed.map((id) => ThreadId.make(id));
  } catch {
    // An unreadable list leaves the spawning thread, whose run recovery then checks alone.
  }
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    providerThreadId: row.provider_thread_id,
    threadId,
    threadIds,
    driver: row.driver as SessionHostDriver,
    socketPath: row.socket_path,
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
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const runtime = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const hostEnv = yield* HostProcess.Environment;
  const agentScopeOption = yield* Effect.serviceOption(AgentScope);
  const processRunner = yield* ProcessRunner.ProcessRunner;

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
  const adoptableByProviderSession = new Map<string, DetachedStdioHandle>();
  const detachedThreads = new Set<ThreadId>();

  const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

  // Whoever holds a broker's token can drive the provider's stdio. SQLite is copied into backups
  // and diagnostics bundles, so the token lives in the secret store and the row only names it.
  const authTokenSecretName = (id: string) => `session-host-${id}`;

  const storeAuthToken = (id: string, authToken: string) =>
    secretStore.set(authTokenSecretName(id), new TextEncoder().encode(authToken)).pipe(
      Effect.mapError(
        (cause) =>
          new SessionHostError({
            detail: `Failed to store the auth token of session host ${id}: ${cause.message}`,
            cause,
          }),
      ),
    );

  const readAuthToken = (id: string) =>
    secretStore.get(authTokenSecretName(id)).pipe(
      Effect.mapError(
        (cause) =>
          new SessionHostError({
            detail: `Failed to read the auth token of session host ${id}: ${cause.message}`,
            cause,
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new SessionHostError({ detail: `Session host ${id} has no auth token.` })),
          onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
        }),
      ),
    );

  // Reads that feed a best-effort sweep keep going with nothing found, but never silently.
  const orEmptyLogged =
    (what: string) =>
    <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logError(`Failed to read ${what}`, cause).pipe(Effect.as([] as ReadonlyArray<A>)),
        ),
      );

  const removeAuthToken = (id: string) =>
    secretStore.remove(authTokenSecretName(id)).pipe(
      Effect.ignore({
        log: "Error",
        message: `Failed to remove the auth token of session host ${id}`,
      }),
    );

  const updateRowStatus = (id: string, status: SessionHostStatus) =>
    nowIso().pipe(
      Effect.flatMap(
        (updatedAt) => sql`
          UPDATE session_hosts
          SET status = ${status}, updated_at = ${updatedAt}
          WHERE id = ${id}
        `,
      ),
      Effect.asVoid,
      Effect.ignore({ log: "Error", message: `Failed to mark session host ${id} ${status}` }),
    );

  /** A host whose process ended or cannot be used is forgotten with the token that drives it. */
  const retireRow = (id: string) =>
    sql`DELETE FROM session_hosts WHERE id = ${id}`.pipe(
      Effect.asVoid,
      Effect.ignore({ log: "Error", message: `Failed to forget session host ${id}` }),
      Effect.andThen(removeAuthToken(id)),
    );

  // Sets the seq rather than raising it: the replay point can be older than the last flushed ack.
  const markDetachedForUpdate = (
    id: string,
    replayFromSeq: number,
    threadIds: ReadonlyArray<ThreadId>,
  ) =>
    nowIso().pipe(
      Effect.flatMap(
        (updatedAt) =>
          sql`
            UPDATE session_hosts
            SET status = 'detached_for_update',
                last_acked_seq = ${replayFromSeq},
                thread_ids_json = ${JSON.stringify(threadIds)},
                updated_at = ${updatedAt}
            WHERE id = ${id}
          `,
      ),
      Effect.asVoid,
      Effect.ignore({ log: "Error", message: `Failed to mark session host ${id} detached` }),
    );

  const clearTrackedHost = (tracked: ActiveTrackedHost) => {
    if (activeById.get(tracked.id) === tracked) {
      activeById.delete(tracked.id);
    }
    if (activeByProviderSession.get(tracked.providerSessionId) === tracked) {
      activeByProviderSession.delete(tracked.providerSessionId);
    }
    if (adoptableByProviderSession.get(tracked.providerSessionId) === tracked.handle) {
      adoptableByProviderSession.delete(tracked.providerSessionId);
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
      unit,
    };
    activeById.set(id, tracked);
    activeByProviderSession.set(providerSessionId, tracked);

    handle.events.on("error", (error: unknown) => {
      runFork(Effect.logError("A session host connection failed", { sessionHostId: id, error }));
    });
    handle.events.once("exit", () => {
      // Whoever cleared the host first (terminate, a failed reattach) already wrote its status.
      if (handle.detachingForUpdate || activeById.get(id) !== tracked) return;
      clearTrackedHost(tracked);
      runFork(retireRow(id));
      if (unit !== null && Option.isSome(agentScopeOption)) {
        runFork(agentScopeOption.value.stop(unit).pipe(Effect.ignore));
      }
    });

    return tracked;
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
    const startedAt = yield* readProcessStartedAt(pid).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.provideService(FileSystem.FileSystem, fs),
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
    if (record.brokerIdentity === null) {
      return { alive: false, reason: "missing_broker_identity" };
    }
    if (record.brokerIdentity === ENDED_IDENTITY) {
      return { alive: false, reason: "broker_ended" };
    }
    // The token goes only to the process that was given it: a pid that cannot be told apart
    // from a later holder counts as gone.
    const current = yield* identityOfBroker(record.brokerPid);
    const verdict = compareIdentity(record.brokerIdentity, current);
    if (verdict === "other") {
      return { alive: false, reason: "broker_pid_reused" };
    }
    if (verdict === "unknown") {
      return { alive: false, reason: "broker_identity_unknown" };
    }
    return { alive: true };
  });

  const launchDetachedBrokerProcess = Effect.fn("SessionHostService.launchDetachedBrokerProcess")(
    function* (
      configPath: string,
      input: SpawnSessionHostInput,
    ): Effect.fn.Return<
      { readonly unit: string | null; readonly pid: number | null },
      SessionHostError
    > {
      const { cwd } = input;
      const brokerArgs = [...(cliEntry ? [cliEntry] : []), "__session-host", configPath];
      const brokerEnv: Record<string, string> = {
        ...sanitizeEnv(hostEnv),
        ELECTRON_RUN_AS_NODE: "1",
      };

      if (!isWindows) {
        // The broker's scope is the provider process's only one: the child it starts stays in it.
        const scoped = Option.isSome(agentScopeOption)
          ? yield* agentScopeOption.value.wrap({
              command: runtime,
              args: brokerArgs,
              name: input.driver,
              threadId: input.threadId,
              env: brokerEnv,
              cwd,
              shared: true,
              survivesRestart: true,
            })
          : { command: runtime, args: brokerArgs, unit: undefined };

        const pid = yield* Effect.tryPromise({
          try: () =>
            new Promise<number | null>((resolve, reject) => {
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
                resolve(child.pid ?? null);
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

        return { unit: scoped.unit ?? null, pid };
      }

      // On Windows, prefer Win32_Process.Create so the broker lives outside any desktop Job Object.
      {
        const commandLine = [runtime, ...brokerArgs].map(quoteWindowsArg).join(" ");
        const envBase64 = Buffer.from(
          Object.entries(brokerEnv)
            .map(([key, value]) => `${key}=${value}`)
            .join("\0"),
          "utf8",
        ).toString("base64");
        const created = yield* processRunner
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
          return { unit: null, pid: null };
        }
      }

      const pid = yield* Effect.tryPromise({
        try: () =>
          new Promise<number | null>((resolve, reject) => {
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
              resolve(child.pid ?? null);
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
      return { unit: null, pid };
    },
  );

  /** Stops a broker no client got to attach to; it would otherwise wait out its orphan TTL. */
  const stopUnattachedBroker = (launched: {
    readonly unit: string | null;
    readonly pid: number | null;
  }) =>
    launched.unit !== null && Option.isSome(agentScopeOption)
      ? agentScopeOption.value.stop(launched.unit).pipe(Effect.ignore({ log: "Error" }))
      : Effect.sync(() => {
          if (launched.pid === null) return;
          try {
            // The broker ends its child on SIGTERM; it may already be gone.
            process.kill(launched.pid, "SIGTERM");
          } catch {
            // ESRCH: nothing left to stop.
          }
        });

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
            thread_ids_json,
            driver,
            socket_path,
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
            ${JSON.stringify([input.threadId])},
            ${input.driver},
            ${input.socketPath},
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
      shell: input.shell === true,
    };
    NodeFS.writeFileSync(configPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { id, authToken, socketPath, configPath, readyFilePath };
  };

  // Background writes end with the service, before the database it writes to closes.
  const runForkInService = yield* FiberSet.makeRuntime<never, void, never>();
  const runFork = <E>(effect: Effect.Effect<void, E>): Fiber.Fiber<void, never> =>
    runForkInService(effect.pipe(Effect.ignoreCause));

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

    yield* storeAuthToken(id, authToken).pipe(
      Effect.tapError(() => Effect.sync(() => safeUnlinkSync(configPath))),
    );
    const launched = yield* launchDetachedBrokerProcess(configPath, input).pipe(
      Effect.tapError(() =>
        Effect.sync(() => safeUnlinkSync(configPath)).pipe(Effect.andThen(removeAuthToken(id))),
      ),
    );
    const { unit } = launched;

    const handle = DetachedStdioHandle.createPending({
      sessionHostId: id,
      socketPath,
      authToken,
      initialAfterSeq: 0,
      ...(input.onStderr !== undefined ? { onStderr: input.onStderr } : {}),
    });
    const tracked = trackHandle(
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
          clearTrackedHost(tracked);
          safeUnlinkSync(configPath);
          safeUnlinkSync(readyFilePath);
        }).pipe(
          Effect.andThen(stopUnattachedBroker(launched)),
          Effect.andThen(removeAuthToken(id)),
        ),
      ),
    );

    // Upgrade a missing or fallback window identity (Windows, or a failed broker ps read)
    // to the exact OS creation time read by the server, provided it agrees with the broker's window.
    let brokerIdentity = attached.brokerIdentity;
    if (
      attached.brokerPid > 0 &&
      (brokerIdentity === null || brokerIdentity.startsWith("window:"))
    ) {
      const observed = yield* identityOfBroker(attached.brokerPid);
      if (
        observed !== undefined &&
        (brokerIdentity === null || compareIdentity(brokerIdentity, observed) === "same")
      ) {
        brokerIdentity = observed;
      }
    }

    yield* insertHostRow({
      id,
      providerSessionId: input.providerSessionId,
      providerThreadId: input.providerThreadId ?? null,
      threadId: input.threadId,
      driver: input.driver,
      socketPath,
      brokerPid: attached.brokerPid,
      brokerIdentity,
      childPid: attached.childPid,
      status: "running",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionHostError({
            detail: `Failed to persist detached session host ${id}: ${String(cause)}`,
            cause,
          }),
      ),
      // A host with no row is one no later server can find, so it must not outlive this one.
      Effect.tapError(() => terminate(id)),
    );

    return handle;
  });

  const takeAdoptable: SessionHostServiceShape["takeAdoptable"] = (providerSessionId) =>
    Effect.sync(() => {
      const handle = adoptableByProviderSession.get(providerSessionId);
      adoptableByProviderSession.delete(providerSessionId);
      return handle === undefined || activeById.get(handle.sessionHostId) === undefined
        ? Option.none()
        : Option.some({ handle, childProcess: handle.asChildProcessHandle() });
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

  const listHostsWithStatus = Effect.fn("SessionHostService.listHostsWithStatus")(function* (
    status: SessionHostStatus,
  ) {
    const rows = yield* sql<SessionHostRow>`
      SELECT
        id,
        provider_session_id,
        provider_thread_id,
        thread_id,
        thread_ids_json,
        driver,
        socket_path,
        broker_pid,
        broker_identity_json,
        child_pid,
        last_acked_seq,
        status,
        created_at,
        updated_at
      FROM session_hosts
      WHERE status = ${status}
      ORDER BY created_at ASC
      LIMIT ${MAX_HOST_ROWS}
    `.pipe(orEmptyLogged(`${status} session hosts`));
    return rows.map(rowToRecord);
  });

  const probeDetachedForUpdate = Effect.fn("SessionHostService.probeDetachedForUpdate")(
    function* () {
      const records = yield* listHostsWithStatus("detached_for_update");
      const results: Array<ProbedDetachedHost> = [];
      for (const record of records) {
        const verdict = yield* verifyBrokerIdentity(record);
        if (!verdict.alive) {
          yield* retireRow(record.id);
          results.push({ status: "dead", record, reason: verdict.reason });
        } else {
          results.push({ status: "alive", record });
        }
      }
      return results;
    },
  );

  const readHostRecord = (sessionHostId: string) =>
    sql<SessionHostRow>`
      SELECT
        id,
        provider_session_id,
        provider_thread_id,
        thread_id,
        thread_ids_json,
        driver,
        socket_path,
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
      Effect.map((rows) => (rows[0] === undefined ? undefined : rowToRecord(rows[0]))),
      Effect.mapError(
        (cause) =>
          new SessionHostError({
            detail: `Failed to read session host ${sessionHostId}: ${String(cause)}`,
            cause,
          }),
      ),
    );

  // The attach message carries the auth token, so it never goes to a socket another user could
  // have planted.
  const ensurePrivateSocket = (record: SessionHostRecord) =>
    isWindows
      ? Effect.void
      : Effect.try({
          try: () => ensurePrivateSocketDirectory(NodePath.dirname(record.socketPath)),
          catch: (cause) =>
            new SessionHostError({
              detail: `Refusing to connect to session host ${record.id}: ${String(cause)}`,
              cause,
            }),
        });

  const reattach: SessionHostServiceShape["reattach"] = Effect.fn("SessionHostService.reattach")(
    function* (sessionHostId: string) {
      const record = yield* readHostRecord(sessionHostId);
      if (record === undefined) {
        return yield* new SessionHostError({
          detail: `Session host ${sessionHostId} not found.`,
        });
      }
      const verdict = yield* verifyBrokerIdentity(record);
      if (!verdict.alive) {
        yield* retireRow(record.id);
        return yield* new SessionHostError({
          detail: `Session host ${sessionHostId} is no longer alive (${verdict.reason}).`,
        });
      }

      yield* ensurePrivateSocket(record).pipe(Effect.tapError(() => retireRow(record.id)));
      const authToken = yield* readAuthToken(record.id).pipe(
        Effect.tapError(() => retireRow(record.id)),
      );

      const handle = DetachedStdioHandle.createPending({
        sessionHostId: record.id,
        socketPath: record.socketPath,
        authToken,
        initialAfterSeq: record.lastAckedSeq,
        // The replay must wait for the session that takes the process over: run now, its
        // notifications would find no turn to belong to.
        holdOutput: true,
      });
      const tracked = trackHandle(
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
          Effect.sync(() => clearTrackedHost(tracked)).pipe(Effect.andThen(retireRow(record.id))),
        ),
      );

      // A frame the old server never consumed that the ring buffer already dropped is lost
      // output; adopting the process anyway would leave the run waiting on it forever.
      const missedFrames = attachedInfo.oldestSeq - (record.lastAckedSeq + 1);
      if (missedFrames > 0) {
        yield* terminate(record.id);
        return yield* new SessionHostError({
          detail: `Session host ${record.id} dropped ${missedFrames} unread output frames while detached.`,
        });
      }

      yield* updateRowStatus(record.id, "running");
      adoptableByProviderSession.set(record.providerSessionId, handle);

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
      // A host still marked running was left by a server that stopped without detaching it; its
      // broker ends its child once that server's socket closes, and no session will take it.
      const leftovers = yield* listHostsWithStatus("running");
      for (const record of leftovers) {
        if (!activeById.has(record.id)) {
          yield* terminate(record.id);
        }
      }
      return results;
    });

  const detachOneForUpdate = Effect.fn("SessionHostService.detachOneForUpdate")(function* (
    tracked: ActiveTrackedHost,
    prepare: DetachAllForUpdateOptions["prepare"],
  ): Effect.fn.Return<DetachedHostSummary | undefined> {
    if (tracked.handle.exited) {
      clearTrackedHost(tracked);
      yield* retireRow(tracked.id);
      return undefined;
    }
    const stop = (reason: string) =>
      Effect.logWarning("A session host is stopped instead of detached for the update", {
        sessionHostId: tracked.id,
        reason,
      }).pipe(Effect.andThen(terminate(tracked.id)), Effect.as(undefined));
    // The broker keeps its child only for a detach it got while attached.
    if (tracked.handle.info === null) return yield* stop("not_attached");
    const preparation: DetachPreparation | undefined =
      prepare === undefined
        ? {
            deliver: Effect.void,
            drain: Effect.void,
            takenOverThreads: Effect.succeed([tracked.threadId]),
          }
        : yield* prepare(tracked.providerSessionId);
    if (preparation === undefined) return yield* stop("no_session");
    const within = (step: Effect.Effect<void>, timeout: Duration.Duration, failure: string) =>
      step.pipe(
        Effect.timeoutOption(timeout),
        Effect.map(Option.isSome),
        Effect.catchCause((cause) => Effect.logError(failure, cause).pipe(Effect.as(false))),
      );
    if (
      !(yield* within(
        preparation.deliver,
        DETACH_DELIVER_TIMEOUT,
        "What was queued for a session host could not be delivered",
      ))
    ) {
      return yield* stop("delivery_incomplete");
    }
    // Output the session got before this point must be persisted; the next server replays the rest.
    const replayFromSeq = tracked.handle.holdForDetach();
    if (
      !(yield* within(
        preparation.drain,
        DETACH_DRAIN_TIMEOUT,
        "A session host's output could not be drained",
      ))
    ) {
      return yield* stop("drain_incomplete");
    }
    const threadIds = yield* preparation.takenOverThreads.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Could not tell which runs a session host keeps", cause).pipe(
          Effect.as([]),
        ),
      ),
    );
    if (threadIds.length === 0) return yield* stop("not_adoptable");
    for (const threadId of threadIds) detachedThreads.add(threadId);
    detachedProviderSessions.add(tracked.providerSessionId);
    tracked.handle.markDetachingForUpdate();
    yield* Effect.promise(() => tracked.handle.detach());
    clearTrackedHost(tracked);
    yield* markDetachedForUpdate(tracked.id, replayFromSeq, threadIds);
    return {
      id: tracked.id,
      providerSessionId: tracked.providerSessionId,
      threadIds,
      driver: tracked.driver,
      lastAckedSeq: replayFromSeq,
    };
  });

  const detachAllForUpdate: SessionHostServiceShape["detachAllForUpdate"] = Effect.fn(
    "SessionHostService.detachAllForUpdate",
  )(function* (options?: DetachAllForUpdateOptions) {
    const summaries = yield* Effect.forEach(
      [...activeById.values()],
      (tracked) => detachOneForUpdate(tracked, options?.prepare),
      { concurrency: "unbounded" },
    );
    return summaries.filter((summary) => summary !== undefined);
  });

  const isProviderSessionDetachedForUpdate: SessionHostServiceShape["isProviderSessionDetachedForUpdate"] =
    (providerSessionId) => Effect.sync(() => detachedProviderSessions.has(providerSessionId));

  const isThreadDetachedForUpdate: SessionHostServiceShape["isThreadDetachedForUpdate"] = (
    threadId,
  ) => Effect.sync(() => detachedThreads.has(threadId));

  const injectOutputLine: SessionHostServiceShape["injectOutputLine"] = (providerSessionId, line) =>
    Effect.sync(() => {
      const tracked = activeByProviderSession.get(providerSessionId);
      return tracked !== undefined && tracked.handle.injectStdoutLine(line);
    });

  const hostsProviderSession: SessionHostServiceShape["hostsProviderSession"] = (
    providerSessionId,
  ) => Effect.sync(() => activeByProviderSession.has(providerSessionId));

  const awaitExitLogged = (handle: DetachedStdioHandle, sessionHostId: string) =>
    Effect.promise(() => handle.waitForExit()).pipe(
      Effect.timeoutOption(TERMINATE_EXIT_WAIT),
      Effect.flatMap((exited) =>
        Option.isSome(exited)
          ? Effect.void
          : Effect.logError("A session host did not confirm its process ended", {
              sessionHostId,
              waitedMs: Duration.toMillis(TERMINATE_EXIT_WAIT),
            }),
      ),
    );

  const terminate: SessionHostServiceShape["terminate"] = Effect.fn("SessionHostService.terminate")(
    function* (sessionHostId: string, signal?: NodeJS.Signals) {
      const tracked = activeById.get(sessionHostId);
      if (tracked !== undefined) {
        clearTrackedHost(tracked);
        yield* Effect.promise(() => tracked.handle.terminate(signal));
        // A caller that starts a replacement must not find the old process still running.
        if (!tracked.handle.detachingForUpdate) {
          yield* awaitExitLogged(tracked.handle, sessionHostId);
        }
        yield* retireRow(sessionHostId);
        if (tracked.unit !== null && Option.isSome(agentScopeOption)) {
          yield* agentScopeOption.value.stop(tracked.unit).pipe(Effect.ignore);
        }
        return;
      }

      // Not attached here: connect briefly and stop it if it still runs.
      const record = yield* readHostRecord(sessionHostId).pipe(
        Effect.catch((cause) =>
          Effect.logError(`Failed to read session host ${sessionHostId}`, cause).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (record === undefined) return;
      const verdict = yield* verifyBrokerIdentity(record);
      if (verdict.alive) {
        yield* Effect.gen(function* () {
          yield* ensurePrivateSocket(record);
          const authToken = yield* readAuthToken(record.id);
          const handle = yield* Effect.tryPromise({
            try: () =>
              DetachedStdioHandle.connect({
                sessionHostId: record.id,
                socketPath: record.socketPath,
                authToken,
                initialAfterSeq: record.lastAckedSeq,
              }),
            catch: (cause) =>
              new SessionHostError({
                detail: `Failed to connect to session host ${record.id}: ${String(cause)}`,
                cause,
              }),
          });
          yield* Effect.promise(() => handle.terminate(signal));
          yield* awaitExitLogged(handle, record.id);
        }).pipe(
          Effect.ignore({ log: "Error", message: `Failed to terminate session host ${record.id}` }),
        );
      }
      yield* retireRow(sessionHostId);
    },
  );

  return {
    spawn,
    spawnChildProcessHandle,
    reattach,
    reattachAllDetachedForUpdate,
    takeAdoptable,
    detachAllForUpdate,
    isProviderSessionDetachedForUpdate,
    isThreadDetachedForUpdate,
    injectOutputLine,
    hostsProviderSession,
    terminate,
  } satisfies SessionHostServiceShape;
});

export const layer = Layer.effect(SessionHostService, make);
