import type * as NodeUtil from "node:util";
import { parseCommandLine } from "../../../scripts/lib/command-line.ts";

// An empty value most often comes from a shell variable left unset, and guessing from it would start a paid provider
// run or overwrite a tracked fixture.
const isBlank = (value: string) => value.trim() === "";

/**
 * Parses a replay recorder's command line in parseArgs's strict mode, so an option the recorder does not take fails
 * before it starts a provider run instead of recording with defaults. `run record:<name> -- --scenario <name>` passes
 * the `--` on to the script, so a leading one is dropped. An empty option value or positional is refused.
 */
export const parseRecorderArguments = <
  const T extends Omit<NodeUtil.ParseArgsConfig, "args" | "strict" | "tokens">,
>(
  config: T,
  args: ReadonlyArray<string>,
) => {
  const parsed = parseCommandLine({
    ...config,
    args: args[0] === "--" ? args.slice(1) : args,
  });
  for (const token of parsed.tokens!) {
    if (token.kind === "option" && token.value !== undefined && isBlank(token.value)) {
      throw new Error("--" + token.name + " needs a value.");
    }
    if (token.kind === "positional" && isBlank(token.value)) {
      throw new Error("A positional argument needs a value.");
    }
  }
  return parsed;
};

/** Reads a recorder's environment variable; one that is set but empty is refused. */
export function recorderEnvironmentValue(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = env[name];
  if (value !== undefined && isBlank(value)) {
    throw new Error(name + " is set but empty; unset it or give it a value.");
  }
  return value;
}

export function parseClaudeReplayArguments(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  const { values, positionals } = parseRecorderArguments(
    {
      allowPositionals: true,
      options: {
        "query-mode": { type: "string" },
        scenario: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
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
  return {
    queryMode: values["query-mode"] ?? recorderEnvironmentValue("T3_CLAUDE_REPLAY_QUERY_MODE", env),
    scenario:
      values.scenario ?? recorderEnvironmentValue("T3_CLAUDE_REPLAY_SCENARIO", env) ?? "simple",
    out: values.out ?? positionals[0],
    dryRun: values["dry-run"] ?? false,
  };
}

export function selectClaudeReplayPrompts(
  defaults: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const configured = recorderEnvironmentValue("T3_CLAUDE_REPLAY_PROMPTS", env);
  if (configured !== undefined) {
    const prompts = configured.split(/\r?\n---\r?\n/u);
    const blank = prompts.findIndex(isBlank);
    if (blank !== -1) {
      throw new Error(`T3_CLAUDE_REPLAY_PROMPTS contains a blank prompt at position ${blank + 1}.`);
    }
    return prompts;
  }
  const prompt = recorderEnvironmentValue("T3_CLAUDE_REPLAY_PROMPT", env);
  return prompt === undefined ? defaults : [prompt];
}

/** Splits comma-separated scenario selections; a name given twice is recorded once. */
export function replayScenarioNames(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const names = values.flatMap((value) => value.split(",").map((name) => name.trim()));
  if (names.length === 0 || names.includes("")) {
    throw new Error("Pass --scenario <fixture name>[,<fixture name>...] without empty names.");
  }
  return [...new Set(names)];
}

export function validateReplayOutput(out: string | undefined, scenarioCount: number) {
  if (out !== undefined && scenarioCount !== 1) {
    throw new Error("--out requires exactly one replay scenario.");
  }
}
