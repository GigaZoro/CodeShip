// @effect-diagnostics nodeBuiltinImport:off - the standalone runner uses Vitest's Node API.
import * as NodePath from "node:path";
import { createCLI, createVitest } from "vite-plus/test/node";

async function runCachedTestGroup(argv: string[]) {
  const cli = createCLI();
  const { args, options } = cli.parse([process.execPath, "vitest", "run", ...argv], { run: false });
  if (!cli.matchedCommand) {
    if (argv.length !== 1) throw new Error("--help must be used alone.");
    return; // Vitest has already printed help.
  }
  // Parsing with dispatch disabled leaves these checks to the caller.
  cli.matchedCommand.checkUnknownOptions();
  cli.matchedCommand.checkOptionValue();
  const files: string[] = [...args, ...(options["--"] ?? [])];
  if (!files.length) throw new Error("A cached test group requires at least one test file");
  const requested = new Set(files.map((file) => NodePath.resolve(file)));
  process.env.VITEST = "true";
  process.env.NODE_ENV ??= "test";
  const context = await createVitest({ ...options, run: true, watch: false });
  try {
    await context.standalone();
    // Keep all configured projects for each selected module, including browser projects.
    const selected = (await context.globTestSpecifications()).filter((spec) =>
      requested.has(NodePath.resolve(spec.moduleId)),
    );
    const found = new Set(selected.map((spec) => NodePath.resolve(spec.moduleId)));
    const missing = [...requested].filter((file) => !found.has(file));
    if (missing.length && !context.config.passWithNoTests) {
      throw new Error(`Vitest did not discover: ${missing.join(", ")}`);
    }
    await context.runTestSpecifications(selected);
  } finally {
    await context.close();
  }
}

if (import.meta.main) await runCachedTestGroup(process.argv.slice(2));
