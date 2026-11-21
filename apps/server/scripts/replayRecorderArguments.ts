import type * as NodeUtil from "node:util";
import { parseCommandLine } from "../../../scripts/lib/command-line.ts";

/**
 * Parses a replay recorder's command line in parseArgs's strict mode, so an option the recorder does not take fails
 * before it starts a provider run instead of recording with defaults. `run record:<name> -- --scenario <name>` passes
 * the `--` on to the script, so a leading one is dropped.
 */
export const parseRecorderArguments = <
  const T extends Omit<NodeUtil.ParseArgsConfig, "args" | "strict" | "tokens">,
>(
  config: T,
  args: ReadonlyArray<string> = process.argv.slice(2),
) =>
  parseCommandLine({
    ...config,
    args: args[0] === "--" ? args.slice(1) : args,
  });

export function parseClaudeReplayArguments(args?: ReadonlyArray<string>) {
  const { values, positionals } = parseRecorderArguments(
    {
      allowPositionals: true,
      options: {
        "query-mode": { type: "string" },
        scenario: { type: "string" },
        out: { type: "string" },
      },
    },
    args,
  );
  if (positionals.length > 1) {
    throw new Error("Pass at most one positional output path.");
  }
  if (values.out !== undefined && positionals.length > 0) {
    throw new Error("Pass either --out or a positional output path.");
  }
  return { ...values, out: values.out ?? positionals[0] };
}

export function replayScenarioNames(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const names = values.flatMap((value) => value.split(",").map((name) => name.trim()));
  if (names.length === 0 || names.includes("")) {
    throw new Error("Pass --scenario <fixture name>[,<fixture name>...] without empty names.");
  }
  return names;
}

export function validateReplayOutput(out: string | undefined, scenarioCount: number) {
  if (out !== undefined && scenarioCount !== 1) {
    throw new Error("--out requires exactly one replay scenario.");
  }
}
