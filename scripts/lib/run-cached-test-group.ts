// @effect-diagnostics nodeBuiltinImport:off - the standalone runner uses Vitest's Node API.
import * as NodePath from "node:path";
import { createCLI, startVitest, type Reporter, type TestSpecification } from "vite-plus/test/node";
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
  const { args, options } = cli.parse([process.execPath, "vitest", "run", ...packageArgs], {
    run: false,
  });
  if (!cli.matchedCommand) throw new Error("The package test command must run tests");
  cli.matchedCommand.checkUnknownOptions();
  cli.matchedCommand.checkOptionValue();
  const filters: string[] = [...args, ...(options["--"] ?? [])];

  // The Vitest CLI treats --exclude as additional to the project's configured excludes.
  if (options.exclude) {
    options.cliExclude = [options.exclude].flat();
    delete options.exclude;
  }
  if (filters.some((filter) => filter.includes(":"))) options.includeTaskLocation ??= true;
  if (typeof options.typecheck?.only === "boolean") options.typecheck.enabled ??= true;

  let scheduled: ReadonlyArray<TestSpecification> = [];
  let completed = false;
  const member = (file: string) => requested.has(NodePath.resolve(file));
  const observer: Reporter = {
    onInit(vitest) {
      for (const project of vitest.projects) {
        // Retain the project's globs, CLI filters and separate typecheck pool. Restrict
        // discovery before Vitest starts global setup or schedules any file in the group.
        const discover = project.globTestFiles.bind(project);
        project.globTestFiles = async (filters) => {
          const { testFiles, typecheckTestFiles } = await discover(filters);
          return {
            testFiles: testFiles.filter(member),
            typecheckTestFiles: typecheckTestFiles.filter(member),
          };
        };
      }
    },
    onTestRunStart(specs) {
      scheduled = specs;
      const found = new Set(specs.map((spec) => NodePath.resolve(spec.moduleId)));
      const missing = [...requested].filter((file) => !found.has(file));
      if (missing.length) throw new Error("Vitest did not discover: " + missing.join(", "));
      const extra = [...found].filter((file) => !requested.has(file));
      if (extra.length)
        throw new Error("Unexpected test files in cache group: " + extra.join(", "));
    },
    onTestRunEnd(modules, errors, reason) {
      const finished = new Set(
        modules.filter((module) => ["passed", "skipped"].includes(module.state())),
      );
      completed =
        reason === "passed" &&
        !errors.length &&
        scheduled.length > 0 &&
        scheduled.every((spec) => spec.testModule !== undefined && finished.has(spec.testModule));
    },
  };
  const context = await startVitest(
    filters,
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
      throw new Error("Vitest did not complete the requested test group: " + files.join(", "));
    }
  } finally {
    await context.exit();
  }
}

if (import.meta.main) await runCachedTestGroup(process.argv.slice(2));
