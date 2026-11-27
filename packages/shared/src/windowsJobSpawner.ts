import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { timeoutAwakeOrElse } from "./AwakeTime.ts";
import * as HostProcess from "./HostProcess.ts";
import {
  attachWindowsJob,
  parseWindowsProcessIdentity,
  WindowsJobHost,
  windowsHostSpawnError,
  windowsJobName,
  type WindowsJob,
} from "./windowsJob.ts";

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];
const owned = new WeakSet<Spawner>();

/** Awake time a job host has to create its job and report the suspended child. */
export const WINDOWS_JOB_START_TIMEOUT_SECONDS = 30;

/** Why a launch failed whose job host did not report its child within that time. */
export const WINDOWS_JOB_START_TIMEOUT_MESSAGE = `The Windows job host did not start the command within ${WINDOWS_JOB_START_TIMEOUT_SECONDS} s of awake time and was stopped.`;

/** Native spawners retain the same ownership protocol without another enclosing job. */
export const markWindowsJobSpawner = (spawner: Spawner): Spawner => {
  owned.add(spawner);
  return spawner;
};

/** Each job's control descriptors outlive startup and stay outside the process family. */
export const owningWindowsJobs = (spawner: Spawner, platform: NodeJS.Platform): Spawner => {
  if (platform !== "win32" || owned.has(spawner)) return spawner;
  return markWindowsJobSpawner(
    ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        if (command._tag !== "StandardCommand")
          return yield* PlatformError.badArgument({
            module: "ChildProcess",
            method: "spawn",
            description: "Spawn each pipeline stage in its own Windows job.",
          });
        const failed = (description: string, tag: PlatformError.SystemErrorTag = "Unknown") =>
          PlatformError.systemError({
            _tag: tag,
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: command.command,
            description,
          });
        const host = yield* (yield* WindowsJobHost).pipe(
          Effect.mapError((error) => failed(error.message)),
        );
        const nonce = yield* Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4()).pipe(
          Effect.provide(NodeCrypto.layer),
        );
        const job: WindowsJob = { host, name: windowsJobName(nonce) };
        const fd =
          Math.max(
            2,
            ...Object.keys(command.options.additionalFds ?? {}).map((key) => Number(key.slice(2))),
          ) + 1;
        const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const started = yield* Deferred.make<
          NonNullable<WindowsJob["child"]>,
          PlatformError.PlatformError
        >();
        const references: Array<Deferred.Deferred<void, PlatformError.PlatformError>> = [];
        const env = yield* HostProcess.Environment;
        let target = command.command;
        let args = command.args;
        let raw = false;
        if (command.options.shell) {
          target =
            typeof command.options.shell === "string"
              ? command.options.shell
              : (env.ComSpec ?? env.COMSPEC ?? "cmd.exe");
          const content = [command.command, ...command.args].join(" ");
          raw = /cmd(?:\.exe)?$/i.test(target);
          args = raw ? ["/d", "/s", "/c", `"${content}"`] : ["-c", content];
        }
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              host,
              [raw ? "owned-raw" : "owned", job.name, String(fd), target, ...args],
              {
                ...command.options,
                shell: false,
                additionalFds: {
                  ...command.options.additionalFds,
                  [`fd${fd}`]: { type: "input", stream: Stream.fromQueue(input) },
                  [`fd${fd + 1}`]: { type: "output" },
                },
              },
            ),
          )
          .pipe(
            Effect.mapError((error) => {
              if (error.reason._tag === "BadArgument") return error;
              const diagnostic = windowsHostSpawnError(host, error.reason.cause ?? error);
              return PlatformError.systemError({
                ...error.reason,
                pathOrDescriptor: host,
                description: diagnostic.message,
                cause: diagnostic,
              });
            }),
          );
        const failPending = (error: PlatformError.PlatformError) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(started, Effect.fail(error));
            for (const pending of references.splice(0))
              Deferred.doneUnsafe(pending, Effect.fail(error));
          });
        let closed = false;
        let referenced = true;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true;
            if (!referenced) return;
            yield* Queue.end(input);
            yield* child.exitCode.pipe(Effect.ignore({ log: "Error" }));
          }),
        );
        yield* child.getOutputFd(fd + 1).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              if (line === "W") {
                yield* Queue.offer(input, new Uint8Array([82]));
                return;
              }
              if (line === "R" || line === "U") {
                const pending = references.shift();
                if (pending !== undefined) yield* Deferred.succeed(pending, undefined);
                return;
              }
              const [kind, value, detail] = line.split(" ");
              const identity = parseWindowsProcessIdentity(detail);
              if (
                kind === "S" &&
                Number.isSafeInteger(Number(value)) &&
                Number(value) > 0 &&
                identity !== undefined
              ) {
                job.child = { pid: Number(value), created: identity };
                yield* Deferred.succeed(started, job.child);
              } else if (kind === "E") {
                return yield* failed(
                  Buffer.from(detail ?? "", "base64").toString(),
                  value === "2" || value === "3"
                    ? "NotFound"
                    : value === "5"
                      ? "PermissionDenied"
                      : "Unknown",
                );
              } else return yield* failed("Invalid Windows ownership reply.");
            }),
          ),
          Effect.catch(failPending),
          Effect.ensuring(failPending(failed("The Windows ownership channel closed."))),
          Effect.forkScoped,
        );
        // Ending the host closes its job, whose kill-on-close limit ends a child it already made.
        const identity = yield* Deferred.await(started).pipe(
          timeoutAwakeOrElse({
            duration: `${WINDOWS_JOB_START_TIMEOUT_SECONDS} seconds`,
            orElse: () =>
              child
                .kill()
                .pipe(
                  Effect.ignore({ log: "Error" }),
                  Effect.andThen(
                    Effect.fail(failed(WINDOWS_JOB_START_TIMEOUT_MESSAGE, "TimedOut")),
                  ),
                ),
          }),
        );
        const reference = Effect.fn("WindowsJobSpawner.reference")(function* (referenced: boolean) {
          if (!(yield* child.isRunning)) return;
          if (closed) return yield* failed("The Windows ownership scope is closed.", "BadResource");
          const acknowledged = yield* Deferred.make<void, PlatformError.PlatformError>();
          references.push(acknowledged);
          yield* Queue.offer(input, new Uint8Array([referenced ? 82 : 85]));
          yield* Deferred.await(acknowledged);
        });
        const handle = ChildProcessSpawner.makeHandle({
          ...child,
          pid: ChildProcessSpawner.ProcessId(identity.pid),
          kill: () =>
            Effect.scoped(
              Effect.gen(function* () {
                const stop = yield* spawner.spawn(
                  ChildProcess.make(
                    job.host,
                    ["stop", job.name, String(identity.pid), String(identity.created)],
                    { stdin: "ignore" },
                  ),
                );
                const [code, stderr] = yield* Effect.all(
                  [stop.exitCode, stop.stderr.pipe(Stream.decodeText(), Stream.mkString)],
                  { concurrency: "unbounded" },
                );
                if (code !== 0)
                  return yield* failed(`Could not stop Windows job: ${stderr.trim()}`);
                yield* child.exitCode;
              }),
            ),
          unref: Effect.gen(function* () {
            yield* reference(false);
            const reref = yield* child.unref;
            referenced = false;
            return Effect.gen(function* () {
              yield* reference(true);
              yield* reref;
              referenced = true;
            });
          }),
        });
        attachWindowsJob(handle, job);
        return handle;
      }),
    ),
  );
};
