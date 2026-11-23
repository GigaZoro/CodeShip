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

// Number() also reads "0x10", "1e3" and " 5", so only plain decimal digits count.
export function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number))
    throw new Error(flag + " must be a positive safe integer.");
  return number;
}

export function nonNegativeInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number))
    throw new Error(flag + " must be a non-negative safe integer.");
  return number;
}

export function nonBlankPath(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(label + " must be a non-blank path.");
  return value;
}
