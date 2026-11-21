// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as HostProcess from "./HostProcess.ts";
import {
  AWAIT_HOLDER_PYTHON,
  hostHoldsProcessGroups,
  watchFreedGroupSignals,
} from "./testing/freedProcessGroups.ts";

import {
  type GroupLaunch,
  HOLDER_LINES,
  HoldThroughFifo,
  holdProcessGroup,
  isFifoHolderHeld,
  layerHeldProcessGroups,
  ownProcessGroup,
  reapsOrphans,
  releaseFifoHolder,
  signalProcessGroup,
  signalSpawnedGroup,
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

// What a child printed and how it ended, or how its spawn failed.
const outcome = (start: () => NodeChildProcess.ChildProcess) => {
  let child: NodeChildProcess.ChildProcess;
  try {
    child = start();
  } catch (cause) {
    return Effect.succeed(`error ${(cause as NodeJS.ErrnoException).code}`);
  }
  let text = "";
  let errors = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const done = new Promise<string>((resolve) => {
    child.once("error", (cause: NodeJS.ErrnoException) => resolve(`error ${cause.code}`));
    child.once("close", (code, signal) =>
      resolve(`${text} stderr ${errors} exit ${code ?? signal}`),
    );
  });
  return Effect.promise(() => done);
};

const spawnOptionsOf = (launch: GroupLaunch) =>
  ({ cwd: launch.cwd, env: launch.env, detached: true }) satisfies NodeChildProcess.SpawnOptions;

/** That the held launch runs as Node's spawn runs `launch`: the same output, errors and exit. */
const expectRunsAsNode = (launch: GroupLaunch) =>
  Effect.gen(function* () {
    const held = holdProcessGroup(launch, { fd: 4 });
    if (held === undefined) throw new Error(`${launch.command} starts unheld`);
    const expected = yield* outcome(() =>
      NodeChildProcess.spawn(launch.command, launch.args, {
        ...spawnOptionsOf(launch),
        shell: launch.shell,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const actual = yield* outcome(() => {
      const child = NodeChildProcess.spawn(held.command, held.args, {
        ...spawnOptionsOf(launch),
        stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
      });
      holderPipe(child, 4).resume();
      child.once("exit", () => holderPipe(child, 4).end(HOLDER_LINES.quit));
      return child;
    });
    expect(actual, launch.command).toBe(expected);
  });

/** How a child ended: its exit code, or the signal that ended it. */
const exitOf = (child: NodeChildProcess.ChildProcess) => {
  const ended = new Promise<number | NodeJS.Signals | null>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? signal));
  });
  return Effect.promise(() => ended);
};

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

// Without one, every command starts unheld, as `reapsOrphans` and the tests that stub it show.
const holds = hostHoldsProcessGroups();

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

  it.live("finds nothing to refuse in a group whose members exited unreaped", () =>
    Effect.gen(function* () {
      // The child leads its own group and exits, and Python never reaps it. Their stdout closes once
      // both let it go, so the child has exited by then.
      const parent = NodeChildProcess.spawn(
        "python3",
        [
          "-c",
          [
            "import os, time",
            "pid = os.fork()",
            "if pid == 0: os.setpgid(0, 0); os._exit(0)",
            "print(pid, flush=True); os.close(1); time.sleep(600)",
          ].join("\n"),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => parent.kill("SIGKILL")));
      const zombie = Number((yield* output(parent)).trim());

      expect(["ESRCH", undefined]).toContain(
        errorCode(() => signalProcessGroup(zombie, "SIGKILL")),
      );
    }).pipe(Effect.scoped),
  );
});

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

describe.skipIf(HostProcess.Platform.defaultValue() === "win32" || !holds)(
  "holdProcessGroup",
  () => {
    it.live(
      "keeps a group's number past its leader's exit, outside the group, until released",
      () =>
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

    // A command that exec might not run starts unheld, so that Node's spawn runs it or reports it.
    it.live(
      "runs what Node's spawn would run, with the same arguments and exit, or leaves it to Node",
      () =>
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
          // Binaries the kernel refuses with ENOEXEC: no type, and a CPU no host has.
          const elf = Buffer.alloc(64);
          elf.write("\x7fELF\x02\x01\x01", "latin1");
          const machO = Buffer.alloc(64);
          machO.writeUInt32BE(0xcffa_edfe, 0);
          machO.writeUInt32LE(18, 4);
          machO.writeUInt32LE(2, 12);
          NodeFS.writeFileSync(NodePath.join(dir, "elf"), elf, { mode: 0o755 });
          NodeFS.writeFileSync(NodePath.join(dir, "macho"), machO, { mode: 0o755 });
          // execve runs a file this process may not read.
          writeScript(NodePath.join(dir, "early", "hidden"), 'printf "hidden %s|" "$@"', 0o111);
          writeScript(NodePath.join(dir, "bin", "hidden"), 'printf "found %s|" "$@"');
          const hiddenReadable =
            errorCode(() =>
              NodeFS.accessSync(NodePath.join(dir, "early", "hidden"), NodeFS.constants.R_OK),
            ) === undefined;
          // The kernel resolves `missing/..` to no directory, where a normalized path finds this.
          writeScript(NodePath.join(dir, "show"), 'printf "top %s|" "$@"');
          const linux = HostProcess.Platform.defaultValue() === "linux";
          const darwin = HostProcess.Platform.defaultValue() === "darwin";
          if (linux) {
            // execve fails with ENOENT for a program whose loader is missing, and Node searches on.
            const program = NodeFS.readFileSync("/bin/true");
            const loader = program.subarray(0, 1024).indexOf("/lib");
            expect(loader, "the loader /bin/true names").toBeGreaterThan(0);
            program.write("/t3x", loader, "latin1");
            NodeFS.writeFileSync(NodePath.join(dir, "early", "unloaded"), program, { mode: 0o755 });
            writeScript(NodePath.join(dir, "bin", "unloaded"), 'printf "found %s|" "$@"');
            // A loader, found from the child's directory, too short to hold its program headers.
            program.write("./cut\0", loader, "latin1");
            NodeFS.writeFileSync(NodePath.join(dir, "cut-loader"), program, { mode: 0o755 });
            NodeFS.writeFileSync(NodePath.join(dir, "cut"), program.subarray(0, 64), {
              mode: 0o755,
            });
          }
          if (darwin) {
            // This host's own program, cut short, started by another loader, and whole.
            const head = Buffer.alloc(65_536);
            const node = NodeFS.openSync(process.execPath, "r");
            NodeFS.readSync(node, head, 0, head.length, 0);
            const { size } = NodeFS.fstatSync(node);
            NodeFS.closeSync(node);
            expect(head.readUInt32BE(0), "node is a thin Mach-O program").toBe(0xcffa_edfe);
            NodeFS.writeFileSync(NodePath.join(dir, "cut"), head, { mode: 0o755 });
            NodeFS.writeFileSync(NodePath.join(dir, "whole"), head, { mode: 0o755 });
            NodeFS.truncateSync(NodePath.join(dir, "whole"), size);
            const dyld = head.indexOf("/usr/lib/dyld\0");
            expect(dyld, "node's loader").toBeGreaterThan(0);
            head.write("/usr/lib/dylx", dyld, "latin1");
            NodeFS.writeFileSync(NodePath.join(dir, "stranger"), head, { mode: 0o755 });
            NodeFS.truncateSync(NodePath.join(dir, "stranger"), size);
            expect(
              holdProcessGroup({ command: "./whole", args: [], cwd: dir }, { fd: 4 }),
            ).toBeDefined();
          }
          const env = (path: string) => ({ ...process.env, PATH: path });
          const searched = { cwd: dir, env: env(`early:bin:${process.env.PATH}`) };
          const hidden = { command: "hidden", args: ["h"], ...searched };
          const heldLaunches: ReadonlyArray<GroupLaunch> = [
            { command: "sh", args: ["-c", 'printf "%s|" "$0" "$@"', "a b", "c"] },
            { command: "show", args: ["x y"], ...searched },
            { command: "show", args: ["n"], cwd: dir, env: env(`${dir}/missing/..:${dir}/bin`) },
            { command: "dot", args: ["w"], cwd: dir, env: env(`early::/usr/bin`) },
            { command: "./here", args: ["z"], cwd: dir, env: env("/usr/bin") },
            { command: "lost", args: ["v"], ...searched },
            { command: 'printf "%s|" "$0"', args: ["more"], shell: true },
            { command: "printf '%s|' \"$0\"", args: [], shell: "sh" },
            { command: "sh", args: ["-c", "exit 5"] },
            // Neither the holder's pipe nor a copy of it reaches the command.
            { command: "ls", args: ["/dev/fd"] },
            // macOS starts its protected /bin/bash without DYLD_ variables.
            {
              command: process.execPath,
              args: ["-p", "process.env.DYLD_T3_GROUP_TEST"],
              env: { ...process.env, DYLD_T3_GROUP_TEST: "kept" },
            },
            ...(hiddenReadable ? [hidden] : []),
            ...(linux ? [{ command: "unloaded", args: ["u"], ...searched }] : []),
          ];
          const unheldLaunches: ReadonlyArray<GroupLaunch> = [
            { command: "./text", args: ["t"], cwd: dir },
            { command: "text", args: ["p"], cwd: dir, env: env(`${dir}:${dir}/later:/usr/bin`) },
            { command: "text", args: ["e"], cwd: dir, env: env(`:${dir}/later:/usr/bin`) },
            ...(hiddenReadable ? [] : [hidden]),
            ...[
              "t3-group-missing-command",
              "./plain",
              "./folder",
              "",
              "./lone",
              "./elf",
              "./macho",
              ...(linux ? ["./cut-loader"] : []),
              ...(darwin ? ["./cut", "./stranger"] : []),
            ].map((command) => ({ command, args: [], cwd: dir })),
          ];
          for (const launch of heldLaunches) yield* expectRunsAsNode(launch);
          for (const launch of unheldLaunches) {
            expect(holdProcessGroup(launch, { fd: 4 }), launch.command).toBeUndefined();
          }
        }).pipe(Effect.scoped),
    );

    // Bash sets, changes or refuses some variables on its way to the command.
    it.live("passes the command its environment as given, or leaves it to Node", () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const printEnv = (env: NodeJS.ProcessEnv): GroupLaunch => ({
          command: process.execPath,
          args: ["-e", "console.log(JSON.stringify(Object.entries(process.env).sort()))"],
          cwd: dir,
          env,
        });
        const given = {
          PATH: process.env.PATH,
          SHLVL: "5",
          "A-B": "1",
          F: "() { echo hi; }",
          T3_GROUP_VALUE: "a b'\"c\n$d",
        };
        const named = {
          ...given,
          ...Object.fromEntries(
            [
              "BASH",
              "BASHPID",
              "BASH_ARGV0",
              "BASH_COMMAND",
              "BASH_EXECUTION_STRING",
              "BASH_MONOSECONDS",
              "BASH_SUBSHELL",
              "BASH_VERSION",
              "COMP_WORDBREAKS",
              "EPOCHREALTIME",
              "EPOCHSECONDS",
              "HISTCMD",
              "LINENO",
              "OLDPWD",
              "OPTERR",
              "OPTIND",
              "PS1",
              "PS2",
              "PS4",
              "RANDOM",
              "SRANDOM",
              "TMOUT",
              "_",
              "DYLD_T3_GROUP_TEST",
            ].map((name) => [name, `given ${name}'`]),
          ),
          IFS: " x\t",
          PWD: "/given",
        };
        for (const env of [named, given, { ...given, LC_ALL: "C" }]) {
          yield* expectRunsAsNode(printEnv(env));
        }
        const refused = [
          ...["SHELLOPTS", "BASHOPTS", "PPID", "BASH_COMPAT", "BASH_VERSINFO", "BASH_XTRACEFD"].map(
            (name) => ({ [name]: "1" }),
          ),
          ...["1000", "05", "999", "-1", ""].map((SHLVL) => ({ SHLVL })),
        ];
        for (const env of refused) {
          const launch = printEnv({ ...given, ...env });
          expect(holdProcessGroup(launch, { fd: 4 }), JSON.stringify(env)).toBeUndefined();
        }
        // glibc's bash 5 warns on stderr that it cannot set an unknown locale; macOS's bash does not.
        const unknownLocale = {
          command: "sh",
          args: ["-c", "echo ok"],
          env: { ...given, LC_ALL: "xx_YY.t3-group-missing" },
        };
        if (holdProcessGroup(unknownLocale, { fd: 4 }) !== undefined) {
          yield* expectRunsAsNode(unknownLocale);
        }
      }).pipe(Effect.scoped),
    );

    it.live("keeps the group to the end of a command whose environment sets TMOUT", () =>
      Effect.gen(function* () {
        const launch = {
          command: "sh",
          args: ["-c", "sleep 2; exit 7"],
          env: { ...process.env, TMOUT: "1" },
        };
        const held = holdProcessGroup(launch, { fd: 3, endGroupAfterSeconds: 0 })!;
        const child = NodeChildProcess.spawn(held.command, held.args, {
          ...spawnOptionsOf(launch),
          stdio: ["ignore", "ignore", "inherit", "pipe"],
        });
        const holder = holderPipe(child, 3).resume();

        expect(yield* exitOf(child)).toBe(7);
        holder.end(HOLDER_LINES.quit);
      }),
    );

    it.live("gives the group its grace period where the command's PATH has no sleep", () =>
      Effect.gen(function* () {
        const launch = {
          command: "/bin/sh",
          args: ["-c", 'trap "/bin/sleep 1; exit 3" TERM; /bin/sleep 600 & echo ready; wait'],
          env: { ...process.env, PATH: "/t3-group-missing" },
        };
        const held = holdProcessGroup(launch, { fd: 3, endGroupAfterSeconds: 5 })!;
        const child = NodeChildProcess.spawn(held.command, held.args, {
          ...spawnOptionsOf(launch),
          stdio: ["ignore", "pipe", "inherit", "pipe"],
        });
        const exit = exitOf(child);
        const ready = new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
        yield* Effect.promise(() => ready);
        holderPipe(child, 3).resume().end();

        expect(yield* exit).toBe(3);
      }),
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

    it.live(
      "runs the command unheld and unchanged when its FIFO cannot be made and it has no pipe",
      () =>
        Effect.gen(function* () {
          const fifo = NodePath.join(yield* tempDir, "missing", "holder");
          const held = holdProcessGroup(
            { command: "sh", args: ["-c", "exit 7"] },
            { fd: 3, fifo },
          )!;
          const child = NodeChildProcess.spawn(held.command, held.args, {
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let errors = "";
          child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
          const exit = new Promise<number | null>((resolve) => child.once("close", resolve));

          expect(yield* Effect.promise(() => exit)).toBe(7);
          expect(errors).toBe("");
          expect(isFifoHolderHeld(fifo)).toBe(false);
        }).pipe(Effect.scoped),
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
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32" || !holds)(
  "layerHeldProcessGroups",
  () => {
    const spawner = Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
      Effect.provide(layerHeldProcessGroups.pipe(Layer.provideMerge(NodeServices.layer))),
    );

    // Effect's spawner signals the group of a failed command as it exits and as its scope closes,
    // after the finalizers its caller added once it started, which may signal the group too.
    it.live.each([
      { case: "through its pipe", fifo: [] },
      { case: "through its FIFO", fifo: ["holder"] },
      { case: "through its pipe where its FIFO cannot be made", fifo: ["missing", "holder"] },
    ])(
      "keeps a failed command's group number through every signal after its exit, $case",
      ({ fifo }) =>
        Effect.gen(function* () {
          const dir = yield* tempDir;
          const freed = yield* watchFreedGroupSignals;
          const run = Effect.gen(function* () {
            const handle = yield* (yield* spawner).spawn(ChildProcess.make("sh", ["-c", "exit 3"]));
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => errorCode(() => signalProcessGroup(handle.pid, "SIGKILL"))),
            );
            return yield* handle.exitCode;
          });
          const holder = fifo.length === 0 ? undefined : { fifo: NodePath.join(dir, ...fifo) };

          expect(
            yield* Effect.scoped(run).pipe(Effect.provideService(HoldThroughFifo, holder)),
          ).toBe(3);
          expect(freed.signals()).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.live("signals a spawned group only while its number is still ours", () =>
      Effect.gen(function* () {
        const freed = yield* watchFreedGroupSignals;
        const plain = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
          Effect.provide(NodeServices.layer),
        );
        const unheld = yield* plain.spawn(
          ChildProcess.make("sh", ["-c", "exit 0"], { detached: true }),
        );
        const held = yield* (yield* spawner).spawn(
          ChildProcess.make("sh", ["-c", "sleep 600 & exit 0"], { detached: true }),
        );
        yield* unheld.exitCode;
        yield* held.exitCode;

        expect(yield* signalSpawnedGroup(unheld, "SIGKILL")).toBe(false);
        expect(yield* signalSpawnedGroup(held, "SIGKILL")).toBe(true);
        // The leftover sleep keeps stdout open until the signal ends it.
        yield* Stream.runDrain(held.stdout);
        expect(freed.signals()).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("lets the holder of a spawn interrupted while it started go", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const starting = ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
            Effect.as(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.ensuring(Sink.drain, Deferred.succeed(released, undefined)),
                getOutputFd: () => Stream.empty,
              }),
            ),
          ),
        );
        const held = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
          Effect.provide(
            layerHeldProcessGroups.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, starting)),
            ),
          ),
        );
        const fiber = yield* Effect.forkChild(
          Effect.scoped(held.spawn(ChildProcess.make("sh", ["-c", "exit 0"]))),
        );
        yield* Deferred.await(started);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber), {
          startImmediately: true,
        });
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(interrupted);

        expect(yield* Deferred.isDone(released)).toBe(true);
      }),
    );

    it.live("signals no group once its holder's beacon ended, though its scope is open", () =>
      Effect.gen(function* () {
        const freed = yield* watchFreedGroupSignals;
        const reaped = NodeChildProcess.spawn("true", { stdio: "ignore" });
        yield* exitOf(reaped);
        const quitHolder = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(reaped.pid!),
              exitCode: Effect.never,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const held = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
          Effect.provide(
            layerHeldProcessGroups.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, quitHolder)),
            ),
          ),
        );
        const handle = yield* held.spawn(ChildProcess.make("sh", ["-c", "exit 0"]));

        expect(yield* signalSpawnedGroup(handle, "SIGKILL")).toBe(false);
        expect(freed.signals()).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.live("leaves the command the file descriptors it was given", () =>
      Effect.gen(function* () {
        const handle = yield* (yield* spawner).spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              "echo three >&3; (true >&4) 2>/dev/null && echo four >&3; (true >&5) 2>/dev/null && echo five >&3",
            ],
            { additionalFds: { fd3: { type: "output" } } },
          ),
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
  },
);
