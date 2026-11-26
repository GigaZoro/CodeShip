// @effect-diagnostics nodeBuiltinImport:off - the Git version probe runs synchronously at load.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { afterAll } from "vite-plus/test";

export const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
export const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

export const makeUnreadableConfigHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(
      Stream.make("fatal: unknown error occurred while reading the configuration files"),
    ),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

export const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

export const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

// Releases the lock as soon as a matching git command fails on it, before the driver retries.
export const makeDriverReleasingLock = (
  matches: (args: ReadonlyArray<string>) => boolean,
  lockPath: string,
) =>
  Effect.gen(function* () {
    const failures = yield* Ref.make(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const handle = yield* delegate.spawn(command);
        if (!ChildProcess.isStandardCommand(command) || !matches(command.args.map(String)))
          return handle;
        return ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: handle.exitCode.pipe(
            Effect.tap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Ref.update(failures, (count) => count + 1).pipe(
                    Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                    Effect.orDie,
                  ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    return { driver, failures };
  });

export const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

export const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

// Each test copies the suite's initial commit, including its private refs, index and hooks.
const seedScope = Scope.makeUnsafe();
afterAll(() => Effect.runPromise(Scope.close(seedScope, Exit.void)));

export const commitInitialRepo = (cwd: string, initArgs: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    yield* git(cwd, ["init", ...initArgs]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    // Newer Git detaches auto-maintenance after commit; its lock file would race the copy.
    yield* git(cwd, ["config", "maintenance.auto", "false"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    return { initialBranch: yield* git(cwd, ["branch", "--show-current"]) };
  });

const seedRepository = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const directory = yield* makeTmpDir("git-vcs-seed-");
      const { initialBranch } = yield* commitInitialRepo(directory);
      return { directory, initialBranch };
    }).pipe(Effect.provide(layerTest), Scope.provide(seedScope)),
  ),
);

export const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if ((yield* fileSystem.exists(cwd)) && (yield* fileSystem.readDirectory(cwd)).length > 0)
      return yield* commitInitialRepo(cwd);
    const seed = yield* seedRepository;
    yield* fileSystem.copy(seed.directory, cwd);
    return { initialBranch: seed.initialBranch };
  });

const [, gitMajor, gitMinor] =
  /(\d+)\.(\d+)/u.exec(NodeChildProcess.execFileSync("git", ["--version"], { encoding: "utf8" })) ??
  [];
export const gitHasReftable =
  Number(gitMajor) > 2 || (Number(gitMajor) === 2 && Number(gitMinor) >= 45);

export const gitWithStdin = (
  cwd: string,
  args: ReadonlyArray<string>,
  stdin: string,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "GitVcsDriver.test.git", cwd, args, stdin, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

// Git blocks file submodule transports (CVE-2022-39253) despite repo config; local fixtures need env permission.
export const withGitFileProtocol = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(HostProcess.Environment, (env) =>
    effect.pipe(
      Effect.provideService(HostProcess.Environment, { ...env, GIT_ALLOW_PROTOCOL: "file" }),
    ),
  );
