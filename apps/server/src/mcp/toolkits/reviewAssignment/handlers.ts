import { OrchestratorMcpFailure } from "@t3tools/contracts/orchestratorMcp";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ReviewAssignmentRegistry from "../../ReviewAssignmentRegistry.ts";
import { ReviewAssignmentToolkit } from "./tools.ts";

const unavailable = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "Material read unavailable.",
});

export const layer = McpToolAccess.toLayer(ReviewAssignmentToolkit, {
  read_material: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const assignment = scope.assignment;
      if (
        scope.thread === undefined ||
        assignment === undefined ||
        !scope.capabilities.has("review-assignment") ||
        input.handle !== assignment.handle
      ) {
        return yield* unavailable;
      }
      const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
      const text = yield* registry
        .readMaterial({ threadId: scope.thread.threadId, handle: assignment.handle }, input)
        .pipe(Effect.catchTags({ ReviewMaterialUnavailableError: () => Effect.fail(unavailable) }));
      return { text };
    }),
  ),
});
