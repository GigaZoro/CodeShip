import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName } from "../utils.ts";

const PULL_REQUEST_GLYPH_NAMES = new Set([
  "arrow.triangle.pull",
  "arrow.triangle.merge",
  "git.pull-request.closed",
  "git.pull-request.draft",
  "square.3.layers.3d",
]);

// Material names reach AppSymbol only through `{ ios, android }` objects, and
// "merge" is too common a string to ban outside that slot.
const ANDROID_PULL_REQUEST_GLYPH_NAMES = new Set(["merge"]);

const MESSAGE =
  "Pick a glyph by meaning from PullRequestGlyph in apps/mobile/src/features/pull-requests/pullRequestGlyphs.ts so every surface draws the same pull request the same way.";

function staticString(node: ESTree.Node) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow pull request symbol names as string literals in mobile code; the import restriction that guards web cannot see string names.",
    },
  },
  create(context) {
    // `{ [key]: ... }` names what `key` holds, not `key`.
    const keyIs = (property: ESTree.Node, name: string) =>
      property.type === "Property" &&
      Option.contains(resolvePropertyName(context.sourceCode, property.key), name);

    return {
      Literal(node) {
        if (typeof node.value !== "string" || !PULL_REQUEST_GLYPH_NAMES.has(node.value)) return;
        context.report({ node, message: MESSAGE });
      },
      Property(node) {
        if (
          !keyIs(node, "android") ||
          node.parent.type !== "ObjectExpression" ||
          !node.parent.properties.some((property) => keyIs(property, "ios"))
        )
          return;
        const value = staticString(node.value);
        if (value === null || !ANDROID_PULL_REQUEST_GLYPH_NAMES.has(value)) return;
        context.report({ node: node.value, message: MESSAGE });
      },
      TemplateElement(node) {
        if (!PULL_REQUEST_GLYPH_NAMES.has(node.value.cooked ?? "")) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
