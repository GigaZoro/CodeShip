// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as HostProcess from "./HostProcess.ts";
import { AWAIT_HOLDER_PYTHON, watchFreedGroupSignals } from "./testing/freedProcessGroups.ts";

import {
  type GroupLaunch,
  HOLDER_LINES,
  holdProcessGroup,
  isFifoHolderHeld,
  layerHeldProcessGroups,
  ownProcessGroup,
  reapsOrphans,
  releaseFifoHolder,
  signalProcessGroup,
} from "./processGroup.ts";

const errorCode = (run: () => void) => {
  try {
    run();
    return undefined;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code;
  }
};

// Each listens from the call, so an event that comes before the effect runs is not missed.
const exited = (child: NodeChildProcess.ChildProcess) => {
  const signal = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => resolve(signal));
  });
  return Effect.promise(() => signal);
};

const closed = (stream: NodeJS.EventEmitter) => {
  const close = new Promise<void>((resolve) => stream.once("close", () => resolve()));
  return Effect.promise(() => close);
};

const output = (child: NodeChildProcess.ChildProcess) => {
  let text = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  return closed(child.stdout!).pipe(Effect.map(() => text));
};

const holderPipe = (child: NodeChildProcess.ChildProcess, fd: number) =>
  child.stdio[fd] as NodeNet.Socket;

// What a child printed, or how its spawn failed.
const outcome = (start: () => NodeChildProcess.ChildProcess) => {
  let child: NodeChildProcess.ChildProcess;
  try {
    child = start();
  } catch (cause) {
    return Effect.succeed(`error ${(cause as NodeJS.ErrnoException).code}`);
  }
  let text = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const done = new Promise<string>((resolve) => {
    child.once("error", (cause: NodeJS.ErrnoException) => resolve(`error ${cause.code}`));
    child.once("close", () => resolve(text));
  });
  return Effect.promise(() => done);
};

const spawnOptionsOf = (launch: GroupLaunch) =>
  ({ cwd: launch.cwd, env: launch.env, detached: true }) satisfies NodeChildProcess.SpawnOptions;

// The launch as Node's spawn would run it, and through its holder, which reads `fd`.
const spawnBoth = (launch: GroupLaunch, fd: number) => {
  const held = holdProcessGroup(launch, { fd });
  if (held === undefined) throw new Error(`No holder for ${launch.command}`);
  return {
    direct: NodeChildProcess.spawn(launch.command, launch.args, {
      ...spawnOptionsOf(launch),
      shell: launch.shell,
      stdio: ["ignore", "pipe", "inherit"],
    }),
    held: NodeChildProcess.spawn(held.command, held.args, {
      ...spawnOptionsOf(launch),
      stdio: ["ignore", "pipe", "inherit", ...Array<"ignore">(fd - 3).fill("ignore"), "pipe"],
    }),
  };
};

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-group-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const writeFile = (path: string, content: string, mode = 0o755) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${content}\n`, { mode });
};

const writeScript = (path: string, body: string, mode = 0o755) =>
  writeFile(path, `#!/bin/sh\n${body}`, mode);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("signalProcessGroup", () => {
  // Signal 0 probes without killing.
  it("never reaches this server's group or every process the user owns", () => {
    for (const pid of [1, 0, -1, Number.NaN, 1.5]) {
      expect(
        errorCode(() => signalProcessGroup(pid, 0)),
        `pid ${pid}`,
      ).toBe("ESRCH");
    }
  });

  it.live("signals a spawned process group", () =>
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 600 & wait"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid!;

      expect(errorCode(() => signalProcessGroup(pid, 0))).toBeUndefined();
      signalProcessGroup(pid, "SIGKILL");
      expect(yield* exited(child)).toBe("SIGKILL");
    }),
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("holdProcessGroup", () => {
  it.live("keeps a group's number past its leader's exit, outside the group, until released", () =>
    Effect.gen(function* () {
      const freed = yield* watchFreedGroupSignals;
      const { direct, held } = spawnBoth({ command: "sh", args: ["-c", "exit 0"] }, 3);
      const directExit = exited(direct);
      const heldExit = exited(held);
      const holderGone = closed(held.stdio[3]!);
      const unheldGroup = ownProcessGroup(direct, undefined);
      const heldGroup = ownProcessGroup(held, 3);
      yield* directExit;
      yield* heldExit;

      expect(unheldGroup.signal("SIGKILL")).toBe(false);
      expect(errorCode(() => heldGroup.signal("SIGKILL"))).toBe("ESRCH");
      heldGroup.release();
      yield* holderGone;
      expect(heldGroup.signal("SIGKILL")).toBe(false);
      expect(freed.signals()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // A command execve refuses starts unheld, so that Node's spawn reports it.
  it.live("runs what Node's spawn would run, with the same arguments, or leaves it to Node", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      // A script sees the path it was run by as $0, which macOS's bash 3.2 makes absolute.
      writeScript(NodePath.join(dir, "bin", "show"), 'printf "bin %s|" "$@"');
      writeScript(NodePath.join(dir, "early", "show"), "echo not executable", 0o644);
      writeScript(NodePath.join(dir, "early", "dot"), "echo not executable", 0o644);
      // execve fails with ENOENT for a missing interpreter, and Node searches on; bash would not.
      writeFile(NodePath.join(dir, "early", "lost"), "#!/t3-group-missing/sh\necho lost");
      writeScript(NodePath.join(dir, "bin", "lost"), 'printf "found %s|" "$@"');
      writeScript(NodePath.join(dir, "here"), 'printf "here %s|" "$@"');
      writeScript(NodePath.join(dir, "dot"), 'printf "dot %s|" "$@"');
      writeScript(NodePath.join(dir, "plain"), "exit 0", 0o644);
      NodeFS.mkdirSync(NodePath.join(dir, "folder"));
      writeFile(NodePath.join(dir, "lone"), "#!/t3-group-missing/sh\nexit 0");
      // No `#!` and no binary: execve fails with ENOEXEC, which ends the PATH search, and glibc
      // then runs the file with /bin/sh, where bash would run it as a bash script.
      writeFile(NodePath.join(dir, "text"), 'printf "text %s|" "$0" "$@"');
      writeScript(NodePath.join(dir, "later", "text"), 'printf "later %s|" "$@"');
      const env = (path: string) => ({ ...process.env, PATH: path });
      const launches: ReadonlyArray<GroupLaunch> = [
        { command: "sh", args: ["-c", 'printf "%s|" "$0" "$@"', "a b", "c"] },
        { command: "show", args: ["x y"], cwd: dir, env: env(`early:bin:${process.env.PATH}`) },
        { command: "dot", args: ["w"], cwd: dir, env: env(`early::/usr/bin`) },
        { command: "./here", args: ["z"], cwd: dir, env: env("/usr/bin") },
        { command: "lost", args: ["v"], cwd: dir, env: env(`early:bin:${process.env.PATH}`) },
        { command: 'printf "%s|" "$0"', args: ["more"], shell: true },
        { command: "printf '%s|' \"$0\"", args: [], shell: "sh" },
        // Neither the holder's pipe nor a copy of it reaches the command.
        { command: "ls", args: ["/dev/fd"] },
        // macOS starts its protected /bin/bash without DYLD_ variables.
        {
          command: process.execPath,
          args: ["-p", "process.env.DYLD_T3_GROUP_TEST"],
          env: { ...process.env, DYLD_T3_GROUP_TEST: "kept" },
        },
        { command: "./text", args: ["t"], cwd: dir },
        { command: "text", args: ["p"], cwd: dir, env: env(`${dir}:${dir}/later:/usr/bin`) },
        { command: "text", args: ["e"], cwd: dir, env: env(`:${dir}/later:/usr/bin`) },
        ...["t3-group-missing-command", "./plain", "./folder", "", "./lone"].map((command) => ({
          command,
          args: [],
          cwd: dir,
        })),
      ];
      for (const launch of launches) {
        const expected = yield* outcome(() =>
          NodeChildProcess.spawn(launch.command, launch.args, {
            ...spawnOptionsOf(launch),
            shell: launch.shell,
            stdio: ["ignore", "pipe", "inherit"],
          }),
        );
        const held = holdProcessGroup(launch, { fd: 4 });
        if (held === undefined) {
          expect(expected, launch.command).toMatch(/^error /);
          continue;
        }
        const actual = yield* outcome(() => {
          const child = NodeChildProcess.spawn(held.command, held.args, {
            ...spawnOptionsOf(launch),
            stdio: ["ignore", "pipe", "inherit", "ignore", "pipe"],
          });
          holderPipe(child, 4).resume();
          child.once("exit", () => holderPipe(child, 4).end(HOLDER_LINES.quit));
          return child;
        });
        expect(actual, launch.command).toBe(expected);
      }
    }).pipe(Effect.scoped),
  );

  it.live("keeps a group's number past its leader's exit while its FIFO's holder runs", () =>
    Effect.gen(function* () {
      const fifo = NodePath.join(yield* tempDir, "it's held");
      const held = holdProcessGroup({ command: "sh", args: ["-c", "exit 0"] }, { fd: 3, fifo })!;
      const child = NodeChildProcess.spawn(held.command, held.args, {
        detached: true,
        stdio: "ignore",
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(fifo)));
      yield* exited(child);
      const freed = yield* watchFreedGroupSignals;

      expect(isFifoHolderHeld(fifo)).toBe(true);
      expect(errorCode(() => signalProcessGroup(child.pid!, "SIGKILL"))).toBe("ESRCH");
      expect(freed.signals()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("holds through a FIFO from before the command runs until a release", () =>
    Effect.gen(function* () {
      const fifo = NodePath.join(yield* tempDir, "holder");
      // The command checks that the FIFO has a reader, finds the holder as the other process of
      // its session, and once the holder ended, checks again.
      const script = [
        AWAIT_HOLDER_PYTHON,
        "def read(): os.close(os.open(sys.argv[1], os.O_WRONLY | os.O_NONBLOCK))",
        "read()",
        "await_holder(lambda: print('held', flush=True))",
        "try: read(); print('still held')",
        "except OSError: print('released')",
      ].join("\n");
      const held = holdProcessGroup(
        { command: "python3", args: ["-c", script, fifo] },
        { fd: 3, fifo },
      )!;
      const child = NodeChildProcess.spawn(held.command, held.args, {
        detached: true,
        stdio: ["ignore", "pipe", "inherit"],
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseFifoHolder(fifo)));
      const printed = output(child);
      const first = new Promise<void>((resolve) => {
        child.stdout!.once("data", () => resolve());
        child.once("close", () => resolve());
      });
      yield* Effect.promise(() => first);

      releaseFifoHolder(fifo);
      expect(yield* printed).toBe("held\nreleased\n");
    }).pipe(Effect.scoped),
  );

  it.live("runs the command unheld when its FIFO cannot be made", () =>
    Effect.gen(function* () {
      const fifo = NodePath.join(yield* tempDir, "missing", "holder");
      const held = holdProcessGroup({ command: "sh", args: ["-c", "exit 7"] }, { fd: 3, fifo })!;
      const child = NodeChildProcess.spawn(held.command, held.args, {
        detached: true,
        stdio: "ignore",
      });
      const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));

      expect(yield* Effect.promise(() => exit)).toBe(7);
      expect(isFifoHolderHeld(fifo)).toBe(false);
    }).pipe(Effect.scoped),
  );

  // A holder outlives its command, so it stays a zombie unless something reaps it.
  it.each([
    { platform: "darwin", pid: 400, init: undefined, held: true },
    { platform: "linux", pid: 400, init: "systemd", held: true },
    { platform: "linux", pid: 400, init: "docker-init", held: true },
    { platform: "linux", pid: 1, init: "systemd", held: false },
    { platform: "linux", pid: 400, init: "node", held: false },
    { platform: "linux", pid: 400, init: undefined, held: false },
    { platform: "freebsd", pid: 400, init: "init", held: false },
  ] as const)(
    "holds on $platform as pid $pid under $init: $held",
    ({ platform, pid, init, held }) => {
      expect(reapsOrphans(platform, pid, () => init)).toBe(held);
    },
  );

  it.live.each([
    { case: "ends the group at EOF", spare: false, ended: "SIGKILL" },
    { case: "spares a group it was told to at EOF", spare: true, ended: "SIGTERM" },
  ])("a holder $case", ({ spare, ended }) =>
    Effect.gen(function* () {
      const held = holdProcessGroup(
        { command: "sh", args: ["-c", "sleep 600 & wait"] },
        { fd: 3, endGroupAfterSeconds: 0 },
      )!;
      const child = NodeChildProcess.spawn(held.command, held.args, {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe"],
      });
      const holder = holderPipe(child, 3);
      const exit = exited(child);
      const holderGone = closed(holder.resume());
      if (spare) holder.write(HOLDER_LINES.spare);
      holder.end();
      yield* holderGone;

      // Its unreaped leader still keeps the number. A SIGKILL the holder sent wins over this one.
      if (child.exitCode === null && child.signalCode === null) {
        errorCode(() => signalProcessGroup(child.pid!, "SIGTERM"));
      }
      expect(yield* exit).toBe(ended);
    }),
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("layerHeldProcessGroups", () => {
  const spawner = Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.provide(layerHeldProcessGroups.pipe(Layer.provideMerge(NodeServices.layer))),
  );

  // Effect's spawner signals the group of a failed command as it exits and as its scope closes,
  // after the finalizers its caller added once it started, which may signal the group too.
  it.live("keeps a failed command's group number through every signal after its exit", () =>
    Effect.gen(function* () {
      const freed = yield* watchFreedGroupSignals;
      const run = Effect.gen(function* () {
        const handle = yield* (yield* spawner).spawn(ChildProcess.make("sh", ["-c", "exit 3"]));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => errorCode(() => signalProcessGroup(handle.pid, "SIGKILL"))),
        );
        return yield* handle.exitCode;
      });

      expect(yield* Effect.scoped(run)).toBe(3);
      expect(freed.signals()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("leaves the command the file descriptors it was given", () =>
    Effect.gen(function* () {
      const handle = yield* (yield* spawner).spawn(
        ChildProcess.make("sh", ["-c", "echo three >&3"], {
          additionalFds: { fd3: { type: "output" } },
        }),
      );

      expect(yield* Stream.mkString(Stream.decodeText(handle.getOutputFd(3)))).toBe("three\n");
    }).pipe(Effect.scoped),
  );

  it.live("reports a held command's errors under the command it was given", () =>
    Effect.gen(function* () {
      const command = ChildProcess.make("sh", ["-c", "kill -KILL $$"]);
      const error = yield* (yield* spawner).exitCode(command).pipe(Effect.flip);

      expect(error.message).toContain("(sh -c kill -KILL $$)");
    }),
  );
});
