// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GitCommandError } from "@t3tools/contracts";
import * as WorkerProcessSpawner from "../process/WorkerProcessSpawner.ts";
import {
  GIT_REMOTE_TIMED_OUT_DETAIL,
  makeGitVcsDriverCore,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
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
} from "./GitVcsDriverCore.testkit.ts";

const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

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
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

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
        assert.equal(command.options.env?.LC_ALL, "C");
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
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

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
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
        if (traceFile === undefined) return yield* Effect.die("expected a trace2 file");
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
    yield* TestClock.adjust("30 seconds");
    const error = yield* Fiber.join(fetch);

    assert.equal(error.detail, GIT_REMOTE_TIMED_OUT_DETAIL);
    assert.include(error.message, "credential helper git-credential-hang get still running after");
    assert.notInclude(error.message, "/home/me");
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    yield* TestClock.adjust("30 seconds");
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
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("lets a worktree checkout that is still working run past five minutes", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const checkoutFinished = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (!command.args.includes("worktree")) return makeSuccessfulHandle("");
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
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
          NodeServices.layer,
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
      Layer.provideMerge(NodeServices.layer),
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
            spawnedArgs.push(command.args);
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
        assert.deepStrictEqual(metadataQueries, [["rev-parse", "--git-common-dir"]]);
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
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args);
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

        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
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
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args);
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
          assert.equal(result.failure.detail, "git branch create failed");
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        assert.isFalse(spawnedArgs.some((args) => args[0] === "symbolic-ref"));
        spawnedArgs.length = 0;
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isRepo);
        if (state === "bare") {
          assert.isTrue(refs.refs.some((ref) => ref.name === "feature/fallback"));
        } else {
          assert.isEmpty(refs.refs);
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
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

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    { action: "worktree add -b", detail: "git branch create failed" },
    { action: "switch", detail: "git checkout failed" },
  ])(
    "reports a missing ref during $action with stable, redacted diagnostics",
    ({ action, detail }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const refName = "private/deleted-base";
        const locales: Array<string | undefined> = [];
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (
            ChildProcess.isStandardCommand(command) &&
            (command.args.includes("worktree") ||
              command.args[0] === "branch" ||
              command.args[0] === "checkout")
          ) {
            locales.push(command.options.env?.LC_ALL);
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
