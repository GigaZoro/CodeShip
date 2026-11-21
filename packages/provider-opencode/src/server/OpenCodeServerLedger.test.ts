// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type FifoHold,
  holdProcessGroup,
  isFifoHolderHeld,
  layerHeldProcessGroups,
  releaseFifoHolder,
  signalProcessGroup,
  stopFifoHolderGroup,
} from "@t3tools/shared/processGroup";
import {
  hostHoldsProcessGroups,
  watchFreedGroupSignals,
} from "@t3tools/shared/testing/freedProcessGroups";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4096"];
// Probed and launched alike, so a shell setting in this process's environment cannot decline a hold.
const FIXTURE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

// As the server spawns: its spawner holds each detached group until the spawn's scope closes.
const layerNodeServices = layerHeldProcessGroups.pipe(Layer.provideMerge(NodeServices.layer));

const groupExists = (pgid: number) => {
  try {
    // oxlint-disable-next-line t3code/no-raw-process-group-signal -- a probe, which delivers nothing
    signalProcessGroup(pgid, 0);
    return true;
  } catch {
    return false;
  }
};

// A group of zombies can be reaped between a check and the kill, so ESRCH just means it is gone.
const killGroup = (group: { readonly pid: number; readonly owned: () => boolean }) =>
  Effect.sync(() => {
    if (!group.owned()) return;
    try {
      // oxlint-disable-next-line t3code/no-raw-process-group-signal -- `owned` just found the number still the group's
      signalProcessGroup(group.pid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  });

// libuv ignores a failed setsid(), which happens when the new pid equals the id of a group
// that still has members (such as a sleep orphaned by an earlier test). The child would then
// share the test worker's group, so the script first confirms it leads its own group and exits
// with 97 before starting anything if it does not.
const groupLeaderGuard = `pgid="$(ps -o pgid= -p $$ 2>&1 | tr -d ' ')"; [ "$pgid" = "$$" ] || { echo "ungrouped:$pgid"; exit 97; }; echo grouped; `;

// Yields the group, or a description of why this shell cannot be used as one. With `hold`, a FIFO
// hold keeps its number, as a T3 server that crashed leaves it. A `gated` one waits for `resume`
// before its launch starts, so it leads its group before it opens its FIFO.
const spawnGroupLeader = (
  args: ReadonlyArray<string>,
  script: string,
  hold?: FifoHold,
  gated = false,
) =>
  Effect.gen(function* () {
    const launch = {
      command: "/bin/sh",
      args: ["-c", groupLeaderGuard + script, ...args],
      env: FIXTURE_ENV,
    };
    const held = hold === undefined ? launch : holdProcessGroup(launch, { fd: 3, ...hold });
    if (held === undefined) return yield* Effect.die("this host cannot hold a process group");
    const gate = `${groupLeaderGuard}IFS= read -r _ || exit; exec </dev/null; exec "$@"`;
    const child = NodeChildProcess.spawn(
      gated ? "/bin/sh" : held.command,
      gated ? ["-c", gate, "sh", held.command, ...held.args] : held.args,
      { detached: true, env: FIXTURE_ENV, stdio: [gated ? "pipe" : "ignore", "pipe", "ignore"] },
    );
    const pid = child.pid;
    if (pid === undefined) return yield* Effect.die("spawn failed");
    const grouped = yield* Deferred.make<true | string>();
    const exited = yield* Deferred.make<NodeJS.Signals | null>();
    const printed = yield* Deferred.make<void>();
    const lines: Array<string> = [];
    const closed = yield* Deferred.make<ReadonlyArray<string>>();
    child.once("exit", (_code, signal) => Deferred.doneUnsafe(exited, Effect.succeed(signal)));
    child.once("close", () => Deferred.doneUnsafe(closed, Effect.succeed(lines)));
    // "close" fires after stdout drains, so a guard line always lands first. It only fires before
    // "grouped" when the shell died without starting the script, such as from a signal.
    child.once("close", (code, signal) =>
      Deferred.doneUnsafe(
        grouped,
        Effect.succeed(
          `shell ${pid} exited (code ${code}, signal ${signal}) before its group check`,
        ),
      ),
    );
    NodeReadline.createInterface({ input: child.stdout! }).on("line", (line) => {
      lines.push(line);
      if (line === "grouped") Deferred.doneUnsafe(grouped, Effect.succeed(true));
      if (line.startsWith("ungrouped:")) {
        const output = line.slice("ungrouped:".length);
        Deferred.doneUnsafe(
          grouped,
          Effect.succeed(`\`ps -o pgid= -p ${pid}\` printed ${JSON.stringify(output)}`),
        );
      }
      if (line === "ready") Deferred.doneUnsafe(printed, Effect.void);
    });
    const result = yield* Deferred.await(grouped);
    return result === true
      ? {
          pid,
          /** Whether the number is still the group's: its leader runs, or its holder keeps it. */
          owned: () =>
            (child.exitCode === null && child.signalCode === null) ||
            (hold !== undefined && isFifoHolderHeld(hold.fifo)),
          exited: Deferred.await(exited),
          resume: () => child.stdin?.end("\n"),
          printed: Deferred.await(printed),
          /** What it printed, once it and every process that kept its stdout ended. */
          closed: Deferred.await(closed),
        }
      : result;
  });

// A pid colliding with a live group id is rare, so a few retries clear it. Repeated failures
// mean the guard itself is broken (for example a missing or BusyBox `ps`).
const GROUP_LEADER_ATTEMPTS = 5;

const spawnGroup = (
  args: ReadonlyArray<string>,
  script = "sleep 600 & wait",
  hold?: FifoHold,
  gated = false,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let failure = "";
      for (let attempt = 0; attempt < GROUP_LEADER_ATTEMPTS; attempt++) {
        const group = yield* spawnGroupLeader(args, script, hold, gated);
        if (typeof group !== "string") return group;
        failure = group;
      }
      return yield* Effect.die(
        `no shell led its own process group after ${GROUP_LEADER_ATTEMPTS} attempts; last: ${failure}`,
      );
    }),
    killGroup,
  );

const recordFromDeadServer = (
  stateDir: string,
  server: { readonly pid: number },
  holder?: string,
) =>
  Effect.gen(function* () {
    const previousServer = yield* spawnGroup([]);
    const previousLedger = yield* OpenCodeServerLedger.make({
      stateDir,
      ownerPid: previousServer.pid,
    });
    yield* Effect.asVoid(
      previousLedger.track({ pid: server.pid, port: 4096, args: SERVE_ARGS, holder }),
    );
    yield* killGroup(previousServer);
    yield* previousServer.exited;
  });

// Without it, each server starts unheld, as `holdProcessGroup` declines.
const holds = hostHoldsProcessGroups(FIXTURE_ENV);
const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path. macOS reaps
// orphans, so only a Linux host that can hold a group, and so each `ps`, stands in for it.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux"
    ? holds
      ? ["linux", "darwin"]
      : ["linux"]
    : hostPlatform === "darwin"
      ? ["darwin"]
      : [];

// As a `ps` that cannot run or times out leaves the macOS ledger.
const blindSpawner = ChildProcessSpawner.make(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "spawn",
      description: "no process can be looked up",
    }),
  ),
);

describe.each(observedPlatforms)("OpenCodeServerLedger observing as %s", (platform) => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(layerNodeServices),
    );

  it.live.each([
    ["SIGTERM", "sleep 600 & wait"],
    ["SIGKILL", "trap '' TERM; sleep 600 & wait"],
  ] as const)(
    "stops with %s an OpenCode server group left by a server that died, and no group after it",
    ([signal, script]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const orphan = yield* spawnGroup(SERVE_ARGS, script);
        yield* recordFromDeadServer(stateDir, orphan);
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

        const restarted = yield* OpenCodeServerLedger.make({ stateDir });
        const freedGroupSignals = yield* Effect.scoped(
          watchFreedGroupSignals.pipe(
            Effect.tap(() => restarted.reapOrphans),
            Effect.map((freed) => freed.signals()),
          ),
        );

        expect(yield* orphan.exited).toBe(signal);
        expect(groupExists(orphan.pid)).toBe(false);
        expect(freedGroupSignals).toEqual([]);
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
      }).pipe(provideHost),
  );

  it.live.skipIf(!holds)("stops a held OpenCode server group with what it started on SIGTERM", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const directory = path.join(stateDir, "opencode-servers");
      yield* fs.makeDirectory(directory);
      const holder = path.join(directory, "server.hold");
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder)));
      // On SIGTERM it starts a process that ignores it and exits, so no member seen before the
      // signal is left. Only a SIGKILL to the group ends that process, which keeps the output open.
      const orphan = yield* spawnGroup(
        SERVE_ARGS,
        `trap '(trap "" TERM; sleep 600) & exit 0' TERM; echo ready; sleep 600 & wait`,
        { fifo: holder },
      );
      yield* orphan.printed;
      yield* recordFromDeadServer(stateDir, orphan, holder);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      const kill = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(process, "kill")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      yield* restarted.reapOrphans;
      const serverGroupSignals = kill.mock.calls.filter(
        ([pid, signal]) => pid === -orphan.pid && signal !== 0,
      );

      // The holder sends both, so no signal of this server can outlive the number.
      expect(serverGroupSignals).toEqual([]);
      yield* orphan.closed;
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(provideHost),
  );

  it.live.skipIf(!holds)(
    "stops the group of a held launch that a server which died never recorded",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const previousServer = yield* spawnGroup([]);
        const previousLedger = yield* OpenCodeServerLedger.make({
          stateDir,
          ownerPid: previousServer.pid,
        });
        // Its scope stays open, as when the server crashes before `track` records the group.
        const holder = yield* previousLedger.holderFifo.pipe(
          Effect.provideService(Scope.Scope, yield* Scope.make()),
        );
        if (holder === undefined) return yield* Effect.die("the ledger made no holder FIFO");
        yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder.fifo)));
        const orphan = yield* spawnGroup(
          SERVE_ARGS,
          `trap '(trap "" TERM; sleep 600) & exit 0' TERM; echo ready; sleep 600 & wait`,
          holder,
        );
        yield* orphan.printed;
        yield* killGroup(previousServer);
        yield* previousServer.exited;

        const restarted = yield* OpenCodeServerLedger.make({ stateDir });
        const freedGroupSignals = yield* Effect.scoped(
          watchFreedGroupSignals.pipe(
            Effect.tap(() => restarted.reapOrphans),
            Effect.map((freed) => freed.signals()),
          ),
        );

        yield* orphan.closed;
        expect(freedGroupSignals).toEqual([]);
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
      }).pipe(provideHost),
  );

  it.live.skipIf(!holds)(
    "never runs a held launch whose record a later server reaped before it started",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const previousServer = yield* spawnGroup([]);
        const previousLedger = yield* OpenCodeServerLedger.make({
          stateDir,
          ownerPid: previousServer.pid,
        });
        const holder = yield* previousLedger.holderFifo.pipe(
          Effect.provideService(Scope.Scope, yield* Scope.make()),
        );
        if (holder === undefined) return yield* Effect.die("the ledger made no holder FIFO");
        yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder.fifo)));
        yield* killGroup(previousServer);
        yield* previousServer.exited;
        const restarted = yield* OpenCodeServerLedger.make({ stateDir });
        yield* restarted.reapOrphans;

        const launch = holdProcessGroup(
          { command: "/bin/sh", args: ["-c", "echo ran"], env: FIXTURE_ENV },
          { fd: 3, ...holder },
        );
        if (launch === undefined) return yield* Effect.die("this host cannot hold a process group");
        const output = yield* Effect.callback<string>((resume) => {
          const child = NodeChildProcess.spawn(launch.command, launch.args, {
            detached: true,
            env: FIXTURE_ENV,
            stdio: ["ignore", "pipe", "ignore"],
          });
          let text = "";
          child.stdout.on("data", (chunk: Buffer) => {
            text += chunk.toString();
          });
          child.once("close", () => resume(Effect.succeed(text)));
        });
        // The FIFO it made goes with the next reap.
        yield* restarted.reapOrphans;

        expect(output).toBe("");
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
      }).pipe(provideHost),
  );

  it.live.skipIf(!holds)(
    "stops a held launch that passed its claim while a later server reaped its record",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const previousServer = yield* spawnGroup([]);
        const previousLedger = yield* OpenCodeServerLedger.make({
          stateDir,
          ownerPid: previousServer.pid,
        });
        const holder = yield* previousLedger.holderFifo.pipe(
          Effect.provideService(Scope.Scope, yield* Scope.make()),
        );
        if (holder === undefined) return yield* Effect.die("the ledger made no holder FIFO");
        yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder.fifo)));
        yield* killGroup(previousServer);
        yield* previousServer.exited;
        // The launch passes its claim and runs just before the reaper removes that claim.
        const removing = yield* Deferred.make<void>();
        const running = yield* Deferred.make<void>();
        const launching = yield* Deferred.await(removing).pipe(
          Effect.andThen(
            spawnGroup(
              SERVE_ARGS,
              `trap '(trap "" TERM; sleep 600) & exit 0' TERM; echo ready; sleep 600 & wait`,
              holder,
            ),
          ),
          Effect.tap((orphan) => orphan.printed),
          Effect.tap(() => Deferred.succeed(running, undefined)),
          Effect.forkScoped,
        );
        const restarted = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (target, options) =>
              target === holder.claim
                ? Deferred.succeed(removing, undefined).pipe(
                    Effect.andThen(Deferred.await(running)),
                    Effect.andThen(fs.remove(target, options)),
                  )
                : fs.remove(target, options),
          }),
        );
        yield* restarted.reapOrphans;
        const orphan = yield* Fiber.join(launching);

        yield* orphan.closed;
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
      }).pipe(provideHost),
  );

  it.live.skipIf(!holds)(
    "never runs a held launch that a later server reached between its record and its FIFO",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const previousServer = yield* spawnGroup([]);
        const previousLedger = yield* OpenCodeServerLedger.make({
          stateDir,
          ownerPid: previousServer.pid,
        });
        const holder = yield* previousLedger.holderFifo.pipe(
          Effect.provideService(Scope.Scope, yield* Scope.make()),
        );
        if (holder === undefined) return yield* Effect.die("the ledger made no holder FIFO");
        // A name outside the ledger's directory still reaches a holder the reap left running.
        const keep = path.join(stateDir, "keep");
        NodeChildProcess.execFileSync("mkfifo", ["-m", "600", holder.fifo]);
        yield* fs.link(holder.fifo, keep);
        yield* Effect.addFinalizer(() => Effect.sync(() => stopFifoHolderGroup(keep)));
        // Both records name it before it opens its FIFO, as when `track` finds it that early.
        const launch = yield* spawnGroup(SERVE_ARGS, "echo ran", holder, true);
        yield* Effect.asVoid(
          previousLedger.track({
            pid: launch.pid,
            port: 4096,
            args: SERVE_ARGS,
            holder: holder.fifo,
          }),
        );
        yield* killGroup(previousServer);
        yield* previousServer.exited;

        // It goes on once the reaper found no reader on its FIFO and looks the launch up.
        const outcome = yield* Deferred.make<"ran" | "exited">();
        const advance = Effect.suspend(() => {
          if (Deferred.isDoneUnsafe(outcome)) return Effect.void;
          launch.resume();
          return launch.closed.pipe(
            Effect.flatMap((lines) =>
              Deferred.succeed(outcome, lines.includes("ran") ? "ran" : "exited"),
            ),
          );
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const restarted = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) =>
              (file === `/proc/${launch.pid}/stat` ? advance : Effect.void).pipe(
                Effect.andThen(fs.readFileString(file, encoding)),
              ),
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              (ChildProcess.isStandardCommand(command) && command.args.includes(String(launch.pid))
                ? advance
                : Effect.void
              ).pipe(Effect.andThen(spawner.spawn(command))),
            ),
          ),
        );
        yield* restarted.reapOrphans;

        expect(yield* Deferred.await(outcome)).toBe("exited");
        expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
      }).pipe(provideHost),
  );

  it.live.skipIf(!holds)("records a group whose spawned wrapper already exited", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      // Keeps the number of the leaderless group for its cleanup; the ledger is not told of it.
      const holder = path.join(stateDir, "wrapper.hold");
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder)));
      // The inner shell prints once it has exec'd. Until then it still carries the wrapper's
      // command line, and recording that would make the reaper skip the group as recycled.
      const wrapper = yield* spawnGroup(
        SERVE_ARGS,
        '/bin/sh -c "echo ready; sleep 600 & wait" "$0" "$@" & exit 0',
        { fifo: holder },
      );
      yield* wrapper.exited;
      yield* wrapper.printed;
      expect(groupExists(wrapper.pid)).toBe(true);

      yield* recordFromDeadServer(stateDir, wrapper);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(wrapper.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("leaves a recycled pid alone when its start time does not match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace(/"startTime":"[^"]+"/, '"startTime":"1"'));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves a serve process on another port alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace("--port=4096", "--port=4097"));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live.skipIf(!holds)("leaves the servers of a running T3 server alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const directory = path.join(stateDir, "opencode-servers");
      const running = yield* OpenCodeServerLedger.make({ stateDir });
      const server = yield* spawnGroup(SERVE_ARGS);
      const forget = yield* running.track({
        pid: server.pid,
        port: 4096,
        args: SERVE_ARGS,
        holder: undefined,
      });
      // And one it launched but has not recorded yet.
      const holder = yield* running.holderFifo;
      if (holder?.claim === undefined) return yield* Effect.die("the ledger made no holder FIFO");
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(holder.fifo)));
      const launched = yield* spawnGroup(SERVE_ARGS, undefined, holder);

      const other = yield* OpenCodeServerLedger.make({ stateDir });
      yield* other.reapOrphans;
      const blind = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, blindSpawner),
      );
      yield* blind.reapOrphans;
      // A home that shares the directory through a link reaps only its own records.
      const alias = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-alias-" }),
        "home",
      );
      yield* fs.symlink(stateDir, alias);
      yield* (yield* OpenCodeServerLedger.make({ stateDir: alias })).reapOrphans;
      const entryPath = path.join(directory, `${server.pid}.json`);
      expect([groupExists(server.pid), groupExists(launched.pid)]).toEqual([true, true]);
      expect(isFifoHolderHeld(holder.fifo)).toBe(true);
      expect([yield* fs.exists(entryPath), yield* fs.exists(holder.claim)]).toEqual([true, true]);

      yield* forget;
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );
});

describe.skipIf(observedPlatforms.length === 0 || !holds)("OpenCode server startup", () => {
  it.live("holds the group and stops it when interrupted while the server is being recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-startup-" });
      const binaryPath = path.join(tempDir, "opencode");
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\nsleep 600 &\nexit 0\n");
      yield* fs.chmod(binaryPath, 0o755);

      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const recording = yield* Deferred.make<{
        readonly pid: number;
        readonly holder: string | undefined;
      }>();
      const ledger = yield* OpenCodeServerLedger.make({ stateDir: tempDir });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const layerRuntime = OpenCodeRuntime.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner
                .spawn(command)
                .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
            ),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            OpenCodeServerLedger.OpenCodeServerLedger,
            OpenCodeServerLedger.OpenCodeServerLedger.of({
              holderFifo: ledger.holderFifo,
              track: (server) =>
                Effect.gen(function* () {
                  yield* (yield* Deferred.await(spawned)).exitCode.pipe(Effect.ignore);
                  yield* Deferred.succeed(recording, server);
                  return yield* Effect.never;
                }),
            }),
          ),
        ),
      );

      const serverScope = yield* Scope.make();
      const starting = yield* OpenCodeRuntime.OpenCodeRuntime.pipe(
        Effect.flatMap((runtime) =>
          runtime.startOpenCodeServerProcess({ binaryPath, directory: tempDir, port: 4096 }),
        ),
        Effect.provideService(Scope.Scope, serverScope),
        Effect.provide(layerRuntime),
        Effect.forkChild,
      );
      const { pid: pgid, holder } = yield* Deferred.await(recording);
      yield* Effect.addFinalizer(() =>
        killGroup({ pid: pgid, owned: () => holder !== undefined && isFifoHolderHeld(holder) }),
      );
      expect(groupExists(pgid)).toBe(true);
      expect(holder !== undefined && isFifoHolderHeld(holder)).toBe(true);

      yield* Fiber.interrupt(starting);
      yield* Scope.close(serverScope, Exit.void);

      expect(groupExists(pgid)).toBe(false);
      expect(yield* fs.exists(holder ?? "")).toBe(false);
    }).pipe(Effect.provide(layerNodeServices)),
  );
});
