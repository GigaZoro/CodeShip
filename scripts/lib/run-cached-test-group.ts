// @effect-diagnostics nodeBuiltinImport:off - the standalone runner uses Vitest's Node API.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  createCLI,
  startVitest,
  type Reporter,
  type TestModule,
  type TestSpecification,
} from "vite-plus/test/node";
import { CHECKOUT_HEAD_ENV } from "./cached-tests.ts";
import { validateNestedVitestOptions } from "./cached-vitest-options.ts";

const checkout = NodePath.resolve(import.meta.dirname, "../..");

// Git writes a trace2 file per process into the folder, with a def_repo event naming the worktree
// of each repository it opens. A def_repo it cannot parse counts as a read of this checkout.
function openedCheckout(traces: string, root: string) {
  for (const file of NodeFS.readdirSync(traces)) {
    for (const line of NodeFS.readFileSync(NodePath.join(traces, file), "utf8").split("\n")) {
      if (!line.includes('"def_repo"')) continue;
      let worktree: unknown;
      try {
        worktree = JSON.parse(line).worktree;
      } catch {
        return true;
      }
      if (typeof worktree !== "string" || NodePath.resolve(worktree) === root) return true;
    }
  }
  return false;
}

/**
 * Cached groups key on the files their tests read, not on HEAD, so a test that reads this
 * checkout's Git state keys its group on HEAD through Vite+'s runner client. When Git cannot show
 * that it traces opening this checkout, every group counts as a reader.
 */
function traceCheckoutGit() {
  // Outside `vp run` no cache records the group.
  const client = process.env.VP_RUN_NODE_CLIENT_PATH;
  if (!client) return undefined;
  const runner = NodeModule.createRequire(import.meta.url)(client).load();
  if (runner.getEnv(CHECKOUT_HEAD_ENV, { tracked: false }) === undefined) {
    throw new Error(`Vite+ did not pass ${CHECKOUT_HEAD_ENV} to the cached test group`);
  }
  const keyOnHead = () => runner.getEnv(CHECKOUT_HEAD_ENV);
  const traces = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-trace-"));
  const probe = NodePath.join(traces, "probe");
  const tests = NodePath.join(traces, "tests");
  NodeFS.mkdirSync(probe);
  NodeFS.mkdirSync(tests);
  const root = NodeFS.realpathSync(checkout);
  const traced =
    NodeChildProcess.spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      env: { ...process.env, GIT_TRACE2_EVENT: probe },
      stdio: "ignore",
    }).status === 0 && openedCheckout(probe, root);
  process.env.GIT_TRACE2_EVENT = tests;
  return () => {
    delete process.env.GIT_TRACE2_EVENT;
    if (!traced || openedCheckout(tests, root)) keyOnHead();
    NodeFS.rmSync(traces, { recursive: true, force: true });
  };
}

async function runCachedTestGroup(args: string[]) {
  // check:changed passes the files its package config leaves out, as `vp test run` would.
  const allowExcluded = args[0] === "--allow-excluded";
  const argv = allowExcluded ? args.slice(1) : args;
  const separator = argv.indexOf("--");
  const files = separator < 0 ? argv : argv.slice(0, separator);
  const packageArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const cli = createCLI();
  if (files.includes("--help")) {
    if (argv.length !== 1) throw new Error("--help must be used alone.");
    cli.parse([process.execPath, "vitest", "run", "--help"], { run: false });
    return;
  }
  const invalid = files.find((file) => file.startsWith("-"));
  if (invalid) throw new Error("Unknown option " + invalid);
  if (!files.length) throw new Error("A cached test group requires at least one test file");
  const requested = new Set(files.map((file) => NodePath.resolve(file)));
  validateNestedVitestOptions(packageArgs, cli);
  const { args: filters, options } = cli.parse(
    [process.execPath, "vitest", "run", ...packageArgs],
    {
      run: false,
    },
  );
  if (!cli.matchedCommand) throw new Error("The package test command must run tests");
  cli.matchedCommand.checkUnknownOptions();
  cli.matchedCommand.checkOptionValue();

  // The Vitest CLI treats --exclude as additional to the project's configured excludes.
  if (options.exclude) {
    options.cliExclude = [options.exclude].flat();
    delete options.exclude;
  }
  if (filters.some((filter) => filter.includes(":"))) options.includeTaskLocation ??= true;
  if (typeof options.typecheck?.only === "boolean") options.typecheck.enabled ??= true;
  // Only check:changed passes the commit, which test:cached groups have never keyed on.
  const finishGitTrace = allowExcluded ? traceCheckoutGit() : undefined;

  const identity = (spec: TestSpecification) =>
    JSON.stringify([spec.project.name, spec.moduleId, spec.pool]);
  let scheduled: string[] = [];
  const active = new Map<string, string>();
  const finished = new Set<string>();
  let ambiguousModule: string | undefined;
  let completed = false;
  const member = (file: string) => requested.has(NodePath.resolve(file));
  function observeModule(module: TestModule) {
    const spec = module.toTestSpecification();
    const key = identity(spec);
    const previous = active.get(spec.taskId);
    // Vitest routes worker results by a hash. While two live specs share that hash,
    // even a terminal reporter event cannot identify which worker produced it.
    if (previous !== undefined && previous !== key) ambiguousModule ??= spec.moduleId;
    finished.delete(key);
    active.set(spec.taskId, key);
  }
  const observer: Reporter = {
    onInit(vitest) {
      // Vitest 5's start() uses this manager directly. Its glob resolves every
      // file:line filter before we narrow the specifications sent to the sequencer.
      const discovery: Pick<typeof vitest, "globTestSpecifications"> = vitest["specifications"];
      const discover = discovery.globTestSpecifications.bind(discovery);
      discovery.globTestSpecifications = async (filters) =>
        (await discover(filters)).filter((spec) => member(spec.moduleId));
    },
    onTestRunStart(specs) {
      scheduled = specs.map(identity);
      const found = new Set(specs.map((spec) => NodePath.resolve(spec.moduleId)));
      const missing = [...requested].filter((file) => !found.has(file));
      if (missing.length && !allowExcluded)
        throw new Error("Vitest did not discover: " + missing.join(", "));
      const extra = [...found].filter((file) => !requested.has(file));
      if (extra.length)
        throw new Error("Unexpected test files in cache group: " + extra.join(", "));
    },
    onTestModuleQueued: observeModule,
    onTestModuleCollected: observeModule,
    onTestModuleEnd(module) {
      const spec = module.toTestSpecification();
      const key = identity(spec);
      if (active.get(spec.taskId) !== key) return;
      active.delete(spec.taskId);
      if (["passed", "skipped"].includes(module.state())) finished.add(key);
      else finished.delete(key);
    },
    onTestRunEnd(_modules, errors, reason) {
      completed =
        reason === "passed" &&
        !errors.length &&
        active.size === 0 &&
        ambiguousModule === undefined &&
        (scheduled.length > 0 || allowExcluded) &&
        scheduled.every((key) => finished.has(key));
    },
  };
  const context = await startVitest(
    [...filters],
    { ...options, run: true, watch: false },
    {
      plugins: [
        {
          name: "codeship-cached-test-group",
          configureServer(server) {
            // The root server has resolved configured, default and CLI-selected reporters.
            const reporters = server.config.test?.reporters;
            if (!Array.isArray(reporters))
              throw new Error("Vitest has not initialized its reporters");
            if (!reporters.includes(observer)) reporters.push(observer);
          },
        },
      ],
    },
  );
  try {
    if (!process.exitCode && !completed) {
      if (ambiguousModule !== undefined) {
        throw new Error(
          "Overlapping Vitest tasks shared a result ID while running " + ambiguousModule,
        );
      }
      throw new Error("Vitest did not complete the requested test group: " + files.join(", "));
    }
  } finally {
    try {
      finishGitTrace?.();
    } finally {
      await context.exit();
    }
  }
}

if (import.meta.main) await runCachedTestGroup(process.argv.slice(2));
