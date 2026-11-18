import { defineRule, type ESTree } from "@oxlint/plugins";

import { findVariable } from "../utils.ts";

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
      findVariable(context.sourceCode.getScope(identifier), identifier.name)?.defs.some(
        (def) =>
          def.type === "ImportBinding" &&
          def.node.type === "ImportNamespaceSpecifier" &&
          def.parent?.type === "ImportDeclaration" &&
          def.parent.source.value === "effect/Effect",
      ) ?? false;

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
          !node.computed &&
          node.object.type === "Identifier" &&
          node.property.type === "Identifier" &&
          node.property.name === "catchTag" &&
          isEffectNamespace(node.object)
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
