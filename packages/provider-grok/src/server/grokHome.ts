import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type * as Path from "effect/Path";

/** The home a `grok` started with `environment` uses: `GROK_HOME`, or `.grok` in its HOME. */
export function grokHomePath(
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const home = environment.HOME || environment.USERPROFILE || homeDirectory;
  return expandHomePath(environment.GROK_HOME?.trim() || path.join(home, ".grok"), home);
}
