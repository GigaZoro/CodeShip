import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName } from "../utils.ts";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

function isResizeObserverConstructor(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "ResizeObserver";
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return false;
  if (!GLOBAL_OBJECTS.has(node.object.name)) return false;
  return Option.contains(resolvePropertyName(sourceCode, node.property), "ResizeObserver");
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow constructing ResizeObserver directly in web code; use observeResize.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (!isResizeObserverConstructor(context.sourceCode, node.callee)) return;
        context.report({
          node: node.callee,
          message:
            "Use observeResize from ~/lib/observeResize. React commits state set in a raw ResizeObserver callback after the paint, so layout derived from the observed size lands one frame late.",
        });
      },
    };
  },
});
