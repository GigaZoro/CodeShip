import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

export const codexAccountShadowHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
) => path.join(stateDir, "providers", "codex", instanceId, "shadow");

export const resolveManagedCodexHomeLayout = Effect.fn("resolveManagedCodexHomeLayout")(function* (
  stateDir: string,
  instanceId: ProviderInstanceId,
  config: CodexSettings,
) {
  const path = yield* Path.Path;
  return yield* resolveCodexHomeLayout({
    ...config,
    shadowHomePath:
      config.shadowHomePath.trim() ||
      (instanceId === "codex" ? "" : codexAccountShadowHomePath(path, stateDir, instanceId)),
  });
});
