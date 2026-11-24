// @effect-diagnostics nodeBuiltinImport:off - the standalone runner uses Vitest's Node API.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  createCLI,
  startVitest,
  type Reporter,
  type TestModule,
  type TestSpecification,
} from "vite-plus/test/node";
import { validateNestedVitestOptions } from "./cached-vitest-options.ts";

async function runCachedTestGroup(argv: string[]) {
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
  const hostInput = process.env.T3_CHECK_CHANGED_HOST_INPUT;
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
      if (hostInput) {
        const preload = import.meta.resolve("./test-host-input.ts");
        for (const spec of specs) {
          if (
            (spec.pool === "forks" || spec.pool === "threads") &&
            spec.project.config.env?.T3_CHECK_CHANGED_HOST_INPUT === undefined
          ) {
            if (!spec.project.config.execArgv.includes(preload))
              spec.project.config.execArgv.unshift("--import", preload);
          } else {
            NodeFS.readFileSync(hostInput);
          }
        }
      }
      scheduled = specs.map(identity);
      const found = new Set(specs.map((spec) => NodePath.resolve(spec.moduleId)));
      const missing = [...requested].filter((file) => !found.has(file));
      if (missing.length) throw new Error("Vitest did not discover: " + missing.join(", "));
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
        scheduled.length > 0 &&
        scheduled.every((key) => finished.has(key));
    },
  };
  if (hostInput) {
    const guard = await import("./test-host-input.ts");
    guard.observeHostProcesses(hostInput, true);
  }
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
    await context.exit();
  }
}

if (import.meta.main) await runCachedTestGroup(process.argv.slice(2));
