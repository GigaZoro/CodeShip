import {
  OrchestratorMcpFailure,
  TerminalToolReadInput,
  TerminalToolReadResult,
  TerminalToolWriteInput,
  TerminalToolWriteResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    TerminalManager.TerminalManager,
  ],
};

const TerminalReadTool = Tool.make("terminal_read", {
  description:
    "Read the recent output of a thread's terminals in T3.CodeShip's terminal panel, such as a dev server or a command the user ran there. Omit `threadId` for this thread. Returns plain text, newest lines last.",
  parameters: TerminalToolReadInput,
  success: TerminalToolReadResult,
  ...shared,
})
  .annotate(Tool.Title, "Read terminal output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalWriteTool = Tool.make("terminal_write", {
  description:
    "Type into one of this thread's terminals in the terminal panel, where the user watches, such as to restart their dev server. Input goes to whatever runs there; send \\u0003 first to stop it. Returns what it printed once the command finishes, output pauses for 3s, or `waitSeconds` pass; pass the `cursor` as `after` to `terminal_read` for later output. Use your own shell for ordinary commands.",
  parameters: TerminalToolWriteInput,
  success: TerminalToolWriteResult,
  ...shared,
})
  .annotate(Tool.Title, "Type in a terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TerminalToolkit = Toolkit.make(TerminalReadTool, TerminalWriteTool);
