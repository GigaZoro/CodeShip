import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
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
  installUpdatesAutomatically: ServerSettings.fields.installUpdatesAutomatically,
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
// Optional so an answer forwarded from a linked machine on an older version still decodes.
const ProviderAccounts = Schema.optionalKey(
  Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      driver: ProviderDriverKind,
      displayName: Schema.optionalKey(Schema.String),
      sharedWithMachines: Schema.Boolean,
      config: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
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
    "Read this server's identity, preferences, model defaults, and the config fields each provider account shares (providerAccounts). Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    providerAccounts: ProviderAccounts,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    'Update server preferences/model defaults, also on full-access linked machines. Live full-access/default callers only. Omitted fields stay; null clears a role; customInstructions: \'\' clears it. providerUpdates: off/notify/automatic; overrides enableProviderUpdateChecks. Checks off disables automatic updates; automatic enables checks. installUpdatesAutomatically: install releases when idle.usageLimitRecovery: off/resume/switch-and-resume; snoozeLimitedThreads hides independently. Legacy snooze hides with recovery off. Switching is opt-in; some providers forbid extra accounts to bypass limits. allMachines: true shares the change with machines that follow shared settings, even if off now. providerAccounts {accountId: {field: value}} sets only config fields t3_environment_read lists for that account, checked like its settings form; Claude autoCompactWindow is a string from "100000" to "1000000", "" for the default. An added account\'s change reaches machines that follow shared settings (sharedWithMachines); allMachines also shares a value already set here, and refuses built-in accounts, whose fields stay on each machine.',
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultModelSelection: ServerSettingsPatch.fields.defaultModelSelection,
    scheduledTaskModelSelection: ServerSettingsPatch.fields.scheduledTaskModelSelection,
    delegatedTaskModelSelections: ServerSettingsPatch.fields.delegatedTaskModelSelections,
    autoModeModels: ServerSettingsPatch.fields.autoModeModels,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    installUpdatesAutomatically: ServerSettingsPatch.fields.installUpdatesAutomatically,
    providerUpdates: Schema.optionalKey(ProviderUpdatesChoice),
    usageLimitRecovery: Schema.optionalKey(
      Schema.Union([UsageLimitRecoveryChoice, Schema.Literal("snooze")]),
    ),
    snoozeLimitedThreads: ServerSettingsPatch.fields.snoozeLimitedThreads,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    providerAccounts: Schema.optionalKey(
      Schema.Record(ProviderInstanceId, Schema.Record(Schema.String, Schema.Unknown)),
    ),
    allMachines: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({ ...PreferenceFields, providerAccounts: ProviderAccounts }),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
