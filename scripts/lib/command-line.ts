// @effect-diagnostics nodeBuiltinImport:off - Repository command-line tools use Node's argument parser.
import * as NodeUtil from "node:util";

export function parseCommandLine<
  const T extends Omit<NodeUtil.ParseArgsConfig, "strict" | "tokens">,
>(config: T) {
  const parsed = NodeUtil.parseArgs({ ...config, strict: true as const, tokens: true as const });
  const seen = new Set<string>();
  for (const token of parsed.tokens!) {
    if (token.kind !== "option" || config.options?.[token.name]?.multiple) continue;
    if (seen.has(token.name)) throw new Error("Pass --" + token.name + " at most once.");
    seen.add(token.name);
  }
  return parsed;
}

export function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(flag + " must be a positive safe integer.");
  return number;
}
