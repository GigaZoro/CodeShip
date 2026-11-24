import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName } from "../utils.ts";

const UNSUPPORTED_GLOBAL_APIS = new Map([
  [
    "Intl.Segmenter",
    "Use a portable implementation or a simpler character-counting approximation.",
  ],
]);

const UNSUPPORTED_METHODS = new Map([
  [
    "toSorted",
    "Hermes does not implement Array#toSorted. Copy the array first: [...array].sort(...).",
  ],
  [
    "toReversed",
    "Hermes does not implement Array#toReversed. Copy the array first: [...array].reverse().",
  ],
  [
    "toSpliced",
    "Hermes does not implement Array#toSpliced. Copy the array first: const copy = [...array]; copy.splice(...); use copy.",
  ],
]);

function globalApiPath(sourceCode: SourceCode, node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  const object = globalApiPath(sourceCode, node.object);
  const property = Option.getOrNull(resolvePropertyName(sourceCode, node.property));
  if (object === null || property === null) return null;
  return ["globalThis", "global", "window"].includes(object) ? property : `${object}.${property}`;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow APIs that Hermes does not implement in mobile and shared client code.",
    },
  },
  create(context) {
    function checkApi(node: ESTree.CallExpression | ESTree.NewExpression) {
      const path = globalApiPath(context.sourceCode, node.callee);
      const replacement = path === null ? undefined : UNSUPPORTED_GLOBAL_APIS.get(path);
      if (replacement !== undefined) {
        context.report({
          node: node.callee,
          message: `Hermes does not implement ${path}. ${replacement}`,
        });
        return;
      }
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const name = Option.getOrNull(resolvePropertyName(context.sourceCode, node.callee.property));
      const message = name === null ? undefined : UNSUPPORTED_METHODS.get(name);
      if (message !== undefined) context.report({ node: node.callee.property, message });
    }
    return { NewExpression: checkApi, CallExpression: checkApi };
  },
});
