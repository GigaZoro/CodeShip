import type { ProjectScript } from "@t3tools/contracts";
import { msg, t } from "./i18n.ts";

/** @public */
export function projectScriptMenuLabel(script: ProjectScript, resolve: typeof t = t): string {
  const name = script.name;
  if (script.runOnWorktreeCreate && script.runOnSettle) {
    return resolve(msg("{name} (setup, on settle)"), { name });
  }
  if (script.runOnWorktreeCreate) return resolve(msg("{name} (setup)"), { name });
  if (script.runOnSettle) return resolve(msg("{name} (on settle)"), { name });
  return name;
}
