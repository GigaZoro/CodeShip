// @effect-diagnostics nodeBuiltinImport:off - hashes inputs with node:crypto, sizes the budget with node:os, holds its slots with node:sqlite, and resolves test imports with node:path.
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, the test files beside the changed files,
// those that import them directly or through test-support code and those
// beside the production files that import them, and the cross-file checks
// those miss (agent context budget, React Compiler coverage of the changed
// client files).
// A dependency change also gets the unused-patch install check below. CI still
// runs the full test suites and the jobs listed in the summary; the fork's CI
// does not, so these tests are the last ones a change meets before main.
//
//   vp run check:changed                  compare against the closest merge base with any remote main
//   vp run check:changed <ref>            compare against the merge base with <ref>
//   vp run check:changed --concurrency 1  run the steps one at a time
//   vp run check:changed --suites apps/web --suites apps/server
//                                         run those packages' full suites on the same budget
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
// The steps run side by side within a budget derived from the machine's cores
// and available memory, which every run in this repository's worktrees shares,
// and each prints its output when it finishes. A step's timeout counts from
// when it gets its slot; a step running past it is killed with its process
// group, or its process tree on Windows, and reported as TIMEOUT. Test groups
// run against a private copy of the shared cache. When the step ends (pass,
// fail, timeout, or interrupt), it publishes passes if its inputs still match.
// A killed coordinator leaves the shared cache with its existing results.
// A matching whole-run pass reuses its summary after validating those groups.
// Each pass records the tree it checked, and the pre-push hook refuses a push
// to main without one.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  hostCapabilitiesEnv,
  probeHostCapabilities,
} from "@t3tools/shared/testing/hostCapabilityProbe";
import { endingWindowsTrees } from "@t3tools/shared/windowsProcessTree";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  alternateObjectDirectory,
  recordPass,
  workingTree,
} from "../.github/scripts/check-changed-receipt.cjs";
import { GIT_CALL_TIMEOUT_MS, REAL_HISTORY_ENV } from "../.github/scripts/git-history.cjs";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { checkNodeRuntime } from "../.github/scripts/check-node-runtime.cjs";
import { vitePlusCommand } from "./check-changed-command.ts";
import {
  isRepositoryCommandManifest,
  isRepositoryCommandSource,
} from "./lib/repository-command-source.ts";
import {
  ARGUMENT_CHARACTERS,
  cachedTestTasks,
  changedTestRequestEnv,
  changedTestRuntime,
  gitEnvironment,
  gitPaths,
  installFingerprint,
  isFileAt,
  isReferenceRepoPath,
  nameKey,
  unlessAbsent,
} from "./lib/cached-tests.ts";
import { isSqliteBusy, stageTestCache, testCachePartition } from "./lib/staged-test-cache.ts";

const GiB = 1024 ** 3;
// The test step's limit grows by this much per selected file: server tests run one at a time.
const TEST_FILE_SECONDS = 120;
// Without an explicit timeout, a test step stops growing here, so a run selecting thousands of files ends.
// A landing raises it to what its lease has left (CHECK_CHANGED_TEST_STEP_MAX).
const TEST_STEP_MAX_SECONDS = 3600;

export const testStepTimeoutSeconds = (
  files: number,
  timeoutSeconds: number,
  explicit: boolean,
  maxSeconds = TEST_STEP_MAX_SECONDS,
) =>
  explicit
    ? timeoutSeconds
    : Math.min(Math.max(timeoutSeconds, TEST_FILE_SECONDS * files), maxSeconds);

export const argumentBatches = (
  items: ReadonlyArray<string>,
  limit = ARGUMENT_CHARACTERS,
): Array<Array<string>> => {
  const batches: Array<Array<string>> = [];
  let length = 0;
  for (const item of items) {
    const last = batches.at(-1);
    if (last && length + item.length + 1 <= limit) {
      last.push(item);
      length += item.length + 1;
    } else {
      batches.push([item]);
      length = item.length + 1;
    }
  }
  return batches;
};

// A typecheck or test step can take several cores and gigabytes of memory, so
// allow one step per two cores and per 6 GiB of available memory.
export const defaultConcurrency = (cores: number, availableBytes: number) =>
  Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(availableBytes / (6 * GiB))));

// Another run frees its slots without telling this one, so a run that found none looks again this often.
const SLOT_POLL_INTERVAL = "1 second";

// Every run sharing `directory` draws from this budget. A slot is an open exclusive
// transaction on its file, which the OS releases when the process exits, killed or not.
// Open the files only through SQLite: closing any other handle drops this process's lock.
const sharedBudget = (directory: string, size: number, landing: boolean) => {
  const files = Array.from({ length: size }, (_, index) =>
    NodePath.join(directory, `slot-${index}.sqlite`),
  );
  let holding = 0;
  let announced = false;
  // Completed when this run frees slots, so its next step starts without waiting for a poll.
  let freed = Deferred.makeUnsafe<void>();

  const release = Effect.fn("checkChanged.releaseSlots")(function* (
    held: ReadonlyArray<NodeSqlite.DatabaseSync>,
  ) {
    // Closing rolls back the open transaction, which releases the slot.
    for (const db of held) db.close();
    holding -= held.length;
    const waiting = freed;
    freed = Deferred.makeUnsafe<void>();
    yield* Deferred.succeed(waiting, undefined);
  });

  // A landing run (the one holding main's landing turn, .github/scripts/landing-turn.cjs) holds a marker file's
  // transaction while it waits for a slot; other runs leave free slots to it. The OS drops the marker with
  // its process, so a crashed landing blocks nobody.
  const markerPrefix = "landing-wait-";
  let marker: NodeSqlite.DatabaseSync | undefined;
  const markLanding = () => {
    if (!landing || marker) return;
    marker = new NodeSqlite.DatabaseSync(
      NodePath.join(directory, `${markerPrefix}${process.pid}.sqlite`),
    );
    marker.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  };
  const unmarkLanding = () => {
    marker?.close();
    marker = undefined;
    NodeFS.rmSync(NodePath.join(directory, `${markerPrefix}${process.pid}.sqlite`), {
      force: true,
    });
  };
  const landingWaits = () =>
    NodeFS.readdirSync(directory)
      .filter((name) => name.startsWith(markerPrefix))
      .some((name) => {
        const file = NodePath.join(directory, name);
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } catch (cause) {
          if (isSqliteBusy(cause)) return true;
          throw cause;
        } finally {
          db.close();
        }
        // Nobody held it: a marker its landing left behind.
        NodeFS.rmSync(file, { force: true });
        return false;
      });

  const lockFree = (max: number) =>
    Effect.try({
      try: () => {
        const held: Array<NodeSqlite.DatabaseSync> = [];
        if (!landing && landingWaits()) return held;
        try {
          for (const file of files) {
            if (held.length === max) break;
            const db = new NodeSqlite.DatabaseSync(file);
            try {
              db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
              held.push(db);
            } catch (cause) {
              db.close();
              if (!isSqliteBusy(cause)) throw cause;
            }
          }
        } catch (cause) {
          for (const db of held) db.close();
          throw cause;
        }
        holding += held.length;
        return held;
      },
      catch: (cause) =>
        `check:changed: cannot take a budget slot in ${directory}: ${String(cause)}`,
    });

  /** Waits for a free slot, then holds as many free ones as it can, up to `max`, until the scope closes. */
  const take = Effect.fnUntraced(function* (max: number) {
    for (;;) {
      const signal = freed;
      const held = yield* Effect.uninterruptible(
        lockFree(max).pipe(
          Effect.tap((held) =>
            held.length > 0 ? Effect.addFinalizer(() => release(held)) : Effect.void,
          ),
        ),
      );
      if (held.length > 0) {
        unmarkLanding();
        return held.length;
      }
      yield* Effect.try({ try: markLanding, catch: String });
      if (holding === 0 && !announced) {
        announced = true;
        yield* Console.log(
          "check:changed: other check:changed runs on this machine hold every slot; waiting for one.",
        );
      }
      yield* Effect.timeoutOrElse(Deferred.await(signal), {
        duration: SLOT_POLL_INTERVAL,
        orElse: () => Effect.void,
      });
    }
  });
  return { take };
};

export type Outcome = "pass" | "FAIL" | "TIMEOUT";

export interface Step<R> {
  readonly name: string;
  // Gets the number of budget slots the step holds, which is how many workers it may run.
  // Reports each piece of output through `collect` as it arrives, so a step killed at its timeout still has it.
  readonly run: (
    slots: number,
    collect: (chunk: string) => void,
  ) => Effect.Effect<{ readonly ok: boolean; readonly output: string }, never, R>;
  // The most workers the step can run in parallel. It starts once one slot is
  // free and takes as many free ones as it can use, so other runs never wait on it.
  readonly workers?: number;
  // Vitest runs started together race to rebuild node_modules/.vitest-cache (ENOTEMPTY).
  readonly serial?: boolean;
  // Replaces the run's timeout for a step whose work grows with its input.
  readonly timeoutSeconds?: number;
}

// Interrupting a step at its timeout closes the scopes of the processes it
// spawned, which kills each one's process group, or its tree on Windows
// (endingWindowsTrees).
export const runSteps = Effect.fn("checkChanged.runSteps")(function* <R>(
  steps: ReadonlyArray<Step<R>>,
  options: {
    readonly concurrency: number;
    readonly timeoutSeconds: number;
    // An existing directory holding the machine's budget slots; every run given the same one shares them.
    readonly slotDirectory: string;
    // Set for the run that holds main's landing turn: it gets the next free slots ahead of other runs.
    readonly landing?: boolean;
  },
) {
  const budget = sharedBudget(options.slotDirectory, options.concurrency, options.landing ?? false);
  // Steps claim budget one at a time, in order, so a step later in the list
  // never starts ahead of one still waiting for a slot.
  const admission = yield* Semaphore.make(1);
  const serial = yield* Semaphore.make(1);
  return yield* Effect.forEach(
    steps,
    (step) => {
      const timed = Effect.fnUntraced(function* (slots: number) {
        const timeoutSeconds = step.timeoutSeconds ?? options.timeoutSeconds;
        const started = yield* Clock.currentTimeMillis;
        let collected = "";
        const result = yield* Effect.timeoutOption(
          step.run(slots, (chunk) => {
            collected += chunk;
          }),
          `${timeoutSeconds} seconds`,
        );
        const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
        const outcome: Outcome = Option.match(result, {
          onNone: () => "TIMEOUT",
          onSome: ({ ok }) => (ok ? "pass" : "FAIL"),
        });
        const time =
          outcome === "TIMEOUT" ? `killed after ${timeoutSeconds}s` : `${seconds.toFixed(1)}s`;
        yield* Console.log(`\n> vp ${step.name}  ${outcome}  ${time}`);
        const output = Option.isSome(result) ? result.value.output.trimEnd() : collected.trimEnd();
        if (output) yield* Console.log(output);
        return { name: step.name, outcome, time };
      });
      const limited = Effect.scoped(
        admission
          .withPermit(budget.take(Math.min(step.workers ?? 1, options.concurrency)))
          .pipe(Effect.flatMap(timed)),
      );
      return step.serial ? serial.withPermit(limited) : limited;
    },
    { concurrency: "unbounded" },
  );
});

const CacheEntry = Schema.fromJsonString(
  Schema.Struct({ key: Schema.String, summary: Schema.Array(Schema.String) }),
);
const decodeCacheEntry = Schema.decodeEffect(CacheEntry);
const encodeCacheEntry = Schema.encodeEffect(CacheEntry);
const TestRequest = Schema.Struct({
  files: Schema.Array(Schema.String),
  groupSize: Schema.Number,
  uncached: Schema.Array(Schema.String),
  completed: Schema.optional(Schema.Array(Schema.String)),
});
const encodeTestRequest = Schema.encodeEffect(Schema.fromJsonString(TestRequest));
const decodeTestSummary = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          task_name: Schema.String,
          result: Schema.Struct({
            Spawned: Schema.optional(
              Schema.Struct({
                outcome: Schema.Struct({
                  Failed: Schema.optional(Schema.Struct({ exit_code: Schema.Number })),
                }),
              }),
            ),
          }),
        }),
      ),
    }),
  ),
);
const decodeRootPackageJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ "knip:check": Schema.String }) })),
);

const collectBytes = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

// The landing's limit for one git call (git-history.cjs): past it the call fails the run.
export const GIT_TIMEOUT = `${GIT_CALL_TIMEOUT_MS / 60_000} minutes` as const;

// Reports git's exit code; a call past GIT_TIMEOUT fails. Without forceKillAfter the spawner sends
// only SIGTERM and then waits for the exit, so a git that ignores it would hold the run forever.
// quotePath=false keeps non-ASCII paths as real paths instead of quoted escapes.
const gitRun = Effect.fn("checkChanged.gitRun")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], {
          cwd,
          env: { ...REAL_HISTORY_ENV, ...env },
          extendEnv: true,
          forceKillAfter: "5 seconds",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectBytes(handle.stdout), collectBytes(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    }),
  );
  return yield* Effect.timeoutOrElse(run, {
    duration: GIT_TIMEOUT,
    orElse: () =>
      Effect.fail(`check:changed: git ${args.join(" ")} did not finish within ${GIT_TIMEOUT}`),
  });
});

// Fails on an exit `allowed` does not name, with git's message: an empty file list from a broken
// index would otherwise pass as "no changes".
const gitAllowing = Effect.fn("checkChanged.gitAllowing")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  allowed: ReadonlyArray<number>,
  env: Record<string, string> = {},
) {
  const { stdout, stderr, exitCode } = yield* gitRun(cwd, args, env);
  if (!allowed.includes(exitCode)) {
    return yield* Effect.fail(
      `check:changed: git ${args.join(" ")} exited with ${exitCode}: ${stderr.toString().trim()}`,
    );
  }
  return { stdout, exitCode };
});

export const git = Effect.fn("checkChanged.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  return (yield* gitAllowing(cwd, args, [0], env)).stdout;
});
export const gitLines = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((stdout) => stdout.toString().split("\n").filter(Boolean)));

const gitCommit = (root: string, ref: string) =>
  git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).pipe(
    Effect.map((stdout) => stdout.toString().trim()),
  );

export const comparisonBase = Effect.fn("checkChanged.comparisonBase")(function* (
  root: string,
  explicitRef: Option.Option<string>,
) {
  const head = yield* gitCommit(root, "HEAD");
  const candidates = Option.isSome(explicitRef)
    ? [{ ref: explicitRef.value, rev: yield* gitCommit(root, explicitRef.value) }]
    : (yield* gitLines(root, ["remote"])).map((name) => ({
        ref: name + "/main",
        rev: "refs/remotes/" + name + "/main",
      }));
  let closest: { ref: string; base: string; ahead: number } | undefined;
  for (const { ref, rev } of candidates) {
    // A ref that does not exist (rev-parse exits 1) or shares no history with HEAD (merge-base exits
    // 1) rules the candidate out. Any other failure fails the run with git's message: merge-base
    // exits 128 for a missing ref too, but also for a ref to a commit this clone lacks, which
    // `git fetch` repairs and skipping would hide.
    const named = yield* gitAllowing(
      root,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", rev],
      [0, 1],
    );
    if (named.exitCode !== 0) continue;
    const found = yield* gitAllowing(root, ["merge-base", head, rev], [0, 1]);
    if (found.exitCode !== 0) continue;
    const base = found.stdout.toString().trim();
    const ahead = Number(
      (yield* git(root, ["rev-list", "--count", base + ".." + head])).toString(),
    );
    if (!closest || ahead < closest.ahead) closest = { ref, base, ahead };
  }
  if (!closest) {
    const tried = candidates.map(({ ref }) => ref).join(", ") || "a remote main";
    return yield* Effect.fail(
      "check:changed: no merge base with " + tried + ". Run git fetch or pass a ref.",
    );
  }
  return closest;
});

const CODE = /\.[cm]?[jt]sx?$/;

// Nothing of the kind read is at the path: it was removed since Git listed it, a path it runs
// through is a file, it is a folder where a file was read, or it is a link that leads back to
// itself, which Git cannot read either.
const ABSENT = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"]);
const unlessAbsentAsync = <A>(read: Promise<A>) =>
  read.catch((error: NodeJS.ErrnoException) => {
    if (error.code !== undefined && ABSENT.has(error.code)) return undefined;
    throw error;
  });

// HEAD, commondir and a .git file each hold one line, which this much of the file covers.
const GIT_FILE_BYTES = 64 * 1024;
// Windows defines no O_NONBLOCK, and its folders hold no FIFO.
const OPEN_WITHOUT_WAITING = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);

// The start of the regular file at `path`, or undefined when there is none. A FIFO or a device
// there would hold a read until something writes to it, which may be never, so the open does not
// wait and only a regular file is read.
const readGitFile = async (path: string) => {
  const file = await unlessAbsentAsync(NodeFSP.open(path, OPEN_WITHOUT_WAITING));
  if (file === undefined) return undefined;
  try {
    if (!(await file.stat()).isFile()) return undefined;
    const { buffer, bytesRead } = await file.read({
      buffer: Buffer.alloc(GIT_FILE_BYTES),
      position: 0,
    });
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
};

// The HEAD of a git directory: a ref, or the commit a detached HEAD holds.
const GIT_HEAD = /^(?:ref:\s*refs\/|[0-9a-fA-F]{40})/;

// Git takes a HEAD that links to a path under refs/ without following it, as an older Git wrote
// one, so it holds even for a branch with no commit yet; it takes a link anywhere else for no HEAD.
const isGitHead = async (path: string) => {
  const info = await unlessAbsentAsync(NodeFSP.lstat(path));
  if (info?.isSymbolicLink()) {
    return (await unlessAbsentAsync(NodeFSP.readlink(path)))?.startsWith("refs/") === true;
  }
  const head = await readGitFile(path);
  return head !== undefined && GIT_HEAD.test(head);
};

// What Git reads as a git directory: a HEAD it can read, and objects and refs folders in the
// directory or, for a linked worktree's, in the one its commondir file names.
const isGitDirectory = async (directory: string) => {
  if (!(await isGitHead(NodePath.join(directory, "HEAD")))) return false;
  const common = await readGitFile(NodePath.join(directory, "commondir"));
  const shared =
    common === undefined ? directory : NodePath.resolve(directory, common.replace(/[\r\n]+$/, ""));
  const folders = await Promise.all(
    ["objects", "refs"].map((name) => unlessAbsentAsync(NodeFSP.stat(NodePath.join(shared, name)))),
  );
  return folders.every((info) => info?.isDirectory() === true);
};

// Git stops at a nested repository and lists its folder: one whose .git is a git directory, or a
// file `gitdir: <path>` naming one, as a submodule's or a linked worktree's is. Any other .git, such
// as a marker file a tool leaves, is no repository, and Git lists what is beside it.
const isNestedRepository = async (folder: string) => {
  const dotGit = NodePath.join(folder, ".git");
  const info = await unlessAbsentAsync(NodeFSP.stat(dotGit));
  if (info?.isDirectory()) return isGitDirectory(dotGit);
  if (!info?.isFile()) return false;
  const text = await readGitFile(dotGit);
  if (!text?.startsWith("gitdir: ")) return false;
  return isGitDirectory(
    NodePath.resolve(folder, text.slice("gitdir: ".length).replace(/[\r\n]+$/, "")),
  );
};

const GENERATED_INPUT = /(?:^|\/)\.generated\//;
const ENV_INPUT = /(?:^|\/)\.env[^/]*$/;
// Of the ignored inputs, tests read env files and the generated sources that are not declarations.
export const isTestInput = (file: string) =>
  !file.endsWith(".d.ts") && (GENERATED_INPUT.test(file) || ENV_INPUT.test(file));

// The ignored files checks read: generated sources, Astro's generated types, declarations and env
// files.
export const ignoredInputs = Effect.fn("checkChanged.ignoredInputs")(function* (root: string) {
  // Pathspec exclusions filter output, but do not prune Git for Windows' junction traversal.
  const output = yield* git(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  // With core.ignorecase set, Git passes over .git in any case. Whether a folder holds a nested
  // repository is the file system's answer for .git, which one that folds case gives for .GIT as
  // well, so a name in any case is checked. Exit 1: the setting is not set.
  const ignoreCase = yield* gitAllowing(
    root,
    ["config", "--type=bool", "--get", "core.ignorecase"],
    [0, 1],
  ).pipe(Effect.map(({ stdout }) => stdout.toString().trim() === "true"));
  const isDotGit = (name: string) => (ignoreCase ? name.toLowerCase() : name) === ".git";
  // Node looks for dependencies in the folder lowercase node_modules opens, through a link too: on a
  // file system that folds case one named in any case, on one that keeps it any folder such a link
  // leads to, whatever core.ignorecase says. The walk enters folders only, never a link.
  const isNodeModules = async (parent: string, name: string) => {
    if (name === "node_modules") return true;
    if (name.toLowerCase() !== "node_modules") return false;
    const [named, lowercase] = await Promise.all([
      unlessAbsentAsync(NodeFSP.lstat(NodePath.join(root, parent, name), { bigint: true })),
      unlessAbsentAsync(
        NodeFSP.stat(NodePath.join(root, parent, "node_modules"), { bigint: true }),
      ),
    ]);
    return named !== undefined && named.ino === lowercase?.ino && named.dev === lowercase.dev;
  };
  const inNodeModules = async (file: string) => {
    const parts = file.split("/");
    for (const [index, part] of parts.entries()) {
      if (await isNodeModules(parts.slice(0, index).join("/"), part)) return true;
    }
    return false;
  };
  return yield* Effect.tryPromise(async () => {
    const files = new Set<string>();
    const matches = (file: string) =>
      GENERATED_INPUT.test(file) ||
      ENV_INPUT.test(file) ||
      /(?:^|\/)\.astro\//.test(file) ||
      file.endsWith(".d.ts");
    // Git can list a folder together with folders inside it; each is read once. A path removed since
    // Git listed it is no input, as for `add` in checkChanged.
    const seen = new Set<string>();
    const walk = async (file: string): Promise<void> => {
      if (seen.has(file) || (await inNodeModules(file))) return;
      seen.add(file);
      const absolute = NodePath.join(root, file);
      const info = await unlessAbsentAsync(NodeFSP.lstat(absolute));
      if (info === undefined) return;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const entries =
          (await unlessAbsentAsync(NodeFSP.readdir(absolute, { withFileTypes: true }))) ?? [];
        const hasDotGit = entries.some((entry) => entry.name.toLowerCase() === ".git");
        if (hasDotGit && (await isNestedRepository(absolute))) {
          if (matches(`${file}/`)) files.add(`${file}/`);
          return;
        }
        for (const entry of entries) {
          // Git never lists a .git entry, whatever it holds.
          if (isDotGit(entry.name)) continue;
          const child = `${file}/${entry.name}`;
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child);
          else if (matches(child)) files.add(child);
        }
      } else if (matches(file)) files.add(file);
    };
    // Git for Windows lists what is in the folder a junction leads to, where Git elsewhere lists the
    // link alone, which the walk never enters; so a path under a link is no input either.
    const underLink = async (file: string) => {
      const parts = file.split("/");
      for (let end = 1; end < parts.length; end++) {
        const info = await unlessAbsentAsync(
          NodeFSP.lstat(NodePath.join(root, ...parts.slice(0, end))),
        );
        if (info?.isSymbolicLink()) return true;
      }
      return false;
    };
    for (const entry of output.toString().split("\0").filter(Boolean)) {
      const file = entry.replace(/\/$/, "");
      if (!(await underLink(file))) await walk(file);
    }
    return [...files].sort();
  });
});
// Directories `scripts/i18n-catalog.ts` reads messages from.
const TRANSLATED_SOURCE = /^(apps\/(web|mobile|desktop)|packages\/(client-runtime|shared))\/src\//;
const TEST = /\.test\.[cm]?[jt]sx?$/;

// Git can spell a file, its directory and the tests beside it in different cases or Unicode forms.
const testsByDirectory = (files: Iterable<string>) =>
  Map.groupBy(
    [...files].filter((file) => TEST.test(file)),
    (file) => nameKey(NodePath.posix.dirname(file)),
  );
const testsBeside = (testsIn: ReadonlyMap<string, ReadonlyArray<string>>, file: string) => {
  const prefix = nameKey(`${NodePath.posix.basename(file).replace(CODE, "")}.`);
  return (testsIn.get(nameKey(NodePath.posix.dirname(file))) ?? []).filter((test) =>
    nameKey(NodePath.posix.basename(test)).startsWith(prefix),
  );
};

/** The changed tests and the tests beside each changed code file, among the checked files. */
export const adjacentTests = (files: Iterable<string>, code: ReadonlyArray<string>) => {
  const own = code.filter((file) => !isReferenceRepoPath(file));
  if (own.length === 0) return new Set<string>();
  const testsIn = testsByDirectory([...files].filter((file) => !isReferenceRepoPath(file)));
  const tests = new Set(own.filter((file) => TEST.test(file)));
  for (const file of own) for (const test of testsBeside(testsIn, file)) tests.add(test);
  return tests;
};

// CI runs the .github/scripts tests with `node --test`; vitest passes a failing node:test file.
const NODE_TEST = /^\.github[/\\]scripts[/\\]/;
const WEB_BROWSER_TEST = /^apps[/\\]web[/\\].*\.browser\.test\.tsx?$/;
export const splitTests = (tests: Iterable<string>) => {
  const all = [...tests];
  return {
    vitestTests: all.filter((file) => !NODE_TEST.test(file)),
    nodeTests: all.filter((file) => NODE_TEST.test(file)),
  };
};
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Harnesses, fakes and fixtures: code that exists to drive tests.
const SUPPORT_DIR =
  /^(?:testkit|testing|test|tests|__tests__|fixtures|testUtils|testFixtures|[\w.-]+-testing)$/;
const SUPPORT_FILE = /(?:^|\.)(?:testkit|testing|fixture)\.[cm]?[jt]sx?$/;
const isTestSupport = (file: string) => {
  const parts = file.split("/");
  return (
    CODE.test(file) &&
    !TEST.test(file) &&
    (SUPPORT_FILE.test(parts.at(-1) ?? "") ||
      parts.slice(0, -1).some((part) => SUPPORT_DIR.test(part)))
  );
};
// Relative paths in any string count, so `new URL("./x.ndjson", import.meta.url)` reaches data files.
// Tests that enumerate inputs at runtime can declare relative path patterns.
const TEST_INPUT = /^\s*\/\/\s*@test-input\s+(\.{1,2}\/\S+)\s*$/gm;
const RELATIVE_REFERENCE = /["'`](\.\.?\/[^"'`\s$]+)["'`]/g;
const PACKAGE_IMPORT = /\b(?:from|import|import\s*\(|vi\.mock\()\s*["']([^"'./][^"']*)["']/g;
const RE_EXPORT =
  /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["'][^"']+["'];?/g;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const SOURCE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts"];

const exportTarget = (exports: unknown, subpath: string) => {
  const entry =
    typeof exports === "object" && exports !== null
      ? Reflect.get(exports, subpath)
      : subpath === "."
        ? exports
        : undefined;
  const target =
    typeof entry === "object" && entry !== null
      ? (Reflect.get(entry, "import") ??
        Reflect.get(entry, "default") ??
        Reflect.get(entry, "types"))
      : entry;
  return typeof target === "string" ? target : undefined;
};

/**
 * Tests that import a changed file directly or through test-support code, and
 * those beside a production file that imports it. The walk stops there: the full
 * import graph pulled 252 of 406 server tests in for one leaf file. A barrel
 * that only re-exports selects nothing; typecheck covers it.
 */
export const testsReaching = (input: {
  readonly changed: ReadonlyArray<string>;
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly dir: string;
    readonly exports: unknown;
  }>;
  readonly read: (file: string) => string;
}) => {
  const byKey = Map.groupBy(input.files, nameKey);
  // A disk that ignores case and Unicode form opens a file an import spells otherwise than Git, so
  // an import reaches every file it can open up to the first that Git spells as the import does.
  const resolvePath = (base: string) => {
    const normalized = NodePath.posix.normalize(base);
    const targets: Array<string> = [];
    for (const candidate of [
      ...SOURCE_SUFFIXES.map((suffix) => normalized + suffix),
      normalized.replace(/\.([cm]?)js$/, ".$1ts"),
    ]) {
      targets.push(...(byKey.get(nameKey(candidate)) ?? []));
      if (input.files.has(candidate)) break;
    }
    return targets;
  };
  const byLongestName = input.packages.toSorted((a, b) => b.name.length - a.name.length);
  const resolvePackage = (specifier: string) => {
    const pkg = byLongestName.find(
      ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (pkg === undefined) return [];
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    const target = exportTarget(pkg.exports, subpath) ?? subpath;
    return resolvePath(NodePath.posix.join(pkg.dir, target));
  };

  const tests = new Set<string>();
  const argumentGuard = "scripts/command-arguments.test.ts";
  if (
    input.files.has(argumentGuard) &&
    input.changed.some(
      (file) => isRepositoryCommandSource(file) || isRepositoryCommandManifest(file),
    )
  ) {
    tests.add(argumentGuard);
  }
  const importers = new Map<string, Array<string>>();
  const sources = [...input.files].filter((file) => CODE.test(file) && !isReferenceRepoPath(file));
  const testsIn = testsByDirectory(sources);
  for (const file of sources) {
    const text = input.read(file);
    if (TEST.test(file)) {
      for (const [, pattern] of text.matchAll(TEST_INPUT)) {
        const glob = NodePath.posix.join(NodePath.posix.dirname(file), pattern!);
        if (input.changed.some((changed) => NodePath.posix.matchesGlob(changed, glob))) {
          tests.add(file);
        }
      }
    }
    const targets = new Set([
      ...[...text.matchAll(RELATIVE_REFERENCE)].flatMap(([, specifier]) =>
        resolvePath(NodePath.posix.join(NodePath.posix.dirname(file), specifier!)),
      ),
      ...[...text.matchAll(PACKAGE_IMPORT)].flatMap(([, specifier]) => resolvePackage(specifier!)),
    ]);
    for (const target of targets) {
      if (target === file) continue;
      const known = importers.get(target);
      if (known === undefined) importers.set(target, [file]);
      else known.push(file);
    }
  }

  const isBarrel = (file: string) =>
    CODE.test(file) &&
    input.read(file).replace(COMMENT, "").replace(RE_EXPORT, "").trim().length === 0;
  const queue = input.changed.filter((file) => !input.files.has(file) || !isBarrel(file));
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const importer of importers.get(queue[index]!) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      if (TEST.test(importer)) tests.add(importer);
      else if (isTestSupport(importer)) queue.push(importer);
      else for (const test of testsBeside(testsIn, importer)) tests.add(test);
    }
  }
  return [...tests].sort();
};

const packageName = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const nameOfKey = (key: string) => key.slice(0, key.indexOf("@", 1));

/** What pnpm-lock.yaml says: each resolved `name@version`, and which package names each name depends on. */
const parseLock = (text: string) => {
  const versions = new Set<string>();
  const dependsOn = new Map<string, Set<string>>();
  let section = "";
  let name = "";
  let inDependencies = false;
  for (const line of text.split("\n")) {
    const top = /^(\w+):/.exec(line);
    if (top) section = top[1]!;
    if (section !== "snapshots") continue;
    const entry = /^ {2}'?([^'(\s][^'(]*?)(?:\(.*?)?'?:$/.exec(line);
    if (entry) {
      versions.add(entry[1]!);
      name = nameOfKey(entry[1]!);
      inDependencies = false;
      continue;
    }
    if (/^ {4}\w+:/.test(line)) inDependencies = /^ {4}(?:optionalD|d)ependencies:/.test(line);
    else if (inDependencies) {
      const dependency = /^ {6}'?([^':]+)'?:/.exec(line)?.[1];
      if (dependency === undefined) continue;
      const known = dependsOn.get(dependency);
      if (known === undefined) dependsOn.set(dependency, new Set([name]));
      else known.add(name);
    }
  }
  return { versions, dependents: dependsOn };
};

/** `patchedDependencies` of pnpm-workspace.yaml: patch file -> the package name it patches. */
const patchedPackages = (text: string) => {
  const patches = new Map<string, string>();
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inSection = line.startsWith("patchedDependencies:");
    const entry = inSection ? /^ {2}"?([^":]+?)"?:\s*"?(\S+?)"?\s*$/.exec(line) : null;
    if (entry) patches.set(entry[2]!, nameOfKey(entry[1]!));
  }
  return patches;
};

/**
 * Workspace files that import a changed dependency, or a package that depends on one: a patch, a
 * `patchedDependencies` entry or a version in pnpm-lock.yaml changes what they run, though no code
 * file changed. The caller selects their tests as it does for a changed source file.
 */
export const dependencyChangeFiles = (input: {
  readonly changed: ReadonlyArray<string>;
  readonly before: (file: string) => string;
  readonly after: (file: string) => string;
  readonly files: ReadonlySet<string>;
  readonly read: (file: string) => string;
}) => {
  const changed = new Set(input.changed);
  const lockChanged = changed.has("pnpm-lock.yaml");
  const patchChanged = input.changed.some((file) => file.startsWith("patches/"));
  if (!lockChanged && !patchChanged && !changed.has("pnpm-workspace.yaml")) return [];

  const names = new Set<string>();
  const oldPatches = patchedPackages(input.before("pnpm-workspace.yaml"));
  const newPatches = patchedPackages(input.after("pnpm-workspace.yaml"));
  for (const patches of [oldPatches, newPatches]) {
    for (const [file, name] of patches) {
      if (changed.has(file) || oldPatches.get(file) !== newPatches.get(file)) names.add(name);
    }
  }
  const lock = parseLock(input.after("pnpm-lock.yaml"));
  if (lockChanged) {
    const old = parseLock(input.before("pnpm-lock.yaml")).versions;
    for (const key of [...old, ...lock.versions]) {
      if (old.has(key) !== lock.versions.has(key)) names.add(nameOfKey(key));
    }
  }
  const queue = [...names];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of lock.dependents.get(queue[index]!) ?? []) {
      if (!names.has(dependent)) {
        names.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return [...input.files]
    .filter(
      (file) =>
        CODE.test(file) &&
        !isReferenceRepoPath(file) &&
        [...input.read(file).matchAll(PACKAGE_IMPORT)].some(([, specifier]) =>
          names.has(packageName(specifier!)),
        ),
    )
    .sort();
};

// A flag wins over its environment variable; either must be a positive integer.
const override = Effect.fn("checkChanged.override")(function* (
  flagName: string,
  flag: Option.Option<number>,
  envName: string,
) {
  const [name, value] = Option.isSome(flag)
    ? [`--${flagName}`, flag]
    : [envName, yield* Config.option(Config.Int(envName))];
  if (Option.isSome(value) && value.value < 1) {
    return yield* Effect.fail(`check:changed: ${name} must be a positive integer.`);
  }
  return value;
});

// Tests that read a doc; a changed doc has no test beside it to select them.
export const docReaderTests = (files: ReadonlyArray<string>) =>
  files.includes("docs/user/t3-connect-troubleshooting.md")
    ? ["apps/server/src/cloud/ConnectReachability.test.ts"]
    : [];

export const uncachedTests = [
  "apps/server/integration/transferBudgetV2.integration.test.ts",
  // No input covers the programs these run: one a variable names (CC, ComSpec,
  // T3CODE_TEST_HEADLESS_SHELL, T3_TEST_NU_PATH), or the shell tools of the
  // machine or its WSL distribution, without which they skip cases.
  "apps/desktop/scripts/browser-secret-native.test.mjs",
  "apps/desktop/src/wsl/DesktopWslEnvironment.test.ts",
  "apps/server/src/cli/uninstall.test.ts",
  "apps/server/src/htmlRender/HtmlRender.test.ts",
  "packages/shared/src/shell.test.ts",
  "scripts/install.test.ts",
  // On macOS the file tracker runs every bash and sh as Vite+'s bundled Oils osh,
  // which refuses bash's own flags such as --noprofile.
  "apps/server/src/project/ProjectSetupScriptRunner.test.ts",
  "scripts/release-desktop-workflow.test.ts",
  // These skip cases without a cgroup this process may join or delegate.
  "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts",
  "apps/server/src/provider/acp/AcpSessionRuntime.processTree.test.ts",
  // These fixtures start their own Vite+ task cache and file tracker.
  "scripts/check-changed.test.ts",
  "scripts/lib/cached-tests.test.ts",
];

// Output is piped, so keep the colors a terminal would get.
export const spawnVp = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform,
  args: ReadonlyArray<string>,
  cwd: string,
  extraEnv: Record<string, string>,
  collect: (chunk: string) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [command, commandArgs] = vitePlusCommand(args, platform);
      // A step's tools start workers and servers, which end with the step, also after it exited, as
      // its process group does on POSIX.
      const handle = yield* endingWindowsTrees(spawner, platform, "always").spawn(
        ChildProcess.make(command, commandArgs, {
          cwd,
          env: { ...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}), ...extraEnv },
          extendEnv: true,
          forceKillAfter: "5 seconds",
        }),
      );
      let output = "";
      const [, exitCode] = yield* Effect.all(
        [
          Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
            Effect.sync(() => {
              output += chunk;
              collect(chunk);
            }),
          ),
          handle.exitCode,
        ],
        { concurrency: 2 },
      );
      return { ok: exitCode === 0, output };
    }),
  ).pipe(Effect.catch((error) => Effect.succeed({ ok: false, output: error.message })));

// Every worktree of this repository shares its git directory, so their runs share one budget.
const budgetDirectory = Effect.fn("checkChanged.budgetDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDirectory = (yield* git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]))
    .toString()
    .trim();
  const slotDirectory = path.join(gitDirectory, "t3-check-changed");
  yield* fs.makeDirectory(slotDirectory, { recursive: true });
  return slotDirectory;
});

export const runTestGroups = Effect.fn("checkChanged.runTestGroups")(function* (
  cache: string,
  requestFile: string,
  request: typeof TestRequest.Type,
  concurrency: number,
  platform: string,
  run: (concurrency: number) => Effect.Effect<{ readonly ok: boolean; readonly output: string }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remaining = new Set(
    cachedTestTasks(yield* encodeTestRequest(request))["test-cache"]?.dependsOn,
  );
  const completed: Array<string> = [];
  let output = "";
  let ok = true;
  const killedExit = platform === "win32" ? undefined : 137;
  const summaries = Effect.gen(function* () {
    const versions = (yield* fs.exists(cache)) ? yield* fs.readDirectory(cache) : [];
    return yield* Effect.filter(
      versions.map((version) => path.join(cache, version, "last-summary.json")),
      fs.exists,
    );
  });

  let limit = concurrency;
  while (remaining.size > 0) {
    for (const file of yield* summaries) yield* fs.remove(file);
    yield* fs.writeFileString(requestFile, yield* encodeTestRequest({ ...request, completed }));
    const result = yield* run(limit);
    output += result.output;
    if (result.ok) break;
    ok = false;

    // Vite+ 1.4 kills in-flight siblings after a failure. Leave those groups pending so they get a
    // complete run and report their own failures. Unix reports a killed task as exit 137; Windows
    // gives it a status a failed task can have, so there only a serial attempt settles one.
    const [summaryFile] = yield* summaries;
    if (!summaryFile) break;
    const summary = yield* decodeTestSummary(yield* fs.readFileString(summaryFile));
    const settled = summary.tasks
      .filter((task) => {
        const failure = task.result.Spawned?.outcome.Failed;
        return (
          limit === 1 ||
          failure === undefined ||
          (killedExit !== undefined && failure.exit_code !== killedExit)
        );
      })
      .map((task) => task.task_name)
      .filter((task) => remaining.delete(task));
    if (settled.length === 0) {
      if (limit === 1 || !summary.tasks.some((task) => remaining.has(task.task_name))) break;
      // A task can itself exit 137. A serial attempt makes that distinguishable from fail-fast.
      limit = 1;
      continue;
    }
    completed.push(...settled);
    if (killedExit === undefined) limit = 1;
  }
  return { ok, output };
});

/** Each install has its own module cache, and one from an earlier install is never read again. */
export const keepModuleCache = Effect.fn("checkChanged.keepModuleCache")(function* (
  current: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(current);
  if (!(yield* fs.exists(parent))) return;
  for (const entry of yield* fs.readDirectory(parent)) {
    if (entry === path.basename(current)) continue;
    yield* fs.remove(path.join(parent, entry), { recursive: true, force: true });
  }
});

// A package's full suite as budgeted steps. Its configs read the worker cap from T3CODE_TEST_MAX_WORKERS
// (scripts/lib/test-workers.ts), so the suite runs on the slots it holds, not one worker per core.
export const suiteSteps = (
  directories: ReadonlyArray<string>,
  concurrency: number,
  run: (
    directory: string,
    slots: number,
    collect: (chunk: string) => void,
  ) => ReturnType<Step<never>["run"]>,
): Array<Step<never>> =>
  directories.map((directory) => ({
    name: `suite ${directory}`,
    run: (slots, collect) => run(directory, slots, collect),
    // apps/server runs its test files one at a time, so more workers would sit idle.
    workers: directory === "apps/server" ? 1 : concurrency,
    serial: true,
  }));

// Without -z, Git quotes a path that holds a quote, backslash, control or non-ASCII character.
const gitNames = (root: string, objects: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(
    git(root, args, { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory(objects) }),
    (stdout) => Effect.try({ try: () => gitPaths(stdout), catch: String }),
  );

// Cached passes key on the files tests read, which leave out modes. Git's modes leave out the
// execute bits of files it trusts the index for, of symlinks it checks out as files, and of the
// files in embedded repositories, so also key on HEAD, working-tree types and modes, and the
// on-disk execute bits and access of every file outside .git and installed node_modules.
export const checkoutState = Effect.fn("checkChanged.checkoutState")(function* (input: {
  readonly root: string;
  readonly objects: string;
  readonly head: string;
  readonly tree: string;
}) {
  const { root, objects, head, tree } = input;
  const inRoot = (file: string) => NodePath.join(root, file);
  const names = (args: ReadonlyArray<string>) => gitNames(root, objects, args);
  const hash = NodeCrypto.createHash("sha256").update(`${head}\0`);
  const fields = yield* names(["diff-tree", "-r", "-z", "--no-renames", head, tree]);
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [from, to] = fields[index]!.slice(1).split(" ");
    const modeChanged = from !== "000000" && to !== "000000" && from !== to;
    if (modeChanged || (from === "000000" && to !== "100644")) {
      hash.update(`${to}\0${fields[index + 1]}\0`);
    }
  }
  // Windows files carry no execute bits.
  if ((yield* HostProcess.Platform) === "win32") return hash.digest("hex");
  const target = Option.liftThrowable((file: string) => NodeFS.statSync(inRoot(file)));
  const runnable = Option.liftThrowable((file: string) =>
    NodeFS.accessSync(inRoot(file), NodeFS.constants.X_OK),
  );
  const executables: Array<string> = [];
  // Git lists an embedded repository, and checks out a gitlink, as one directory.
  const add = (file: string): void => {
    const entry = unlessAbsent(() => NodeFS.lstatSync(inRoot(file)));
    if (entry?.isDirectory()) {
      for (const child of NodeFS.readdirSync(inRoot(file), {
        encoding: "buffer",
        withFileTypes: true,
      })) {
        const [name] = gitPaths(child.name);
        if (!(child.isDirectory() && (name === ".git" || name === "node_modules"))) {
          add(`${file}/${name}`);
        }
      }
      return;
    }
    // A link that leads nowhere or loops is no file anyone may run.
    const info = entry?.isSymbolicLink() ? Option.getOrUndefined(target(file)) : entry;
    // A runner in the file's group, or outside it, may run a file its owner may not, so any
    // execute bit is an input, beside whether this runner may.
    if (info?.isFile() && (info.mode & 0o111) !== 0) {
      const bits = (info.mode & 0o111).toString(8);
      executables.push(`executable on disk\0${bits}\0${Option.isSome(runnable(file))}\0${file}\0`);
    }
  };
  // Where core.ignoreCase is on, Git's listings leave out an untracked file whose name differs from
  // a tracked one only in case.
  const others = yield* names([
    "-c",
    "core.ignoreCase=false",
    "ls-files",
    "-z",
    "--others",
    "--",
    ":(exclude,glob)**/node_modules/**",
  ]);
  const listed = new Set([...(yield* names(["ls-files", "-z"])), ...others].filter(Boolean));
  yield* Effect.try({
    try: () => {
      for (const file of listed) add(file.replace(/\/$/, ""));
    },
    catch: (cause) => `check:changed cannot read the checkout's files: ${String(cause)}`,
  });
  for (const entry of executables.sort()) hash.update(entry);
  return hash.digest("hex");
});

// Enough to find what wrote inside the checkout without burying the summary under a mass edit.
const CHANGED_PATHS_SHOWN = 20;

// The tree's changes, then the change's own files whose bytes on disk changed where the tree did not.
export const changedPaths = (
  tree: ReadonlyArray<{ readonly status: string; readonly path: string }>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) => {
  const named = new Set(tree.map((change) => change.path));
  const bytesOnly = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => !named.has(file) && before.get(file) !== after.get(file))
    .sort();
  return [
    ...tree.map((change) => `${change.status}\t${change.path}`),
    ...bytesOnly.map((file) => `M\t${file} (bytes on disk only, such as line endings)`),
  ];
};

export const changedWhileCheckingMessage = (paths: ReadonlyArray<string>) =>
  [
    "  FAIL  files changed while the checks ran, so their results can mix old and new code. Run again.",
    "        A path nobody edited is one a check or tool wrote inside the checkout: make it write",
    "        under os.tmpdir() or a gitignored folder. Changed since the run started:",
    ...paths.slice(0, CHANGED_PATHS_SHOWN).map((line) => `        ${line}`),
    ...(paths.length > CHANGED_PATHS_SHOWN
      ? [`        and ${paths.length - CHANGED_PATHS_SHOWN} more`]
      : []),
  ].join("\n");

const checkChanged = Effect.fn("checkChanged")(function* (input: {
  readonly ref: Option.Option<string>;
  readonly concurrency: Option.Option<number>;
  readonly timeout: Option.Option<number>;
  readonly suites: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const inRoot = (file: string) => path.join(root, file);
  // Runtime selection can change without a source edit, so check before accepting cached results.
  yield* Console.log(yield* Effect.try(() => checkNodeRuntime()));

  // macOS counts its file cache as used, so available memory there would
  // starve a large Mac. Elsewhere availableMemory() honors a cgroup limit.
  const platform = yield* HostProcess.Platform;
  const concurrency = Option.getOrElse(
    yield* override("concurrency", input.concurrency, "CHECK_CHANGED_CONCURRENCY"),
    () =>
      defaultConcurrency(
        NodeOS.availableParallelism(),
        platform === "darwin" ? NodeOS.totalmem() : process.availableMemory(),
      ),
  );
  const timeoutOverride = yield* override("timeout", input.timeout, "CHECK_CHANGED_TIMEOUT");
  const explicitTimeout = Option.isSome(timeoutOverride);
  const timeoutSeconds = Option.getOrElse(timeoutOverride, () => 900);
  const testStepMaxSeconds = Option.getOrElse(
    yield* override("test-step-max", Option.none(), "CHECK_CHANGED_TEST_STEP_MAX"),
    () => TEST_STEP_MAX_SECONDS,
  );

  if (input.suites.length > 0) {
    for (const directory of input.suites) {
      const manifest = path.join(root, directory, "package.json");
      const hasTest = yield* fs.readFileString(manifest).pipe(
        Effect.map((text) => text.includes('"test":')),
        Effect.orElseSucceed(() => false),
      );
      if (!hasTest) {
        return yield* Effect.fail(
          `check:changed: ${directory} has no package.json with a test script.`,
        );
      }
    }
    const results = yield* runSteps(
      suiteSteps(input.suites, concurrency, (directory, slots, collect) =>
        spawnVp(
          spawner,
          platform,
          ["run", "--filter", `./${directory}`, "test"],
          root,
          { T3CODE_TEST_MAX_WORKERS: String(slots) },
          collect,
        ),
      ),
      {
        concurrency,
        timeoutSeconds: explicitTimeout ? timeoutSeconds : TEST_STEP_MAX_SECONDS,
        slotDirectory: yield* budgetDirectory(root),
        landing: Option.isSome(yield* Config.option(Config.String("T3_LANDING_TURN"))),
      },
    );
    yield* Console.log(
      [
        "\ncheck:changed suites summary",
        ...results.map((r) => `  ${r.outcome}  ${r.name}  ${r.time}`),
      ].join("\n"),
    );
    return results.every((result) => result.outcome === "pass");
  }

  // The checked tree's objects, which in the repository nothing would reference.
  const objects = yield* fs.makeTempDirectoryScoped({ prefix: "t3-check-changed-objects-" });
  const names = (args: ReadonlyArray<string>) => gitNames(root, objects, args);
  const paths = (command: string, ...args: Array<string>) =>
    names([command, "-z", ...args]).pipe(Effect.map((listed) => listed.filter(Boolean)));

  const { ref, base } = yield* comparisonBase(root, input.ref);

  // .vite-hooks/pre-push lets a push to main through only for a tree with a pass recorded here.
  // Read before the files are listed, and again before a pass is recorded or cached, so a pass
  // never covers a tree that differs from the one the checks selected their files from.
  const checkedTree = Effect.try({
    try: () => workingTree(root, objects),
    catch: (cause) => `check:changed cannot read the working tree: ${String(cause)}`,
  });
  const tree = yield* checkedTree;
  const changesBetween = (earlier: string, current: string) =>
    paths("diff-tree", "-r", "--no-renames", "--name-status", earlier, current).pipe(
      Effect.map((fields) =>
        fields.flatMap((status, index) =>
          index % 2 === 0 ? [{ status, path: fields[index + 1] ?? "" }] : [],
        ),
      ),
    );
  const treeUnchanged = Effect.gen(function* () {
    const current = yield* checkedTree;
    if (current === tree) return true;
    const changes = yield* changesBetween(tree, current);
    yield* Console.log(changedWhileCheckingMessage(changedPaths(changes, new Map(), new Map())));
    return false;
  });
  const recordCheckedPass = Effect.gen(function* () {
    yield* Effect.try({
      try: () => recordPass(root, tree, base),
      catch: (cause) =>
        `check:changed passed but cannot record it for the push gate: ${String(cause)}`,
    });
    const head = (yield* git(root, ["rev-parse", "HEAD^{tree}"])).toString().trim();
    yield* Console.log(
      head === tree
        ? "  push gate: recorded this pass for HEAD"
        : "  push gate: recorded this pass for the working tree, not HEAD: commit every change as it is, untracked files included, or main refuses the push",
    );
    return true;
  });
  const recordPassForPush = Effect.gen(function* () {
    if (!(yield* treeUnchanged)) return false;
    return yield* recordCheckedPass;
  });

  // The files the checked tree changes, as a commit of the checkout under Git's own settings would
  // hold them. --no-renames lists a rename as its old and new path, as CI does.
  const changedIn = (current: string, against: string) =>
    paths("diff-tree", "-r", "--name-only", "--no-renames", against, current);
  const files = (yield* changedIn(tree, base)).sort();

  if (files.length === 0) {
    yield* Console.log(`check:changed: no changes since ${base.slice(0, 12)} (${ref}).`);
    return yield* recordPassForPush;
  }
  yield* Console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)} (${ref})`);
  const workspaceFiles = new Set(yield* paths("ls-tree", "-r", "--name-only", tree));
  // Where core.ignoreCase is on for a disk that tells case apart, Git can record a name the disk
  // does not hold, whose checks would then find nothing.
  const requireOnDisk = Effect.fn("checkChanged.requireOnDisk")(function* (
    candidates: Iterable<string>,
  ) {
    const missing = yield* Effect.try({
      try: () =>
        [...candidates].filter(
          (file) =>
            workspaceFiles.has(file) &&
            unlessAbsent(() => NodeFS.lstatSync(inRoot(file))) === undefined,
        ),
      catch: (cause) => `check:changed cannot read the working tree: ${String(cause)}`,
    });
    if (missing.length === 0) return;
    return yield* Effect.fail(
      `check:changed: the checked tree holds ${missing.join(", ")}, which the disk does not ` +
        "hold under that name. Git may ignore case (core.ignoreCase) on a disk that tells it apart.",
    );
  });
  yield* requireOnDisk(files);

  const vp = (
    args: ReadonlyArray<string>,
    cwd = root,
    collect: (chunk: string) => void = () => {},
  ) => spawnVp(spawner, platform, args, cwd, {}, collect);

  // A rebase or pull can change pnpm-lock.yaml under an older install, so check against the
  // dependencies CI installs from it. Up to date, this takes about a second.
  const install = yield* vp(["install", "--frozen-lockfile", "--prefer-offline"]);
  if (!install.ok) {
    return yield* Effect.fail(`check:changed could not install pnpm-lock.yaml:\n${install.output}`);
  }

  const hostCapabilities = yield* Effect.promise(probeHostCapabilities);
  const testGit = gitEnvironment();
  const testRuntime = changedTestRuntime(
    platform,
    yield* HostProcess.Architecture,
    hostCapabilities,
    testGit,
  );
  const ci = Option.getOrElse(yield* Config.option(Config.String("CI")), () => "");
  // Only uncached tasks get the provider variables this opt-in keeps for a live run.
  const keepProviderEnv =
    Option.getOrElse(
      yield* Config.option(Config.String("T3CODE_TEST_KEEP_PROVIDER_ENV")),
      () => "",
    ) === "1";
  // Hashes each file's digest and returns the digests, which name a file whose bytes changed.
  const addFiles = (hash: NodeCrypto.Hash, paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (file) =>
      Effect.gen(function* () {
        // Untracked nested repositories are listed as directories.
        const info = yield* Effect.option(fs.stat(inRoot(file)));
        const digest =
          Option.isSome(info) && info.value.type === "File"
            ? NodeCrypto.createHash("sha256")
                .update(yield* fs.readFile(inRoot(file)))
                .digest("hex")
            : "";
        hash.update(`\0${file}\0${digest}`);
        return [file, digest] as const;
      }),
    ).pipe(Effect.map((digests) => new Map(digests)));
  const sourceFingerprint = Effect.fn("checkChanged.sourceFingerprint")(function* (
    against: string,
  ) {
    const hash = NodeCrypto.createHash("sha256");
    // CI changes test behavior (vite.config.ts rejects .only under CI). The tree holds what the
    // diff and the bytes below leave out, such as an untracked file's mode.
    const current = yield* checkedTree;
    hash.update(`${testRuntime}\0${against}\0${current}\0${ci}\0`);
    hash.update(
      yield* git(root, [
        "diff",
        "--binary",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        against,
        "--",
      ]),
    );
    // The diff normalizes line endings, but the formatter reads the bytes on disk.
    const bytes = yield* addFiles(hash, yield* changedIn(current, against));
    return { hash, tree: current, bytes };
  });
  const installed = () => Effect.try({ try: () => installFingerprint(root), catch: String });
  const testFingerprint = Effect.fn("checkChanged.testFingerprint")(function* (
    head: string,
    install: string,
  ) {
    const { hash } = yield* sourceFingerprint(head);
    yield* addFiles(hash, (yield* ignoredInputs(root)).filter(isTestInput));
    return hash.update(install).digest("hex");
  });
  const fingerprints = Effect.fn("checkChanged.fingerprints")(function* (against: string) {
    const { hash, tree: checked, bytes } = yield* sourceFingerprint(against);
    const source = hash.copy().digest("hex");
    yield* addFiles(hash, yield* ignoredInputs(root));
    return { source, tree: checked, bytes, inputs: hash.update(yield* installed()).digest("hex") };
  });
  const fingerprintStarted = yield* Clock.currentTimeMillis;
  const before = yield* fingerprints(base);
  yield* Console.log(
    `check:changed: fingerprinted inputs in ${(((yield* Clock.currentTimeMillis) - fingerprintStarted) / 1000).toFixed(1)}s`,
  );
  const key = before.inputs;
  const cachePath = inRoot("node_modules/.cache/check-changed.json");
  // A missing or unreadable cache is a miss, never a failure.
  const cached = yield* fs
    .readFileString(cachePath)
    .pipe(Effect.flatMap(decodeCacheEntry), Effect.option);
  const previousPass = Option.filter(cached, (entry) => entry.key === key);

  // `fs.exists` fails where a file stands in for a directory on the path.
  const isFile = (file: string) =>
    Effect.try({
      try: () => isFileAt(inRoot(file)),
      catch: (cause) => `check:changed cannot read ${file}: ${String(cause)}`,
    });
  const present = yield* Effect.filter(files, isFile);
  const code = present.filter((file) => CODE.test(file));
  const packages = readWorkspace();
  const { affected, outputs } = decide(files, packages, false);

  // Changed test files, the test files beside a changed source file
  // (foo.ts -> foo.test.ts, foo.browser.test.tsx), and the tests that reach a
  // changed file through test code, such as a provider's replay fixtures
  // through its adapter's testkit, or through one production importer.
  const tests = adjacentTests(workspaceFiles, code);
  const dependencyInputs = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];
  const baseText = (file: string) =>
    git(root, ["show", `${base}:${file}`]).pipe(
      Effect.map((stdout) => stdout.toString()),
      Effect.orElseSucceed(() => ""),
    );
  const baseTexts = new Map<string, string>();
  const afterTexts = new Map<string, string>();
  if (files.some((file) => dependencyInputs.includes(file) || file.startsWith("patches/"))) {
    for (const file of dependencyInputs) {
      baseTexts.set(file, yield* baseText(file));
      afterTexts.set(
        file,
        yield* fs.readFileString(inRoot(file)).pipe(Effect.orElseSucceed(() => "")),
      );
    }
  }
  const contents = new Map<string, string>();
  yield* Effect.forEach(
    [...workspaceFiles].filter((file) => CODE.test(file) && !isReferenceRepoPath(file)),
    (file) =>
      Effect.gen(function* () {
        // A tracked file deleted in the working tree references nothing.
        if (!(yield* isFile(file))) return;
        contents.set(file, yield* fs.readFileString(inRoot(file)).pipe(Effect.orDie));
      }),
    { concurrency: 64, discard: true },
  );
  for (const test of testsReaching({
    changed: files,
    files: workspaceFiles,
    packages,
    read: (file) => contents.get(file) ?? "",
  })) {
    tests.add(test);
  }
  const dependencyFiles = dependencyChangeFiles({
    changed: files,
    before: (file) => baseTexts.get(file) ?? "",
    after: (file) => afterTexts.get(file) ?? "",
    files: workspaceFiles,
    read: (file) => contents.get(file) ?? "",
  });
  for (const test of adjacentTests(workspaceFiles, dependencyFiles)) tests.add(test);
  for (const test of testsReaching({
    changed: dependencyFiles,
    files: workspaceFiles,
    packages,
    read: (file) => contents.get(file) ?? "",
  })) {
    tests.add(test);
  }
  for (const test of docReaderTests(files)) tests.add(test);
  // It reads files other than the ones beside it, so no changed file selects it.
  if (affected.includes("t3")) tests.add("apps/server/src/provider/AgentContextBudget.test.ts");
  yield* requireOnDisk(tests);
  // A test the change deletes has nothing to run.
  const { vitestTests, nodeTests } = splitTests(yield* Effect.filter([...tests], isFile));
  const allVitestTests = splitTests(
    [...workspaceFiles].filter(
      (file) => CODE.test(file) && TEST.test(file) && !isReferenceRepoPath(file),
    ),
  ).vitestTests;
  if (vitestTests.length > 0 && vitestTests.length === allVitestTests.length) {
    yield* Console.log(
      `check:changed: this change selects every test file (${vitestTests.length}). The test step ` +
        `ends within ${explicitTimeout ? "--timeout" : `${testStepMaxSeconds}s`}; ` +
        "for a full run, use each package's own test script (vp run -r test).",
    );
  }

  // Web browser tests run in the Chromium build CI installs for this Playwright, which no
  // package install fetches. Already installed, this takes about two seconds.
  if (vitestTests.some((file) => WEB_BROWSER_TEST.test(file))) {
    const chromium = yield* vp([
      "exec",
      "node",
      "apps/web/node_modules/playwright/cli.js",
      "install",
      "--only-shell",
      "chromium",
    ]);
    if (!chromium.ok) {
      return yield* Effect.fail(
        `check:changed could not install Chromium for the browser tests:\n${chromium.output}`,
      );
    }
  }

  // React Compiler coverage compiles every client source file, so run only the
  // changed files' cases, in one extra step: a -t filter in the main test step
  // would drop every other test. An app is skipped when the main step already
  // runs its coverage file unfiltered. File filters mirror each coverage test.
  const compilerApps = [
    {
      test: "apps/web/src/reactCompilerCoverage.test.ts",
      root: "apps/web/src/",
      // Test names keep the repo-relative path.
      name: (file: string) => file,
      compiled: (file: string) =>
        /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file) && !file.endsWith(".gen.ts"),
      // Web has only per-file cases.
      always: [],
    },
    {
      test: "apps/mobile/src/reactCompilerCoverage.test.ts",
      root: "apps/mobile/src/",
      name: (file: string) => file.slice("apps/mobile/".length),
      compiled: (file: string) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file),
      // The Metro, cache, and stale-allowlist cases check more than one file, deletions included.
      always: ["^(?!.*compiles )"],
    },
  ].flatMap(({ test, root: appRoot, name, compiled, always }) => {
    const changed = files.filter((file) => file.startsWith(appRoot) && compiled(file));
    if (changed.length === 0 || tests.has(test)) return [];
    const names = changed
      .filter((file) => present.includes(file))
      .map((file) => `compiles ${escapeRegExp(name(file))}$`);
    const pattern = [...names, ...always];
    return pattern.length > 0 ? [{ test, names, pattern }] : [];
  });

  // knip:check cannot be scoped to a package. Any code change can leave a file,
  // export, or dependency unused (removing the last import of a helper does), so
  // it runs whenever code or a manifest changes.
  const runKnip = files.some(
    (file) => CODE.test(file) || path.basename(file) === "package.json" || file === "knip.jsonc",
  );
  // CI runs knip:check as one script of `knip ... && knip ...` passes. The passes
  // do not depend on each other, so they run side by side here.
  const rootPackage = yield* fs
    .readFileString(inRoot("package.json"))
    .pipe(Effect.flatMap(decodeRootPackageJson), Effect.orDie);
  const knipCheck = rootPackage.scripts["knip:check"];
  const knipPasses: Array<Array<string>> = [];
  for (const command of knipCheck.split(" && ")) {
    const [bin, ...args] = command.trim().split(/\s+/);
    if (bin !== "knip" || /["'$\\|;&<>]/.test(command)) {
      return yield* Effect.fail(`check:changed cannot split knip:check: ${command}`);
    }
    knipPasses.push(["exec", "knip", ...args]);
  }

  // A version bump can leave a patch unused, causing pnpm to reject the install
  // with ERR_PNPM_UNUSED_PATCH. Check it here as Release Smoke does in CI.
  const runPatchCheck = files.some(
    (file) =>
      file === "pnpm-workspace.yaml" ||
      file === "pnpm-lock.yaml" ||
      file === ".pnpmfile.cjs" ||
      file.startsWith("patches/") ||
      file.startsWith("apps/mobile/deps/") ||
      path.basename(file) === "package.json",
  );

  // Resolve without the lockfile in a temp copy to preserve the working tree and lockfile.
  // Copy mobile modules too: they are file: dependencies, not workspace packages.
  // Cached registry metadata limits this to patches stranded by local changes, not registry drift.
  const checkPatches = Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-patch-check-" });
      const copy = Effect.fnUntraced(function* (relative: string) {
        const dest = path.join(temp, relative);
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
        yield* fs.copy(inRoot(relative), dest);
      });
      yield* copy("package.json");
      yield* copy("pnpm-workspace.yaml");
      for (const pkg of packages) yield* copy(`${pkg.dir}/package.json`);
      const modulesDir = "apps/mobile/modules";
      if (yield* fs.exists(inRoot(modulesDir))) {
        for (const entry of yield* fs.readDirectory(inRoot(modulesDir))) {
          const manifest = `${modulesDir}/${entry}/package.json`;
          if (yield* fs.exists(inRoot(manifest))) yield* copy(manifest);
        }
      }
      for (const extra of ["apps/mobile/deps", "patches", ".pnpmfile.cjs"]) {
        if (yield* fs.exists(inRoot(extra))) yield* copy(extra);
      }
      const result = yield* vp(["install", "--lockfile-only", "--ignore-scripts"], temp);
      if (result.ok || !result.output.includes("ERR_PNPM_UNUSED_PATCH")) return result;
      return {
        ok: false,
        output:
          `${result.output}\nUnused dependency patches: remove each patch named above from ` +
          "patchedDependencies in pnpm-workspace.yaml and from patches/, " +
          "update it to the version the install resolves, " +
          "or pin the dependency that pulls it in to the patched version.",
      };
    }),
  ).pipe(Effect.catch((error) => Effect.succeed({ ok: false, output: error.message })));

  // CI's Lint job checks that generated GraphQL operations match their sources.
  const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
    files.some((file) => file.startsWith(`${dir}/`)),
  );
  const command = (name: string, args: ReadonlyArray<string>) => ({
    name,
    run: (_slots: number, collect: (chunk: string) => void) => vp(args, root, collect),
  });
  const compilerFiles = compilerApps.reduce((count, app) => count + app.names.length, 0);
  const batched = <S>(
    items: ReadonlyArray<string>,
    step: (batch: Array<string>, part: string) => S,
  ) => {
    const batches = argumentBatches(items);
    return batches.map((batch, index) =>
      step(batch, batches.length > 1 ? ` ${index + 1}/${batches.length}` : ""),
    );
  };

  // Server test files run one at a time (fileParallelism in apps/server/vite.config.ts),
  // so they keep one worker busy however many there are.
  const serverTests = vitestTests.filter((file) => file.startsWith("apps/server/")).length;
  const testWorkers = vitestTests.length - serverTests + Math.min(serverTests, 1);

  const slotDirectory = yield* budgetDirectory(root);
  const testStep: Step<never> = {
    name: `test (${vitestTests.length} files)`,
    run: (slots, collect) =>
      Effect.scoped(
        Effect.gen(function* () {
          const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-check-changed-tests-" });
          const head = yield* gitCommit(root, "HEAD");
          const install = yield* installed();
          const state = yield* checkoutState({ root, objects, head, tree: yield* checkedTree });
          const cache = path.join(temp, "cache");
          const { finish } = yield* stageTestCache(
            yield* testCachePartition(path.join(slotDirectory, "tests"), head),
            cache,
            `${yield* testFingerprint(head, install)}\0${state}\0${testGit}`,
            Effect.gen(function* () {
              if ((yield* gitCommit(root, "HEAD")) !== head) return "";
              const fingerprint = yield* testFingerprint(head, yield* installed());
              const git = yield* Effect.try({ try: () => gitEnvironment(), catch: String });
              const state = yield* checkoutState({ root, objects, head, tree: yield* checkedTree });
              return `${fingerprint}\0${state}\0${git}`;
            }),
          );
          const request = path.join(temp, "tests.json");
          const groups = Math.max(1, Math.floor(slots / 3));
          const workers = Math.floor(slots / groups);
          const env = {
            ...changedTestRequestEnv(request, testRuntime, workers, cache, state, install),
            ...hostCapabilitiesEnv(hostCapabilities),
          };
          yield* keepModuleCache(inRoot(`node_modules/.vitest-cache/check-changed/${install}`));
          const result = yield* runTestGroups(
            cache,
            request,
            {
              files: vitestTests,
              groupSize: 16,
              uncached: keepProviderEnv ? vitestTests : uncachedTests,
            },
            groups,
            platform,
            (limit) =>
              spawnVp(
                spawner,
                platform,
                [
                  "run",
                  "--remote-cache",
                  "off",
                  "--concurrency-limit",
                  String(limit),
                  "test-cache",
                ],
                root,
                env,
                collect,
              ),
          );
          return (yield* finish) ? result : { ...result, ok: false };
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((error) => Effect.succeed({ ok: false, output: String(error) })),
      ),
    workers: testWorkers,
    serial: true,
    timeoutSeconds: testStepTimeoutSeconds(
      vitestTests.length,
      timeoutSeconds,
      explicitTimeout,
      testStepMaxSeconds,
    ),
  };

  const steps: Array<Step<never>> = [
    command("release notes", ["exec", "node", ".github/scripts/release-notes.cjs", "check", base]),
    ...(runPatchCheck ? [{ name: "unused patches", run: () => checkPatches }] : []),
    // The web and mobile builds stop on a shipped package without a license notice. Notices come
    // from installed packages and files the license config names anywhere, so this always runs.
    command("third-party licenses", ["run", "licenses:check"]),
    ...batched(present, (batch, part) =>
      command(`format${part}`, ["fmt", "--check", "--no-error-on-unmatched-pattern", ...batch]),
    ),
    ...batched(code, (batch, part) => command(`lint${part}`, ["lint", ...batch])),
    ...(code.some((file) => TRANSLATED_SOURCE.test(file))
      ? [command("translations", ["run", "i18n:check"])]
      : []),
    ...(runKnip
      ? knipPasses.map((args, index) => command(`knip ${index + 1}/${knipPasses.length}`, args))
      : []),
    ...graphql.map((dir) =>
      command(`graphql (${dir})`, ["run", "--filter", `./${dir}`, "generate", "--check"]),
    ),
    // Vitest's module runner lets an import cycle read a binding before it is set; Node throws.
    ...(files.some((file) => file.startsWith("apps/server/") || file.startsWith("packages/"))
      ? [command("server loads", ["exec", "node", "apps/server/src/bin.ts", "--version"])]
      : []),
    // `tsc --noEmit` writes nothing another package reads, so each package checks
    // on its own and takes a budget slot as one frees, in this run or another.
    ...affected.map((name) =>
      command(`typecheck ${name}`, ["run", "--cache", "--filter", name, "typecheck"]),
    ),
    ...(vitestTests.length > 0 ? [testStep] : []),
    ...batched(nodeTests, (batch, part) =>
      command(`node --test (${batch.length} files)${part}`, ["exec", "node", "--test", ...batch]),
    ),
    ...batched(
      compilerApps.flatMap((app) => app.pattern),
      (batch, part) => ({
        ...command(`react compiler (${compilerFiles} files)${part}`, [
          "test",
          "run",
          "--maxWorkers",
          "1",
          ...compilerApps.map((app) => app.test),
          "-t",
          batch.join("|"),
        ]),
        serial: true,
      }),
    ),
  ];

  const stepsToRun = Option.isSome(previousPass)
    ? steps.filter((step) => step === testStep)
    : steps;
  const results = yield* runSteps(stepsToRun, {
    concurrency,
    timeoutSeconds,
    slotDirectory,
    // The landing command (.github/scripts/landing-turn.cjs) gives its checks the turn it holds.
    landing: Option.isSome(yield* Config.option(Config.String("T3_LANDING_TURN"))),
  });

  const summary = ["check:changed summary"];
  for (const result of results) {
    summary.push(`  ${result.outcome}  ${result.name}  ${result.time}`);
  }
  if (results.some((result) => result.outcome === "TIMEOUT")) {
    summary.push(
      "  TIMEOUT: ran past its time limit and was killed; this is not a check failure. " +
        "Raise --timeout or lower --concurrency.",
    );
  }
  const ciOnly = Object.entries({
    "full test suites": outputs.test || outputs.test_web || outputs.test_server,
    build: outputs.build,
    rust: outputs.rust,
    "mobile native lint": outputs.mobile_native,
    "release smoke": outputs.release_smoke,
  }).flatMap(([job, runs]) => (runs ? [job] : []));
  if (ciOnly.length > 0) summary.push(`  CI also runs: ${ciOnly.join(", ")}`);
  if (!runPatchCheck) summary.push("  unused patch check skipped: no dependency files changed");
  if (!runKnip) summary.push("  knip skipped: no code or manifest changed");
  // A test run keeps the version of each file it loaded first, so its result
  // can mix two versions of the code, and a pass would not describe these files.
  const after = yield* fingerprints(base);
  if (
    Option.isSome(previousPass) &&
    after.inputs === key &&
    results.every(({ outcome }) => outcome === "pass")
  ) {
    if (!(yield* treeUnchanged)) return false;
    yield* Console.log("Checks passed with the previous run's summary.\n");
    for (const line of previousPass.value.summary) yield* Console.log(line);
    return yield* recordCheckedPass;
  }
  yield* Console.log(`\n${summary.join("\n")}`);
  if (after.source !== before.source) {
    const changes = yield* changesBetween(before.tree, after.tree);
    yield* Console.log(
      changedWhileCheckingMessage(changedPaths(changes, before.bytes, after.bytes)),
    );
    return false;
  }
  if (results.some((result) => result.outcome !== "pass")) return false;
  // The cache key was read after the install, so it can hold a file the checks never selected.
  if (!(yield* treeUnchanged)) return false;
  if (after.inputs !== key) {
    // A reused pass ran only the test step, so no other check saw the new files.
    if (Option.isSome(previousPass)) {
      yield* Console.log(
        "  FAIL  generated files changed while the previous run's pass was checked. Run again.",
      );
      return false;
    }
    yield* Console.log("  pass not cached: generated files changed during the run");
    return yield* recordCheckedPass;
  }
  // Write then rename, so a concurrent run never reads half a file.
  const temp = `${cachePath}.${process.pid}`;
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
    yield* fs.writeFileString(temp, yield* encodeCacheEntry({ key, summary }));
    yield* fs.rename(temp, cachePath);
  }).pipe(Effect.catch((error) => Console.warn(`  pass not cached: ${error.message}`)));
  return yield* recordCheckedPass;
}, Effect.scoped);

export const checkChangedCommand = Command.make(
  "check-changed",
  {
    ref: Argument.String("ref").pipe(
      Argument.withDescription("Compare against the merge base with this ref."),
      Argument.optional,
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription(
        "Budget of parallel steps and test workers, shared by every run in this repository's worktrees; also CHECK_CHANGED_CONCURRENCY. Defaults to one per two cores and per 6 GiB of available memory.",
      ),
      Flag.optional,
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription(
        "Seconds before a step is killed; also CHECK_CHANGED_TIMEOUT. Defaults to 900.",
      ),
      Flag.optional,
    ),
    suites: Flag.String("suites").pipe(
      Flag.withDescription(
        "Run the full test suite of this package directory (repeatable) through the shared budget instead of checking changed files, e.g. --suites apps/web --suites apps/server.",
      ),
      Flag.atLeast(0),
    ),
  },
  (input) =>
    checkChanged(input).pipe(
      Effect.catch((message) => Console.error(message).pipe(Effect.as(false))),
      // exitCode, not a failed exit: runMain calls process.exit() on failure, and
      // piped stdout is asynchronous on macOS, so it would cut off step output.
      Effect.flatMap((ok) =>
        Effect.sync(() => {
          if (!ok) process.exitCode = 1;
        }),
      ),
    ),
).pipe(Command.withDescription("Run CI's fast checks for this branch's changes."));

// A walk of a Windows process tree starts PowerShell, which takes seconds on a loaded machine, so a git
// call's tree is walked only when it is killed or a process it started still holds its output. What git
// leaves once it exited with its output closed, such as its fsmonitor or credential-cache daemon, is
// meant to outlive it, as it does on POSIX. Each step's tree is walked (spawnVp).
export const runSpawner = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform,
) => endingWindowsTrees(spawner, platform, "leftBehind");

const spawnerLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return runSpawner(spawner, yield* HostProcess.Platform);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

if (import.meta.main) {
  Command.run(checkChangedCommand, { version: "0.0.0" }).pipe(
    Effect.provide(spawnerLayer),
    NodeRuntime.runMain,
  );
}
