import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { importBinding, resolvePropertyName } from "../utils.ts";

const MESSAGE = "Catch known tags with `Effect.catchTags({ Tag: handler })`, even for one tag.";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require `Effect.catchTags` over `Effect.catchTag`.",
    },
  },
  create(context) {
    const isEffectNamespace = (identifier: ESTree.IdentifierReference) =>
      Option.exists(
        importBinding(context.sourceCode, identifier),
        ({ source, specifier }) =>
          source === "effect/Effect" && specifier.type === "ImportNamespaceSpecifier",
      );

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect/Effect") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            (specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value) === "catchTag"
          ) {
            context.report({ node: specifier, message: MESSAGE });
          }
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          Option.contains(resolvePropertyName(context.sourceCode, node.property), "catchTag") &&
          isEffectNamespace(node.object)
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
