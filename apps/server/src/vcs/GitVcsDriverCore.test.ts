// @effect-diagnostics nodeBuiltinImport:off - real Git and child process integration fixtures exercise the native spawn boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  GitCommandError,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ReviewDiffPreviewInput,
  type ReviewDiffFileContentsInput,
} from "@t3tools/contracts";
import * as WorkerProcessSpawner from "../process/WorkerProcessSpawner.ts";
import {
  GIT_REMOTE_TIMED_OUT_DETAIL,
  isNonRepositoryGitStderr,
  makeGitVcsDriverCore,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { VcsAutomaticFetchInterval } from "./VcsAutomaticFetchInterval.ts";
import { gitConfigEnv } from "./VcsProcess.ts";
import {
  layerServerConfig,
  layerTest,
  makeNonRepositoryHandle,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
  makeFailedHandle,
  gitHasReftable,
  withGitFileProtocol,
  commitInitialRepo,
} from "./GitVcsDriverCore.testkit.ts";

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as Tracer from "effect/Tracer";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import { autoPullProjects } from "../serverRuntimeStartup.ts";

// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

describe("isNonRepositoryGitStderr", () => {
  it.each([
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: not a git repository: /missing-git-directory",
    // Git 2.56+ wording for a `.git` gitfile that points at a missing directory.
    "fatal: gitfile does not point to a valid repository: /tmp/worktrees/feature/.git",
    "FATAL: GITFILE DOES NOT POINT TO A VALID REPOSITORY: /tmp/x/.git",
  ])("classifies %j as a non-repository", (stderr) => {
    assert.isTrue(isNonRepositoryGitStderr(stderr));
  });

  it.each([
    "",
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "fatal: invalid gitfile format: /repo/.git",
  ])("does not classify %j as a non-repository", (stderr) => {
    assert.isFalse(isNonRepositoryGitStderr(stderr));
  });
});

describe("Git output collection", () => {
  // Git writes in arbitrary chunk sizes; one byte per chunk splits every
  // multibyte character across reads.
  const byteChunks = (text: string) =>
    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
  const makeDriver = (output: { stdout?: string; stderr?: string }) =>
    makeGitVcsDriverCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              stdout: byteChunks(output.stdout ?? ""),
              stderr: byteChunks(output.stderr ?? ""),
            }),
          ),
        ),
      ),
    );

  it.effect("returns the same split UTF-8 and NUL output with and without line callbacks", () =>
    Effect.gen(function* () {
      const stdout = "a\\b\0雪\nlast ";
      const stderr = "Receiving é\r\nUpdating 雪\rdone";
      const driver = yield* makeDriver({ stdout, stderr });
      const input = { operation: "test.chunkedGitOutput", cwd: "/repo", args: ["status"] };
      const expected = {
        exitCode: 0,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };

      assert.deepEqual(yield* driver.execute(input), expected);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const withCallbacks = yield* driver.execute({
        ...input,
        progress: {
          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
        },
      });
      assert.deepEqual(withCallbacks, expected);
      assert.deepEqual(stdoutLines, ["a\\b\0雪", "last "]);
      assert.deepEqual(stderrLines, ["Receiving é", "Updating 雪", "done"]);
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("caps output without line callbacks", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver({ stderr: "é雪\rdone" });
      const input = {
        operation: "test.cappedGitOutput",
        cwd: "/repo",
        args: ["status"],
        maxOutputBytes: 3,
      };

      const truncated = yield* driver.execute({ ...input, appendTruncationMarker: true });
      assert.equal(truncated.stderr, "é\uFFFD");
      assert.isTrue(truncated.stderrTruncated);

      const error = yield* driver.execute(input).pipe(Effect.flip);
      assert.equal(error.outputLength, 4);
      assert.include(error.detail, "exceeded 3 bytes");
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});

it.effect("retries a fetch that lost a ref update to another Git process", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
        if (attempt > 1) return makeSuccessfulHandle("");
        return ChildProcessSpawner.makeHandle({
          ...makeNonRepositoryHandle(),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          stderr: Stream.encodeText(
            Stream.make(
              "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "main" });
    assert.equal(yield* Ref.get(attempts), 2);
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("does not fetch for status when the branch tracks a local branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
          fetches.push(command.args.map(String));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "feature", remote]);
      yield* git(cwd, ["branch", "feature/base"]);
      yield* git(cwd, ["checkout", "-b", "stacked", "--track", "feature/base"]);

      const status = yield* driver.statusDetailsRemote(cwd);

      assert.equal(status.upstreamRef, "feature/base");
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("does not fetch for status when the automatic fetch interval is zero", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
          fetches.push(command.args.map(String));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(VcsAutomaticFetchInterval, Effect.succeed(Duration.zero)),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "--set-upstream", "origin", initialBranch]);

      yield* driver.statusDetails(cwd);
      const status = yield* driver.statusDetailsRemote(cwd);

      assert.equal(status.upstreamRef, `origin/${initialBranch}`);
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("names the credential helper that never answered when a fetch times out", () =>
  Effect.gen(function* () {
    const helperStarted = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        const traceFile = command.options.env?.GIT_TRACE2_EVENT;
        if (typeof traceFile !== "string") return yield* Effect.die("expected a trace2 file");
        NodeFS.appendFileSync(
          traceFile,
          `${JSON.stringify({
            event: "child_start",
            sid: "remote-https",
            child_id: 0,
            child_class: "?",
            use_shell: true,
            argv: ["/home/me/bin/git-credential-hang get"],
          })}\n`,
        );
        yield* Deferred.succeed(helperStarted, undefined);
        return ChildProcessSpawner.makeHandle({
          ...makeNonRepositoryHandle(),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          stderr: Stream.empty,
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();

    const fetch = yield* driver
      .fetchRemote({ cwd, remoteName: "origin", refName: "main" })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(helperStarted);
    yield* TestClock.adjust("5 minutes");
    const error = yield* Fiber.join(fetch);

    assert.equal(error.detail, GIT_REMOTE_TIMED_OUT_DETAIL);
    assert.include(error.message, "credential helper git-credential-hang get still running after");
    assert.notInclude(error.message, "/home/me");
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect.each([
  { name: "starts from the local tracking ref", localRef: true },
  { name: "still fails the timeout when no tracking ref exists", localRef: false },
] as const)("a worktree base fetch that times out $name", ({ localRef }) =>
  Effect.gen(function* () {
    const fetchStarted = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] === "fetch") {
          yield* Deferred.succeed(fetchStarted, undefined);
          return ChildProcessSpawner.makeHandle({
            ...makeNonRepositoryHandle(),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            stderr: Stream.empty,
          });
        }
        if (command.args[0] === "rev-parse" && localRef) return makeSuccessfulHandle("abc123\n");
        return makeNonRepositoryHandle();
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();

    const result = yield* driver
      .fetchWorktreeBaseCommit({
        cwd,
        refName: "main",
        remote: { remoteName: "origin", branchName: "main" },
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(fetchStarted);
    yield* TestClock.adjust("5 minutes");
    const outcome = yield* Fiber.join(result);

    if (localRef) {
      assert.deepEqual(
        outcome,
        Result.succeed({ commitSha: "abc123", remoteRefName: "origin/main" }),
      );
    } else {
      assert.equal(
        Result.isFailure(outcome) && outcome.failure.detail,
        GIT_REMOTE_TIMED_OUT_DETAIL,
      );
    }
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("lets a worktree checkout that is still working run past five minutes", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const checkoutFinished = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (!command.args.includes("worktree") || command.args.includes("-h"))
          return makeSuccessfulHandle("");
        yield* Deferred.succeed(checkoutStarted, undefined);
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulHandle(""),
          exitCode: Deferred.await(checkoutFinished).pipe(
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
          stderr: Stream.encodeText(
            Stream.concat(
              Stream.make("Updating files:  40% (49052/122629)\n"),
              Stream.fromEffect(
                Deferred.await(checkoutFinished).pipe(
                  Effect.as("Updating files: 100% (122629/122629), done.\n"),
                ),
              ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const path = yield* Path.Path;
    const cwd = yield* makeTmpDir();
    const worktreePath = path.join(cwd, "worktree");

    const creation = yield* driver
      .createWorktree({ cwd, refName: "main", newRefName: "t3/slow-checkout", path: worktreePath })
      .pipe(Effect.forkChild);
    yield* Deferred.await(checkoutStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Deferred.succeed(checkoutFinished, undefined);

    const result = yield* Fiber.join(creation);
    assert.equal(result.worktree.path, worktreePath);
    assert.equal(result.worktree.refName, "t3/slow-checkout");
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("cancels a slow submodule checkout without reporting best-effort success", () =>
  Effect.gen(function* () {
    const updateStarted = yield* Deferred.make<void>();
    const updateStopped = yield* Deferred.make<void>();
    const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
    const claimed = yield* Ref.make<string | null>(null);
    const spawner = ChildProcessSpawner.make((command) => {
      if (
        ChildProcess.isStandardCommand(command) &&
        command.args[0] === "submodule" &&
        command.args[1] === "update"
      ) {
        return Effect.acquireRelease(
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.succeed(updateStarted, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            }),
          ),
          () => Deferred.succeed(updateStopped, undefined),
        );
      }
      return Effect.succeed(makeSuccessfulHandle(""));
    });
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const path = yield* Path.Path;
    const worktreePath = path.join(cwd, "worktree");
    yield* writeTextFile(worktreePath, ".gitmodules", "");
    const creation = yield* driver
      .createWorktree(
        { cwd, refName: "main", newRefName: "bugfix/cancel-submodules", path: worktreePath },
        {
          progress: {
            onWorktreeClaimed: (value) => Ref.set(claimed, value),
            onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
          },
        },
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(updateStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Fiber.interrupt(creation);
    const exit = yield* Fiber.await(creation);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isTrue(yield* Deferred.isDone(updateStopped));
    assert.equal(yield* Ref.get(claimed), worktreePath);
    assert.isEmpty(yield* Ref.get(finished));
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect.each(["healthy", "hung"] as const)("bounds a %s remote fetch at five minutes", (fetch) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        ChildProcess.isStandardCommand(command) && command.args[0] === "fetch"
          ? ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finished)),
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            })
          : makeNonRepositoryHandle(),
      ),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const fetching = yield* driver
      .fetchRemote({ cwd: yield* makeTmpDir(), remoteName: "origin" })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* TestClock.adjust("31 seconds");
    if (fetch === "healthy") yield* Deferred.succeed(finished, undefined);
    else {
      yield* TestClock.adjust("268 seconds");
      assert.isUndefined(fetching.pollUnsafe());
      yield* TestClock.adjust("1 second");
    }

    const result = yield* Fiber.join(fetching);
    assert.equal(
      Result.isFailure(result) ? result.failure.detail : "fetched",
      fetch === "healthy" ? "fetched" : GIT_REMOTE_TIMED_OUT_DETAIL,
    );
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

describe("rejected git refs", () => {
  const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";
  const failedPush = `error: failed to push some refs to '${remoteUrl}'`;
  const leakedText = [
    "token-123",
    "secret-repo",
    "git.example.invalid",
    "private-branch",
    "workflow scope",
  ];

  const failWith = (stderr: string) => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
    const layer = Layer.effect(GitVcsDriver.GitVcsDriver, GitVcsDriver.make).pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver
        .execute({
          operation: "GitVcsDriver.test.rejectedRef",
          cwd: "/repo",
          args: ["push", "origin", "HEAD"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    {
      label: "a ref the remote refused",
      stderr: [
        "remote: Unable to determine if workflow can be created; workflow scope may be required.",
        `To ${remoteUrl}`,
        " ! [remote rejected] private-branch -> private-branch (workflow scope may be required.)",
        failedPush,
      ],
      reason: "push_rejected_by_remote" as const,
      detail: "The remote rejected the push.",
    },
    {
      label: "a non-fast-forward push",
      stderr: [
        `To ${remoteUrl}`,
        " ! [rejected]        private-branch -> private-branch (non-fast-forward)",
        failedPush,
      ],
      reason: "push_rejected_non_fast_forward" as const,
      detail: "Pull or rebase",
    },
  ])("names $label without quoting stderr", ({ stderr, reason, detail }) =>
    Effect.gen(function* () {
      const error = yield* failWith(stderr.join("\n"));

      assert.deepInclude(error, { reason });
      assert.include(error.detail, detail);
      for (const text of leakedText) assert.notInclude(error.message, text);
    }),
  );

  // A fetch into a diverged local branch prints the same rejected line, but
  // never "failed to push some refs".
  it.effect("leaves a rejected fetch unclassified", () =>
    Effect.gen(function* () {
      const error = yield* failWith(
        [`From ${remoteUrl}`, " ! [rejected]        main       -> side  (non-fast-forward)"].join(
          "\n",
        ),
      );

      assert.equal(error.reason, undefined);
      assert.equal(error.detail, "Git command exited with a non-zero status.");
    }),
  );
});

it.live("returns the result of a command that exited while the event loop was blocked", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.blockedPastDeadline",
      cwd,
      args: ["-c", "alias.pause=!sleep 0.1", "pause"],
      timeoutMs: 500,
      progress: {
        // In the check phase, as a busy server's work is, so its timers run before the next poll.
        onProcessStarted: () =>
          Effect.sync(() => {
            setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000));
          }),
      },
    });
    assert.equal(result.exitCode, 0);
  }).pipe(Effect.provide(layerTest)),
);

// Process creation blocks its calling thread for as long as it takes, so none may run on this one.
const countMainThreadSpawns = Effect.acquireRelease(
  Effect.sync(() => {
    const childProcess = NodeModule.createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof NodeChildProcess;
    const original = childProcess.spawn;
    const counter = { calls: 0 };
    childProcess.spawn = function (this: unknown, ...args: ReadonlyArray<unknown>) {
      counter.calls++;
      return Reflect.apply(original, this, args);
    } as typeof original;
    NodeModule.syncBuiltinESMExports();
    return { counter, restore: () => (childProcess.spawn = original) };
  }),
  ({ restore }) =>
    Effect.sync(() => {
      restore();
      NodeModule.syncBuiltinESMExports();
    }),
).pipe(Effect.map(({ counter }) => counter));

it.live("starts a command off the event loop while process creation is slow", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const mainThreadSpawns = yield* countMainThreadSpawns;
    yield* WorkerProcessSpawner.__testing.slowStarts(1_000);

    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.slowProcessCreation",
      cwd,
      args: ["--version"],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(mainThreadSpawns.calls, 0);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

describe("Windows long path configuration", () => {
  const readGitConfig = Effect.fn("readGitConfig")(function* (
    platform: NodeJS.Platform,
    key: string,
  ) {
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    );
    return yield* Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir("git-longpath-test-");
      const result = yield* driver.execute({
        operation: "GitVcsDriverTest.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "inherited-name",
          GIT_CONFIG_KEY_1: "core.longpaths",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "user.name",
          GIT_CONFIG_VALUE_2: "outside-count",
        },
      });
      return result.stdout.trim();
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("enables long paths for every Git command on Windows", () =>
    Effect.gen(function* () {
      assert.equal(yield* readGitConfig("win32", "core.longpaths"), "true");
      assert.equal(yield* readGitConfig("win32", "user.name"), "inherited-name");
    }),
  );

  it("extends the per-command count when inherited and per-command casings differ", () => {
    assert.deepStrictEqual(
      windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: "0", git_config_count: "1" }),
      {
        GIT_CONFIG_COUNT: "2",
        git_config_count: "2",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
    );
  });

  it("reads only the exact count name outside Windows", () => {
    assert.deepStrictEqual(
      gitConfigEnv({ git_config_count: "3" }, "safe.bareRepository", "explicit", "linux"),
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.bareRepository",
        GIT_CONFIG_VALUE_0: "explicit",
      },
    );
  });

  it("appends after inherited entries, parsing the count as Git does", () => {
    for (const [count, next] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-0", 0],
      ["2", 2],
      [" 2", 2],
      ["+2", 2],
      ["02", 2],
    ] as const) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", count === undefined ? {} : { GIT_CONFIG_COUNT: count }),
        {
          GIT_CONFIG_COUNT: String(next + 1),
          [`GIT_CONFIG_KEY_${next}`]: "core.longpaths",
          [`GIT_CONFIG_VALUE_${next}`]: "true",
        },
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });

  // regression: #14917 Windows worktrees with long paths failed or stranded
  it("leaves a count Git would reject for Git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: count }),
        {},
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });
});

it.layer(layerTest)("branch change totals after a failed untracked listing", (it) => {
  it.effect("do not list untracked files again on every status read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTmpDir("git-untracked-totals-");
      yield* initRepoWithCommit(cwd);
      const many = path.join(cwd, "many");
      yield* fs.makeDirectory(many);
      yield* Effect.forEach(
        Array.from({ length: 5_001 }, (_, index) => index),
        (index) => fs.writeFileString(path.join(many, `file-${index}`), ""),
        { concurrency: 64, discard: true },
      );

      let listings = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("ls-files") &&
            command.args.includes("--others")
          )
            listings++;
          return delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.strictEqual((yield* read).branchChanges, undefined, "too many files to count");
      assert.strictEqual(listings, 1);
      yield* read;
      yield* read;
      assert.strictEqual(listings, 1, "the failed listing is not repeated within the backoff");

      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "it is retried once the backoff passes");
      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "and the next backoff is longer");

      // A change at the untracked-roots level scans again at once and counts again.
      yield* fs.remove(many, { recursive: true });
      yield* writeTextFile(cwd, "notes.txt", "one\ntwo\n");
      const status = yield* read;
      assert.strictEqual(listings, 3);
      assert.deepInclude(status.branchChanges, { baseRef: null, insertions: 2, deletions: 0 });
    }),
  );
});

it.effect("runs background Git in its own lane so user commands never queue behind it", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const starts = yield* Queue.unbounded<string>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        yield* Queue.offer(
          starts,
          ChildProcess.isStandardCommand(command) ? String(command.args[0]) : "",
        );
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulHandle("ok"),
          exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    const run = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "test.gitLane", cwd: "/repo", args: [...args] });
    const background = yield* Effect.forEach(
      Array.from({ length: 12 }),
      () => run(["background"]),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.provideService(GitVcsDriver.BackgroundGitWork, true), Effect.forkChild);
    const foreground = yield* Effect.forEach(Array.from({ length: 4 }), () => run(["foreground"]), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild);

    yield* TestClock.adjust("2 seconds");
    const started = yield* Queue.takeAll(starts);
    assert.deepStrictEqual([...started].toSorted(), [
      "background",
      "background",
      "foreground",
      "foreground",
      "foreground",
      "foreground",
    ]);
    yield* Deferred.succeed(gate, undefined);
    assert.equal((yield* Fiber.join(background)).length, 12);
    assert.equal((yield* Fiber.join(foreground)).length, 4);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["root", "nested", "worktree"] as const)(
  "skips clean filters while the %s index is locked and resumes after unlock",
  (location) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* makeTmpDir();
      yield* initRepoWithCommit(repository);
      const cwd = location === "worktree" ? yield* makeTmpDir() : repository;
      if (location === "worktree") {
        yield* git(repository, ["worktree", "add", "--detach", cwd]);
      }
      yield* git(cwd, ["config", "filter.probe.clean", "echo clean >> .filter-runs; cat"]);
      yield* writeTextFile(cwd, ".gitattributes", "asset.bin filter=probe\n");
      yield* writeTextFile(cwd, ".gitignore", ".filter-runs\n");
      yield* writeTextFile(cwd, "asset.bin", "original\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "filtered asset"]);
      NodeFS.utimesSync(path.join(cwd, "asset.bin"), 1, 1);
      const runsPath = path.join(cwd, ".filter-runs");
      yield* fs.remove(runsPath, { force: true });
      const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const lockPath = `${path.resolve(cwd, indexPath)}.lock`;
      yield* fs.writeFileString(lockPath, "");
      const statusCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
      yield* fs.makeDirectory(statusCwd, { recursive: true });

      for (let poll = 0; poll < 3; poll++) {
        const result = yield* driver.statusDetailsLocal(statusCwd).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(result.failure.detail, "index is locked");
      }
      assert.isFalse(yield* fs.exists(runsPath));
      assert.isTrue(yield* fs.exists(lockPath));

      yield* fs.remove(lockPath);
      const status = yield* driver.statusDetailsLocal(statusCwd);
      assert.isFalse(status.hasWorkingTreeChanges);
      assert.include(yield* fs.readFileString(runsPath), "clean");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["origin", "github"] as const)(
  "recognizes %s as the primary remote after a driver mutation",
  (remoteName) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);

      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);
      assert.equal((yield* driver.listRefs({ cwd })).hasPrimaryRemote, false);

      yield* driver.ensureRemote({ cwd, preferredName: remoteName, url: remote });

      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, true);
      assert.equal((yield* driver.listRefs({ cwd })).hasPrimaryRemote, true);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { hookExitCode: 0, commonDirFailure: "none" },
  { hookExitCode: 1, commonDirFailure: "none" },
  { hookExitCode: 0, commonDirFailure: "error" },
  { hookExitCode: 1, commonDirFailure: "error" },
  { hookExitCode: 0, commonDirFailure: "non-repository" },
  { hookExitCode: 1, commonDirFailure: "non-repository" },
])(
  "invalidates sibling worktree refs and status after checkout hook exit $hookExitCode with common-dir failure $commonDirFailure",
  ({ hookExitCode, commonDirFailure }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        let invalidationFailure = "none";
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            spawnedArgs.push(command.args.map(String));
            if (invalidationFailure !== "none" && command.args.includes("--git-common-dir")) {
              if (invalidationFailure === "non-repository") return makeNonRepositoryHandle();
              return ChildProcessSpawner.makeHandle({
                ...makeNonRepositoryHandle(),
                stderr: Stream.encodeText(Stream.make("fatal: could not read repository metadata")),
              });
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const siblingPath = path.join(yield* makeTmpDir("git-worktrees-"), "sibling");
        yield* git(cwd, ["worktree", "add", "-b", "cache-sibling", siblingPath, "HEAD"]);

        const before = yield* driver.listRefs({ cwd: siblingPath, refresh: true });
        assert.isTrue(before.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusBefore = yield* driver.statusDetailsLocal(siblingPath);
        assert.isFalse(statusBefore.hasOriginRemote);
        assert.isFalse(statusBefore.isDefaultBranch);
        yield* driver.listRefs({ cwd, refresh: true });
        yield* git(cwd, ["checkout", "-b", "creator-current"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\n" +
            "git remote add origin https://example.invalid/repo.git || exit 2\n" +
            "git update-ref refs/remotes/origin/cache-sibling HEAD || exit 2\n" +
            "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/cache-sibling || exit 2\n" +
            `exit ${hookExitCode}\n`,
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "created");
        spawnedArgs.length = 0;
        invalidationFailure = commonDirFailure;

        const created = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/cache-created",
          })
          .pipe(Effect.result);

        assert.equal(Result.isSuccess(created), hookExitCode === 0);
        if (Result.isFailure(created)) {
          assert.equal(created.failure.operation, "GitVcsDriver.createWorktree");
          assert.equal(created.failure.detail, "git worktree add failed");
          assert.equal(created.failure.exitCode, hookExitCode);
        }
        const metadataQueries = spawnedArgs.filter((args) => args.includes("--git-common-dir"));
        assert.deepStrictEqual(
          metadataQueries,
          Array.from({ length: 2 }, () => ["rev-parse", "--git-common-dir"]),
        );
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        invalidationFailure = "none";

        spawnedArgs.length = 0;
        const creatorStatus = yield* driver.statusDetailsLocal(cwd);
        assert.equal(creatorStatus.branch, "creator-current");
        assert.isTrue(spawnedArgs.some((args) => args.includes("--git-common-dir")));
        const siblingRefs = yield* driver.listRefs({ cwd: siblingPath });
        const createdRef = siblingRefs.refs.find((ref) => ref.name === "feature/cache-created");
        assert.isDefined(createdRef?.worktreePath);
        assert.equal(
          NodeFS.realpathSync.native(createdRef!.worktreePath!),
          NodeFS.realpathSync.native(worktreePath),
        );
        assert.isTrue(siblingRefs.hasPrimaryRemote);
        assert.isTrue(siblingRefs.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusAfter = yield* driver.statusDetailsLocal(siblingPath);
        assert.isTrue(statusAfter.hasOriginRemote);
        assert.isTrue(statusAfter.isDefaultBranch);
        const creatorRefs = yield* driver.listRefs({ cwd });
        assert.isTrue(creatorRefs.refs.find((ref) => ref.name === "creator-current")?.current);
        assert.isFalse(creatorRefs.refs.find((ref) => ref.name === initialBranch)?.current);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["branch", "detached", "nested", "aliased-root", "aliased-nested"] as const)(
  "discovers only the common directory during worktree creation from %s",
  (location) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        if (location === "detached") yield* git(cwd, ["checkout", "--detach"]);
        const isNested = location === "nested" || location === "aliased-nested";
        const physicalCwd = isNested ? path.join(cwd, "nested") : cwd;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(physicalCwd, { recursive: true });
        const isAliased = location === "aliased-root" || location === "aliased-nested";
        const creationCwd = isAliased
          ? path.join(yield* makeTmpDir("git-alias-"), "link")
          : physicalCwd;
        if (isAliased) NodeFS.symlinkSync(physicalCwd, creationCwd, "junction");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "cold");

        yield* driver.createWorktree({
          cwd: creationCwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/cold",
        });

        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 2);
        assert.isFalse(spawnedArgs.some((args) => args.includes("--show-toplevel")));
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        spawnedArgs.length = 0;
        const originalStatus = yield* driver.statusDetailsLocal(creationCwd);
        assert.equal(originalStatus.branch, location === "detached" ? null : initialBranch);
        const originalRefs = yield* driver.listRefs({ cwd: creationCwd });
        assert.equal(originalRefs.isAtRepositoryRoot, !isNested);
        assert.deepStrictEqual(
          originalRefs.refs.filter((ref) => ref.current).map((ref) => ref.name),
          location === "detached" ? [] : [initialBranch],
        );
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        const refs = yield* driver.listRefs({ cwd: worktreePath });
        assert.isTrue(refs.refs.find((ref) => ref.name === "feature/cold")?.current);
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("reads the project's own repository when the server inherited GIT_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* makeTmpDir();
      const other = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* initRepoWithCommit(other);
      yield* git(other, ["switch", "-c", "other-repository"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, initialBranch);
      const refs = yield* driver.listRefs({ cwd });
      assert.isFalse(refs.refs.some((ref) => ref.name === "other-repository"));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("reads a branch whose name starts with a parenthesis as attached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["switch", "-c", "(topic"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const status = yield* driver.statusDetailsLocal(cwd, { includeDivergence: false });
      assert.equal(status.branch, "(topic");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["an existing", "a new"] as const)(
  "follows a checkout of %s branch made outside the driver after refs were cached",
  (branch) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        if (branch === "an existing") yield* git(cwd, ["branch", "feature/outside"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.listRefs({ cwd });

        yield* git(
          cwd,
          branch === "an existing"
            ? ["switch", "feature/outside"]
            : ["switch", "-c", "feature/outside"],
        );

        const refs = (yield* driver.listRefs({ cwd })).refs;
        const previous = refs.find((ref) => ref.name === initialBranch);
        assert.isTrue(refs.find((ref) => ref.name === "feature/outside")?.current);
        assert.isFalse(previous?.current);
        assert.isNull(previous?.worktreePath ?? null);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { kind: "working-tree", request: { sourceKind: "working-tree" } },
  { kind: "commit", request: { sourceKind: "commit", commitSha: "HEAD" } },
] as const)("keeps $kind review requests safe without a worktree root", ({ request }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bareRoot = yield* makeTmpDir("git-review-bare-");
      const spawner = ChildProcessSpawner.make((command) =>
        delegate.spawn(
          ChildProcess.isStandardCommand(command) && command.options.cwd === bareRoot
            ? ChildProcess.setEnv(command, { GIT_DIR: bareRoot })
            : command,
        ),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const path = yield* Path.Path;
      const file = { path: "README.md", previousPath: null, sourceKind: request.sourceKind };
      const input = (cwd: string) => ({
        cwd,
        file,
        ...("commitSha" in request ? { commitSha: request.commitSha } : {}),
      });
      const source = yield* makeTmpDir();
      yield* initRepoWithCommit(source);
      yield* git(source, ["clone", "--bare", source, bareRoot]);
      const nonRepository = yield* makeTmpDir();
      for (const cwd of [bareRoot, nonRepository, path.join(nonRepository, "missing")]) {
        assert.isEmpty((yield* driver.getReviewDiffPreview(input(cwd))).sources);
      }

      const brokenConfig = yield* makeTmpDir();
      yield* initRepoWithCommit(brokenConfig);
      yield* writeTextFile(brokenConfig, ".git/config", "[broken");
      const error = yield* driver.getReviewDiffPreview(input(brokenConfig)).pipe(Effect.flip);
      assert.equal(error.operation, "GitVcsDriver.resolveRepositoryPaths.commonDir");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves embedded newlines in repository paths after worktree creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const cwd = path.join(yield* makeTmpDir(), "repo\nwith-newline");
        yield* fs.makeDirectory(cwd);
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "newline");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/newline",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/newline"));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves a trailing carriage return in the repository root after creation through an alias",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const sandbox = yield* makeTmpDir();
        const repository = path.join(sandbox, "repo\r");
        const cwd = path.join(sandbox, "alias");
        yield* fs.makeDirectory(repository);
        const { initialBranch } = yield* initRepoWithCommit(repository);
        NodeFS.symlinkSync(repository, cwd, "junction");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "created"),
          refName: initialBranch,
          newRefName: "feature/carriage-return",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(repository));
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isAtRepositoryRoot);
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/carriage-return"));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reads fresh metadata when another mutation completes during common-directory discovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const discoveryComplete = yield* Deferred.make<void>();
        const releaseDiscovery = yield* Deferred.make<void>();
        let holdDiscovery = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (
              !holdDiscovery ||
              !ChildProcess.isStandardCommand(command) ||
              !command.args.includes("--git-common-dir")
            )
              return handle;
            holdDiscovery = false;
            const output = yield* Stream.runCollect(handle.stdout);
            yield* handle.exitCode;
            yield* Deferred.succeed(discoveryComplete, undefined);
            yield* Deferred.await(releaseDiscovery);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              stdout: Stream.fromIterable(output),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* driver.listRefs({ cwd, refresh: true });
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "concurrent");
        holdDiscovery = true;
        const creation = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/concurrent",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.gen(function* () {
          yield* Deferred.await(discoveryComplete);
          yield* driver.switchRef({ cwd, refName: commit });
        }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
        const created = yield* Fiber.join(creation);
        assert.equal(created.worktree.path, worktreePath);
        const refs = yield* driver.listRefs({ cwd });
        assert.isEmpty(refs.refs.filter((ref) => ref.current));
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/concurrent"));
        assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, null);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("invalidates cached metadata after interrupted worktree creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const discoveryComplete = yield* Deferred.make<void>();
      const releaseDiscovery = yield* Deferred.make<void>();
      let holdDiscovery = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (
            !holdDiscovery ||
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("--git-common-dir")
          )
            return handle;
          holdDiscovery = false;
          const output = yield* Stream.runCollect(handle.stdout);
          yield* handle.exitCode;
          yield* Deferred.succeed(discoveryComplete, undefined);
          yield* Deferred.await(releaseDiscovery);
          return ChildProcessSpawner.makeHandle({ ...handle, stdout: Stream.fromIterable(output) });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* driver.listRefs({ cwd, refresh: true });
      yield* driver.statusDetailsLocal(cwd);
      yield* git(cwd, ["checkout", "-b", "creator-current"]);
      const path = yield* Path.Path;
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "interrupted");
      holdDiscovery = true;
      const creation = yield* driver
        .createWorktree({
          cwd,
          path: worktreePath,
          refName: "HEAD",
          newRefName: "feature/interrupted",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const cancellation = yield* Effect.gen(function* () {
        yield* Deferred.await(discoveryComplete);
        return yield* Fiber.interrupt(creation).pipe(Effect.forkChild({ startImmediately: true }));
      }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
      yield* Fiber.join(cancellation);
      const exit = yield* Fiber.await(creation);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.find((ref) => ref.name === "creator-current")?.current);
      const interruptedRef = refs.refs.find((ref) => ref.name === "feature/interrupted");
      assert.isDefined(interruptedRef?.worktreePath);
      assert.equal(
        NodeFS.realpathSync.native(interruptedRef!.worktreePath!),
        NodeFS.realpathSync.native(worktreePath),
      );
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "creator-current");
      const nextPath = path.join(yield* makeTmpDir("git-worktrees-"), "after-interruption");
      yield* driver.createWorktree({
        cwd,
        path: nextPath,
        refName: "HEAD",
        newRefName: "feature/after",
      });
      assert.isTrue(
        (yield* driver.listRefs({ cwd })).refs.some((ref) => ref.name === "feature/after"),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args.at(-1) === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("reads worktrees from git that rejects worktree list -z", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.36 has no `worktree list -z` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("worktree") && command.args.includes("-z")) {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(129)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.encodeText(Stream.make("error: unknown switch `z'")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      const worktreePath = NodeFS.realpathSync.native(yield* makeTmpDir());
      yield* git(cwd, ["worktree", "add", "-b", "feature/old-git", worktreePath]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const listedPath = refs.refs.find((ref) => ref.name === "feature/old-git")?.worktreePath;
      assert.equal(listedPath && NodeFS.realpathSync.native(listedPath), worktreePath);

      const paths = yield* driver.listWorktreePaths(cwd);
      assert.include(
        paths.map((listed) => NodeFS.realpathSync.native(listed)),
        worktreePath,
      );
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("commits selected files with git that rejects --pathspec-from-file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.25 has no `add --pathspec-from-file` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("expected a standard Git command");
        }
        if (command.args.at(-1) === "version") {
          return Effect.succeed(makeSuccessfulHandle("git version 2.24.4\n"));
        }
        if (command.args.some((arg) => String(arg).startsWith("--pathspec-from-file"))) {
          return Effect.succeed(makeFailedHandle("error: unknown option `pathspec-from-file=-'"));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      yield* Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const selected = ["selected[1].txt", "-dash.txt", "with space.txt"];
        for (const file of selected) yield* writeTextFile(cwd, file, "selected\n");
        yield* writeTextFile(cwd, "left.txt", "left\n");

        yield* driver.commit(cwd, "Selected", "", { stage: { filePaths: selected } });

        assert.sameMembers(
          (yield* git(cwd, ["show", "--pretty=", "--name-only", "-z", "HEAD"]))
            .split("\0")
            .filter(Boolean),
          selected,
        );
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "?? left.txt");
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("does not report a separate git dir as the worktree of its branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const gitDir = yield* makeTmpDir();
      yield* git(cwd, ["init", `--separate-git-dir=${gitDir}`]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "init"]);

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const worktreePath = refs.refs.find((ref) => ref.current)?.worktreePath;

      assert.equal(
        worktreePath && NodeFS.realpathSync.native(worktreePath),
        NodeFS.realpathSync.native(cwd),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("Git command errors", (it) => {
  it.effect("does not retain git arguments or stderr in command failures", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });

      const secret = "secret-token-value";
      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.redactedFailure",
          cwd,
          args: ["status", `--unknown-option=${secret}`],
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.test.redactedFailure",
        command: "git",
        argumentCount: 2,
        cwd,
      });
      assert.isNumber(error.exitCode);
      assert.isAbove(error.stderrLength ?? 0, 0);
      assert.notInclude(error.detail, secret);
      assert.notInclude(error.message, secret);
      assert.notProperty(error, "args");
      assert.notProperty(error, "stderr");
      assert.notProperty(error, "reason");
    }),
  );

  it.effect("fails with a GitCommandError when spawn throws", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;

      // Over the OS argument limit, Node's spawn throws E2BIG synchronously.
      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.spawnThrow",
          cwd,
          args: ["status", "x".repeat(4 * 1024 * 1024)],
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.test.spawnThrow",
        detail: "Failed to spawn Git process.",
      });
    }),
  );

  // regression: #8645 name the cause of a failed git command
  it.effect("names the branch conflict behind a failed worktree add", () =>
    Effect.gen(function* () {
      const parent = yield* makeTmpDir();
      const pathService = yield* Path.Path;
      const cwd = pathService.join(parent, "repo");
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* initRepoWithCommit(cwd);
      const firstWorktree = pathService.join(parent, "first");
      yield* git(cwd, ["worktree", "add", firstWorktree, "-b", "shared-branch"]);

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.worktreeAddConflict",
          cwd,
          args: ["worktree", "add", pathService.join(parent, "second"), "shared-branch"],
          env: { LC_ALL: "C" },
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.test.worktreeAddConflict",
        reason: "branch_checked_out_in_worktree",
      });
      assert.include(error.message, "(branch_checked_out_in_worktree)");
      assert.notInclude(error.message, firstWorktree);
    }),
  );

  // regression: #8645 name the cause of a failed git command
  it.effect("names a missing repository behind a failed command", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.notARepository",
          cwd,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
          env: { LC_ALL: "C" },
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.test.notARepository",
        reason: "not_a_repository",
      });
      assert.include(error.message, "(not_a_repository)");
    }),
  );

  it.effect.each([
    { action: "worktree add", detail: "git worktree add failed" },
    { action: "worktree add -b", detail: "git branch failed" },
    { action: "switch", detail: "git checkout failed" },
  ])(
    "reports a missing ref during $action with stable, redacted diagnostics",
    ({ action, detail }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const refName = "private/deleted-base";
        const locales: Array<CommandLine.Word | undefined> = [];
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (
            ChildProcess.isStandardCommand(command) &&
            !command.args.includes("-h") &&
            (command.args.includes("worktree") ||
              command.args[0] === "branch" ||
              command.args[0] === "checkout")
          ) {
            locales.push(command.options.env?.LANGUAGE);
          }
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const error =
          action === "switch"
            ? yield* driver.switchRef({ cwd, refName }).pipe(Effect.flip)
            : yield* driver
                .createWorktree({
                  cwd,
                  refName,
                  ...(action === "worktree add -b" ? { newRefName: "t3/new-thread" } : {}),
                  path: path.join(cwd, "worktree"),
                })
                .pipe(Effect.flip);

        assert.deepInclude(error, { _tag: "GitCommandError", detail, reason: "ref_not_found" });
        assert.include(error.message, `${detail} (ref_not_found)`);
        assert.notInclude(error.message, refName);
        assert.notInclude(yield* encodeGitCommandError(error), refName);
        assert.deepEqual(locales, ["C"]);
        assert.notProperty(error, "stderr");
        assert.notProperty(error, "args");
      }),
  );

  it.effect("explains a non-fast-forward push from a host with a translated Git", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      const other = yield* makeTmpDir("git-other-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "--set-upstream", "origin", initialBranch]);
      yield* git(other, ["clone", "--branch", initialBranch, remote, "."]);
      yield* git(other, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "remote",
      ]);
      yield* git(other, ["push", "origin", initialBranch]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "local"]);
      const locales: Array<CommandLine.Word | undefined> = [];
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("push")) {
          locales.push(command.options.env?.LANGUAGE);
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const hostEnv = yield* HostProcess.Environment;

      const error = yield* driver
        .pushCurrentBranch(cwd, null)
        .pipe(
          Effect.provideService(HostProcess.Environment, { ...hostEnv, LANGUAGE: "de" }),
          Effect.flip,
        );

      assert.equal(error.reason, "push_rejected_non_fast_forward");
      assert.isNotEmpty(locales);
      for (const locale of locales) assert.equal(locale, "C");
    }),
  );

  it.effect("lets a slow remote branch checkout finish without blocking config writes", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature"]);
      yield* git(cwd, ["fetch", "origin"]);
      const checkoutStarted = yield* Deferred.make<void>();
      const releaseCheckout = yield* Deferred.make<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Holds the real checkout open like a slow LFS smudge filter would.
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "checkout") {
            return handle;
          }
          yield* Deferred.succeed(checkoutStarted, undefined);
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: Deferred.await(releaseCheckout).pipe(Effect.andThen(handle.exitCode)),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );

      const switching = yield* driver
        .switchRef({ cwd, refName: "origin/feature" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(checkoutStarted);
      yield* TestClock.adjust("60 seconds");
      yield* driver.createRef({ cwd, refName: "other" });
      yield* Deferred.succeed(releaseCheckout, undefined);

      const result = yield* Fiber.join(switching);
      assert.equal(result.refName, "feature");
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]),
        "origin/feature",
      );
    }),
  );

  it.effect("switches a remote ref to its tracking branch when a tag shares the branch name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/v1.2"]);
      yield* git(cwd, ["fetch", "origin"]);
      yield* git(cwd, ["branch", "--track", "v1.2", "origin/v1.2"]);
      yield* git(cwd, ["tag", "v1.2"]);
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);

      const result = yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
        cwd,
        refName: "origin/v1.2",
      });

      assert.equal(result.refName, "v1.2");
      assert.equal(yield* git(cwd, ["symbolic-ref", "HEAD"]), "refs/heads/v1.2");
    }),
  );

  it.effect.each([
    // Git cannot tell a missing revision from a missing file in these.
    { label: "an argument that may be a path", args: ["log", "-1", "missing"] },
    {
      label: "a pathspec worded like a diagnostic",
      args: ["checkout", "HEAD", "--", "fatal: invalid reference: missing"],
    },
    // The tag exists; it names a tree, which git reports in the same words.
    {
      label: "a worktree from a non-commit",
      args: ["worktree", "add", "tree-worktree", "tree-tag"],
    },
  ])("leaves $label unclassified rather than calling it a missing ref", ({ args }) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* initRepoWithCommit(cwd);
      if (args.includes("tree-tag")) {
        yield* git(cwd, ["tag", "tree-tag", "HEAD^{tree}"]);
      }

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.ambiguousMissingName",
          cwd,
          args,
          env: { LC_ALL: "C" },
        })
        .pipe(Effect.flip);

      assert.notProperty(error, "reason");
    }),
  );

  it.effect.each([
    {
      label: "a refused key",
      sshMessage: "git@example.invalid: Permission denied (publickey).",
      expectedReason: "authentication_failed" as const,
    },
    {
      label: "a refused key among several methods",
      sshMessage: "git@example.invalid: Permission denied (publickey,password).",
      expectedReason: "authentication_failed" as const,
    },
    {
      label: "a refused keyboard-interactive attempt",
      sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
      expectedReason: "authentication_failed" as const,
    },
    {
      label: "a rejected password",
      sshMessage: "Permission denied, please try again.",
      expectedReason: "authentication_failed" as const,
    },
    {
      label: "an untrusted host key",
      sshMessage: "Host key verification failed.",
      expectedReason: "host_key_unverified" as const,
    },
    {
      label: "a filesystem permission error",
      sshMessage: "fatal: cannot open backup file: Permission denied (os error 13)",
      expectedReason: "remote_unreachable" as const,
    },
  ])("classifies $label as $expectedReason", ({ sshMessage, expectedReason }) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const stderrLines: string[] = [];
      yield* git(cwd, ["init", "-q"]);
      yield* writeTextFile(cwd, "fake-ssh", `printf '%s\n' "${sshMessage}" >&2\nexit 255\n`);

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.sshFailure",
          cwd,
          args: ["fetch", "git@example.invalid:owner/repo.git"],
          env: { LC_ALL: "C", GIT_SSH_COMMAND: "sh ./fake-ssh", GIT_SSH_VARIANT: "simple" },
          progress: { onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)) },
        })
        .pipe(Effect.flip);

      assert.include(stderrLines, sshMessage);
      assert.equal(error.reason, expectedReason);
      assert.include(error.message, `(${expectedReason})`);
    }),
  );

  it.effect("reads a hook-declined push from git's rejection line, not the hook's output", () =>
    Effect.gen(function* () {
      const parent = yield* makeTmpDir();
      const pathService = yield* Path.Path;
      const remote = pathService.join(parent, "origin.git");
      const cwd = pathService.join(parent, "work");
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* fileSystem.makeDirectory(cwd);
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["init", "--bare", remote]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      const preReceive = pathService.join(remote, "hooks", "pre-receive");
      yield* writeTextFile(
        remote,
        "hooks/pre-receive",
        '#!/bin/sh\necho "authentication failed" >&2\necho "Permission denied (publickey)." >&2\necho "Host key verification failed." >&2\nexit 1\n',
      );
      yield* fileSystem.chmod(preReceive, 0o755);

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.remoteHookOutput",
          cwd,
          args: ["push", "origin", "HEAD"],
          env: { LC_ALL: "C" },
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, { reason: "push_rejected_by_remote" });
      assert.notInclude(error.message, "(authentication_failed)");
    }),
  );

  it.effect("leaves a tag collision unclassified rather than calling it a path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["tag", "v1"]);

      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.tagCollision",
          cwd,
          args: ["tag", "v1"],
          env: { LC_ALL: "C" },
        })
        .pipe(Effect.flip);

      assert.notProperty(error, "reason");
      assert.notInclude(error.message, "(path_already_exists)");
    }),
  );

  it.effect("keeps line callbacks flowing past the output cap when asked", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const lines: Array<string> = [];
      const result = yield* driver.execute({
        operation: "GitVcsDriver.test.callbacksPastCap",
        cwd,
        args: [
          "-c",
          'alias.spew=!for i in $(seq 1 128); do printf "é%03d\\n" $i >&2; done; echo fatal: last line >&2',
          "spew",
        ],
        maxOutputBytes: 512,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
      });

      assert.isTrue(result.stderrTruncated);
      assert.isAtMost(result.stderr.length, 600);
      assert.equal(lines.length, 129);
      assert.equal(lines[0], "é001");
      assert.equal(lines[127], "é128");
      assert.equal(lines.at(-1), "fatal: last line");
      assert.isFalse(lines.some((line) => line.includes("\uFFFD")));
    }),
  );

  it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
    Effect.gen(function* () {
      const parent = yield* makeTmpDir();
      const pathService = yield* Path.Path;
      const cwd = pathService.join(parent, "missing");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const [localStatus, remoteStatus, refs] = yield* Effect.all([
        driver.statusDetails(cwd),
        driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
        driver.listRefs({ cwd }),
      ]);

      assert.equal(localStatus.isRepo, false);
      assert.equal(remoteStatus.isRepo, false);
      assert.equal(refs.isRepo, false);
      assert.deepStrictEqual(refs.refs, []);
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.

// Releases the lock as soon as a matching git command fails on it, before the driver retries.

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

// Git blocks file submodule transports (CVE-2022-39253) despite repo config; local fixtures need env permission.

// Most tests start from the same one-commit repository; they copy it instead of spawning git.

it.effect(
  "refreshes remote status after external init while refs still cache a non-repository",
  () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.realPath(yield* makeTmpDir());
      assert.isFalse((yield* driver.listRefs({ cwd })).isRepo);
      yield* git(cwd, ["init"]);

      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote);
      yield* driver.ensureRemote({ cwd, preferredName: "origin", url: cwd });
      assert.isTrue((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("marks the default branch of a primary remote that is not named origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "trunk"]);
      yield* git(cwd, ["remote", "add", "upstream", remote]);
      yield* git(cwd, ["push", "upstream", "trunk"]);
      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/upstream/HEAD",
        "refs/remotes/upstream/trunk",
      ]);
      yield* git(cwd, ["checkout", "-b", "other"]);
      // "other" sorts ahead of "trunk" by name when their commit times tie.
      yield* git(cwd, ["commit", "--allow-empty", "-m", "newer"]);
      yield* git(cwd, ["checkout", "-b", "feature", "trunk"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const status = yield* driver.statusDetailsLocal(cwd);
      yield* git(cwd, ["checkout", "trunk"]);
      assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isDefaultBranch);
      yield* git(cwd, ["checkout", "feature"]);
      assert.isFalse(status.isDefaultBranch);

      const refs = (yield* driver.listRefs({ cwd, refresh: true, includeMatchingRemoteRefs: true }))
        .refs;
      assert.isTrue(refs.find((ref) => ref.name === "trunk")?.isDefault);
      assert.isTrue(refs.find((ref) => ref.name === "upstream/trunk")?.isDefault);
      const names = refs.map((ref) => ref.name);
      assert.isBelow(names.indexOf("trunk"), names.indexOf("other"));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["bare", "unborn"] as const)(
  "invalidates a %s repository after worktree creation",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* makeTmpDir();
        const cwd = yield* makeTmpDir("git-discovery-fallback-");
        if (state === "bare") {
          yield* initRepoWithCommit(source);
          yield* git(source, ["clone", "--bare", source, cwd]);
        } else {
          yield* git(cwd, ["init"]);
        }
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(
            state === "bare" ? ChildProcess.setEnv(command, { GIT_DIR: cwd }) : command,
          );
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "fallback");
        const result = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/fallback",
          })
          .pipe(Effect.result);
        assert.equal(Result.isSuccess(result), state === "bare");
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.createWorktree.createBranch");
          assert.equal(result.failure.detail, "git branch failed");
        }
        assert.equal(
          spawnedArgs.filter((args) => args.includes("--git-common-dir")).length,
          state === "bare" ? 2 : 1,
        );
        assert.isFalse(spawnedArgs.some((args) => args[0] === "symbolic-ref"));
        spawnedArgs.length = 0;
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isRepo);
        if (state === "bare") {
          assert.isTrue(refs.refs.some((ref) => ref.name === "feature/fallback"));
        } else {
          assert.isEmpty(refs.refs);
        }
        assert.equal(
          spawnedArgs.filter((args) => args.includes("--git-common-dir")).length,
          state === "bare" ? 2 : 1,
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["on a branch", "detached", "unborn"] as const)(
  "reuses the cached repository layout for review requests when %s",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const discoveries = () => {
          const spawned = (matches: (args: ReadonlyArray<string>) => boolean) =>
            spawnedArgs.filter(matches).length;
          const counts = {
            commonDir: spawned((args) => args.includes("--git-common-dir")),
            worktreeRoot: spawned((args) => args.includes("--show-toplevel")),
            branch: spawned((args) => args.includes("symbolic-ref") && args.includes("HEAD")),
          };
          spawnedArgs.length = 0;
          return counts;
        };
        const warm = { commonDir: 0, worktreeRoot: 0, branch: 0 };
        const branchRead = { ...warm, branch: 1 };
        const cwd = yield* makeTmpDir();
        if (state === "unborn") {
          yield* git(cwd, ["init", "-b", "main"]);
        } else {
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, "committed.txt", "committed\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "add file"]);
          if (state === "detached") yield* git(cwd, ["checkout", "--detach"]);
        }
        yield* writeTextFile(cwd, "new.txt", "new\n");
        spawnedArgs.length = 0;

        const workingTreeFile = {
          cwd,
          file: { path: "new.txt", previousPath: null, sourceKind: "working-tree" },
        } as const;
        const workingTree = yield* driver.getReviewDiffPreview(workingTreeFile);
        assert.deepStrictEqual(discoveries(), { commonDir: 1, worktreeRoot: 1, branch: 0 });
        assert.deepStrictEqual(
          workingTree.sources
            .find((source) => source.kind === "working-tree")!
            .files!.map((file) => file.path),
          ["new.txt"],
        );
        yield* driver.getReviewDiffPreview(workingTreeFile);
        assert.deepStrictEqual(discoveries(), warm);

        if (state !== "unborn") {
          const commitSha = yield* git(cwd, ["rev-parse", "HEAD"]);
          const commit = yield* driver.getReviewDiffPreview({
            cwd,
            commitSha,
            file: { path: "committed.txt", previousPath: null, sourceKind: "commit" },
          });
          assert.deepStrictEqual(discoveries(), warm);
          assert.include(commit.sources[0]!.diff, "+committed");
        }

        const headRef = (preview: Effect.Success<ReturnType<typeof driver.getReviewDiffPreview>>) =>
          preview.sources.find((entry) => entry.kind === "branch-range")!.headRef;
        const general = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(discoveries(), branchRead);
        assert.equal(
          headRef(general),
          state === "detached" ? "HEAD" : yield* git(cwd, ["branch", "--show-current"]),
        );

        // A checkout made outside the driver is visible to the next request.
        if (state !== "detached") yield* git(cwd, ["checkout", "-b", "outside-checkout"]);
        const afterCheckout = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(discoveries(), branchRead);
        if (state !== "detached") assert.equal(headRef(afterCheckout), "outside-checkout");

        // A file read under that preview reuses its merge base instead of resolving it again.
        const branchFile = yield* driver.getReviewDiffPreview({
          cwd,
          mergeBase: afterCheckout.sources.find((entry) => entry.kind === "branch-range")!
            .mergeBase!,
          file: { path: "new.txt", previousPath: null, sourceKind: "branch-range" },
        });
        assert.isFalse(spawnedArgs.some((args) => args.includes("merge-base")));
        assert.deepStrictEqual(discoveries(), warm);
        assert.deepStrictEqual(
          branchFile.sources
            .find((source) => source.kind === "branch-range")!
            .files!.map((file) => file.path),
          ["new.txt"],
        );

        yield* driver.getReviewBranchCommits({ cwd });
        assert.deepStrictEqual(discoveries(), branchRead);

        // A cached layout must not outlive a removed cwd.
        yield* (yield* FileSystem.FileSystem).remove(cwd, { recursive: true });
        assert.isEmpty((yield* driver.getReviewDiffPreview(workingTreeFile)).sources);
        assert.isEmpty((yield* driver.getReviewDiffPreview({ cwd })).sources);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("resolves a branch's base once while its refs and branch config are unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      let failRemoteLookup = false;
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return delegate.spawn(command);
        spawnedArgs.push(command.args.map(String));
        return failRemoteLookup && command.args.includes("remote")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
              }),
            )
          : delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "feature"]);
      const lookups = () => {
        const count = spawnedArgs.filter((args) =>
          args.includes("branch.feature/x.t3-merge-base-ref"),
        ).length;
        spawnedArgs.length = 0;
        return count;
      };
      spawnedArgs.length = 0;

      // One thread switch: two local status reads and the two diff preview passes.
      yield* driver.statusDetailsLocal(cwd);
      yield* driver.statusDetailsLocal(cwd);
      const tracked = yield* driver.getReviewDiffPreview({ cwd, trackedOnly: true });
      assert.isDefined(tracked.completionToken);
      assert.equal(lookups(), 1);
      // The complete pass adds only the untracked listing to the tracked pass it follows.
      const complete = yield* driver.getReviewDiffPreview({
        cwd,
        completionToken: tracked.completionToken!,
      });
      assert.deepStrictEqual(
        spawnedArgs.map((args) => args.find((arg) => !arg.startsWith("-") && !arg.includes("="))),
        ["ls-files"],
      );
      assert.isUndefined(complete.incomplete);
      assert.deepStrictEqual(complete.sources, tracked.sources);
      spawnedArgs.length = 0;
      // A token is used once, and untracked files are still diffed when there are some.
      yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
      const second = yield* driver.getReviewDiffPreview({ cwd, trackedOnly: true });
      const withUntracked = yield* driver.getReviewDiffPreview({
        cwd,
        completionToken: second.completionToken!,
      });
      assert.include(
        withUntracked.sources.flatMap((source) => source.files?.map((file) => file.path) ?? []),
        "untracked.txt",
      );
      const reused = yield* driver.getReviewDiffPreview({
        cwd,
        completionToken: tracked.completionToken!,
      });
      assert.deepStrictEqual(reused.sources, withUntracked.sources);
      yield* (yield* FileSystem.FileSystem).remove(`${cwd}/untracked.txt`);
      yield* driver.statusDetailsLocal(cwd);
      spawnedArgs.length = 0;

      // Git for Windows' no-op `fetch --dry-run` touches a refs directory without moving a ref.
      NodeFS.utimesSync(`${cwd}/.git/refs/heads`, 1_893_456_000, 1_893_456_000);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 0);

      yield* git(cwd, ["config", "branch.feature/x.t3-merge-base-ref", "refs/heads/main"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);

      const includeDir = yield* makeTmpDir();
      const includedConfig = `${includeDir}/included.gitconfig`;
      yield* git(cwd, ["config", "include.path", includedConfig]);
      yield* driver.statusDetailsLocal(cwd);
      lookups();
      yield* git(cwd, [
        "config",
        "--file",
        includedConfig,
        "branch.feature/x.t3-merge-base",
        "main",
      ]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);

      // A fallback forced by a failed remote lookup is resolved again once git recovers.
      yield* git(cwd, [
        "config",
        "--file",
        includedConfig,
        "--unset",
        "branch.feature/x.t3-merge-base",
      ]);
      yield* git(cwd, ["config", "--unset", "branch.feature/x.t3-merge-base-ref"]);
      failRemoteLookup = true;
      yield* driver.getReviewDiffPreview({ cwd });
      failRemoteLookup = false;
      lookups();
      yield* driver.getReviewDiffPreview({ cwd });
      yield* driver.getReviewDiffPreview({ cwd });
      assert.equal(lookups(), 1);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a branch's base cached while only other refs' commits move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["remote", "add", "origin", cwd]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${initialBranch}`,
      ]);
      const other = `${yield* makeTmpDir()}/other`;
      yield* git(cwd, ["worktree", "add", "-b", "other", other]);
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      yield* git(cwd, ["pack-refs", "--all"]);
      const lookups = () => {
        const count = spawnedArgs.filter((args) =>
          args.includes("branch.feature/x.t3-merge-base-ref"),
        ).length;
        spawnedArgs.length = 0;
        return count;
      };
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);

      // Another worktree's commits and a fetch moving a packed base ref add or remove no name.
      yield* git(other, ["commit", "--allow-empty", "-m", "other"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(spawnedArgs.length, 6);
      assert.equal(lookups(), 0);
      yield* git(other, ["commit", "--allow-empty", "-m", "other again"]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "other"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 0);

      yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
      yield* git(cwd, ["branch", "master"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
      // Deleting a packed ref rewrites packed-refs without touching a loose file.
      yield* git(cwd, ["update-ref", "-d", "refs/remotes/origin/develop"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
      yield* git(cwd, ["config", "branch.feature/x.t3-merge-base", "other"]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rereads the base after a nested remote's HEAD is retargeted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["remote", "add", "team/origin", cwd]);
      yield* git(cwd, ["update-ref", `refs/remotes/team/origin/${initialBranch}`, "HEAD"]);
      yield* git(cwd, ["update-ref", "refs/remotes/team/origin/develop", "HEAD"]);
      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/team/origin/HEAD",
        `refs/remotes/team/origin/${initialBranch}`,
      ]);
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      const lookups = () => {
        const count = spawnedArgs.filter((args) =>
          args.includes("branch.feature/x.t3-merge-base-ref"),
        ).length;
        spawnedArgs.length = 0;
        return count;
      };
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 0);

      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/team/origin/HEAD",
        "refs/remotes/team/origin/develop",
      ]);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the base cached when a remote branch has a HEAD path component", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["remote", "add", "origin", cwd]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
      // A valid ref whose path has a directory named HEAD under refs/remotes.
      yield* git(cwd, ["update-ref", "refs/remotes/origin/topic/HEAD/child", "HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      const lookups = () => {
        const count = spawnedArgs.filter((args) =>
          args.includes("branch.feature/x.t3-merge-base-ref"),
        ).length;
        spawnedArgs.length = 0;
        return count;
      };
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 1);
      yield* driver.statusDetailsLocal(cwd);
      assert.equal(lookups(), 0);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps one cached base per branch however often its refs change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      let lookupCount = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (
          ChildProcess.isStandardCommand(command) &&
          command.args.map(String).includes("branch.feature/x.t3-merge-base-ref")
        ) {
          lookupCount++;
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const other = `${yield* makeTmpDir()}/other`;
      yield* git(cwd, ["worktree", "add", "-b", "other", other]);
      yield* git(cwd, ["checkout", "-b", "feature/x"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "feature 1"]);
      yield* git(cwd, ["branch", "develop"]);
      const read = Effect.fnUntraced(function* () {
        lookupCount = 0;
        const status = yield* driver.statusDetailsLocal(cwd);
        return { lookups: lookupCount, aheadCount: status.aheadCount };
      });
      const useBase = (base: string) =>
        git(cwd, ["config", "branch.feature/x.t3-merge-base", base]);

      yield* useBase(initialBranch);
      assert.deepStrictEqual(yield* read(), { lookups: 1, aheadCount: 1 });
      for (let round = 1; round <= 4; round++) {
        // Commits here and in another worktree keep every ref name, so the base stays cached.
        yield* git(cwd, ["commit", "--allow-empty", "-m", `feature ${round + 1}`]);
        yield* git(other, ["commit", "--allow-empty", "-m", `other ${round}`]);
        assert.deepStrictEqual(yield* read(), { lookups: 0, aheadCount: round + 1 });

        yield* useBase("develop");
        assert.deepStrictEqual(yield* read(), { lookups: 1, aheadCount: round });
        // Returning to an earlier stamp resolves again: the entry under it was overwritten, not kept.
        yield* useBase(initialBranch);
        assert.deepStrictEqual(yield* read(), { lookups: 1, aheadCount: round + 1 });
        yield* git(cwd, ["branch", `scratch-${round}`]);
        assert.deepStrictEqual(yield* read(), { lookups: 1, aheadCount: round + 1 });
        yield* git(cwd, ["branch", "-D", `scratch-${round}`]);
        assert.deepStrictEqual(yield* read(), { lookups: 1, aheadCount: round + 1 });
      }
    }),
  ).pipe(Effect.provide(layerTest)),
);

describe("pullCurrentBranch", () => {
  // A fast-forward that prints over 1 MB takes thousands of files, so the real pull's output is
  // padded past the cap instead.

  const cloneBehindRemote = Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    const updater = yield* makeTmpDir("git-vcs-driver-updater-");
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", initialBranch]);
    yield* git(updater, ["clone", remote, "."]);
    yield* git(updater, ["config", "user.email", "test@test.com"]);
    yield* git(updater, ["config", "user.name", "Test"]);
    yield* writeTextFile(updater, "remote.txt", "remote\n");
    yield* git(updater, ["add", "remote.txt"]);
    yield* git(updater, ["commit", "-m", "remote commit"]);
    yield* git(updater, ["push", "origin", initialBranch]);
    return {
      cwd,
      remote,
      updater,
      initialBranch,
      remoteHead: yield* git(updater, ["rev-parse", "HEAD"]),
    };
  });

  it.effect("the startup pull waits for a status fetch that runs past five seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, remoteHead } = yield* cloneBehindRemote;
        const targetPath = NodeFS.realpathSync.native(cwd);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fetchHeld = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              !held &&
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("fetch") &&
              String(command.options.cwd) === targetPath
            ) {
              held = true;
              yield* Deferred.succeed(fetchHeld, undefined);
              yield* Deferred.await(release);
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const startup = yield* autoPullProjects(
          [{ id: ProjectId.make("behind"), workspaceRoot: cwd, autoPull: true }],
          { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
        ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver), Effect.forkChild);
        yield* Deferred.await(fetchHeld);
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(startup);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  const claimedFetchFallbacks = ["diverged", "interrupted", "upstream-only"] as const;

  it.effect.each(claimedFetchFallbacks)(
    "falls back to the claimed status fetch when Pull is %s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, updater, remoteHead } = yield* cloneBehindRemote;
          if (failure === "upstream-only") {
            yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
            yield* writeTextFile(cwd, ".git/refs/remotes/origin/other.lock", "");
          }
          if (failure === "diverged") {
            yield* writeTextFile(cwd, "local.txt", "local\n");
            yield* git(cwd, ["add", "local.txt"]);
            yield* git(cwd, ["commit", "-m", "local commit"]);
          }
          const blockers: string[] = [];
          for (let index = 0; index < 4; index++) {
            const blocker = yield* cloneBehindRemote;
            blockers.push(NodeFS.realpathSync.native(blocker.cwd));
          }
          const targetPath = NodeFS.realpathSync.native(cwd);
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const release = yield* Deferred.make<void>();
          const blockersStarted = yield* Deferred.make<void>();
          const targetEntered = yield* Deferred.make<void>();
          const targetFetchStarted = yield* Deferred.make<void>();
          const pullBeforeFetch = yield* Deferred.make<void>();
          const releasePull = yield* Deferred.make<void>();
          let running = 0;
          let targetFetches = 0;
          let waiterSucceeded = false;
          let targetFetchExitCode: number | undefined;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (ChildProcess.isStandardCommand(command)) {
                const commandCwd = NodeFS.realpathSync.native(String(command.options.cwd));
                if (
                  commandCwd === targetPath &&
                  failure === "interrupted" &&
                  command.args[0] === "rev-parse" &&
                  command.args[1] === "HEAD" &&
                  command.args.length === 2
                ) {
                  yield* Deferred.succeed(pullBeforeFetch, undefined);
                  yield* Deferred.await(releasePull);
                }
              }
              const handle = yield* delegate.spawn(command);
              // A status fetch downloads once, then fetches again only to move refs.
              if (!ChildProcess.isStandardCommand(command) || !command.args.includes("--dry-run"))
                return handle;
              const commandCwd = String(command.options.cwd);
              if (commandCwd === targetPath) {
                targetFetches++;
                yield* Deferred.succeed(targetFetchStarted, undefined);
                return ChildProcessSpawner.makeHandle({
                  ...handle,
                  exitCode: handle.exitCode.pipe(
                    Effect.tap((exitCode) =>
                      Effect.sync(() => {
                        targetFetchExitCode = exitCode;
                      }),
                    ),
                  ),
                });
              }
              if (blockers.includes(commandCwd)) {
                running++;
                if (running === 4) yield* Deferred.succeed(blockersStarted, undefined);
                yield* Deferred.await(release);
              }
              return handle;
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              if (options.name === "GitVcsDriver.fetchRemoteForStatus.wait") {
                const attribute = span.attribute.bind(span);
                span.attribute = (key, value) => {
                  attribute(key, value);
                  if (key === "statusFetch.joining")
                    Deferred.doneUnsafe(targetEntered, Effect.void);
                };
                const end = span.end.bind(span);
                span.end = (endTime, exit) => {
                  waiterSucceeded = Exit.isSuccess(exit);
                  end(endTime, exit);
                };
              }
              return span;
            },
          });
          yield* Effect.gen(function* () {
            for (const blocker of blockers) {
              yield* driver.statusDetailsRemote(blocker).pipe(Effect.forkChild);
            }
            yield* Deferred.await(blockersStarted);
            const status = yield* driver
              .statusDetailsRemote(cwd)
              .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(targetEntered);
            if (failure === "interrupted") {
              const pull = yield* driver.pullCurrentBranch(cwd).pipe(Effect.forkChild);
              yield* Deferred.await(pullBeforeFetch);
              yield* Fiber.interrupt(pull);
              const exit = yield* Fiber.await(pull);
              assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
            } else if (failure === "upstream-only") {
              assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "pulled");
              yield* (yield* FileSystem.FileSystem).remove(
                `${cwd}/.git/refs/remotes/origin/other.lock`,
              );
            } else {
              const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));
              assert.equal(error.operation, "GitVcsDriver.pullCurrentBranch.pull");
            }
            assert.equal(targetFetches, 0);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(targetFetchStarted);
            assert.isTrue((yield* Fiber.join(status)).isRepo);
            assert.isTrue(waiterSucceeded);
            assert.equal(targetFetches, 1);
            assert.equal(targetFetchExitCode, 0);
            if (failure === "upstream-only") {
              assert.equal(yield* git(cwd, ["rev-parse", "refs/remotes/origin/other"]), remoteHead);
            }
          }).pipe(
            Effect.ensuring(
              Effect.all([
                Deferred.succeed(release, undefined),
                Deferred.succeed(releasePull, undefined),
              ]),
            ),
          );
        }),
      ).pipe(Effect.provide(layerTest)),
  );

  it.effect("waits for a running status fetch before starting Pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, remoteHead } = yield* cloneBehindRemote;
        const targetPath = NodeFS.realpathSync.native(cwd);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fetchStarted = yield* Deferred.make<void>();
        const releaseFetch = yield* Deferred.make<void>();
        const pullResolvedCommonDir = yield* Deferred.make<void>();
        const pullStarted = yield* Deferred.make<void>();
        const events: string[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) return yield* delegate.spawn(command);
            const target = NodeFS.realpathSync.native(String(command.options.cwd)) === targetPath;
            if (target && command.args.includes("pull")) {
              events.push("pull-spawn");
              yield* Deferred.succeed(pullStarted, undefined);
            }
            const handle = yield* delegate.spawn(command);
            if (target && command.args.includes("fetch")) {
              yield* Deferred.succeed(fetchStarted, undefined);
              yield* Deferred.await(releaseFetch);
              yield* handle.exitCode;
              events.push("fetch-exit");
            }
            return handle;
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            if (options.name === "resolveGitCommonDir") {
              const end = span.end.bind(span);
              span.end = (endTime, exit) => {
                end(endTime, exit);
                Deferred.doneUnsafe(pullResolvedCommonDir, Effect.void);
              };
            }
            return span;
          },
        });
        yield* Effect.gen(function* () {
          yield* driver.statusDetailsRemote(cwd).pipe(Effect.forkChild);
          yield* Deferred.await(fetchStarted);
          const pull = yield* driver
            .pullCurrentBranch(cwd)
            .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(pullResolvedCommonDir);
          assert.isFalse(yield* Deferred.isDone(pullStarted));
          assert.isUndefined(pull.pollUnsafe());
          yield* Deferred.succeed(releaseFetch, undefined);
          const result = yield* Fiber.join(pull);
          assert.equal(result.status, "pulled");
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
          // The status fetch downloads, then fetches again to move the refs it found.
          assert.deepEqual(events, ["fetch-exit", "fetch-exit", "pull-spawn"]);
        }).pipe(Effect.ensuring(Deferred.succeed(releaseFetch, undefined)));
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("does not scan the working tree to pull", () =>
    Effect.gen(function* () {
      const { cwd, initialBranch, remoteHead } = yield* cloneBehindRemote;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.deepEqual(result, {
        status: "pulled",
        refName: initialBranch,
        upstreamRef: `origin/${initialBranch}`,
      });
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      // The status broadcast after a pull re-reads the working tree for the UI.
      assert.deepEqual(
        spawnedArgs.filter((args) => args.includes("status") || args.includes("--numstat")),
        [],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("pulls into an unborn branch that tracks an unfetched upstream", () =>
    Effect.gen(function* () {
      const { remote, initialBranch, remoteHead } = yield* cloneBehindRemote;
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init", "--initial-branch", initialBranch]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["config", `branch.${initialBranch}.remote`, "origin"]);
      yield* git(cwd, ["config", `branch.${initialBranch}.merge`, `refs/heads/${initialBranch}`]);
      const driver = yield* makeGitVcsDriverCore();

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.deepEqual(result, {
        status: "pulled",
        refName: initialBranch,
        upstreamRef: `origin/${initialBranch}`,
      });
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
    }).pipe(Effect.provide(layerTest)),
  );

  // A slow smudge filter (LFS) can hold the checkout past 30 seconds; killing it there leaves a
  // half-updated working tree. The automatic pulls and pull request refresh use these defaults.
});

it.effect.each(["a T3 branch creation", "an external worktree addition"] as const)(
  "refreshes an in-flight ref snapshot after %s",
  (mutation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const firstScanCompleted = yield* Deferred.make<void>();
        const releaseOtherScans = yield* Deferred.make<void>();
        const firstScan = yield* Ref.make(true);
        const coordinatingSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            const isWorktreeScan =
              command.args.includes("worktree") && command.args.includes("--porcelain");
            const isRefScan =
              command.args.includes("for-each-ref") &&
              command.args.includes("refs/heads") &&
              command.args.includes("refs/remotes");
            if (!isRefScan && (!isWorktreeScan || mutation === "a T3 branch creation")) {
              return yield* delegate.spawn(command);
            }
            if (!(yield* Ref.getAndSet(firstScan, false))) {
              yield* Deferred.await(releaseOtherScans);
              return yield* delegate.spawn(command);
            }
            const handle = yield* delegate.spawn(command);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap(() =>
                  Deferred.succeed(firstScanCompleted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseOtherScans)),
                  ),
                ),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
        );
        const cwd = yield* makeTmpDir();
        const worktree = (yield* Path.Path).join(cwd, "linked checkout");
        const refName = "feature/during-refresh";
        yield* initRepoWithCommit(cwd).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
        );
        const list = driver.listRefs({ cwd, refresh: true, query: refName });
        const inFlight = yield* list.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(firstScanCompleted);

        if (mutation === "a T3 branch creation") {
          yield* driver.createRef({ cwd, refName });
          yield* Deferred.succeed(releaseOtherScans, undefined);
          assert.equal((yield* Fiber.join(inFlight)).refs[0]?.name, refName);
        } else {
          yield* git(cwd, ["worktree", "add", "-b", refName, worktree]).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
          );
          const refresh = yield* list.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseOtherScans, undefined);
          assert.equal((yield* Fiber.join(refresh)).refs[0]?.worktreePath, worktree);
          yield* Fiber.join(inFlight);
        }
      }),
    ).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect("a refreshed ref list reads the current branch and repository paths once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["checkout", "-b", "outside-checkout"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );
      spawnedArgs.length = 0;

      // The branch selector's paginated queries send two refreshes at once.
      const [first, second] = yield* Effect.all(
        [
          driver.listRefs({ cwd, refresh: true }),
          driver.listRefs({ cwd, refresh: true, limit: 1 }),
        ],
        { concurrency: 2 },
      );

      assert.equal(first.refs.find((ref) => ref.current)?.name, "outside-checkout");
      assert.equal(second.refs.find((ref) => ref.current)?.name, "outside-checkout");
      assert.equal(spawnedArgs.filter((args) => args[0] === "symbolic-ref").length, 1);
      assert.equal(spawnedArgs.filter((args) => args[0] === "rev-parse").length, 1);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("keeps cached branch occupancy when Git cannot rescan worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      let failWorktreeScan = false;
      const spawner = ChildProcessSpawner.make((command) =>
        failWorktreeScan &&
        ChildProcess.isStandardCommand(command) &&
        command.args.includes("worktree") &&
        command.args.includes("--porcelain")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
              }),
            )
          : delegate.spawn(command),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const list = driver.listRefs({ cwd, refresh: true, query: initialBranch });
      const cached = yield* list;
      assert.equal(cached.refs[0]?.worktreePath, cwd);

      failWorktreeScan = true;
      assert.deepEqual(yield* list, cached);
    }).pipe(Effect.provide(layerTest)),
  ),
);

it.effect("superseded ref snapshots of one repository do not evict another's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const quietRepo = yield* makeTmpDir();
      const quietRepoRealPath = NodeFS.realpathSync.native(quietRepo);
      const quietRepoScans = yield* Ref.make(0);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/remotes") &&
            NodeFS.realpathSync.native(String(command.options.cwd)).startsWith(quietRepoRealPath)
          ) {
            yield* Ref.update(quietRepoScans, (count) => count + 1);
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const busyRepo = yield* makeTmpDir();
      yield* initRepoWithCommit(quietRepo).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );
      yield* initRepoWithCommit(busyRepo).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      yield* driver.listRefs({ cwd: quietRepo });
      // More epochs than the snapshot cache holds.
      for (let index = 0; index < 70; index++) {
        yield* driver.invalidateRefs(busyRepo);
        yield* driver.listRefs({ cwd: busyRepo });
      }
      yield* driver.listRefs({ cwd: quietRepo });

      assert.equal(yield* Ref.get(quietRepoScans), 1);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("lists external worktree paths even within the ref snapshot refresh window", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const path = yield* Path.Path;
    const worktree = path.join(cwd, "another checkout");
    const movedWorktree = path.join(cwd, "moved checkout");
    yield* initRepoWithCommit(cwd);
    yield* git(cwd, ["branch", "feature"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const list = driver.listRefs({ cwd, refresh: true, query: "feature" });
    yield* list;

    yield* git(cwd, ["worktree", "add", worktree, "feature"]);
    assert.equal((yield* list).refs[0]?.worktreePath, worktree);
    yield* git(cwd, ["worktree", "move", worktree, movedWorktree]);
    assert.equal((yield* list).refs[0]?.worktreePath, movedWorktree);
    yield* git(cwd, ["worktree", "remove", movedWorktree]);
    assert.isNull((yield* list).refs[0]?.worktreePath);

    yield* git(cwd, ["worktree", "add", "-b", "new-branch", worktree]);
    const newBranchQuery = { cwd, query: "new-branch" };
    assert.equal(
      (yield* driver.listRefs({ ...newBranchQuery, refresh: true })).refs[0]?.worktreePath,
      worktree,
    );
    assert.equal((yield* driver.listRefs(newBranchQuery)).refs[0]?.worktreePath, worktree);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect.each([
  {
    name: "HTTPS credentials",
    stderr: "fatal: Authentication failed for",
    expected: "could not authenticate",
  },
  {
    name: "SSH credentials",
    stderr: "git@example.com: Permission denied (publickey).",
    expected: "could not authenticate",
  },
  {
    name: "disabled prompts",
    stderr: "fatal: could not read Username: terminal prompts disabled",
    expected: "could not authenticate",
  },
  {
    name: "DNS failure",
    stderr: "fatal: Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "connection failure",
    stderr: "ssh: connect to host example.com port 22: Connection refused",
    expected: "could not reach the remote",
  },
  {
    name: "missing remote",
    stderr: "remote: Repository not found.",
    expected: "could not access the remote repository",
  },
  {
    name: "invalid remote",
    stderr: "fatal: remote does not appear to be a git repository",
    expected: "could not access the remote repository",
  },
  {
    name: "reference lock",
    stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "lock file",
    stderr: "fatal: Unable to create '/repo/.git/FETCH_HEAD.lock': File exists.",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "reference race on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "held reference lock on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: reference already exists",
    expected: "could not update a local reference",
    attempts: 2,
  },
  {
    name: "broken local ref",
    stderr: "fatal: bad object refs/remotes/origin/dev 2",
    expected: "broken local ref",
  },
  {
    name: "unrelated remote chatter",
    stderr:
      "remote: Help: authentication failed, connection refused, cannot lock ref\nremote: unrelated service error",
    expected: "git fetch origin failed",
  },
  {
    name: "HTTPS DNS failure",
    stderr:
      "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "unknown failure",
    stderr: "fatal: unexpected remote failure",
    expected: "git fetch origin failed",
  },
] as const)("reports $name during fetch without retaining remote output", (scenario) =>
  Effect.gen(function* () {
    const secret = "secret-fetch-token";
    const stderr = [
      scenario.stderr,
      `https://user:${secret}@example.com/private?token=${secret}`,
      `error: unable to access 'https://user:${secret}@example.com/private?token=${secret}': stalled`,
    ].join("\n");
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        assert.deepEqual(command.args, ["fetch", "--quiet", "--", "origin"]);
        assert.equal(command.options.env?.LANGUAGE, "C");
        assert.equal(command.options.env?.GIT_TERMINAL_PROMPT, "0");
        yield* Ref.update(attempts, (count) => count + 1);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(secret)),
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
    assert.include(error.detail, scenario.expected);
    assert.include(error.message, "error: unable to access '…': …");
    assert.equal(error.exitCode, 128);
    assert.equal(error.stderrLength, stderr.length);
    assert.equal(error.stdoutLength, secret.length);
    assert.notInclude(error.message, secret);
    assert.notInclude(yield* encodeGitCommandError(error), secret);
    assert.notProperty(error, "stderr");
    assert.notProperty(error, "args");
    assert.equal(yield* Ref.get(attempts), "attempts" in scenario ? scenario.attempts : 1);
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

// regression: #18537 the fetch before creating a worktree outgrew the 30s default

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  // regression: #26577 a timed-out git that outlives its timeout holds a process permit

  describe("structured errors", () => {
    // regression: #8645 name the cause of a failed git command

    // regression: #8645 name the cause of a failed git command

    it.effect.each([
      {
        label: "a refused key",
        sshMessage: "git@example.invalid: Permission denied (publickey).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused key among several methods",
        sshMessage: "git@example.invalid: Permission denied (publickey,password).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused keyboard-interactive attempt",
        sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a rejected password",
        sshMessage: "Permission denied, please try again.",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "an untrusted host key",
        sshMessage: "Host key verification failed.",
        expectedReason: "host_key_unverified" as const,
        expectedText: "(host_key_unverified)",
      },
    ])(
      "names $label rather than an unreachable remote",
      ({ sshMessage, expectedReason, expectedText }) =>
        Effect.gen(function* () {
          const parent = yield* makeTmpDir();
          const pathService = yield* Path.Path;
          const cwd = pathService.join(parent, "repo");
          const fileSystem = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* fileSystem.makeDirectory(cwd);
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
          const fakeSsh = pathService.join(parent, "fake-ssh");
          yield* writeTextFile(
            parent,
            "fake-ssh",
            `#!/bin/sh\necho "${sshMessage}" >&2\nexit 255\n`,
          );
          yield* fileSystem.chmod(fakeSsh, 0o755);

          const error = yield* driver
            .execute({
              operation: "GitVcsDriver.test.sshRefusal",
              cwd,
              args: ["fetch", "origin"],
              env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
            })
            .pipe(Effect.flip);

          assert.deepInclude(error, { reason: expectedReason });
          assert.include(error.message, expectedText);
        }),
    );

    it.effect("does not read a filesystem permission error as an ssh refusal", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
        const fakeSsh = pathService.join(parent, "fake-ssh");
        yield* writeTextFile(
          parent,
          "fake-ssh",
          '#!/bin/sh\necho "fatal: cannot open backup file: Permission denied (os error 13)" >&2\nexit 255\n',
        );
        yield* fileSystem.chmod(fakeSsh, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.osPermission",
            cwd,
            args: ["fetch", "origin"],
            env: { LC_ALL: "C", GIT_SSH_COMMAND: fakeSsh },
          })
          .pipe(Effect.flip);

        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("cuts long commit subjects without splitting an emoji", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/emoji-subject"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", `${"a".repeat(299)}😀 tail`]);
        const sha = yield* git(cwd, ["rev-parse", "HEAD"]);

        const branch = yield* driver.getReviewBranchCommits({ cwd, baseRef: initialBranch });
        const preview = yield* driver.getReviewDiffPreview({ cwd, commitSha: sha });
        const commitSubject = preview.sources.find(
          (candidate) => candidate.kind === "commit",
        )?.commitSubject;
        assert.deepStrictEqual(
          [branch.commits[0]?.subject, commitSubject],
          ["a".repeat(299), "a".repeat(299)],
        );
      }),
    );

    it.effect("loads repository-relative files from nested directories and aliases", () =>
      Effect.gen(function* () {
        const directory = yield* makeTmpDir();
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const platform = yield* HostProcess.Platform;
        const cwd = path.join(directory, platform === "win32" ? "repository" : "repository\n ");
        yield* fileSystem.makeDirectory(cwd);
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/nested"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "committed\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "changed\n");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const nestedCwd = path.join(cwd, "nested");
        const clone = path.join(nestedCwd, "clone");
        yield* fileSystem.makeDirectory(clone);
        yield* initRepoWithCommit(clone);
        const projectDirectories = [nestedCwd];
        if (symlinksSupported) {
          const alias = path.join(directory, "alias");
          yield* fileSystem.symlink(nestedCwd, alias);
          projectDirectories.push(alias);
        }
        for (const projectDirectory of projectDirectories) {
          const preview = yield* driver.getReviewDiffPreview({
            cwd: projectDirectory,
            baseRef: initialBranch,
          });
          assert.equal(
            preview.sources.find((source) => source.kind === "working-tree")!.files!.length,
            3,
          );
          for (const source of preview.sources) {
            for (const file of source.files ?? []) {
              const scoped = yield* driver.getReviewDiffPreview({
                cwd: projectDirectory,
                baseRef: initialBranch,
                file: {
                  path: file.path,
                  previousPath: file.previousPath,
                  sourceKind: source.kind,
                  ...(file.changeType ? { changeType: file.changeType } : {}),
                },
              });
              const patch = scoped.sources.find((item) => item.kind === source.kind)!;
              assert.deepStrictEqual(patch.files, [file]);
              assert.include(patch.diff, `b/${file.path}`);
            }
          }
        }
      }),
    );

    it.effect(
      "lists untracked files for a file the preview called tracked only when it is not",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, "tracked.txt", "one\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "tracked"]);
          yield* writeTextFile(cwd, "tracked.txt", "two\n");
          yield* writeTextFile(cwd, "README.md", "dirty\n");
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          let listings = 0;
          const spawner = ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command) && command.args.includes("--others")) {
              listings++;
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const read = (path: string, changeType?: "change") =>
            driver
              .getReviewDiffPreview({
                cwd,
                file: {
                  path,
                  previousPath: null,
                  sourceKind: "working-tree",
                  ...(changeType ? { changeType } : {}),
                },
              })
              .pipe(Effect.map((preview) => preview.sources[0]!));

          const tracked = yield* read("tracked.txt", "change");
          assert.include(tracked.diff, "+two");
          assert.equal(listings, 0);

          // A stale hint: the file left the index after the preview listed it.
          yield* git(cwd, ["rm", "--cached", "-q", "README.md"]);
          const stale = yield* read("README.md", "change");
          assert.equal(listings, 1);
          assert.deepStrictEqual(stale, yield* read("README.md"));
        }),
    );

    it.effect("rejects a file selector for a different source than the request", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "dirty\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const file = { path: "README.md", previousPath: null };

        for (const [sourceKind, fileKind] of [
          ["working-tree", "branch-range"],
          ["branch-range", "working-tree"],
        ] as const) {
          const conflict = yield* driver
            .getReviewDiffPreview({ cwd, sourceKind, file: { ...file, sourceKind: fileKind } })
            .pipe(Effect.flip);
          assert.equal(conflict.operation, "GitVcsDriver.getReviewDiffPreview");
          assert.equal(conflict.detail, "Review source selectors must agree.");
        }
      }),
    );

    it.effect.each([
      { stagedCopy: false, expected: ["deleted file mode", "-remove me"] },
      { stagedCopy: true, expected: ["rename from removed.txt", "rename to copy.txt"] },
    ])(
      "preserves a staged deletion when the removed path still exists (staged copy: $stagedCopy)",
      ({ stagedCopy, expected }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* writeTextFile(cwd, "removed.txt", "remove me\n");
          yield* git(cwd, ["add", "removed.txt"]);
          yield* git(cwd, ["commit", "-m", "add removable file"]);
          yield* git(cwd, ["rm", "--cached", "removed.txt"]);
          if (stagedCopy) {
            yield* writeTextFile(cwd, "copy.txt", "remove me\n");
            yield* git(cwd, ["add", "copy.txt"]);
          }

          const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
          const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
          const [file] = source.files ?? [];
          const single = yield* driver.getReviewDiffPreview({
            cwd,
            sourceKind: "working-tree",
            file: { path: file!.path, previousPath: file!.previousPath, sourceKind: source.kind },
          });

          for (const diff of [source.diff, single.sources[0]!.diff]) {
            for (const text of expected) assert.include(diff, text);
            assert.notInclude(diff, "new file mode");
          }
        }),
    );

    it.effect("preserves renames, unusual paths, modes, and binary statistics", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "mode-only.sh", "echo unchanged\n");
        yield* writeTextFile(cwd, "removed.txt", "removed\n");
        yield* git(cwd, ["add", "mode-only.sh", "removed.txt"]);
        yield* git(cwd, ["commit", "-m", "add executable candidate"]);
        yield* git(cwd, ["checkout", "-b", "feature/paths"]);
        yield* git(cwd, ["mv", "README.md", "renamed.md"]);
        yield* git(cwd, ["rm", "removed.txt"]);
        yield* writeTextFile(cwd, "[literal].txt", "literal\n");
        yield* writeTextFile(cwd, " leading.txt", "whitespace path\n");
        yield* writeTextFile(cwd, "l.txt", "other\n");
        yield* writeTextFile(cwd, "binary.dat", "binary\0data");
        if ((yield* HostProcess.Platform) !== "win32") {
          yield* writeTextFile(cwd, "tab\tand\nnewline.txt", "unusual path\n");
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["update-index", "--chmod=+x", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "rename and add files"]);
        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        const decodeReviewDiffPreviewInput = Schema.decodeEffect(ReviewDiffPreviewInput);

        for (const path of ["renamed.md", "[literal].txt", " leading.txt", "mode-only.sh"]) {
          const stat = branch.files!.find((file) => file.path === path)!;
          const request = yield* decodeReviewDiffPreviewInput({
            cwd,
            baseRef: initialBranch,
            mergeBase: branch.mergeBase!,
            file: { path, previousPath: stat.previousPath, sourceKind: "branch-range" },
          });
          const result = yield* driver.getReviewDiffPreview(request);
          const scoped = result.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scoped.files, [stat]);
          assert.notInclude(scoped.diff, "b/l.txt");
          if (path === "renamed.md") assert.include(scoped.diff, "rename from README.md");
          if (path === "mode-only.sh") {
            assert.include(scoped.diff, "old mode 100644");
            assert.include(scoped.diff, "new mode 100755");
          }
        }
        assert.include(branch.diff, "rename from README.md");
        assert.include(branch.diff, "rename to renamed.md");
        assert.deepInclude(branch.files ?? [], {
          path: "renamed.md",
          previousPath: "README.md",
          changeType: "rename-pure",
          additions: 0,
          deletions: 0,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "removed.txt",
          previousPath: null,
          changeType: "deleted",
          additions: 0,
          deletions: 1,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "mode-only.sh",
          previousPath: null,
          changeType: "change",
          additions: 0,
          deletions: 0,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "binary.dat",
          previousPath: null,
          changeType: "new",
          additions: 0,
          deletions: 0,
        });
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.deepInclude(branch.files ?? [], {
            path: "tab\tand\nnewline.txt",
            previousPath: null,
            changeType: "new",
            additions: 1,
            deletions: 0,
          });
        }
      }),
    );

    it.effect("reports staged and untracked changes before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(dirty.files, [
          { path: "staged.txt", previousPath: null, changeType: "new", additions: 1, deletions: 0 },
          {
            path: "untracked.txt",
            previousPath: null,
            changeType: "new",
            additions: 1,
            deletions: 0,
          },
        ]);
        assert.include(dirty.diff, "b/staged.txt");
        assert.include(dirty.diff, "b/untracked.txt");
        const single = yield* driver.getReviewDiffPreview({
          cwd,
          sourceKind: "working-tree",
          file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.deepStrictEqual(single.sources[0]!.files, dirty.files!.slice(1));
        assert.include(single.sources[0]!.diff, "b/untracked.txt");
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "loads working-tree contents in a repository whose folder name ends in a space",
      () =>
        Effect.gen(function* () {
          const pathService = yield* Path.Path;
          const cwd = pathService.join(yield* makeTmpDir(), "repo ");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* writeTextFile(cwd, "app/.keep", "");
          yield* writeTextFile(cwd, "README.md", "# changed\n");

          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(pathService.join(cwd, "app")),
          );

          assert.strictEqual(contents.newContents, "# changed\n");
        }),
    );

    it.effect("shows GBK-encoded files as readable text in the review diff and expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const before = "// 初始中文注释\nint a = 1;\n";
        const after = "// 修改后的中文注释\nint a = 2;\n";
        // GBK bytes of `before` and `after`.
        const writeMain = (hex: string) =>
          Effect.sync(() =>
            NodeFS.writeFileSync(NodePath.join(cwd, "main.c"), Buffer.from(hex, "hex")),
          );
        yield* writeMain("2f2f20b3f5cabcd6d0cec4d7a2cacd0a696e742061203d20313b0a");
        yield* git(cwd, ["add", "main.c"]);
        yield* git(cwd, ["commit", "-m", "add GBK file"]);
        yield* writeMain("2f2f20d0deb8c4baf3b5c4d6d0cec4d7a2cacd0a696e742061203d20323b0a");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const diff = preview.sources.map((source) => source.diff).join("\n");
        assert.include(diff, "-// 初始中文注释");
        assert.include(diff, "+// 修改后的中文注释");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, { oldPath: "main.c", newPath: "main.c" }),
        );
        assert.deepStrictEqual(contents, { oldContents: before, newContents: after });
      }),
    );

    // macOS and Windows filesystems reject file names that are not valid UTF-8.
    it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
      "keeps UTF-8 paths intact next to a non-UTF-8 path in NUL-separated output",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          for (const name of ["文档.md", "café.md"]) {
            NodeFS.writeFileSync(NodePath.join(cwd, name), "x\n");
          }
          NodeFS.writeFileSync(
            Buffer.concat([
              Buffer.from(`${cwd}/Gro`),
              Buffer.from([0xf6, 0xdf]),
              Buffer.from("e.c"),
            ]),
            "x\n",
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const result = yield* driver.execute({
            operation: "test.lsFilesOthers",
            cwd,
            args: ["ls-files", "-z", "--others"],
          });
          const paths = result.stdout.split("\0");
          assert.include(paths, "文档.md");
          assert.include(paths, "café.md");
        }),
    );

    it.effect("keeps truncated UTF-8 output as UTF-8 when the cap cuts a character", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const blob = yield* driver.execute({
          operation: "test.hashObject",
          cwd,
          args: ["hash-object", "-w", "--stdin"],
          stdin: "a中文中文\n",
        });

        // "a" + "中" + the first byte of "文": the cap lands inside a UTF-8 character.
        const result = yield* driver.execute({
          operation: "test.catFile",
          cwd,
          args: ["cat-file", "-p", blob.stdout.trim()],
          maxOutputBytes: 5,
          appendTruncationMarker: true,
        });
        assert.isTrue(result.stdoutTruncated);
        assert.strictEqual(result.stdout, "a中\uFFFD");
      }),
    );

    it.effect("compares a plain recorded base with the remote that base branch tracks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* writeTextFile(cwd, "upstream.txt", "unrelated upstream work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "upstream work"]);
        yield* git(cwd, ["push", "-u", "upstream", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/from-local-main"]);
        yield* git(cwd, ["config", "branch.feature/from-local-main.t3-merge-base", "main"]);
        yield* writeTextFile(cwd, "feature.txt", "intended branch change\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, {
          baseRef: "upstream/main",
          insertions: 1,
          deletions: 0,
        });
        assert.strictEqual(status.aheadCount, 1);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "upstream/main");
        assert.deepStrictEqual(
          changes.files?.map((file) => file.path),
          ["feature.txt"],
        );
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reads Changes totals and review diffs without minimizing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.algorithm", "myers"]);
        // Repeated lines make the default and minimal algorithms choose different edits.
        const lines = Array.from({ length: 2000 }, (_, index) => index);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 3)) % 16}\n`).join(""),
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "repeated lines"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 5)) % 16}\n`).join(""),
        );
        const defaultStat = yield* git(cwd, ["diff", "--numstat", "HEAD", "--"]);
        const minimalStat = yield* git(cwd, ["diff", "--minimal", "--numstat", "HEAD", "--"]);
        assert.notEqual(defaultStat, minimalStat);
        const [insertions, deletions] = defaultStat.split("\t");
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, {
          baseRef: initialBranch,
          insertions: Number(insertions),
          deletions: Number(deletions),
        });

        const defaultPatch = yield* git(cwd, [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "HEAD",
          "--",
        ]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        for (const source of preview.sources) {
          assert.deepStrictEqual(source.files, [
            {
              path: "repeated.txt",
              previousPath: null,
              changeType: "change",
              additions: Number(insertions),
              deletions: Number(deletions),
            },
          ]);
          assert.strictEqual(source.diff.trim(), defaultPatch);
        }
      }),
    );

    it.effect("reads Changes totals with untracked files when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);
        yield* writeTextFile(cwd, "nested/untracked.txt", "one\ntwo\n");
        yield* writeTextFile(cwd, "src/code.ts", "export const value = 1;\n");
        yield* writeTextFile(cwd, "src/code.test.ts", "test\n");
        yield* writeTextFile(cwd, "__mocks__/value.ts", "mock\n");
        yield* writeTextFile(cwd, "pnpm-lock.yaml", "lock\n");
        yield* writeTextFile(cwd, "new [1].txt", "literal\n");

        const nested = pathService.join(cwd, "nested");
        const alias = pathService.join(yield* makeTmpDir(), "alias");
        const platform = yield* HostProcess.Platform;
        yield* Effect.promise(() =>
          NodeFS.promises.symlink(nested, alias, platform === "win32" ? "junction" : "dir"),
        );
        const status = yield* driver.statusDetailsLocal(alias, {
          includeBranchChanges: true,
        });
        assert.deepInclude(status.branchChanges, {
          baseRef: "main",
          insertions: 8,
          deletions: 0,
        });
        assert.deepStrictEqual(status.branchChanges?.breakdown, {
          code: { additions: 1, deletions: 0 },
          tests: { additions: 1, deletions: 0 },
          mocks: { additions: 1, deletions: 0 },
          generated: { additions: 1, deletions: 0 },
          docs: { additions: 4, deletions: 0 },
        });
        yield* driver.ensureRemote({ cwd: alias, preferredName: "origin", url: cwd });
        assert.isTrue((yield* driver.statusDetailsLocal(alias)).hasOriginRemote);
        assert.isUndefined((yield* driver.statusDetailsLocal(cwd)).branchChanges);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          `refs/remotes/origin/${initialBranch}`,
        ]);
        const linked = yield* makeTmpDir();
        yield* git(cwd, ["worktree", "add", "-b", "feature", linked]);
        const observed = yield* driver.readStatusPoll(linked, "feature", false);
        if (observed === null) return assert.fail("Expected poll inputs for the linked worktree");
        assert.equal(yield* observed.inputStampAfterLookup, observed.inputStamp);
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
        const fresh = yield* driver.readStatusPoll(linked, "feature", false);
        if (fresh === null) return assert.fail("Expected poll inputs after the fetch");
        assert.notEqual(fresh.inputStamp, observed.inputStamp);
        assert.equal(yield* observed.inputStampAfterLookup, fresh.inputStamp);
      }),
    );

    it.effect("a ref snapshot detects which branches are checked out in other worktrees", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const worktree = (yield* Path.Path).join(cwd, "linked checkout");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "feature"]);
        yield* git(cwd, ["branch", "same-commit"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const snapshot = driver.readRefSnapshot(cwd);
        const initial = yield* snapshot;
        assert.isNotNull(initial);

        yield* git(cwd, ["worktree", "add", "--detach", worktree]);
        assert.equal(yield* snapshot, initial);
        yield* git(worktree, ["checkout", "feature"]);
        const attached = yield* snapshot;
        assert.isNotNull(attached);
        assert.notEqual(attached, initial);
        assert.equal(yield* snapshot, attached);
        yield* git(worktree, ["checkout", "same-commit"]);
        const switched = yield* snapshot;
        assert.isNotNull(switched);
        assert.notEqual(switched, attached);
        assert.notEqual(switched, initial);
        yield* git(cwd, ["worktree", "remove", worktree]);
        assert.equal(yield* snapshot, initial);
      }),
    );

    it.effect.each([{ reftable: false }, { reftable: gitHasReftable }])(
      "scopes linked worktree poll inputs and matches Git after ref moves (reftable: $reftable)",
      ({ reftable }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const linked = yield* makeTmpDir();
          const sibling = yield* makeTmpDir();
          yield* commitInitialRepo(cwd, [
            "--initial-branch=main",
            ...(reftable ? ["--ref-format=reftable"] : []),
          ]);
          yield* git(cwd, ["remote", "add", "origin", cwd]);
          const initial = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["commit", "--allow-empty", "-m", "next"]);
          const next = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["update-ref", "refs/remotes/origin/main", initial]);
          yield* git(cwd, ["update-ref", "refs/remotes/origin/trunk", next]);
          yield* git(cwd, ["update-ref", "refs/remotes/origin/feature", initial]);
          yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
          yield* git(cwd, ["worktree", "add", "-b", "feature", linked, next]);
          yield* git(cwd, ["worktree", "add", "-b", "sibling", sibling, initial]);
          yield* git(linked, ["branch", "--set-upstream-to=origin/feature"]);
          yield* git(cwd, ["config", "extensions.worktreeConfig", "true"]);

          const driver = yield* GitVcsDriver.GitVcsDriver;
          const readPoll = Effect.fnUntraced(function* () {
            const head = yield* driver.execute({
              operation: "GitVcsDriver.test.head",
              cwd: linked,
              args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
              allowNonZeroExit: true,
            });
            const branch = head.exitCode === 0 ? head.stdout.trim() : null;
            const poll = yield* driver.readStatusPoll(linked, branch, false);
            if (poll === null) return assert.fail("Expected a bounded poll read");
            const defaultRef = yield* git(linked, [
              "rev-parse",
              "--verify",
              "--symbolic-full-name",
              "refs/remotes/origin/HEAD",
            ]);
            const upstream = yield* driver.execute({
              operation: "GitVcsDriver.test.upstream",
              cwd: linked,
              args: ["rev-parse", "--symbolic-full-name", "@{upstream}"],
              allowNonZeroExit: true,
            });
            const hasUpstream = upstream.exitCode === 0;
            const configured = yield* driver.execute({
              operation: "GitVcsDriver.test.base",
              cwd: linked,
              args: ["config", "--get", "branch.feature.t3-merge-base-ref"],
              allowNonZeroExit: true,
            });
            const base = configured.exitCode === 0 ? configured.stdout.trim() : defaultRef;
            const aheadOfBase =
              branch === null
                ? 0
                : Number(yield* git(linked, ["rev-list", "--count", `${base}..HEAD`]));
            const [ahead = 0, behind = 0] = hasUpstream
              ? (yield* git(linked, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
                  .split(/\s+/)
                  .map(Number)
              : [aheadOfBase, 0];
            assert.deepStrictEqual(poll.details, {
              isRepo: true,
              branch,
              defaultBranch: defaultRef.replace("refs/remotes/origin/", ""),
              hasPrimaryRemote: true,
              isDefaultBranch: false,
              upstreamRef: hasUpstream
                ? upstream.stdout.trim().replace(/^refs\/remotes\//, "")
                : null,
              hasUpstream,
              aheadCount: ahead,
              behindCount: behind,
              aheadOfDefaultCount: aheadOfBase,
            });
            return poll.inputStamp;
          });

          let snapshot = yield* readPoll();
          const digest = yield* driver.readRefSnapshot(linked);
          yield* git(cwd, ["update-ref", "refs/t3/checkpoints/thread/turn", next]);
          assert.notEqual(yield* driver.readRefSnapshot(linked), digest);
          assert.equal(yield* readPoll(), snapshot);
          assert.notEqual(
            (yield* driver.readStatusPoll(sibling, "sibling", false))?.inputStamp,
            snapshot,
          );

          yield* git(sibling, ["update-ref", "refs/heads/sibling", next]);
          yield* git(cwd, ["update-ref", "refs/remotes/origin/unrelated", next]);
          yield* git(cwd, ["pack-refs", "--all"]);
          assert.equal(yield* readPoll(), snapshot);
          // Divergence comes from the poll itself; readPoll checks it against Git.
          yield* git(cwd, ["update-ref", "refs/remotes/origin/feature", next]);
          snapshot = yield* readPoll();

          yield* git(cwd, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
          ]);
          const movedHead = yield* readPoll();
          assert.notEqual(movedHead, snapshot);
          yield* git(cwd, ["update-ref", "refs/remotes/origin/trunk", initial]);
          const movedBase = yield* readPoll();
          assert.notEqual(movedBase, movedHead);
          yield* git(linked, [
            "config",
            "--worktree",
            "branch.feature.t3-merge-base-ref",
            "refs/remotes/origin/main",
          ]);
          const configuredBase = yield* readPoll();
          assert.notEqual(configuredBase, movedBase);
          assert.equal(
            (yield* driver.statusDetailsLocal(linked, { includeBranchChanges: true })).branchChanges
              ?.baseRef,
            "origin/main",
          );
          yield* git(linked, ["branch", "--unset-upstream"]);
          yield* readPoll();
          yield* git(linked, ["checkout", "--detach", "HEAD"]);
          const detached = yield* readPoll();
          assert.notEqual(detached, configuredBase);
          yield* git(linked, ["checkout", "feature"]);
          assert.notEqual(yield* readPoll(), detached);

          yield* git(cwd, ["branch", "local-base", initial]);
          const localWorktree = yield* makeTmpDir();
          yield* driver.createWorktree({
            cwd,
            path: localWorktree,
            refName: "refs/heads/local-base",
            baseRefName: "refs/heads/local-base",
            newRefName: "local-feature",
          });
          assert.equal(
            yield* git(localWorktree, ["config", "--get", "branch.local-feature.t3-merge-base"]),
            "local-base",
          );
          yield* git(localWorktree, ["commit", "--allow-empty", "-m", "local feature"]);
          const pollLocal = driver.readStatusPoll(localWorktree, "local-feature", false);
          const local = yield* pollLocal;
          assert.isNotNull(local);
          assert.equal(local?.details.aheadCount, 1);
          yield* git(cwd, ["update-ref", "refs/t3/checkpoints/thread/unrelated", initial]);
          assert.equal((yield* pollLocal)?.inputStamp, local?.inputStamp);
          const featureHead = yield* git(localWorktree, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["update-ref", "refs/heads/local-base", featureHead]);
          const advanced = yield* pollLocal;
          assert.isNotNull(advanced);
          assert.notEqual(advanced?.inputStamp, local?.inputStamp);
          assert.equal(advanced?.details.aheadCount, 0);
        }),
    );

    it.effect("uses Git's exact fallback ref lookup for differently cased loose refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* commitInitialRepo(cwd, ["--initial-branch=Main"]);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "feature work"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const poll = driver.readStatusPoll(cwd, "feature", false);
        const before = yield* poll;
        assert.isNotNull(before);
        const direct = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
        assert.deepStrictEqual(before?.details, direct);
        yield* git(cwd, ["update-ref", "refs/heads/Main", "HEAD"]);
        const after = yield* poll;
        assert.isNotNull(after);
        assert.deepStrictEqual(
          after?.details,
          yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
        );
        // With loose refs, the filesystem decides whether Main also resolves as main.
        if (direct.aheadCount > 0) assert.notEqual(after?.inputStamp, before?.inputStamp);
      }),
    );

    it.effect("polls an unborn worktree and declines unproven ref dependencies", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init", "--initial-branch=main"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const poll = driver.readStatusPoll(cwd, "main", false);
        const unborn = yield* poll;
        assert.isNotNull(unborn);
        assert.equal((yield* poll)?.inputStamp, unborn?.inputStamp);
        assert.equal(unborn?.details.branch, "main");
        assert.isFalse(unborn?.details.hasUpstream);
        yield* commitInitialRepo(cwd);
        const born = yield* poll;
        assert.isNotNull(born);
        assert.notEqual(born?.inputStamp, unborn?.inputStamp);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "replacement"]);
        yield* git(cwd, ["replace", "HEAD^", "HEAD"]);
        assert.isNull(yield* poll);
      }),
    );

    it.effect("a ref snapshot detects branch identity, ref and ancestry changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const snapshot = driver.readRefSnapshot(cwd);

        // Newer Git can create origin/HEAD on the first fetch.
        yield* git(cwd, ["fetch", "origin"]);
        const initial = yield* snapshot;
        assert.isNotNull(initial);
        yield* git(cwd, ["fetch", "origin"]);
        assert.equal(yield* snapshot, initial);

        yield* git(cwd, ["branch", "same-commit"]);
        const beforeCheckout = yield* snapshot;
        const refsBeforeCheckout = yield* git(cwd, ["show-ref", "--head"]);
        yield* git(cwd, ["checkout", "same-commit"]);
        assert.equal(yield* git(cwd, ["show-ref", "--head"]), refsBeforeCheckout);
        const afterCheckout = yield* snapshot;
        assert.isNotNull(afterCheckout);
        assert.notEqual(afterCheckout, beforeCheckout);
        yield* git(cwd, ["checkout", "--detach"]);
        assert.equal(yield* git(cwd, ["show-ref", "--head"]), refsBeforeCheckout);
        const detached = yield* snapshot;
        assert.isNotNull(detached);
        assert.notEqual(detached, beforeCheckout);
        assert.notEqual(detached, afterCheckout);
        assert.equal(yield* snapshot, detached);
        yield* git(cwd, ["checkout", initialBranch]);
        assert.equal(yield* snapshot, beforeCheckout);
        yield* git(cwd, ["branch", "-d", "same-commit"]);

        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);
        assert.equal(yield* snapshot, initial);
        yield* git(cwd, ["fetch", "origin"]);
        const fetched = yield* snapshot;
        assert.notEqual(fetched, initial);

        const shallow = yield* makeTmpDir("git-vcs-driver-shallow-");
        yield* git(shallow, ["clone", "--depth=1", NodeURL.pathToFileURL(remote).href, "."]);
        const shallowRefs = yield* git(shallow, ["show-ref", "--head"]);
        const shallowSnapshot = yield* driver.readRefSnapshot(shallow);
        assert.isNotNull(shallowSnapshot);
        const shallowBranch = yield* git(shallow, ["symbolic-ref", "--short", "HEAD"]);
        const shallowInputs = yield* driver.readStatusPoll(shallow, shallowBranch, false);
        assert.isNotNull(shallowInputs);
        const shallowWorktree = yield* makeTmpDir("git-vcs-driver-shallow-worktree-");
        yield* git(shallow, ["worktree", "add", "--detach", shallowWorktree]);
        const worktreeSnapshot = yield* driver.readRefSnapshot(shallowWorktree);
        assert.isNotNull(worktreeSnapshot);
        const worktreeInputs = yield* driver.readStatusPoll(shallowWorktree, null, false);
        assert.isNotNull(worktreeInputs);
        yield* git(shallow, ["fetch", "--unshallow", "origin"]);
        assert.equal(yield* git(shallow, ["show-ref", "--head"]), shallowRefs);
        const unshallowSnapshot = yield* driver.readRefSnapshot(shallow);
        const unshallowWorktreeSnapshot = yield* driver.readRefSnapshot(shallowWorktree);
        assert.isNotNull(unshallowSnapshot);
        assert.isNotNull(unshallowWorktreeSnapshot);
        assert.notEqual(unshallowSnapshot, shallowSnapshot);
        assert.notEqual(unshallowWorktreeSnapshot, worktreeSnapshot);
        const deepened = yield* driver.readStatusPoll(shallow, shallowBranch, false);
        const deepenedWorktree = yield* driver.readStatusPoll(shallowWorktree, null, false);
        assert.isNotNull(deepened);
        assert.isNotNull(deepenedWorktree);
        assert.notEqual(deepened?.inputStamp, shallowInputs?.inputStamp);
        assert.notEqual(deepenedWorktree?.inputStamp, worktreeInputs?.inputStamp);

        yield* git(cwd, ["checkout", "--detach"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "detached"]);
        assert.notEqual(yield* snapshot, fetched);

        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* driver.execute({
          operation: "GitVcsDriver.test.git",
          cwd,
          args: ["update-ref", "--stdin"],
          stdin: Array.from(
            { length: 16_000 },
            (_, index) => `create refs/heads/snapshot-${String(index).padStart(5, "0")} ${head}\n`,
          ).join(""),
        });
        yield* git(cwd, ["pack-refs", "--all"]);
        const large = yield* snapshot;
        assert.isNotNull(large);
        assert.isAbove(Buffer.byteLength(large ?? "", "utf8"), 1_000_000);
        assert.equal(yield* snapshot, large);
        yield* git(cwd, ["update-ref", "refs/heads/snapshot-00000", "HEAD~1"]);
        assert.notEqual(yield* snapshot, large);

        assert.isNull(yield* driver.readRefSnapshot(yield* makeTmpDir()));
      }),
    );

    it.effect.each([
      { fetch: "statusDetailsRemote" },
      // Storage cleanup's merge check fetches the default branch on every sweep.
      { fetch: "fetchRemoteTrackingBranch" },
      // Startup pulls each project's default branch.
      { fetch: "pullCurrentBranch" },
    ] as const)("does not start Git auto-maintenance from $fetch", ({ fetch }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["repack", "-d"]);
        yield* writeTextFile(cwd, "second.txt", "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "second commit"]);
        yield* git(cwd, ["push"]);
        yield* git(cwd, ["repack", "-d"]);
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        // The test template's global config turns auto-maintenance off.
        yield* git(cwd, ["config", "maintenance.auto", "true"]);
        const packCount = git(cwd, ["count-objects", "-v"]).pipe(
          Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
        );
        assert.equal(yield* packCount, "2");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        if (fetch === "statusDetailsRemote") yield* driver.statusDetailsRemote(cwd);
        else if (fetch === "pullCurrentBranch") yield* driver.pullCurrentBranch(cwd);
        else
          yield* driver.fetchRemoteTrackingBranch({
            cwd,
            remoteName: "origin",
            remoteBranch: initialBranch,
          });

        assert.equal(yield* packCount, "2");
      }),
    );

    // Cutting a transfer short takes a shell `upload-pack` wrapper.
    describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "background upstream fetch objects",
      () => {
        it.effect.each([
          { transfer: "cut short", unpackLimit: "1", behindCount: 0 },
          { transfer: "complete as a pack", unpackLimit: "1", behindCount: 1 },
          { transfer: "complete as loose objects", unpackLimit: "100", behindCount: 1 },
          { transfer: "followed by a push", unpackLimit: "100", behindCount: 0 },
        ] as const)(
          "leaves only finished objects after a background upstream fetch that is $transfer",
          ({ transfer, unpackLimit, behindCount }) =>
            Effect.gen(function* () {
              const path = yield* Path.Path;
              const cwd = yield* makeTmpDir();
              const remote = yield* makeTmpDir("git-vcs-driver-remote-");
              const updater = yield* makeTmpDir("git-vcs-driver-updater-");
              const { initialBranch } = yield* initRepoWithCommit(cwd);
              yield* git(remote, ["init", "--bare"]);
              yield* git(cwd, ["remote", "add", "origin", remote]);
              yield* git(cwd, ["push", "-u", "origin", initialBranch]);

              yield* git(updater, ["clone", remote, "."]);
              yield* git(updater, ["config", "user.email", "test@test.com"]);
              yield* git(updater, ["config", "user.name", "Test"]);
              const incompressible = new Uint8Array(150_000);
              for (let index = 0, state = 1; index < incompressible.length; index++) {
                state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
                incompressible[index] = state >>> 16;
              }
              NodeFS.writeFileSync(path.join(updater, "remote.bin"), incompressible);
              yield* git(updater, ["add", "remote.bin"]);
              yield* git(updater, ["commit", "-m", "remote commit"]);
              yield* git(updater, ["push", "origin", initialBranch]);
              NodeFS.writeFileSync(path.join(updater, "pushed.bin"), incompressible.reverse());
              yield* git(updater, ["add", "pushed.bin"]);
              yield* git(updater, ["commit", "-m", "pushed between connections"]);
              yield* git(updater, ["push", "origin", "HEAD:refs/pending/push"]);

              // The first transfer is whole and the branch may move right after it. The fetch
              // that moves the refs then meets a remote its download did not see, and must not
              // point a ref at the push: nothing has put those objects in the repository.
              const served = path.join(remote, "served");
              if (transfer === "cut short") NodeFS.writeFileSync(served, "");
              const push =
                transfer === "followed by a push"
                  ? `git --git-dir='${remote}' update-ref refs/heads/${initialBranch} refs/pending/push;`
                  : "";
              const later =
                transfer === "followed by a push" ? "" : "| dd bs=1 count=50000 2>/dev/null";
              yield* git(cwd, [
                "config",
                "remote.origin.uploadpack",
                `f() { if [ -e '${served}' ]; then git upload-pack "$@" ${later}; else : > '${served}'; git upload-pack "$@"; ${push} fi; }; f`,
              ]);
              yield* git(cwd, ["config", "fetch.unpackLimit", unpackLimit]);
              const objects = path.join(cwd, ".git", "objects");
              NodeFS.writeFileSync(path.join(objects, "pack", "tmp_pack_other"), "another fetch");

              const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

              assert.equal(status.behindCount, behindCount);
              assert.deepEqual(
                [...NodeFS.readdirSync(objects), ...NodeFS.readdirSync(path.join(objects, "pack"))]
                  .filter((name) => name.startsWith("tmp_"))
                  .toSorted(),
                ["tmp_pack_other"],
              );
            }),
        );
      },
    );
  });

  describe("refName operations", () => {
    it.effect.each(["trunk", "feature/memo\u3000", "\u00a0release"])(
      "marks the origin default ref %s as default when no local copy exists",
      (defaultBranch) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-vcs-driver-remote-");
          yield* initRepoWithCommit(cwd);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["branch", "-M", defaultBranch]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", defaultBranch]);
          yield* git(cwd, ["remote", "set-head", "origin", defaultBranch]);
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const localStatus = yield* driver.statusDetails(cwd);
          const remoteStatus = yield* driver.statusDetailsRemote(cwd);
          for (const status of [localStatus, remoteStatus]) {
            assert.equal(status.branch, defaultBranch);
            assert.equal(status.upstreamRef, `origin/${defaultBranch}`);
            assert.isTrue(status.isDefaultBranch);
          }

          yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
          yield* git(cwd, ["branch", "-D", defaultBranch]);

          const refs = yield* driver.listRefs({ cwd });
          const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${defaultBranch}`);
          assert.equal(remoteDefault?.isRemote, true);
          assert.equal(remoteDefault?.isDefault, true);
        }),
    );

    it.effect(
      "tracks the real branch name and refuses local collisions for remotes containing slashes",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const slashedRemote = yield* makeTmpDir("git-remote-slashed-");
          yield* git(slashedRemote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "team/origin", slashedRemote]);
          yield* git(cwd, ["push", "team/origin", "HEAD:refs/heads/feature/demo"]);
          yield* git(cwd, ["push", "team/origin", "HEAD:refs/heads/conflict"]);
          yield* git(cwd, ["fetch", "team/origin"]);

          const driver = yield* GitVcsDriver.GitVcsDriver;
          const switched = yield* driver.switchRef({ cwd, refName: "team/origin/feature/demo" });

          assert.equal(switched.refName, "feature/demo");
          assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/demo");
          assert.equal(
            yield* git(cwd, ["for-each-ref", "--format=%(upstream)", "refs/heads/feature/demo"]),
            "refs/remotes/team/origin/feature/demo",
          );
          assert.equal(
            yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/origin"]),
            "",
          );

          yield* git(cwd, ["checkout", "--no-track", "-b", "conflict"]);
          yield* git(cwd, ["commit", "--allow-empty", "-m", "Local conflict work"]);
          yield* git(cwd, ["checkout", initialBranch]);

          const conflicted = yield* driver
            .switchRef({ cwd, refName: "team/origin/conflict" })
            .pipe(Effect.flip);

          assert.equal(conflicted.reason, "branch_already_exists");
          assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
          assert.equal(
            yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/origin"]),
            "",
          );
        }),
    );

    it.effect("explains how to proceed when local changes block a branch switch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "example.txt", "main\n");
        yield* git(cwd, ["add", "example.txt"]);
        yield* git(cwd, ["commit", "-m", "main example"]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature"]);
        yield* writeTextFile(cwd, "example.txt", "feature\n");
        yield* git(cwd, ["commit", "-am", "feature example"]);
        yield* git(cwd, ["checkout", "-q", initialBranch]);
        yield* writeTextFile(cwd, "example.txt", "uncommitted work\n");

        const error = yield* driver.switchRef({ cwd, refName: "feature" }).pipe(Effect.flip);

        assert.match(error.detail, /local changes/i);
        assert.match(error.detail, /commit|stash|discard/i);
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
    );
  });

  describe("worktree operations", () => {
    // regression: #27749 hooks inherited the driver's forced LC_ALL=C

    // regression: #25367 a checkout that writes over 1 MB to stderr failed on the output cap

    it.effect("refreshes a new worktree's index once its checkout second is over", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (let file = 0; file < 50; file++) {
          yield* writeTextFile(cwd, `src/file-${file}.txt`, `contents ${file}\n`);
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "more files"]);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "fresh");
        // A refresh still inside the checkout's second finishes in the background.
        const worktreesDir = path.join(cwd, ".git", "worktrees");
        yield* fs.makeDirectory(worktreesDir, { recursive: true });
        const indexChanges = yield* Queue.unbounded<void>();
        yield* fs.watch(worktreesDir, { recursive: true }).pipe(
          Stream.runForEach(() => Queue.offer(indexChanges, undefined)),
          Effect.forkScoped,
        );

        // The refresh waits on the clock that stamps the files.
        yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/fresh",
          }),
        );

        // Git re-reads every entry stamped in the index's own second or later.
        const indexPath = path.resolve(
          worktreePath,
          yield* git(worktreePath, ["rev-parse", "--git-path", "index"]),
        );
        const racyEntries = Effect.gen(function* () {
          const indexMtime = Option.getOrThrow((yield* fs.stat(indexPath)).mtime);
          const indexSecond = Math.floor(indexMtime.getTime() / 1000);
          const entrySeconds = Array.from(
            (yield* git(worktreePath, ["ls-files", "--debug"])).matchAll(/^ {2}mtime: (\d+):/gm),
            ([, seconds]) => Number(seconds),
          );
          assert.equal(entrySeconds.length, 51);
          return entrySeconds.filter((seconds) => seconds >= indexSecond);
        });
        while ((yield* racyEntries).length > 0 || (yield* fs.exists(`${indexPath}.t3-refresh`))) {
          yield* Queue.take(indexChanges);
        }
        assert.isFalse(yield* fs.exists(`${indexPath}.lock`));
      }),
    );

    // regression: #28354 a failed worktree add left its new branch behind and blocked retries

    it.effect.each([
      "release/v2",
      "origin/release/v2",
      "refs/remotes/origin/release/v2",
      "origin/release/v2\u3000",
    ])("records a remote-only PR base when creating a worktree from %s", (baseRef) =>
      Effect.gen(function* () {
        const branch = baseRef.replace(/^(refs\/remotes\/)?origin\//, "");
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `HEAD:refs/heads/${branch}`]);
        const commit = yield* git(cwd, ["rev-parse", `origin/${branch}`]);
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "remote");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: commit,
          newRefName: "feature/remote",
          baseRefName: baseRef,
        });

        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/remote.t3-merge-base"),
          branch,
        );
        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]), commit);
      }),
    );

    // NTFS rejects a newline in a file name, so there is nothing to preserve there.

    it.effect("sparse worktrees read .gitmodules and t3.json from HEAD", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", NodeURL.pathToFileURL(submoduleRepo).href, "shared"]);
        yield* writeTextFile(cwd, "sparse-patterns.txt", "/shared/\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktrees = yield* makeTmpDir("git-worktrees-");

        const createSparse = Effect.fn(function* (projectFile: string, branch: string) {
          yield* writeTextFile(cwd, "t3.json", projectFile);
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", branch]);
          const sparsePath = pathService.join(worktrees, branch);
          // A relative path also covers the git commands that run inside the new worktree.
          yield* driver.createWorktree({
            cwd,
            path: pathService.relative(cwd, sparsePath),
            refName: initialBranch,
            newRefName: branch,
          });
          assert.isFalse(yield* fileSystem.exists(pathService.join(sparsePath, ".gitmodules")));
          assert.isFalse(yield* fileSystem.exists(pathService.join(sparsePath, "t3.json")));
          return yield* fileSystem.exists(pathService.join(sparsePath, "shared", "SHARED.md"));
        });

        assert.isTrue(
          yield* createSparse(`{ "worktreeSparsePatternsPath": "sparse-patterns.txt" }`, "sparse"),
        );
        assert.isFalse(
          yield* createSparse(
            `{ "worktreeSparsePatternsPath": "sparse-patterns.txt", "worktreeSubmodules": "none" }`,
            "sparse-none",
          ),
        );
      }).pipe(withGitFileProtocol),
    );

    it.effect("checks out only the t3.json sparse patterns in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const repo = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(repo);
        yield* writeTextFile(repo, "src/app.ts", "export {};\n");
        yield* writeTextFile(repo, "assets/large.bin", "large\n");
        yield* writeTextFile(repo, "sparse-patterns.txt", "/*\n!/assets/\n");
        yield* writeTextFile(
          repo,
          "t3.json",
          `{ "worktreeSparsePatternsPath": "./sparse-patterns.txt" }`,
        );
        yield* git(repo, ["add", "."]);
        yield* git(repo, ["commit", "-m", "sparse patterns"]);
        yield* git(repo, ["checkout", "-q", "-b", "previous"]);
        yield* git(repo, ["checkout", "-q", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktrees = yield* makeTmpDir("git-worktrees-");
        // A project opened at a subdirectory still reads both files from the repository root.
        const cwd = pathService.join(repo, "src");

        const assertSparse = Effect.fn(function* (worktreePath: string, branch: string) {
          assert.isTrue(yield* fileSystem.exists(pathService.join(worktreePath, "src", "app.ts")));
          assert.isFalse(
            yield* fileSystem.exists(pathService.join(worktreePath, "assets", "large.bin")),
          );
          assert.equal(yield* git(worktreePath, ["sparse-checkout", "list"]), "/*\n!/assets/");
          assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), branch);
        });

        const sparse = pathService.join(worktrees, "sparse");
        yield* driver.createWorktree({
          cwd,
          path: pathService.relative(cwd, sparse),
          refName: initialBranch,
          newRefName: "feature/sparse",
        });
        yield* assertSparse(sparse, "feature/sparse");

        const fromPrevious = pathService.join(worktrees, "from-previous");
        yield* driver.createWorktree({
          cwd,
          path: fromPrevious,
          refName: "-",
          newRefName: "feature/from-previous",
        });
        yield* assertSparse(fromPrevious, "feature/from-previous");
        assert.notInclude(yield* git(repo, ["worktree", "list", "--porcelain"]), "locked");

        // Only the sparse checkout runs the hook, so its failure removes the locked registration.
        yield* writeTextFile(repo, ".git/hooks/post-checkout", "#!/bin/sh\nexit 1\n");
        yield* fileSystem.chmod(pathService.join(repo, ".git/hooks/post-checkout"), 0o755);
        const failed = pathService.join(worktrees, "failed");
        yield* Effect.flip(
          driver.createWorktree({
            cwd,
            path: failed,
            refName: initialBranch,
            newRefName: "feature/failed",
          }),
        );
        assert.isFalse(yield* fileSystem.exists(failed));
        assert.notInclude(yield* git(repo, ["worktree", "list", "--porcelain"]), "feature/failed");
        assert.equal(yield* git(repo, ["branch", "--list", "feature/failed"]), "");
      }),
    );

    it.effect("fails without a worktree when the t3.json sparse pattern path is not a file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "patterns/keep.txt", "/*\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktrees = yield* makeTmpDir("git-worktrees-");
        for (const patternsPath of ["missing.txt", "patterns"]) {
          yield* writeTextFile(
            cwd,
            "t3.json",
            JSON.stringify({ worktreeSparsePatternsPath: patternsPath }),
          );
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "missing sparse patterns"]);
          const worktreePath = pathService.join(worktrees, patternsPath);

          const error = yield* Effect.flip(
            driver.createWorktree({
              cwd,
              path: worktreePath,
              refName: initialBranch,
              newRefName: `feature/${patternsPath}`,
            }),
          );

          assert.include(error.detail, patternsPath);
          assert.isFalse(yield* fileSystem.exists(worktreePath));
          assert.notInclude(yield* git(cwd, ["worktree", "list"]), worktreePath);
          assert.equal(yield* git(cwd, ["branch", "--list", `feature/${patternsPath}`]), "");
        }
      }),
    );

    it.effect("reports a rename as done when Git moved the ref but kept the config locked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "t3/abcd1234"]);
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const renamed = yield* TestClock.withLive(
          driver.renameBranch({ cwd, oldBranch: "t3/abcd1234", newBranch: "t3/fix-login" }),
        );

        assert.equal(renamed.branch, "t3/fix-login");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3/fix-login");
      }),
    );

    it.effect.each([
      ["native", ""],
      ["Windows with trailing NBSP in metadata paths", "\u00a0"],
    ] as const)("force-removes a worktree without deleting junction targets: %s", ([, suffix]) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const commonDir = pathService.join(cwd, suffix ? "metadata" + suffix : ".git");
        if (suffix) yield* git(cwd, ["init", "--separate-git-dir", commonDir]);
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        yield* writeTextFile(outside, "keep.txt", "keep\n");
        const worktreeName = "linked" + suffix;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), worktreeName);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        // Junctions on Windows, the way pnpm links packages; symlinks elsewhere.
        NodeFS.mkdirSync(pathService.join(worktreePath, "node_modules"));
        NodeFS.symlinkSync(
          outside,
          pathService.join(worktreePath, "node_modules", "dep"),
          "junction",
        );
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "shared"), "junction");

        const platform = yield* HostProcess.Platform;
        yield* driver
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(Effect.provideService(HostProcess.Platform, suffix ? "win32" : platform));

        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), []);
        assert.isFalse(
          yield* fileSystem.exists(pathService.join(commonDir, "worktrees", worktreeName)),
        );
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
          "keep\n",
        );
      }),
    );
  });

  describe("commit context", () => {
    it.effect.each(["root", "aliased-nested"] as const)(
      "prepares selected files without staging and commits only those files from %s",
      (location) =>
        Effect.gen(function* () {
          const sandbox = yield* makeTmpDir();
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const repository = path.join(sandbox, "repo");
          const nested = path.join(repository, "sub", "dir");
          yield* fileSystem.makeDirectory(nested, { recursive: true });
          yield* initRepoWithCommit(repository);
          const cwd = location === "aliased-nested" ? path.join(sandbox, "link") : repository;
          if (location === "aliased-nested") NodeFS.symlinkSync(nested, cwd, "junction");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const selected = "sub/dir/a.txt";
          yield* writeTextFile(repository, selected, "a\n");
          yield* writeTextFile(repository, "b.txt", "b\n");

          const context = yield* driver.prepareCommitContext(cwd, [selected]);
          assert.include(context?.stagedSummary ?? "", "a.txt");
          assert.notInclude(context?.stagedSummary ?? "", "b.txt");
          assert.equal(yield* git(repository, ["diff", "--cached", "--name-only"]), "");

          // A selected file staged and then reverted stages to nothing, like git commit --only.
          const head = yield* git(repository, ["rev-parse", "HEAD"]);
          yield* writeTextFile(repository, "README.md", "staged\n");
          yield* git(repository, ["add", "README.md"]);
          yield* git(repository, ["restore", "--source=HEAD", "--worktree", "--", "README.md"]);
          const empty = yield* driver
            .commit(cwd, "Empty", "", { stage: { filePaths: ["README.md"] } })
            .pipe(Effect.flip);
          assert.equal(empty._tag, "GitNothingToCommitError");
          assert.equal(yield* git(repository, ["rev-parse", "HEAD"]), head);

          const commit = yield* driver.commit(cwd, "Add a", "", {
            stage: { filePaths: [selected] },
          });
          assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
          assert.equal(yield* git(repository, ["log", "-1", "--pretty=%s"]), "Add a");
          assert.equal(
            yield* git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
            selected,
          );
          const status = yield* git(repository, ["status", "--porcelain"]);
          assert.include(status, "?? b.txt");
          assert.notInclude(status, "a.txt");
        }),
    );

    it.effect("reports a merge resolved to HEAD's tree as committable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // A branch named MERGE_HEAD is not a merge in progress.
        yield* git(cwd, ["branch", "MERGE_HEAD"]);
        assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
        const empty = yield* driver.commit(cwd, "Empty", "", { stage: {} }).pipe(Effect.flip);
        assert.equal(empty._tag, "GitNothingToCommitError");
        yield* git(cwd, ["branch", "-D", "MERGE_HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "README.md", "feature version\n");
        yield* git(cwd, ["commit", "-am", "Feature"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "README.md", "main version\n");
        yield* git(cwd, ["commit", "-am", "Main"]);
        const merge = yield* driver.execute({
          operation: "test.merge",
          cwd,
          args: ["merge", "feature"],
          allowNonZeroExit: true,
        });
        assert.equal(merge.exitCode, 1);
        yield* writeTextFile(cwd, "README.md", "main version\n");

        assert.isNotNull(
          yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }),
        );
        const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        const featureHead = yield* git(cwd, ["rev-parse", "feature"]);
        yield* driver.commit(cwd, "Merge feature", "", { stage: {} });
        assert.equal(
          yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
          `${mainHead} ${featureHead}`,
        );
      }),
    );

    it.effect("keeps other files conflicted through a selected-file commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // git stash pop leaves README.md conflicted with no merge in progress.
        yield* writeTextFile(cwd, "README.md", "stashed version\n");
        yield* git(cwd, ["stash"]);
        yield* writeTextFile(cwd, "README.md", "committed version\n");
        yield* writeTextFile(cwd, "same.txt", "same\n");
        yield* writeTextFile(cwd, "gone.txt", "gone\n");
        yield* git(cwd, ["add", "same.txt", "gone.txt"]);
        yield* git(cwd, ["commit", "-am", "Change README"]);
        const pop = yield* driver.execute({
          operation: "test.stashPop",
          cwd,
          args: ["stash", "pop"],
          allowNonZeroExit: true,
        });
        assert.equal(pop.exitCode, 1);
        const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

        // A selected file staged and then reverted has nothing to commit despite the conflict.
        const unchangedHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "same.txt", "staged\n");
        yield* git(cwd, ["add", "same.txt"]);
        yield* git(cwd, ["restore", "--source=HEAD", "--worktree", "--", "same.txt"]);
        const empty = yield* driver
          .commit(cwd, "Empty", "", { stage: { filePaths: ["same.txt"] } })
          .pipe(Effect.flip);
        assert.equal(empty._tag, "GitNothingToCommitError");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), unchangedHead);
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

        yield* (yield* FileSystem.FileSystem).remove((yield* Path.Path).join(cwd, "gone.txt"));
        yield* driver.commit(cwd, "Remove gone", "", { stage: { filePaths: ["gone.txt"] } });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-status", "HEAD"]),
          "D\tgone.txt",
        );

        yield* writeTextFile(cwd, "other.txt", "other\n");
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nested = path.join(cwd, "nested");
        yield* fs.makeDirectory(nested);
        // A formatting hook stages its edit into the temporary index that --only commits from.
        yield* writeTextFile(
          cwd,
          ".git/hooks/pre-commit",
          "#!/bin/sh\necho formatted >> other.txt\ngit add other.txt\n",
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/pre-commit"), 0o755);

        yield* driver.commit(cwd, "Add other", "", { stage: { filePaths: ["other.txt"] } });

        assert.equal(yield* git(cwd, ["rev-parse", "HEAD~1"]), head);
        assert.equal(yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]), "other.txt");
        assert.equal(yield* git(cwd, ["show", "HEAD:other.txt"]), "other\nformatted");
        assert.equal(yield* git(cwd, ["show", ":other.txt"]), "other\nformatted");
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
        const all = yield* driver.prepareCommitContext(nested).pipe(Effect.flip);
        assert.equal(
          all.detail,
          "Cannot commit with unresolved merge conflicts in README.md. Resolve them, then commit.",
        );
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("publishes a new branch at the same commit as its local upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const remoteBase = yield* git(remote, [
          "--git-dir=.",
          "rev-parse",
          `refs/heads/${initialBranch}`,
        ]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        const { commitSha } = yield* driver.commit(cwd, "Add feature", "");
        yield* git(cwd, ["config", "branch.autoSetupMerge", "always"]);
        yield* driver.createRef({ cwd, refName: "feature/push" });
        yield* driver.switchRef({ cwd, refName: "feature/push" });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
          `refs/heads/${initialBranch}`,
        );

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          upstreamBranch: "origin/feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
          commitSha,
        );
        assert.equal(
          yield* git(remote, ["--git-dir=.", "rev-parse", `refs/heads/${initialBranch}`]),
          remoteBase,
        );
      }),
    );

    it.effect(
      "publishes a new branch prefixed with another remote's name under its full name",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const origin = yield* makeTmpDir("git-remote-");
          const fork = yield* makeTmpDir("git-fork-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(origin, ["init", "--bare"]);
          yield* git(fork, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", origin]);
          // e.g. the remote T3 adds when checking out a pull request from alice's fork.
          yield* git(cwd, ["remote", "add", "alice", fork]);
          yield* git(cwd, ["checkout", "-b", "alice/fix"]);
          yield* writeTextFile(cwd, "fix.txt", "fix\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add fix", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, { status: "pushed", upstreamBranch: "origin/alice/fix" });
          assert.equal(
            yield* git(origin, ["--git-dir=.", "rev-parse", "refs/heads/alice/fix"]),
            yield* git(cwd, ["rev-parse", "HEAD"]),
          );
        }),
    );

    it.effect("runs approved push hooks only while they are the files that were approved", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-hooked-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        assert.isNull(yield* driver.pushHooks(cwd));

        // Kept in a linked worktree's checkout, as a project with husky has them.
        const worktree = NodePath.join(yield* makeTmpDir("git-hooked-worktree-"), "topic");
        yield* git(cwd, ["config", "core.hooksPath", ".husky"]);
        yield* git(cwd, ["worktree", "add", "-b", "topic", worktree]);
        const hook = NodePath.join(worktree, ".husky", "pre-push");
        const ran = NodePath.join(yield* makeTmpDir("git-hook-ran-"), "ran");
        NodeFS.mkdirSync(NodePath.dirname(hook));
        const writeHook = (label: string) =>
          NodeFS.writeFileSync(hook, `#!/bin/sh\necho ${label} >> '${ran}'\n`, { mode: 0o755 });
        writeHook("first");
        const approved = yield* driver.pushHooks(worktree);
        assert.deepEqual(
          approved?.files.map((file) => NodeFS.realpathSync(file)),
          [NodeFS.realpathSync(hook)],
        );
        assert.deepEqual(approved?.commands, []);
        if ((yield* HostProcess.Platform) !== "win32") {
          // A file Git may not execute is not a hook it would run.
          NodeFS.chmodSync(hook, 0o644);
          assert.isNull(yield* driver.pushHooks(worktree));
          NodeFS.chmodSync(hook, 0o755);
        }

        writeHook("second");
        const push = (digest: string | null) =>
          driver.pushCurrentBranch(worktree, null).pipe(
            Effect.provideService(GitVcsDriver.RepositoryHooks, {
              _tag: "approved-push",
              digest,
            }),
          );
        const pushedTopic = git(cwd, ["ls-remote", "origin", "refs/heads/topic"]);
        for (const digest of [approved!.digest, null]) {
          const refused = yield* push(digest).pipe(Effect.flip);
          assert.instanceOf(refused.cause, GitVcsDriver.PushHooksUnapprovedError);
          assert.equal(yield* pushedTopic, "");
          assert.isFalse(NodeFS.existsSync(ran));
        }

        const current = yield* driver.pushHooks(worktree);
        assert.notEqual(current?.digest, approved?.digest);
        assert.deepInclude(yield* push(current!.digest), { status: "pushed", branch: "topic" });
        assert.equal(NodeFS.readFileSync(ran, "utf8"), "second\n");
        assert.notEqual(yield* pushedTopic, "");
      }),
    );

    /** A checkout on `topic` with a remote to push to, and `push` under an approval for `digest`. */
    const repoToPush = Effect.fn(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-hooked-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "-b", "topic"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      const ran = NodePath.join(yield* makeTmpDir("git-hook-ran-"), "ran");
      const push = (digest: string | null) =>
        driver
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(GitVcsDriver.RepositoryHooks, { _tag: "approved-push", digest }),
          );
      const hooksRun = () => (NodeFS.existsSync(ran) ? NodeFS.readFileSync(ran, "utf8") : "");
      return { cwd: NodeFS.realpathSync(cwd), driver, ran, push, hooksRun };
    });

    it.effect("an approved push runs the approved hook files and no other", () =>
      Effect.gen(function* () {
        const repo = yield* repoToPush();
        const hooksDir = NodePath.join(repo.cwd, ".hooks");
        yield* git(repo.cwd, ["config", "core.hooksPath", ".hooks"]);
        NodeFS.mkdirSync(hooksDir);
        // The approved hook leaves another one beside it while the push is under way.
        const late = NodePath.join(hooksDir, "reference-transaction");
        NodeFS.writeFileSync(
          NodePath.join(hooksDir, "pre-push"),
          [
            "#!/bin/sh",
            `echo pre-push >> '${repo.ran}'`,
            `printf '#!/bin/sh\\necho late >> "%s"\\n' '${repo.ran}' > '${late}'`,
            `chmod +x '${late}'`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const approved = yield* repo.driver.pushHooks(repo.cwd);
        assert.deepEqual(approved?.files, [NodePath.join(hooksDir, "pre-push")]);

        assert.deepInclude(yield* repo.push(approved!.digest), { status: "pushed" });
        assert.isTrue(NodeFS.existsSync(late));
        assert.equal(repo.hooksRun(), "pre-push\n");
      }),
    );

    /** `repoToPush` with a `pre-push` hook, and its approved push by a driver over `services`. */
    const hookedRepoToPush = Effect.fn(function* (services: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    }) {
      const repo = yield* repoToPush();
      const hook = NodePath.join(repo.cwd, ".git", "hooks", "pre-push");
      NodeFS.mkdirSync(NodePath.dirname(hook), { recursive: true });
      NodeFS.writeFileSync(hook, `#!/bin/sh\necho pre-push >> '${repo.ran}'\n`, { mode: 0o755 });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(FileSystem.FileSystem, services.fileSystem),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
      );
      const approved = yield* driver.pushHooks(repo.cwd);
      assert.deepEqual(approved?.files, [hook]);
      const push = driver.pushCurrentBranch(repo.cwd, null).pipe(
        Effect.provideService(GitVcsDriver.RepositoryHooks, {
          _tag: "approved-push",
          digest: approved!.digest,
        }),
      );
      return { ...repo, push };
    });

    /** What is left of the per-push hook directories once a push has ended. */
    const pushHookDirectories = Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      return NodeFS.readdirSync(NodePath.join(stateDir, "push-hooks"));
    });

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "an approved push does not start when its hook launchers are not executable",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          // Files the driver writes stay as written, without the permission to execute them.
          const repo = yield* hookedRepoToPush({
            fileSystem: { ...fileSystem, chmod: () => Effect.void },
            spawner,
          });

          const refused = yield* repo.push.pipe(Effect.flip);
          assert.equal(
            refused.detail,
            "Could not start the repository's push hooks from the server's state directory. Nothing was pushed.",
          );
          assert.equal(repo.hooksRun(), "");
          assert.equal(yield* git(repo.cwd, ["ls-remote", "origin", "refs/heads/topic"]), "");
          assert.deepEqual(yield* pushHookDirectories, []);
        }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "an approved push leaves no hook directory behind",
      () =>
        Effect.gen(function* () {
          const repo = yield* hookedRepoToPush({
            fileSystem: yield* FileSystem.FileSystem,
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          });

          yield* repo.push;
          assert.equal(repo.hooksRun(), "pre-push\n");
          assert.deepEqual(yield* pushHookDirectories, []);
        }),
    );

    describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("hook launcher checks", () => {
      it.effect.each([
        { outcome: "is refused permission", exits: null },
        { outcome: "exits 126", exits: 126 },
      ])("an approved push does not start when the launcher check $outcome", ({ exits }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const launchers = NodePath.join(stateDir, "push-hooks") + NodePath.sep;
          const checked: Array<string> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            // Git is started by name or from where it is installed; the check, from the launchers.
            if (
              !ChildProcess.isStandardCommand(command) ||
              !command.command.startsWith(launchers)
            ) {
              return delegate.spawn(command);
            }
            checked.push(command.command);
            if (exits !== null) {
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  ...makeNonRepositoryHandle(),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exits)),
                }),
              );
            }
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "ChildProcess",
                method: "spawn",
                syscall: "spawn",
                pathOrDescriptor: command.command,
              }),
            );
          });
          const repo = yield* hookedRepoToPush({ fileSystem, spawner });

          const refused = yield* repo.push.pipe(Effect.flip);
          assert.include(refused.detail, "Could not start the repository's push hooks");
          assert.equal(repo.hooksRun(), "");
          assert.equal(yield* git(repo.cwd, ["ls-remote", "origin", "refs/heads/topic"]), "");
          assert.lengthOf(checked, 1);
          assert.deepEqual(yield* pushHookDirectories, []);
        }),
      );
    });

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "turns hooks off for a Git that reads no configuration from the environment",
      () =>
        Effect.gen(function* () {
          const repo = yield* repoToPush();
          const hook = NodePath.join(repo.cwd, ".git", "hooks", "pre-push");
          NodeFS.mkdirSync(NodePath.dirname(hook), { recursive: true });
          NodeFS.writeFileSync(hook, `#!/bin/sh\necho pre-push >> '${repo.ran}'\n`, {
            mode: 0o755,
          });
          // Git before 2.31 does not know GIT_CONFIG_COUNT: this one is started without it.
          const env = yield* HostProcess.Environment;
          const realGit = (env.PATH ?? "")
            .split(NodePath.delimiter)
            .map((directory) => NodePath.join(directory, "git"))
            .find((candidate) => NodeFS.existsSync(candidate));
          assert.isDefined(realGit);
          const bin = yield* makeTmpDir("git-without-config-env-");
          NodeFS.writeFileSync(
            NodePath.join(bin, "git"),
            `#!/bin/sh\nunset GIT_CONFIG_COUNT\nexec '${realGit}' "$@"\n`,
            { mode: 0o755 },
          );
          const olderGit = Effect.provideService(HostProcess.Environment, {
            ...env,
            PATH: `${bin}${NodePath.delimiter}${env.PATH}`,
          });

          const pushed = yield* repo.driver
            .pushCurrentBranch(repo.cwd, null)
            .pipe(Effect.provideService(GitVcsDriver.RepositoryHooks, { _tag: "none" }), olderGit);
          assert.deepInclude(pushed, { status: "pushed" });
          assert.equal(repo.hooksRun(), "");

          // And with them on, the hook does run under that Git.
          NodeFS.writeFileSync(NodePath.join(repo.cwd, "more.txt"), "more\n");
          yield* git(repo.cwd, ["add", "more.txt"]);
          yield* git(repo.cwd, ["commit", "-m", "More"]);
          yield* repo.driver.pushCurrentBranch(repo.cwd, null).pipe(olderGit);
          assert.equal(repo.hooksRun(), "pre-push\n");
        }),
    );

    it.effect("finds the hooks from a folder inside the checkout", () =>
      Effect.gen(function* () {
        const repo = yield* repoToPush();
        yield* git(repo.cwd, ["config", "core.hooksPath", ".hooks"]);
        const hook = NodePath.join(repo.cwd, ".hooks", "pre-push");
        NodeFS.mkdirSync(NodePath.dirname(hook));
        NodeFS.writeFileSync(hook, "#!/bin/sh\n", { mode: 0o755 });
        const inside = NodePath.join(repo.cwd, "packages", "app");
        NodeFS.mkdirSync(inside, { recursive: true });
        assert.deepEqual((yield* repo.driver.pushHooks(inside))?.files, [hook]);
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
      "a hook that cannot be inspected stops the push instead of counting as none",
      () =>
        Effect.gen(function* () {
          // Mode bits do not keep an administrator or a Windows user out.
          const repo = yield* repoToPush();
          const hooksDir = NodePath.join(repo.cwd, ".hooks");
          yield* git(repo.cwd, ["config", "core.hooksPath", ".hooks"]);
          NodeFS.mkdirSync(hooksDir);
          NodeFS.writeFileSync(
            NodePath.join(hooksDir, "pre-push"),
            `#!/bin/sh\necho pre-push >> '${repo.ran}'\n`,
            { mode: 0o755 },
          );
          NodeFS.chmodSync(hooksDir, 0o000);
          yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(hooksDir, 0o755)));

          const unread = yield* repo.driver.pushHooks(repo.cwd).pipe(Effect.flip);
          assert.include(unread.detail, "Could not read the hook");
          const refused = yield* repo.push(null).pipe(Effect.flip);
          assert.include(refused.detail, "Could not read the hook");
          assert.equal(yield* git(repo.cwd, ["ls-remote", "origin", "refs/heads/topic"]), "");

          // A hooks path that is not a directory holds no hook, and that is known.
          yield* git(repo.cwd, ["config", "core.hooksPath", "/dev/null"]);
          assert.isNull(yield* repo.driver.pushHooks(repo.cwd));
        }).pipe(Effect.scoped),
    );

    it.effect("a hook set up in Git's configuration is approved and turned off like a file", () =>
      Effect.gen(function* () {
        const repo = yield* repoToPush();
        const command = (word: string) => `echo ${word} >> '${repo.ran}'`;
        yield* git(repo.cwd, ["config", "hook.checks.command", command("checks")]);
        yield* git(repo.cwd, ["config", "--add", "hook.checks.event", "pre-commit"]);
        yield* git(repo.cwd, ["config", "--add", "hook.checks.event", "pre-push"]);
        // Not for a push, switched off, and with its events cleared: none of these would run.
        yield* git(repo.cwd, ["config", "hook.format.command", command("format")]);
        yield* git(repo.cwd, ["config", "hook.format.event", "pre-commit"]);
        yield* git(repo.cwd, ["config", "hook.unused.command", command("unused")]);
        yield* git(repo.cwd, ["config", "hook.unused.event", "pre-push"]);
        yield* git(repo.cwd, ["config", "hook.unused.enabled", "false"]);
        yield* git(repo.cwd, ["config", "hook.cleared.command", command("cleared")]);
        yield* git(repo.cwd, ["config", "--add", "hook.cleared.event", "pre-push"]);
        yield* git(repo.cwd, ["config", "--add", "hook.cleared.event", ""]);
        // Read through an included file kept in the checkout, as a project can ship one.
        const shipped = ["config", "--file", "hooks.gitconfig"];
        yield* git(repo.cwd, [...shipped, "hook.shipped.event", "reference-transaction"]);
        yield* git(repo.cwd, [...shipped, "hook.shipped.command", command("shipped")]);
        yield* git(repo.cwd, ["config", "include.path", "../hooks.gitconfig"]);

        const first = yield* repo.driver.pushHooks(repo.cwd);
        assert.deepEqual(first?.files, []);
        assert.deepEqual(first?.commands, [
          { name: "checks", command: command("checks") },
          { name: "shipped", command: command("shipped") },
        ]);
        const pushedTopic = git(repo.cwd, ["ls-remote", "origin", "refs/heads/topic"]);
        const refused = yield* repo.push(null).pipe(Effect.flip);
        assert.instanceOf(refused.cause, GitVcsDriver.PushHooksUnapprovedError);

        // A changed command is a change to what was approved.
        yield* git(repo.cwd, ["config", "hook.checks.command", command("edited")]);
        const edited = yield* repo.push(first!.digest).pipe(Effect.flip);
        assert.instanceOf(edited.cause, GitVcsDriver.PushHooksUnapprovedError);
        assert.equal(yield* pushedTopic, "");
        assert.equal(repo.hooksRun(), "");

        // With hooks off, no configured hook runs for the push.
        yield* repo.driver
          .pushCurrentBranch(repo.cwd, null)
          .pipe(Effect.provideService(GitVcsDriver.RepositoryHooks, { _tag: "none" }));
        assert.notEqual(yield* pushedTopic, "");
        assert.equal(repo.hooksRun(), "");

        // Approved as they are now: the two named hooks run where Git runs configured hooks.
        NodeFS.writeFileSync(NodePath.join(repo.cwd, "more.txt"), "more\n");
        yield* git(repo.cwd, ["add", "more.txt"]);
        yield* git(repo.cwd, [
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--no-verify",
          "-m",
          "More",
        ]);
        NodeFS.rmSync(repo.ran, { force: true });
        const current = yield* repo.driver.pushHooks(repo.cwd);
        assert.deepInclude(yield* repo.push(current!.digest), { status: "pushed" });
        const version = /^git version (\d+)\.(\d+)/.exec(yield* git(repo.cwd, ["version"]));
        const runsConfiguredHooks = Number(version?.[1]) > 2 || Number(version?.[2]) >= 54;
        // Git passes a configured hook its arguments, so each line is the name and then those.
        const ran = new Set(
          repo
            .hooksRun()
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(" ")[0]),
        );
        assert.deepEqual([...ran].sort(), runsConfiguredHooks ? ["edited", "shipped"] : []);
      }),
    );

    it.effect("a configured hook moved to another point of the push is asked about again", () =>
      Effect.gen(function* () {
        const repo = yield* repoToPush();
        yield* git(repo.cwd, ["config", "hook.checks.command", "true"]);
        yield* git(repo.cwd, ["config", "hook.checks.event", "pre-push"]);
        const approved = yield* repo.driver.pushHooks(repo.cwd);
        assert.equal((yield* repo.driver.pushHooks(repo.cwd))?.digest, approved?.digest);

        yield* git(repo.cwd, ["config", "hook.checks.event", "reference-transaction"]);
        const moved = yield* repo.driver.pushHooks(repo.cwd);
        assert.deepEqual(moved?.commands, approved?.commands);
        assert.notEqual(moved?.digest, approved?.digest);
        const refused = yield* repo.push(approved!.digest).pipe(Effect.flip);
        assert.instanceOf(refused.cause, GitVcsDriver.PushHooksUnapprovedError);
      }),
    );

    it.effect(
      "finds configured hooks when the server's environment names one file for `git config`",
      () =>
        Effect.gen(function* () {
          const repo = yield* repoToPush();
          yield* git(repo.cwd, ["config", "hook.checks.command", "true"]);
          yield* git(repo.cwd, ["config", "hook.checks.event", "pre-push"]);
          const other = NodePath.join(yield* makeTmpDir("git-config-env-"), "config");
          NodeFS.writeFileSync(other, "");
          const env = yield* HostProcess.Environment;
          const found = yield* repo.driver
            .pushHooks(repo.cwd)
            .pipe(Effect.provideService(HostProcess.Environment, { ...env, GIT_CONFIG: other }));
          assert.deepEqual(found?.commands, [{ name: "checks", command: "true" }]);
        }),
    );

    // The files husky 9.1.7 installs: `_/pre-push` is what Git runs, `_/h` is its runner.
    const HUSKY_SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';
    const HUSKY_RUNNER = [
      "#!/usr/bin/env sh",
      '[ "$HUSKY" = "2" ] && set -x',
      'n=$(basename "$0")',
      's=$(dirname "$(dirname "$0")")/$n',
      "",
      '[ ! -f "$s" ] && exit 0',
      "",
      'if [ -f "$HOME/.huskyrc" ]; then',
      "\techo \"husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh\"",
      "fi",
      'i="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"',
      '[ -f "$i" ] && . "$i"',
      "",
      '[ "${HUSKY-}" = "0" ] && exit 0',
      "",
      'export PATH="node_modules/.bin:$PATH"',
      'sh -e "$s" "$@"',
      "c=$?",
      "",
      '[ $c != 0 ] && echo "husky - $n script failed (code $c)"',
      '[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"',
      "exit $c",
      "",
    ].join("\n");

    it.effect("an approval of a husky hook covers the script husky runs for it", () =>
      Effect.gen(function* () {
        const repo = yield* repoToPush();
        const husky = NodePath.join(repo.cwd, ".husky");
        yield* git(repo.cwd, ["config", "core.hooksPath", ".husky/_"]);
        NodeFS.mkdirSync(NodePath.join(husky, "_"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(husky, "_", "pre-push"), HUSKY_SHIM, { mode: 0o755 });
        NodeFS.writeFileSync(NodePath.join(husky, "_", "h"), HUSKY_RUNNER);
        // The project's own script finds a file beside itself, and the runner one beside `$0`.
        NodeFS.writeFileSync(NodePath.join(husky, "label.sh"), "label=first\n");
        const writeScript = (word: string) =>
          NodeFS.writeFileSync(
            NodePath.join(husky, "pre-push"),
            `. "$(dirname "$0")/label.sh"\necho "${word} $label $1" >> '${repo.ran}'\n`,
          );
        writeScript("ran");
        // The runner reads these from whoever runs the suite; here it gets none of them.
        const home = yield* makeTmpDir("git-husky-home-");
        const env = { ...(yield* HostProcess.Environment), HOME: home, XDG_CONFIG_HOME: home };
        const push = (digest: string) =>
          repo
            .push(digest)
            .pipe(Effect.provideService(HostProcess.Environment, { ...env, HUSKY: undefined }));

        const approved = yield* repo.driver.pushHooks(repo.cwd);
        assert.deepEqual(approved?.files, [
          NodePath.join(husky, "_", "pre-push"),
          NodePath.join(husky, "_", "h"),
          NodePath.join(husky, "pre-push"),
        ]);

        // Editing the script, not the file Git runs, is a change to what was approved.
        writeScript("edited");
        const refused = yield* push(approved!.digest).pipe(Effect.flip);
        assert.instanceOf(refused.cause, GitVcsDriver.PushHooksUnapprovedError);
        assert.equal(repo.hooksRun(), "");

        const current = yield* repo.driver.pushHooks(repo.cwd);
        assert.notEqual(current?.digest, approved?.digest);
        assert.deepInclude(yield* push(current!.digest), { status: "pushed" });
        assert.equal(repo.hooksRun(), "edited first origin\n");
      }),
    );
  });
});

it.layer(layerTest)("branch change totals after a failed read", (it) => {
  it.effect("back off a timed-out branch diff until it expires or HEAD moves", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir("git-branch-totals-timeout-");
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "feature.txt", "one\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature"]);

      let diffs = 0;
      let hang = true;
      const diffStarted = yield* Queue.unbounded<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          // Status diffs the working tree against HEAD; the branch totals diff the merge base.
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("diff-index") ||
            command.args.includes("HEAD")
          ) {
            return delegate.spawn(command);
          }
          diffs++;
          if (!hang) return delegate.spawn(command);
          return Queue.offer(diffStarted, undefined).pipe(
            Effect.as(
              ChildProcessSpawner.makeHandle({
                ...makeSuccessfulHandle(""),
                isRunning: Effect.succeed(true),
                exitCode: Effect.never,
              }),
            ),
          );
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      const first = yield* read.pipe(Effect.forkChild);
      yield* Queue.take(diffStarted);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(first)).branchChanges, undefined);
      assert.strictEqual(diffs, 1);
      assert.strictEqual((yield* read).branchChanges, undefined);
      assert.strictEqual(diffs, 1, "the same HEAD and base are not diffed within the backoff");

      hang = false;
      yield* TestClock.adjust("1 minute");
      assert.deepInclude((yield* read).branchChanges, {
        baseRef: "main",
        insertions: 1,
        deletions: 0,
      });
      assert.strictEqual(diffs, 2, "it is retried once the backoff passes");

      hang = true;
      const again = yield* read.pipe(Effect.forkChild);
      yield* Queue.take(diffStarted);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(again);
      yield* read;
      assert.strictEqual(diffs, 3);

      hang = false;
      yield* writeTextFile(cwd, "feature.txt", "one\ntwo\n");
      yield* git(cwd, ["commit", "-am", "more"]);
      const status = yield* read;
      assert.strictEqual(diffs, 4, "a new HEAD diffs again within the backoff");
      assert.deepInclude(status.branchChanges, {
        baseRef: "main",
        insertions: 2,
        deletions: 0,
      });
    }),
  );
});
