import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { requireModelPreferences } from "../../OrchestratorMcpService.ts";
import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import {
  providerUpdatesChoice,
  providerUpdatesPatch,
  usageLimitRecoveryChoice,
  usageLimitRecoveryPatch,
} from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultModelSelection,
    scheduledTaskModelSelection,
    delegatedTaskModelSelections,
    autoModeModels,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultModelSelection,
    scheduledTaskModelSelection,
    delegatedTaskModelSelections,
    autoModeModels,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    providerUpdates: providerUpdatesChoice(settings),
    usageLimitRecovery: usageLimitRecoveryChoice(settings),
    snoozeLimitedThreads: settings.snoozeLimitedThreads,
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const { providerUpdates, usageLimitRecovery, ...legacyPatch } = patch;
      const settingsPatch = {
        ...legacyPatch,
        ...(legacyPatch.enableProviderUpdateChecks === false ? { autoUpdateProviders: false } : {}),
        ...(providerUpdates === undefined ? {} : providerUpdatesPatch(providerUpdates)),
        ...(usageLimitRecovery === undefined
          ? {}
          : usageLimitRecoveryPatch(usageLimitRecovery === "snooze" ? "off" : usageLimitRecovery)),
        ...(usageLimitRecovery === "snooze"
          ? { snoozeLimitedThreads: legacyPatch.snoozeLimitedThreads ?? true }
          : {}),
      };
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        yield* requireModelPreferences(
          yield* (yield* ProviderRegistry.ProviderRegistry).getProviders,
          settingsPatch,
        );
        return preferences(
          yield* settings.updateSettings(settingsPatch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
