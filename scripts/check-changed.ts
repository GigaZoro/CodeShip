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
// group, or its process tree on Windows, and reported as TIMEOUT. A rerun on
// exactly the files of the last passing run prints that run's summary. Each pass
// records the tree it checked, and the pre-push hook refuses a push to main without one.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

import { recordPass, workingTree } from "../.github/scripts/check-changed-receipt.cjs";
import { REAL_HISTORY_ENV } from "../.github/scripts/git-history.cjs";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { checkNodeRuntime } from "../.github/scripts/check-node-runtime.cjs";
import { vitePlusCommand } from "./check-changed-command.ts";
import {
  isRepositoryCommandManifest,
  isRepositoryCommandSource,
} from "./lib/repository-command-source.ts";

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

// Windows cannot start a process whose command line passes 32,767 characters, and vp passes
// its arguments on to the tool it starts, so a long list of paths runs in several steps.
const ARGUMENT_CHARACTERS = 24_000;

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

const SQLITE_BUSY = 5;
const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY;

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
const decodeRootPackageJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ "knip:check": Schema.String }) })),
);

const collectBytes = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

// Fails on a nonzero exit: an empty file list from a broken index would
// otherwise pass as "no changes". quotePath=false keeps non-ASCII paths as real
// paths instead of quoted escapes.
export const git = Effect.fn("checkChanged.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], {
          cwd,
          env: REAL_HISTORY_ENV,
          extendEnv: true,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectBytes(handle.stdout), collectBytes(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          `check:changed: git ${args.join(" ")} exited with ${exitCode}: ${stderr.toString().trim()}`,
        );
      }
      return stdout;
    }),
  );
});
export const gitLines = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((stdout) => stdout.toString().split("\n").filter(Boolean)));

export const comparisonBase = Effect.fn("checkChanged.comparisonBase")(function* (
  root: string,
  explicitRef: Option.Option<string>,
) {
  const candidates = Option.isSome(explicitRef)
    ? [{ ref: explicitRef.value, rev: explicitRef.value }]
    : (yield* gitLines(root, ["remote"])).map((name) => ({
        ref: name + "/main",
        rev: "refs/remotes/" + name + "/main",
      }));
  let closest: { ref: string; base: string; ahead: number } | undefined;
  for (const { ref, rev } of candidates) {
    const base = yield* git(root, ["merge-base", "HEAD", rev]).pipe(
      Effect.map((stdout) => stdout.toString().trim()),
      Effect.orElseSucceed(() => undefined),
    );
    if (!base) continue;
    const ahead = Number((yield* git(root, ["rev-list", "--count", base + "..HEAD"])).toString());
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
// Directories `scripts/i18n-catalog.ts` reads messages from.
const TRANSLATED_SOURCE = /^(apps\/(web|mobile|desktop)|packages\/(client-runtime|shared))\/src\//;
const TEST = /\.test\.[cm]?[jt]sx?$/;
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
  const resolvePath = (base: string) => {
    const normalized = NodePath.posix.normalize(base);
    for (const suffix of SOURCE_SUFFIXES) {
      if (input.files.has(normalized + suffix)) return normalized + suffix;
    }
    const typescript = normalized.replace(/\.([cm]?)js$/, ".$1ts");
    return input.files.has(typescript) ? typescript : undefined;
  };
  const byLongestName = input.packages.toSorted((a, b) => b.name.length - a.name.length);
  const resolvePackage = (specifier: string) => {
    const pkg = byLongestName.find(
      ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (pkg === undefined) return undefined;
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
  const testsByDir = new Map<string, Array<string>>();
  for (const file of input.files) {
    if (!CODE.test(file) || file.startsWith(".repos/")) continue;
    if (TEST.test(file)) {
      const dir = NodePath.posix.dirname(file);
      const known = testsByDir.get(dir);
      if (known === undefined) testsByDir.set(dir, [file]);
      else known.push(file);
    }
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
      ...[...text.matchAll(RELATIVE_REFERENCE)].map(([, specifier]) =>
        resolvePath(NodePath.posix.join(NodePath.posix.dirname(file), specifier!)),
      ),
      ...[...text.matchAll(PACKAGE_IMPORT)].map(([, specifier]) => resolvePackage(specifier!)),
    ]);
    for (const target of targets) {
      if (target === undefined || target === file) continue;
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
      else {
        const prefix = `${NodePath.posix.basename(importer).replace(CODE, "")}.`;
        for (const test of testsByDir.get(NodePath.posix.dirname(importer)) ?? []) {
          if (NodePath.posix.basename(test).startsWith(prefix)) tests.add(test);
        }
      }
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
        !file.startsWith(".repos/") &&
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

// Output is piped, so keep the colors a terminal would get.
const spawnVp = (
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
      const handle = yield* spawner.spawn(
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

  const lines = (...args: Array<string>) => gitLines(root, args);

  const { ref, base } = yield* comparisonBase(root, input.ref);

  // .vite-hooks/pre-push lets a push to main through only for a tree with a pass recorded here.
  // Read before the files are listed, and again before a pass is recorded or cached, so a pass
  // never covers a tree that differs from the one the checks selected their files from.
  const checkedTree = Effect.try({
    try: () => workingTree(root),
    catch: (cause) => `check:changed cannot read the working tree: ${String(cause)}`,
  });
  const tree = yield* checkedTree;
  const treeUnchanged = Effect.gen(function* () {
    if ((yield* checkedTree) === tree) return true;
    yield* Console.log(
      "  FAIL  files changed while the checks ran, so their results can mix old and new code. Run again.",
    );
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

  // --no-renames lists a rename as its old and new path, as CI does.
  const changedFiles = lines("diff", "--name-only", "--no-renames", base, "--");
  const untrackedFiles = lines("ls-files", "--others", "--exclude-standard");
  const files = [...new Set([...(yield* changedFiles), ...(yield* untrackedFiles)])].sort();

  if (files.length === 0) {
    yield* Console.log(`check:changed: no changes since ${base.slice(0, 12)} (${ref}).`);
    return yield* recordPassForPush;
  }
  yield* Console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)} (${ref})`);

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

  // `source` hashes the change's own files. `inputs` adds the ignored generated sources,
  // declarations, env files, and install state that affect results but that no large
  // ignored folder holds. The checks write some of those (typecheck writes
  // apps/marketing/.astro), so they key the cache but never fail a run.
  const ci = Option.getOrElse(yield* Config.option(Config.String("CI")), () => "");
  const fingerprints = Effect.gen(function* () {
    const hash = NodeCrypto.createHash("sha256");
    const add = (paths: ReadonlyArray<string>) =>
      Effect.forEach(
        paths,
        (file) =>
          Effect.gen(function* () {
            hash.update(`\0${file}\0`);
            // Untracked nested repositories are listed as directories.
            const info = yield* Effect.option(fs.stat(inRoot(file)));
            if (Option.isSome(info) && info.value.type === "File") {
              hash.update(yield* fs.readFile(inRoot(file)));
            }
          }),
        { discard: true },
      );
    // CI changes test behavior (vite.config.ts rejects .only under CI). The tree holds what the
    // diff and the bytes below leave out, such as an untracked file's mode.
    hash.update(`${process.version}\0${base}\0${yield* checkedTree}\0${ci}\0`);
    hash.update(
      yield* git(root, [
        "diff",
        "--binary",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        base,
        "--",
      ]),
    );
    // Raw bytes of changed files too: .gitattributes normalizes line endings in
    // the diff, but the formatter reads the file as it is on disk.
    yield* add([...(yield* changedFiles), ...(yield* untrackedFiles)]);
    const source = hash.copy().digest("hex");
    yield* add([
      ...(yield* lines(
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ":(glob)**/.generated/**",
        ":(glob)**/.astro/**",
        ":(glob)**/*.d.ts",
        ":(glob)**/.env*",
        ":(exclude,glob)**/node_modules/**",
      )),
      "node_modules/.modules.yaml",
      "node_modules/.pnpm/lock.yaml",
    ]);
    return { source, inputs: hash.digest("hex") };
  });
  const before = yield* fingerprints;
  const key = before.inputs;
  const cachePath = inRoot("node_modules/.cache/check-changed.json");
  // A missing or unreadable cache is a miss, never a failure.
  const cached = yield* fs
    .readFileString(cachePath)
    .pipe(Effect.flatMap(decodeCacheEntry), Effect.option);
  if (Option.isSome(cached) && cached.value.key === key) {
    yield* Console.log("Nothing changed since the last passing run.\n");
    for (const line of cached.value.summary) yield* Console.log(line);
    return yield* recordPassForPush;
  }

  const present = yield* Effect.filter(files, (file) => fs.exists(inRoot(file)));
  const code = present.filter((file) => CODE.test(file));
  const packages = readWorkspace();
  const { affected, outputs } = decide(files, packages, false);

  // Changed test files, the test files beside a changed source file
  // (foo.ts -> foo.test.ts, foo.browser.test.tsx), and the tests that reach a
  // changed file through test code, such as a provider's replay fixtures
  // through its adapter's testkit, or through one production importer.
  const tests = new Set(code.filter((file) => TEST.test(file)));
  for (const file of code) {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file).replace(CODE, "")}.`;
    for (const entry of yield* fs.readDirectory(inRoot(dir))) {
      if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(path.join(dir, entry));
    }
  }
  const workspaceFiles = new Set([...(yield* lines("ls-files")), ...(yield* untrackedFiles)]);
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
    [...workspaceFiles].filter((file) => CODE.test(file) && !file.startsWith(".repos/")),
    (file) =>
      Effect.gen(function* () {
        // A tracked file deleted in the working tree references nothing.
        if (!(yield* fs.exists(inRoot(file)))) return;
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
  for (const file of dependencyFiles) {
    if (TEST.test(file)) tests.add(file);
    const dir = path.dirname(file);
    const prefix = `${path.basename(file).replace(CODE, "")}.`;
    for (const entry of yield* fs.readDirectory(inRoot(dir))) {
      if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(path.join(dir, entry));
    }
  }
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
  const { vitestTests, nodeTests } = splitTests(tests);
  const allVitestTests = splitTests(
    [...workspaceFiles].filter((file) => CODE.test(file) && TEST.test(file)),
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
    // From the repo root, the root vite.config.ts hands each file to its package's config.
    ...batched(vitestTests, (batch, part) => {
      // Server test files run one at a time (fileParallelism in apps/server/vite.config.ts),
      // so they keep one worker busy however many there are.
      const serverTests = batch.filter((file) => file.startsWith("apps/server/")).length;
      return {
        name: `test (${batch.length} files)${part}`,
        run: (slots: number, collect: (chunk: string) => void) =>
          vp(
            ["test", "run", "--passWithNoTests", "--maxWorkers", String(slots), ...batch],
            root,
            collect,
          ),
        workers: batch.length - serverTests + Math.min(serverTests, 1),
        serial: true,
        timeoutSeconds: testStepTimeoutSeconds(
          batch.length,
          timeoutSeconds,
          explicitTimeout,
          testStepMaxSeconds,
        ),
      };
    }),
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

  const slotDirectory = yield* budgetDirectory(root);
  const results = yield* runSteps(steps, {
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
  yield* Console.log(`\n${summary.join("\n")}`);

  // A test run keeps the version of each file it loaded first, so its result
  // can mix two versions of the code, and a pass would not describe these files.
  const after = yield* fingerprints;
  if (after.source !== before.source) {
    yield* Console.log(
      "  FAIL  files changed while the checks ran, so their results can mix old and new code. Run again.",
    );
    return false;
  }
  if (results.some((result) => result.outcome !== "pass")) return false;
  // The cache key was read after the install, so it can hold a file the checks never selected.
  if (!(yield* treeUnchanged)) return false;
  if (after.inputs !== key) {
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
});

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

// Every process ends with what it started, also after it exited, as its process group does on POSIX.
const spawnerLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return endingWindowsTrees(spawner, yield* HostProcess.Platform);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

if (import.meta.main) {
  Command.run(checkChangedCommand, { version: "0.0.0" }).pipe(
    Effect.provide(spawnerLayer),
    NodeRuntime.runMain,
  );
}
