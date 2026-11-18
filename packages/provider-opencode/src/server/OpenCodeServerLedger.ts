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
  isFifoHolderHeld,
  releaseFifoHolder,
  signalProcessGroup,
} from "@t3tools/shared/processGroup";

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

export class OpenCodeServerLedger extends Context.Service<
  OpenCodeServerLedger,
  {
    /**
     * A FIFO path for `HoldThroughFifo`, removed when the scope closes, so that a later server can
     * stop the group if this one crashes.
     */
    readonly holderFifo: Effect.Effect<string | undefined, never, Scope.Scope>;
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

  const isRunning = (identity: ProcessIdentity) =>
    observe(identity.pid).pipe(
      Effect.map(
        (observed) =>
          observed !== undefined && !observed.zombie && observed.startTime === identity.startTime,
      ),
    );

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const removeHolder = (holder: string | undefined) =>
    holder === undefined ? Effect.void : fs.remove(holder, { force: true });

  const holderFifo: OpenCodeServerLedger["Service"]["holderFifo"] = recordable
    ? Effect.acquireRelease(
        fs.makeDirectory(directory, { recursive: true }).pipe(
          Effect.andThen(crypto.randomUUIDv4()),
          Effect.map((id) => path.join(directory, `${id}${HOLDER_SUFFIX}`)),
        ),
        (holder) =>
          removeHolder(holder).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not remove an OpenCode server's holder FIFO", { cause }),
            ),
          ),
      ).pipe(
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

  const stopHeldOrphan = Effect.fn("OpenCodeServerLedger.stopHeldOrphan")(function* (
    entry: OpenCodeServerEntry,
    holder: string,
  ) {
    if (groupExists(entry.pgid)) {
      yield* Effect.logInfo("Stopping an OpenCode server left by a previous T3.CodeShip server", {
        pid: entry.pgid,
        port: entry.port,
      });
      signalGroup(entry.pgid, "SIGTERM");
      for (let attempt = 0; groupExists(entry.pgid) && attempt < STOP_POLL_ATTEMPTS; attempt++) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      if (groupExists(entry.pgid)) signalGroup(entry.pgid, "SIGKILL");
    }
    releaseFifoHolder(holder);
  });

  // While its holder keeps the number, every member of the group is the server's, also one it
  // started after the signal. Otherwise only a recorded member with the same pid, start time,
  // group, and full command line proves the group is still the one recorded.
  const stopOrphan = Effect.fn("OpenCodeServerLedger.stopOrphan")(function* (
    entry: OpenCodeServerEntry,
  ) {
    if (entry.holder !== undefined && isFifoHolderHeld(entry.holder)) {
      return yield* stopHeldOrphan(entry, entry.holder);
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
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        if (yield* isRunning(entry.value.owner)) return;
        yield* stopOrphan(entry.value);
        yield* removeHolder(entry.value.holder);
      }
      yield* fs.remove(entryPath, { force: true });
    },
    (effect, entryPath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not clean up a recorded OpenCode server", { entryPath, cause }),
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
