import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName } from "../utils.ts";

const DETAIL_ROUTES = new Set(["Thread", "PullRequest"]);

const MESSAGE =
  "`navigate` to a Thread or PullRequest pushes or updates in place depending on what is on top. Use useSelectWorkspaceDetail to show it as the page, or StackActions.push to open it over the current one.";

/** The function a call names: `navigate`, `navigation.navigate`, or `navigation[method]` with `method` a const holding it. */
function calleeName(sourceCode: SourceCode, callee: ESTree.Expression): Option.Option<string> {
  if (callee.type === "Identifier") return Option.some(callee.name);
  if (callee.type === "MemberExpression") return resolvePropertyName(sourceCode, callee.property);
  return Option.none();
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `navigate` to the workspace's detail routes; selections and drill-ins each have one explicit action.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          !Option.contains(
            calleeName(context.sourceCode, node.callee as ESTree.Expression),
            "navigate",
          )
        ) {
          return;
        }
        const [route] = node.arguments;
        if (route?.type !== "Literal" || typeof route.value !== "string") return;
        if (!DETAIL_ROUTES.has(route.value)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
