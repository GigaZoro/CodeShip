import type { DesktopAutoInstallReadiness } from "@t3tools/contracts";
import { isRestartHoldEmpty } from "@t3tools/shared/restartHold";
import * as Effect from "effect/Effect";

import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Settings from "../serverSettings.ts";

/**
 * What the desktop app reads while no window is open, since the setting and the chats are this
 * server's. An unreadable hold fails, so the app treats it as busy instead of installing blind.
 */
export const readDesktopAutoInstallReadiness = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const current = yield* settings.getSettings;
  const hold = yield* recovery.restartHold;
  return {
    enabled: current.installUpdatesAutomatically,
    idle: isRestartHoldEmpty(hold),
  } satisfies DesktopAutoInstallReadiness;
}).pipe(Effect.withSpan("cloud.desktop_auto_install.read_readiness"));
