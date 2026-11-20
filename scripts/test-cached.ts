// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  nonBlankPath,
  nonNegativeInteger,
  parseCommandLine,
  positiveInteger,
} from "./lib/command-line.ts";

import { GIT_OUTPUT_MAX_BYTES } from "../.github/scripts/git-history.cjs";
import { localVitePlusCommand } from "./check-changed-command.ts";
import {
  gitPaths,
  isReferenceRepoPath,
  matchesTestPath,
  missingVitePlusTestEnv,
  relativeTestPath,
  TEST_FILE,
  testPathResolver,
} from "./lib/cached-tests.ts";
import { shardedTestFiles, validateShard } from "./lib/sharded-tests.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
export function parseCachedTestArguments(args: ReadonlyArray<string>) {
  const result = parseCommandLine({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      "group-size": { type: "string", default: "1" },
      concurrency: { type: "string", default: "1" },
      shard: { type: "string" },
      report: { type: "string" },
      "verify-hits": { type: "string", default: "0" },
      uncached: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h" },
    },
  });
  if (result.values.help && result.tokens.length !== 1)
    throw new Error("--help must be used alone.");
  const { values, positionals } = result;
  const groupSize = positiveInteger(values["group-size"], "--group-size");
  const concurrency = positiveInteger(values.concurrency, "--concurrency");
  const verifyHits = nonNegativeInteger(values["verify-hits"], "--verify-hits");
  if (values.shard !== undefined) {
    validateShard(values.shard);
    if (positionals.length !== 1)
      throw new Error("Sharding requires exactly one test project directory");
  }
  if (values.report !== undefined) nonBlankPath(values.report, "--report");
  for (const file of values.uncached) nonBlankPath(file, "--uncached");
  for (const path of positionals) nonBlankPath(path, "Test file or directory");
  return { ...result, groupSize, concurrency, verifyHits };
}

if (import.meta.main) {
  const { values, positionals, groupSize, concurrency, verifyHits } = parseCachedTestArguments(
    process.argv.slice(2),
  );
  if (values.help) {
    console.log(
      "vp run test:cached [--group-size 1] [--concurrency 1] [--shard index/count] [--uncached file] [test files or directories]",
    );
    process.exit(0);
  }
  let candidates: string[];
  if (values.shard) {
    // Only discovery runs in this Node process. The task launcher supplies its own runtime defaults.
    const discoveryEnv = {
      ...Object.fromEntries(missingVitePlusTestEnv()),
      TEST: "true",
      VITEST: "true",
      NODE_ENV: process.env.NODE_ENV ?? "test",
    };
    const previous = Object.keys(discoveryEnv).map((name) => [name, process.env[name]] as const);
    Object.assign(process.env, discoveryEnv);
    try {
      candidates = (await shardedTestFiles(NodePath.resolve(positionals[0]!), values.shard)).map(
        (file) => relativeTestPath(root, file),
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } else {
    candidates = gitPaths(
      NodeChildProcess.execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, maxBuffer: GIT_OUTPUT_MAX_BYTES },
      ),
    );
  }
  const canonicalPath = testPathResolver(root);
  const resolveEntered = (path: string) =>
    canonicalPath(relativeTestPath(root, NodePath.resolve(path)));
  const filters = positionals.map(resolveEntered);
  const selected = new Set<string>();
  for (const candidate of candidates) {
    const file =
      TEST_FILE.test(candidate) && !isReferenceRepoPath(candidate)
        ? canonicalPath(candidate)
        : undefined;
    if (file !== undefined && matchesTestPath(file, filters)) {
      selected.add(file);
    } else if (values.shard) {
      throw new Error(`Discovered test cannot be selected: ${candidate}`);
    }
  }
  const files = [...selected];
  if (files.length === 0) {
    console.error("No test files matched");
    process.exit(values.shard ? 0 : 1);
  }
  // A renamed or misspelt file would otherwise run cached without a word.
  const missing = values.uncached.filter((file) => resolveEntered(file) === undefined);
  if (missing.length) throw new Error(`--uncached names no file on disk: ${missing.join(", ")}`);
  console.log(
    `Cached tests: ${files.length} files, about ${groupSize} per task, concurrency ${concurrency}`,
  );
  const env = {
    ...process.env,
    T3_CACHED_TESTS: JSON.stringify({
      files,
      groupSize,
      uncached: values.uncached.map(resolveEntered).filter((file) => file !== undefined),
    }),
  };
  const started = performance.now();
  const result = NodeChildProcess.spawnSync(
    ...localVitePlusCommand(["run", "--concurrency-limit", String(concurrency), "test-cache"]),
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  const cacheRunMs = performance.now() - started;
  process.exitCode = result.status ?? 1;
  if (values.report || verifyHits > 0) {
    const cacheRoot =
      process.env.VITE_CACHE_PATH || NodePath.join(root, "node_modules/.vite/task-cache");
    const summaryFiles = NodeFS.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => NodePath.join(cacheRoot, entry.name, "last-summary.json"))
      .filter((file) => NodeFS.existsSync(file))
      .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs);
    const summary: {
      tasks: Array<{
        task_name: string;
        result: { CacheHit?: { source: string; saved_duration_ms: number } };
      }>;
    } = JSON.parse(NodeFS.readFileSync(summaryFiles[0]!, "utf8"));
    const rank = (task: string) =>
      NodeCrypto.createHash("sha256")
        .update(
          `${process.env.GITHUB_RUN_ID || "local"}:${process.env.GITHUB_RUN_ATTEMPT || "1"}:${task}`,
        )
        .digest("hex");
    const hits = summary.tasks.filter((task) => task.result.CacheHit);
    const verify = hits
      .toSorted((a, b) => rank(a.task_name).localeCompare(rank(b.task_name)))
      .slice(0, verifyHits);
    const verification: Array<{ task: string; exitCode: number; durationMs: number }> = [];
    if (result.status === 0) {
      for (const task of verify) {
        console.log(`Verifying cached result without cache: ${task.task_name}`);
        const start = performance.now();
        const audit = NodeChildProcess.spawnSync(
          ...localVitePlusCommand(["run", "--no-cache", "--remote-cache", "off", task.task_name]),
          { cwd: root, env, stdio: "inherit" },
        );
        if (audit.error) throw audit.error;
        verification.push({
          task: task.task_name,
          exitCode: audit.status ?? 1,
          durationMs: performance.now() - start,
        });
        if (audit.status !== 0) process.exitCode = audit.status ?? 1;
      }
    }
    const report = {
      shard: values.shard,
      files,
      cacheRunMs,
      exitCode: result.status,
      summary,
      verification,
    };
    if (values.report) {
      NodeFS.mkdirSync(NodePath.dirname(values.report), { recursive: true });
      NodeFS.writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const remote = hits.filter((task) => task.result.CacheHit?.source === "Remote").length;
      const savedMs = hits.reduce(
        (total, task) => total + (task.result.CacheHit?.saved_duration_ms ?? 0),
        0,
      );
      NodeFS.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Server test cache (${values.shard || "unsharded"})\n\n` +
          `${files.length} files selected; ${hits.length} hits (${remote} remote); ${(savedMs / 1000).toFixed(1)}s task runtime avoided; ${(cacheRunMs / 1000).toFixed(1)}s elapsed.\n\n` +
          `${verification.length} cached results re-executed without cache; ${verification.filter((audit) => audit.exitCode !== 0).length} verification failures.\n`,
      );
    }
  }
}
