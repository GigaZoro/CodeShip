import type { createCLI } from "vite-plus/test/node";

export function validateNestedVitestOptions(
  argv: readonly string[],
  cli: ReturnType<typeof createCLI>,
) {
  // Vitest's built-in unknown-option check only checks the first segment.
  const known = new Set(cli.globalCommand.options.flatMap((option) => option.names));
  for (const arg of argv) {
    if (arg === "--") break;
    const [flag] = arg.split("=", 1);
    if (!flag?.startsWith("--") || !flag.includes(".")) continue;
    const name = flag.replace(/^--(?:no-)?/, "");
    // The outputFile map takes one caller-selected reporter name as its key.
    if (known.has(name) || /^output(?:File|-file)\.[^.]+$/.test(name)) continue;
    throw new Error(`Unknown option \`${flag}\``);
  }
}
