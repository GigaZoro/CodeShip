import { OrchestratorMcpFailure, ReviewMaterialRead } from "@t3tools/contracts";
import { REVIEW_ASSIGNMENT_TOOL } from "@t3tools/provider-core/server/mcpSession";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ReviewAssignmentRegistry from "../../ReviewAssignmentRegistry.ts";

const ReadMaterialTool = Tool.make(REVIEW_ASSIGNMENT_TOOL, {
  description:
    "Read one file of your review assignment. Pass the assignment `handle`, and the `side` and `path` your task names.",
  parameters: ReviewMaterialRead,
  success: Schema.Struct({ text: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ReviewAssignmentRegistry.ReviewAssignmentRegistry,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

/** The only toolkit `/mcp/review-assignment` serves. */
export const ReviewAssignmentToolkit = Toolkit.make(ReadMaterialTool);
