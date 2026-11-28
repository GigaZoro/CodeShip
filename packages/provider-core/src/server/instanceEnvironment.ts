import type { ProviderInstanceEnvironment } from "@t3tools/contracts/providerInstance";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

/** The name `mergeProviderInstanceEnvironment` sets a variable under on `platform`. */
export const mergedProviderInstanceEnvironmentName = (name: string, platform: NodeJS.Platform) =>
  platform === "win32" ? name.toUpperCase() : name;

/** The variable whose value `mergeProviderInstanceEnvironment` gives `name`, which must be upper case. */
export const findProviderInstanceEnvironmentVariable = Effect.fn(
  "findProviderInstanceEnvironmentVariable",
)(function* <V extends ProviderInstanceEnvironment[number]>(
  environment: ReadonlyArray<V> | undefined,
  name: string,
) {
  const platform = yield* HostProcess.Platform;
  return environment?.findLast(
    (variable) =>
      typeof variable.value === "string" &&
      mergedProviderInstanceEnvironmentName(variable.name, platform) === name,
  );
});

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = mergedProviderInstanceEnvironmentName(variable.name, platform);
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] =
      name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
