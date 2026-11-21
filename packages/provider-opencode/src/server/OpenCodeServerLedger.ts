import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  type FifoHold,
  signalProcessGroup,
  stopFifoHolderGroup,
} from "@t3tools/shared/processGroup";
import { isProcessAlive } from "@t3tools/shared/processProbe";

const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
type ProcessIdentity = typeof ProcessIdentity.Type;

const OpenCodeServerEntry = Schema.Struct({
  version: Schema.Literal(1),
  pgid: Schema.Int,
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  port: Schema.Int,
  stateDir: Schema.String,
  owner: ProcessIdentity,
  /** The FIFO of the holder that keeps `pgid` the server's, from `holderFifo`. */
  holder: Schema.optionalKey(Schema.String),
});
type OpenCodeServerEntry = typeof OpenCodeServerEntry.Type;
const OpenCodeServerEntryJson = Schema.fromJsonString(OpenCodeServerEntry);
const decodeEntry = Schema.decodeUnknownOption(OpenCodeServerEntryJson);
const encodeEntry = Schema.encodeEffect(OpenCodeServerEntryJson);

/**
 * Written before a held server spawns, so its group can be stopped before it is recorded, and the
 * launch's claim: without it, the launch exits before the server runs. Its holder's FIFO has the
 * same name with `HOLDER_SUFFIX`.
 */
const OpenCodeServerLaunch = Schema.Struct({
  version: Schema.Literal(1),
  stateDir: Schema.String,
  owner: ProcessIdentity,
});
const OpenCodeServerLaunchJson = Schema.fromJsonString(OpenCodeServerLaunch);
const decodeLaunch = Schema.decodeUnknownOption(OpenCodeServerLaunchJson);
const encodeLaunch = Schema.encodeEffect(OpenCodeServerLaunchJson);

export class OpenCodeServerLedger extends Context.Service<
  OpenCodeServerLedger,
  {
    /**
     * A hold for `HoldThroughFifo`, removed when the scope closes, so that a later server can stop
     * the group if this one crashes, also before `track` recorded it.
     */
    readonly holderFifo: Effect.Effect<FifoHold | undefined, never, Scope.Scope>;
    readonly track: (server: {
      readonly pid: number;
      readonly port: number;
      readonly args: ReadonlyArray<string>;
      readonly holder: string | undefined;
    }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeServerLedger") {}

const ENTRY_DIRECTORY = "opencode-servers";
const ENTRY_FILE = /^\d+\.json$/;
const HOLDER_SUFFIX = ".hold";
const LAUNCH_SUFFIX = ".launch.json";
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// ps lstart needs C locale and UTC for stable parsing.
const DARWIN_PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const parseDarwinPs = (output: string): ReadonlyArray<ObservedProcess> =>
  output.split("\n").flatMap((line) => {
    const match = DARWIN_PS_LINE.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        zombie: match[3]!.startsWith("Z"),
        startTime: match[4]!,
        command: match[5]!.trimEnd(),
      },
    ];
  });

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    // oxlint-disable-next-line t3code/no-raw-process-group-signal -- callers first prove the number is the server's: its holder or recorded members
    signalProcessGroup(pgid, signal);
  } catch {}
};

const groupExists = (pgid: number) => {
  try {
    // oxlint-disable-next-line t3code/no-raw-process-group-signal -- a probe, which delivers nothing
    signalProcessGroup(pgid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

export const make = Effect.fn("OpenCodeServerLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(input.stateDir, ENTRY_DIRECTORY);
  const recordable = platform === "linux" || platform === "darwin";

  // A process-group scan calls this for every /proc entry; avoid a span per process.
  const observeLinux = Effect.fnUntraced(function* (pid: number, group?: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(pgid) || startTime === undefined) return undefined;
    if (group !== undefined && pgid !== group) return undefined;
    const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
    return {
      pid,
      pgid,
      startTime,
      command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
      zombie: fields[0] === "Z",
    } satisfies ObservedProcess;
  });

  const psDarwin = (selection: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(
          "/bin/ps",
          ["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", ...selection],
          {
            env: { LC_ALL: "C", TZ: "UTC" },
            extendEnv: true,
            stdin: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(Effect.timeout("5 seconds"), Effect.map(parseDarwinPs));

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin") {
      return psDarwin(["-p", String(pid)]).pipe(
        Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - Missing process observations are undefined, not void.
    return Effect.succeed(undefined);
  };

  const observeAll = (
    pids: ReadonlyArray<number>,
  ): Effect.Effect<ReadonlyArray<ObservedProcess | undefined>> =>
    platform === "darwin"
      ? psDarwin(["-p", pids.join(",")]).pipe(
          Effect.map((found) =>
            pids.map((pid) => found.find((candidate) => candidate.pid === pid)),
          ),
          Effect.orElseSucceed(() => []),
        )
      : Effect.forEach(pids, observe);

  const observeGroup = (pgid: number): Effect.Effect<ReadonlyArray<ObservedProcess>> => {
    if (platform === "linux") {
      return fs.readDirectory("/proc").pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names.filter((name) => /^\d+$/.test(name)),
            (name) => observeLinux(Number(name), pgid).pipe(Effect.orElseSucceed(() => undefined)),
            { concurrency: 16 },
          ),
        ),
        Effect.map((found) => found.filter((candidate) => candidate !== undefined)),
        Effect.orElseSucceed(() => []),
      );
    }
    if (platform === "darwin") {
      return psDarwin(["-A"]).pipe(
        Effect.map((found) => found.filter((candidate) => candidate.pgid === pgid)),
        Effect.orElseSucceed(() => []),
      );
    }
    return Effect.succeed([]);
  };

  // A lookup that fails, such as a `ps` that timed out, counts the process as running unless the
  // kernel says it is gone, so a live server's groups wait for a later look.
  const isRunning = (identity: ProcessIdentity) =>
    observe(identity.pid).pipe(
      Effect.map((observed) =>
        observed === undefined
          ? isProcessAlive(identity.pid)
          : !observed.zombie && observed.startTime === identity.startTime,
      ),
    );

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const removeHolder = (holder: string | undefined) =>
    holder === undefined ? Effect.void : fs.remove(holder, { force: true });

  // A launch opens its FIFO before it checks its claim, so once the claim is gone a holder that
  // does not answer never will, and the launch exits before its server runs.
  const stopHeld = (holder: string) =>
    fs
      .remove(`${holder.slice(0, -HOLDER_SUFFIX.length)}${LAUNCH_SUFFIX}`, { force: true })
      .pipe(Effect.map(() => stopFifoHolderGroup(holder)));

  // Without an owner to record, a FIFO no later server could tell from a live one's goes unheld.
  const holderFifo: OpenCodeServerLedger["Service"]["holderFifo"] =
    recordable && owner !== undefined
      ? Effect.acquireRelease(
          Effect.gen(function* () {
            yield* fs.makeDirectory(directory, { recursive: true });
            const id = path.join(directory, yield* crypto.randomUUIDv4());
            yield* writeFileStringAtomically({
              filePath: `${id}${LAUNCH_SUFFIX}`,
              contents: yield* encodeLaunch({ version: 1, stateDir: input.stateDir, owner }),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            return id;
          }),
          (id) =>
            removeHolder(`${id}${HOLDER_SUFFIX}`).pipe(
              Effect.andThen(fs.remove(`${id}${LAUNCH_SUFFIX}`, { force: true })),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not remove an OpenCode server's holder FIFO", { cause }),
              ),
            ),
        ).pipe(
          Effect.map((id) => ({ fifo: `${id}${HOLDER_SUFFIX}`, claim: `${id}${LAUNCH_SUFFIX}` })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not prepare to hold an OpenCode server's process group", {
              cause,
            }).pipe(Effect.as(undefined)),
          ),
        )
      : Effect.undefined;

  const track: OpenCodeServerLedger["Service"]["track"] = Effect.fn("OpenCodeServerLedger.track")(
    function* (server) {
      if (!recordable) return Effect.void;
      const pgid = server.pid;
      // Any live member identifies a leaderless group; pgid cannot be reused while members remain.
      const leader = yield* observe(pgid);
      const members =
        leader !== undefined && !leader.zombie && leader.pgid === pgid
          ? [leader]
          : (yield* observeGroup(pgid)).filter((candidate) => !candidate.zombie);
      const member =
        members.find((candidate) => candidate.command.endsWith(` ${server.args.join(" ")}`)) ??
        members[0];
      if (owner === undefined || member === undefined) {
        if (groupExists(pgid)) {
          yield* Effect.logWarning(
            "Could not record an OpenCode server; it will keep running if this server crashes",
            { pid: pgid, port: server.port },
          );
        }
        return Effect.void;
      }
      const entryPath = path.join(directory, `${pgid}.json`);
      const entry: OpenCodeServerEntry = {
        version: 1,
        pgid,
        pid: member.pid,
        startTime: member.startTime,
        command: member.command,
        port: server.port,
        stateDir: input.stateDir,
        owner,
        ...(server.holder === undefined ? {} : { holder: server.holder }),
      };
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry(entry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return fs
        .remove(entryPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a stopped OpenCode server", { cause }),
          ),
        );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record an OpenCode server process", { cause }).pipe(
        Effect.as(Effect.void),
      ),
    ),
  );

  // A holder that keeps the number stops the group itself, so no signal of this server can reach
  // a group that took the number. Otherwise only a recorded member with the same pid, start time,
  // group, and full command line proves the group is still the one recorded.
  const stopOrphan = Effect.fn("OpenCodeServerLedger.stopOrphan")(function* (
    entry: OpenCodeServerEntry,
  ) {
    if (entry.holder !== undefined && (yield* stopHeld(entry.holder))) {
      return yield* Effect.logInfo(
        "Stopping an OpenCode server left by a previous T3.CodeShip server",
        { pid: entry.pgid, port: entry.port },
      );
    }
    const observed = yield* observe(entry.pid);
    if (
      observed === undefined ||
      observed.zombie ||
      observed.startTime !== entry.startTime ||
      observed.pgid !== entry.pgid ||
      observed.command !== entry.command
    ) {
      return;
    }
    yield* Effect.logInfo("Stopping an OpenCode server left by a previous T3.CodeShip server", {
      pid: entry.pgid,
      port: entry.port,
    });
    let members: ReadonlyArray<ObservedProcess> = [
      observed,
      ...(yield* observeGroup(entry.pgid)).filter(
        (member) => !member.zombie && member.pid !== observed.pid,
      ),
    ];
    signalGroup(entry.pgid, "SIGTERM");
    // Only these members prove the group is still the one recorded: once it empties, an
    // unrelated group can take its number, which `kill(-pgid, 0)` would count as alive. A number
    // freed between a look and the signal goes to another only if the pid allocator reaches it then.
    for (let attempt = 0; members.length > 0 && attempt < STOP_POLL_ATTEMPTS; attempt++) {
      yield* Effect.sleep(STOP_POLL_INTERVAL);
      const now = yield* observeAll(members.map((member) => member.pid));
      members = members.filter((member, index) => {
        const current = now[index];
        return (
          current !== undefined &&
          !current.zombie &&
          current.startTime === member.startTime &&
          current.pgid === entry.pgid
        );
      });
    }
    if (members.length > 0) signalGroup(entry.pgid, "SIGKILL");
  });

  const reapEntry = Effect.fn("OpenCodeServerLedger.reapEntry")(
    function* (entryPath: string) {
      // Another home can share this directory through a link; its own servers reap its records.
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isNone(entry) || entry.value.stateDir !== input.stateDir) return;
      if (yield* isRunning(entry.value.owner)) return;
      yield* stopOrphan(entry.value);
      yield* removeHolder(entry.value.holder);
      yield* fs.remove(entryPath, { force: true });
    },
    (effect, entryPath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not clean up a recorded OpenCode server", { entryPath, cause }),
        ),
      ),
  );

  // The FIFO of a launch whose claim is gone. A holder that reads it started before the claim went.
  const stopUnclaimed = Effect.fn("OpenCodeServerLedger.stopUnclaimed")(function* (holder: string) {
    if (yield* stopHeld(holder)) {
      yield* Effect.logInfo(
        "Stopping an OpenCode server a previous T3.CodeShip server left unrecorded",
      );
    }
    yield* removeHolder(holder);
  });

  // A launch its server never recorded, or whose record went with the server: only its holder
  // knows the group, and stops it. A record's reap can take the launch first.
  const reapLaunch = Effect.fn("OpenCodeServerLedger.reapLaunch")(
    function* (launchPath: string) {
      const contents = yield* fs
        .readFileString(launchPath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
      if (contents === undefined) return;
      const launch = decodeLaunch(contents);
      if (Option.isNone(launch) || launch.value.stateDir !== input.stateDir) return;
      if (yield* isRunning(launch.value.owner)) return;
      yield* stopUnclaimed(`${launchPath.slice(0, -LAUNCH_SUFFIX.length)}${HOLDER_SUFFIX}`);
    },
    (effect, launchPath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not clean up an OpenCode server launch", { launchPath, cause }),
        ),
      ),
  );

  const reapOrphans = Effect.gen(function* () {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.forEach(
      names.filter((name) => name.endsWith(LAUNCH_SUFFIX)),
      (name) => reapLaunch(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
    // A launch that started after its claim was reaped made its FIFO and exited before it ran.
    yield* Effect.forEach(
      names.filter((name) => name.endsWith(HOLDER_SUFFIX)),
      (name) =>
        Effect.gen(function* () {
          const holder = path.join(directory, name);
          const claim = `${holder.slice(0, -HOLDER_SUFFIX.length)}${LAUNCH_SUFFIX}`;
          if (!(yield* fs.exists(claim))) yield* stopUnclaimed(holder);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not clean up an OpenCode server's holder FIFO", {
              name,
              cause,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  return { holderFifo, track, reapOrphans };
});

export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    OpenCodeServerLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans.pipe(Effect.forkScoped);
      return OpenCodeServerLedger.of({ holderFifo: ledger.holderFifo, track: ledger.track });
    }),
  );

export const layerTest = Layer.succeed(
  OpenCodeServerLedger,
  OpenCodeServerLedger.of({
    holderFifo: Effect.undefined,
    track: Effect.fn("OpenCodeServerLedger.track")(function () {
      return Effect.succeed(Effect.void);
    }),
  }),
);
