import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FeedbackToolkit } from "./toolkits/feedback/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { IssuesToolkit } from "./toolkits/issues/tools.ts";
import { MessageToolkit } from "./toolkits/message/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProviderMcpToolkit } from "./toolkits/providerMcp/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ToolSearchToolkit } from "./toolkits/toolSearch/tools.ts";
import { VisualStudioToolkit } from "./toolkits/visualStudio/tools.ts";
import { WorkflowToolkit } from "./toolkits/workflow/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

/** Every toolkit `/mcp` serves, for tests that hold each tool to a contract. */
export const MCP_TOOLKITS = [
  AttachmentToolkit,
  DeviceToolkit,
  EnvironmentToolkit,
  FeedbackToolkit,
  HtmlToolkit,
  IssuesToolkit,
  MessageToolkit,
  OrchestratorToolkit,
  PreviewControlsToolkit,
  PreviewToolkit,
  ProjectToolkit,
  ProviderMcpToolkit,
  PullRequestsToolkit,
  TerminalToolkit,
  ThemeToolkit,
  ThreadToolkit,
  ToolSearchToolkit,
  VisualStudioToolkit,
  WorkflowToolkit,
  WorktreeToolkit,
] as const;
