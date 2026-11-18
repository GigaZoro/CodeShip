// @effect-diagnostics nodeBuiltinImport:off - Vite configs load this before any Effect runtime exists.
import * as NodeOS from "node:os";

// Every vitest config takes its worker cap from here. Vitest defaults to about one worker per core,
// and a machine runs several worktrees' test runs at once, so the default multiplies by the number
// of chats. CI runs one job per machine and keeps every core.
const LOCAL_TEST_WORKERS = 2;

export function resolveTestMaxWorkers(
  env: Record<string, string | undefined> = process.env,
  cores = NodeOS.availableParallelism(),
): number {
  const requested = Number(env.T3CODE_TEST_MAX_WORKERS);
  if (Number.isInteger(requested) && requested >= 1) return requested;
  return env.CI ? cores : Math.min(LOCAL_TEST_WORKERS, cores);
}

export const TEST_MAX_WORKERS = resolveTestMaxWorkers();
