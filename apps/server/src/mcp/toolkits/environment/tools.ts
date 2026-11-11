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
    "Update environment-wide preferences and model defaults, including on a full-access linked machine. Live full-access or default caller thread only. Omitted fields are unchanged; null clears a delegated-task role; `customInstructions: ''` clears it. `providerUpdates`: off, notify, automatic (also enables checks). Prefer it to the legacy enableProviderUpdateChecks flag; it takes precedence. `usageLimitRecovery`: off, snooze, resume, switch-and-resume. Switching is opt-in: some providers forbid using extra accounts to get around limits. Existing custom combinations are preserved until a choice is supplied.",
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
    usageLimitRecovery: Schema.optionalKey(UsageLimitRecoveryChoice),
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
