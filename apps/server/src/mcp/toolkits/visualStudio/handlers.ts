import * as Effect from "effect/Effect";

import * as VisualStudioDebugger from "../../../visualStudio/VisualStudioDebugger.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VisualStudioToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(
  VisualStudioToolkit,
  Effect.gen(function* () {
    const visualStudio = yield* VisualStudioDebugger.VisualStudioDebugger;
    return {
      visual_studio_status: McpToolAccess.readsAsCaller(visualStudio.status),
      visual_studio_eval: McpToolAccess.actsAsCaller(visualStudio.evaluate),
      visual_studio_control: McpToolAccess.actsAsCaller(visualStudio.control),
      visual_studio_auto_continue: McpToolAccess.actsAsCaller(visualStudio.autoContinue),
    };
  }),
);
