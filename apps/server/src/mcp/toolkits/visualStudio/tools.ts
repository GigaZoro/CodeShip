import {
  OrchestratorMcpFailure,
  VisualStudioAutoContinue,
  VisualStudioAutoContinueInput,
  VisualStudioControlInput,
  VisualStudioError,
  VisualStudioEvalInput,
  VisualStudioEvalResult,
  VisualStudioStatusInput,
  VisualStudioStatusResult,
  VisualStudioWindow,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VisualStudioDebugger from "../../../visualStudio/VisualStudioDebugger.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  VisualStudioDebugger.VisualStudioDebugger,
];

const failure = Schema.Union([...VisualStudioError.members, OrchestratorMcpFailure]);

const VisualStudioStatusTool = Tool.make("visual_studio_status", {
  description:
    "Visual Studio windows on this Windows machine (not VS Code): each solution and whether its app is idle, running or paused. A paused one includes the exception, stack and locals. Also reports auto-continue and the exceptions it passed. Call it when the app under test runs under the Visual Studio debugger.",
  parameters: VisualStudioStatusInput,
  success: VisualStudioStatusResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Visual Studio status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const VisualStudioEvalTool = Tool.make("visual_studio_eval", {
  description:
    "Evaluate a C# expression in the paused frame of the Visual Studio debugger. Property getters and methods run inside the app.",
  parameters: VisualStudioEvalInput,
  success: VisualStudioEvalResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Evaluate in Visual Studio")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const VisualStudioControlTool = Tool.make("visual_studio_control", {
  description:
    "Continue a paused app, start debugging (builds the solution first), or stop debugging in Visual Studio. The user may be debugging there too: start or stop only when the task needs a fresh run.",
  parameters: VisualStudioControlInput,
  success: VisualStudioWindow,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Control Visual Studio debugging")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const VisualStudioAutoContinueTool = Tool.make("visual_studio_auto_continue", {
  description:
    "While on, T3.CodeShip presses Continue on every exception break in one Visual Studio window, so tests against the debugged app do not hang, and logs each exception for `visual_studio_status`. It ends when debugging stops, at a breakpoint, after `minutes`, or when turned off. Turn it off when your run is done.",
  parameters: VisualStudioAutoContinueInput,
  success: VisualStudioAutoContinue,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Auto-continue Visual Studio")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VisualStudioToolkit = Toolkit.make(
  VisualStudioStatusTool,
  VisualStudioEvalTool,
  VisualStudioControlTool,
  VisualStudioAutoContinueTool,
);
