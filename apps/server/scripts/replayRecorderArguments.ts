import * as NodeUtil from "node:util";

/**
 * Parses a replay recorder's command line in parseArgs's strict mode, so an option the recorder does not take fails
 * before it starts a provider run instead of recording with defaults. `run record:<name> -- --scenario <name>` passes
 * the `--` on to the script, so a leading one is dropped.
 */
export const parseRecorderArguments = <T extends Omit<NodeUtil.ParseArgsConfig, "args" | "strict">>(
  config: T,
) =>
  NodeUtil.parseArgs({
    ...config,
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
    strict: true as const,
  });
