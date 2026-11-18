// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  holdProcessGroup,
  isFifoHolderHeld,
  layerHeldProcessGroups,
  releaseFifoHolder,
  signalProcessGroup,
} from "@t3tools/shared/processGroup";
import { watchFreedGroupSignals } from "@t3tools/shared/testing/freedProcessGroups";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4096"];

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

// Yields the group, or a description of why this shell cannot be used as one. With `holder`, a
// FIFO hold keeps its number, as a T3 server that crashed leaves it.
const spawnGroupLeader = (args: ReadonlyArray<string>, script: string, holder?: string) =>
  Effect.gen(function* () {
    const launch = { command: "/bin/sh", args: ["-c", groupLeaderGuard + script, ...args] };
    const held = holder === undefined ? launch : holdProcessGroup(launch, { fd: 3, fifo: holder });
    if (held === undefined) return yield* Effect.die("this host cannot hold a process group");
    const child = NodeChildProcess.spawn(held.command, held.args, {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
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
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
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
            (holder !== undefined && isFifoHolderHeld(holder)),
          exited: Deferred.await(exited),
          printed: Deferred.await(printed),
          /** What it printed, once it and every process that kept its stdout ended. */
          closed: Deferred.await(closed),
        }
      : result;
  });

// A pid colliding with a live group id is rare, so a few retries clear it. Repeated failures
// mean the guard itself is broken (for example a missing or BusyBox `ps`).
const GROUP_LEADER_ATTEMPTS = 5;

const spawnGroup = (args: ReadonlyArray<string>, script = "sleep 600 & wait", holder?: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let failure = "";
      for (let attempt = 0; attempt < GROUP_LEADER_ATTEMPTS; attempt++) {
        const group = yield* spawnGroupLeader(args, script, holder);
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

const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

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

  it.live("stops a held OpenCode server group with what it started on SIGTERM", () =>
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
        holder,
      );
      yield* orphan.printed;
      yield* recordFromDeadServer(stateDir, orphan, holder);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      const freedGroupSignals = yield* Effect.scoped(
        watchFreedGroupSignals.pipe(
          Effect.tap(() => restarted.reapOrphans),
          Effect.map((freed) => freed.signals()),
        ),
      );

      yield* orphan.closed;
      expect(freedGroupSignals).toEqual([]);
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("records a group whose spawned wrapper already exited", () =>
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
        holder,
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

  it.live("leaves the servers of a running T3 server alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const running = yield* OpenCodeServerLedger.make({ stateDir });
      const server = yield* spawnGroup(SERVE_ARGS);
      const forget = yield* running.track({
        pid: server.pid,
        port: 4096,
        args: SERVE_ARGS,
        holder: undefined,
      });

      const other = yield* OpenCodeServerLedger.make({ stateDir });
      yield* other.reapOrphans;
      expect(groupExists(server.pid)).toBe(true);

      yield* forget;
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );
});

describe.skipIf(observedPlatforms.length === 0)("OpenCode server startup", () => {
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
