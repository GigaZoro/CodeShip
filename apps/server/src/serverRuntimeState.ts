import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  WindowsJobHost,
  parseWindowsProcessIdentity,
  windowsCreationTimeMillis,
} from "@t3tools/shared/windowsJob";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import * as ProcessRunner from "./processRunner.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  privateNetworkOnly: Schema.optional(Schema.Boolean),
  port: Schema.Int,
  origin: Schema.String,
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
  // The managed policy this server loaded at startup, null for none; absent from older servers.
  managedPolicy: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.String,
        organization: Schema.String,
        fingerprint: Schema.String,
      }),
    ),
  ),
  // Whether this server checks for and installs its own updates (runsAutomaticUpdates); absent from
  // older servers.
  automaticUpdates: Schema.optional(Schema.Boolean),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedError<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<
    ServerConfig.ServerConfig["Service"],
    "host" | "privateNetworkOnly" | "devUrl"
  >;
  readonly port: number;
  readonly serviceManaged?: boolean;
  readonly managedPolicy?: PersistedServerRuntimeState["managedPolicy"];
  readonly automaticUpdates?: boolean;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    ...(input.config.privateNetworkOnly ? { privateNetworkOnly: true } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
    ...(input.serviceManaged ? { serviceManaged: true } : {}),
    serverVersion: packageJson.version,
    ...(input.managedPolicy === undefined ? {} : { managedPolicy: input.managedPolicy }),
    ...(input.automaticUpdates === undefined ? {} : { automaticUpdates: input.automaticUpdates }),
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.clearPersistedServerRuntimeState",
)(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "clear",
          statePath: path,
          cause,
        }),
    ),
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
        ),
    }),
  );
});

/** What the job host's `identity` prints for a live process; nothing when it cannot tell. */
const runIdentityProbe = Effect.fn("serverRuntimeState.runIdentityProbe")(function* (
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = yield* (yield* WindowsJobHost).pipe(Effect.option);
  if (Option.isNone(host)) return undefined;
  const result = yield* runner
    .run({ command: host.value, args: ["identity", ...args], timeout, maxOutputBytes: 16_384 })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  return result.value.stdout.trim();
});

export const readWindowsProcessIdentity = Effect.fn(
  "serverRuntimeState.readWindowsProcessIdentity",
)(function* (pid: number, timeout: Duration.Input = Duration.seconds(2)) {
  return parseWindowsProcessIdentity(yield* runIdentityProbe([String(pid)], timeout));
});

/**
 * A live process's full FILETIME and whether its command line contains `text`, read through one
 * handle, so a pid that passes to another process between the two cannot mix them.
 */
export const readWindowsProcessNaming = Effect.fn("serverRuntimeState.readWindowsProcessNaming")(
  function* (pid: number, text: string, timeout: Duration.Input = Duration.seconds(2)) {
    const [created, verdict] =
      (yield* runIdentityProbe([String(pid), text], timeout))?.split(" ") ?? [];
    const createdAt = parseWindowsProcessIdentity(created);
    return createdAt === undefined || (verdict !== "named" && verdict !== "other")
      ? undefined
      : { createdAt, named: verdict === "named" };
  },
);

/** Linux counts a process's start in USER_HZ ticks since boot, 100 a second wherever Node runs. */
const LINUX_TICKS_PER_SECOND = 100;

/** From /proc, as ps would read it, so a host without procps still tells processes apart. */
const readLinuxProcessStartedAt = Effect.fn("serverRuntimeState.readLinuxProcessStartedAt")(
  function* (pid: number) {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* Effect.all([
      fs.readFileString(`/proc/${pid}/stat`),
      fs.readFileString("/proc/stat"),
    ]).pipe(
      Effect.match({
        onSuccess: (value) => ({ _tag: "ok" as const, value }),
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? { _tag: "not-found" as const }
            : { _tag: "error" as const },
      }),
    );
    if (files._tag !== "ok") return files._tag;
    const [stat, system] = files.value;
    // The command name can hold spaces and parentheses; starttime is the 20th field after it.
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const bootedAt = /^btime (\d+)$/mu.exec(system)?.[1];
    if (ticks === undefined || !/^\d+$/u.test(ticks) || bootedAt === undefined)
      return "error" as const;
    return Number(bootedAt) * 1_000 + (Number(ticks) * 1_000) / LINUX_TICKS_PER_SECOND;
  },
);

/** Millisecond timestamps support runtime diagnostics; Windows stop ownership uses full FILETIME. */
export const readProcessStartedAt = Effect.fn("serverRuntimeState.readProcessStartedAt")(function* (
  pid: number,
  timeout: Duration.Input = Duration.seconds(2),
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    const identity = yield* readWindowsProcessIdentity(pid, timeout);
    return identity === undefined ? undefined : windowsCreationTimeMillis(identity);
  }
  if (platform === "linux") {
    const startedAt = yield* readLinuxProcessStartedAt(pid);
    if (typeof startedAt === "number") return startedAt;
    if (startedAt === "error") return undefined;
  }
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: "ps",
      args: ["-p", String(pid), "-o", "lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout,
      maxOutputBytes: 16_384,
    })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  const startedAt = Date.parse(`${result.value.stdout.trim()} UTC`);
  return Number.isFinite(startedAt) ? startedAt : undefined;
});

export const readPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.readPersistedServerRuntimeState",
)(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  },
  Effect.catchTags({
    ServerRuntimeStateError: (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({
          operation: error.operation,
          statePath: error.statePath,
          cause: error,
        }),
        Effect.as(Option.none<PersistedServerRuntimeState>()),
      ),
  }),
);
