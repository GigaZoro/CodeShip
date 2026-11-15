import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProviderMcpToolkit } from "./toolkits/providerMcp/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { VisualStudioToolkit } from "./toolkits/visualStudio/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

/** Every toolkit `/mcp` serves, for tests that hold each tool to a contract. */
export const MCP_TOOLKITS = [
  AttachmentToolkit,
  DeviceToolkit,
  EnvironmentToolkit,
  HtmlToolkit,
  OrchestratorToolkit,
  PreviewToolkit,
  PreviewControlsToolkit,
  ProjectToolkit,
  ProviderMcpToolkit,
  PullRequestsToolkit,
  TerminalToolkit,
  ThreadToolkit,
  VisualStudioToolkit,
  WorktreeToolkit,
] as const;
