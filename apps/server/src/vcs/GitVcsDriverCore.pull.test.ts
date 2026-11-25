// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

const claimedFetchFallbacks = ["diverged", "interrupted", "upstream-only"] as const;

describe("pullCurrentBranch", () => {
  // A fast-forward that prints over 1 MB takes thousands of files, so the real pull's output is
  // padded past the cap instead.
  const withPaddedPull = (
    stream: "stdout" | "stderr",
    onPull?: (args: ReadonlyArray<string>) => void,
  ) =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const padding = new Uint8Array(1_000_001).fill(0x20);
      const paddingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          const isPull =
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("pull") &&
            command.args.includes("--ff-only");
          if (isPull) onPull?.(command.args.map(String));
          return isPull
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                [stream]: Stream.concat(handle[stream], Stream.make(padding)),
              })
            : handle;
        }),
      );
      return yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, paddingSpawner),
      );
    });

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

  it.effect("resolves a status waiter when Pull claims its queued fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, remoteHead } = yield* cloneBehindRemote;
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
        let running = 0;
        let targetFetches = 0;
        let waiterSucceeded = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || !command.args.includes("fetch"))
              return handle;
            const commandCwd = String(command.options.cwd);
            if (commandCwd === targetPath) targetFetches++;
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
                if (key === "statusFetch.joining") Deferred.doneUnsafe(targetEntered, Effect.void);
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
          const pull = yield* driver.pullCurrentBranch(cwd);
          const refreshed = yield* Fiber.join(status);
          assert.equal(pull.status, "pulled");
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
          assert.isTrue(waiterSucceeded);
          assert.equal(refreshed.behindCount, 0);
          assert.equal(targetFetches, 0);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
    ).pipe(Effect.provide(layerTest)),
  );

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
              if (!ChildProcess.isStandardCommand(command) || !command.args.includes("fetch"))
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
          assert.deepEqual(events, ["fetch-exit", "pull-spawn"]);
        }).pipe(Effect.ensuring(Deferred.succeed(releaseFetch, undefined)));
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("still fetches other branches on the first pull", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { cwd, updater, remoteHead } = yield* cloneBehindRemote;
      yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.equal(result.status, "pulled");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      assert.equal(yield* git(cwd, ["rev-parse", "refs/remotes/origin/other"]), remoteHead);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "pulls past an unrelated lock with custom fetch mapping=%s",
    (customMapping) =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const { cwd, updater, initialBranch, remoteHead } = yield* cloneBehindRemote;
        yield* git(cwd, ["tag", initialBranch]);
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        const remoteName = customMapping ? "team/upstream" : "origin";
        const refPrefix = customMapping
          ? `refs/remotes/${remoteName}/mapped`
          : "refs/remotes/origin";
        if (customMapping) {
          yield* git(cwd, ["remote", "rename", "origin", remoteName]);
          yield* git(cwd, ["config", `remote.${remoteName}.fetch`, `+refs/heads/*:${refPrefix}/*`]);
          yield* git(cwd, ["update-ref", `${refPrefix}/${initialBranch}`, "HEAD"]);
        }
        const lock = `.git/${refPrefix}/other.lock`;
        yield* writeTextFile(cwd, lock, "");

        const result = yield* driver.pullCurrentBranch(cwd);

        assert.equal(result.status, "pulled");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(yield* git(cwd, ["rev-parse", `${refPrefix}/${initialBranch}`]), remoteHead);
        assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
        assert.equal(yield* fs.readFileString(`${cwd}/${lock}`), "");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports an upstream lock after the fallback without removing it", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const { cwd, initialBranch } = yield* cloneBehindRemote;
      const before = yield* git(cwd, ["rev-parse", "HEAD"]);
      const lock = `.git/refs/remotes/origin/${initialBranch}.lock`;
      yield* writeTextFile(cwd, lock, "");

      const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

      assert.include(error.detail, "could not update a local reference");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), before);
      assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["branch", "HEAD"] as const)(
    "does not retry a failed fetch if another operation moved %s",
    (moved) =>
      Effect.gen(function* () {
        const fixtureDriver = yield* GitVcsDriver.GitVcsDriver;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd, updater } = yield* cloneBehindRemote;
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        yield* writeTextFile(cwd, ".git/refs/remotes/origin/other.lock", "");
        let pulls = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || !command.args.includes("pull")) {
              return handle;
            }
            pulls += 1;
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap(() =>
                  git(
                    cwd,
                    moved === "branch"
                      ? ["checkout", "-b", "moved"]
                      : ["commit", "--allow-empty", "-m", "concurrent commit"],
                  ).pipe(
                    Effect.provideService(GitVcsDriver.GitVcsDriver, fixtureDriver),
                    Effect.orDie,
                  ),
                ),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

        assert.include(error.detail, "could not update a local reference");
        assert.equal(pulls, 1);
      }).pipe(Effect.scoped, Effect.provide(layerServerConfig.pipe(Layer.provideMerge(layerTest)))),
  );

  it.effect.each(["stdout", "stderr"] as const)(
    "reports a fast-forward whose %s passes the cap as pulled",
    (stream) =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* withPaddedPull(stream);
          yield* Effect.gen(function* () {
            const { cwd, remoteHead } = yield* cloneBehindRemote;

            const result = yield* driver.pullCurrentBranch(cwd);

            assert.equal(result.status, "pulled");
            assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
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

  it.effect("still fails a pull that Git rejects, whatever its output size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pulls: ReadonlyArray<string>[] = [];
        const driver = yield* withPaddedPull("stderr", (args) => pulls.push(args));
        yield* Effect.gen(function* () {
          const { cwd } = yield* cloneBehindRemote;
          yield* writeTextFile(cwd, "local.txt", "local\n");
          yield* git(cwd, ["add", "local.txt"]);
          yield* git(cwd, ["commit", "-m", "local commit"]);

          const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

          assert.equal(error.operation, "GitVcsDriver.pullCurrentBranch.pull");
          assert.equal(error.exitCode, 128);
          assert.notInclude(error.detail, "exceeded");
          assert.lengthOf(pulls, 1);
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

  it.effect.each(["pull", "merge"] as const)(
    "lets a slow %s checkout finish instead of killing it at 30 seconds",
    (subcommand) =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd, remoteHead } = yield* cloneBehindRemote;
        yield* git(cwd, ["fetch", "origin"]);
        const checkoutStarted = yield* Deferred.make<void>();
        const releaseCheckout = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || command.args[0] !== subcommand) {
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
        );

        const move =
          subcommand === "pull"
            ? Effect.asVoid(driver.pullCurrentBranch(cwd))
            : Effect.asVoid(driver.refreshCheckedOutBranch({ cwd, targetCommit: remoteHead }));
        const moving = yield* move.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(checkoutStarted);
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.succeed(releaseCheckout, undefined);

        yield* Fiber.join(moving);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      }).pipe(Effect.provide(layerTest)),
  );
});
