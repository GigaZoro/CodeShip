import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
  ProviderUpdatesChoice,
  UsageLimitRecoveryChoice,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SharedSettings from "../../../sharedSettings/SharedSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultModelSelection: ServerSettings.fields.defaultModelSelection,
  scheduledTaskModelSelection: ServerSettings.fields.scheduledTaskModelSelection,
  delegatedTaskModelSelections: ServerSettings.fields.delegatedTaskModelSelections,
  autoModeModels: ServerSettings.fields.autoModeModels,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  providerUpdates: Schema.Union([ProviderUpdatesChoice, Schema.Literal("custom")]),
  usageLimitRecovery: Schema.Union([UsageLimitRecoveryChoice, Schema.Literal("custom")]),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    SharedSettings.SharedSettings,
    ProviderRegistry.ProviderRegistry,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity, preferences, and model defaults. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update server preferences/model defaults, also on full-access linked machines. Live full-access/default callers only. Omitted fields stay; null clears a role; customInstructions: '' clears it. providerUpdates: off/notify/automatic; overrides enableProviderUpdateChecks. Checks off disables automatic updates; automatic enables checks. usageLimitRecovery: off/resume/switch-and-resume; snoozeLimitedThreads hides independently. Legacy snooze hides with recovery off. Switching is opt-in; some providers forbid extra accounts to bypass limits. allMachines: true shares the change with machines that follow shared settings, even if off now.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultModelSelection: ServerSettingsPatch.fields.defaultModelSelection,
    scheduledTaskModelSelection: ServerSettingsPatch.fields.scheduledTaskModelSelection,
    delegatedTaskModelSelections: ServerSettingsPatch.fields.delegatedTaskModelSelections,
    autoModeModels: ServerSettingsPatch.fields.autoModeModels,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    providerUpdates: Schema.optionalKey(ProviderUpdatesChoice),
    usageLimitRecovery: Schema.optionalKey(
      Schema.Union([UsageLimitRecoveryChoice, Schema.Literal("snooze")]),
    ),
    snoozeLimitedThreads: ServerSettingsPatch.fields.snoozeLimitedThreads,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    allMachines: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
