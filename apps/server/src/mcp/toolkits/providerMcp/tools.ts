import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderMcpServer,
  ProviderMcpServerEdit,
  ProviderMcpServerName,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AccountRouting from "../../../orchestration-v2/AccountRouting.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderMcp from "../../../provider/ProviderMcp.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProviderMcpServersTool = Tool.make("t3_provider_mcp_servers", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderMcp.ProviderMcp,
  ],
  description:
    'MCP servers a provider loads here; new sessions get changes. `add` needs a full `server`. `edit`: "" keeps a stored header/env value, no `url` keeps the address; values are never returned. `disable` keeps config; `remove` deletes it and its keys, so prefer `disable`. Changes need a full-access caller.',
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    instanceId: ProviderInstanceId.annotate({
      description: "Provider instance, such as `claudeAgent` or `codex`.",
    }),
    action: Schema.Literals(["list", "add", "edit", "enable", "disable", "remove"]),
    name: Schema.optional(ProviderMcpServerName.annotate({ description: "All but `list`." })),
    server: Schema.optional(ProviderMcpServerEdit),
  }),
  success: Schema.Struct({
    servers: Schema.optional(Schema.Array(ProviderMcpServer)),
    message: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, true);

const ProviderRetryUsageLimitTool = Tool.make("t3_provider_retry_usage_limit", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AccountRouting.AccountRouting,
  ],
  description:
    "Releases T3's hold on a usage-limited account (`usageLimited` in `orchestrator_capabilities`), so its next turn tries it; a new refusal holds it again. For a limit lifted early, such as ChatGPT's app cap. Needs a full-access caller.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    instanceId: ProviderInstanceId,
  }),
  success: Schema.Struct({ message: Schema.String }),
});

export const ProviderMcpToolkit = Toolkit.make(ProviderMcpServersTool, ProviderRetryUsageLimitTool);
