import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, importBinding, resolvePropertyName } from "../utils.ts";

/** Combinators whose object of callbacks is inline code, not a service: `Option.match(o, { onNone: ... })`. */
const CALLBACK_COMBINATORS = new Set(["catchTags", "match", "matchEffect", "matchCauseEffect"]);

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Use Effect.fn for reusable generator-based Effect functions.",
    },
  },
  create(context) {
    const isEffectImport = (identifier: ESTree.IdentifierReference, member: string) =>
      Option.exists(importBinding(context.sourceCode, identifier), ({ source, specifier }) => {
        const imported =
          specifier.type === "ImportSpecifier"
            ? Option.getOrUndefined(getPropertyName(specifier.imported))
            : undefined;
        if (source === "effect/Effect") {
          return member === "" ? imported === "gen" : specifier.type === "ImportNamespaceSpecifier";
        }
        return source === "effect" && imported === "Effect";
      });

    const isGeneratorCall = (expression: ESTree.Expression): boolean => {
      if (expression.type !== "CallExpression") return false;
      const callee = expression.callee;
      if (callee.type === "Identifier") return isEffectImport(callee, "");
      if (callee.type !== "MemberExpression") return false;
      // `Effect["gen"]`, or `Effect[key]` with `const key = "gen"`, is the same call.
      const method = resolvePropertyName(context.sourceCode, callee.property);
      if (Option.contains(method, "pipe")) return isGeneratorCall(callee.object);
      return (
        Option.contains(method, "gen") &&
        callee.object.type === "Identifier" &&
        isEffectImport(callee.object, "gen")
      );
    };

    const check = (node: ESTree.ArrowFunctionExpression | ESTree.Function) => {
      if (node.async || node.generator) return;
      const parent = node.parent;
      if (node.type !== "FunctionDeclaration") {
        if (parent.type === "MethodDefinition") {
          if (parent.kind !== "method") return;
        } else if (parent.type === "Property") {
          if (parent.kind !== "init") return;
          // `{ [key]: ... }` and `a[method](...)` name what `key` and `method` hold, not `key` and `method`.
          const name = resolvePropertyName(context.sourceCode, parent.key);
          const call = parent.parent.parent;
          if (call?.type === "CallExpression") {
            let callee = call.callee;
            while (callee.type === "CallExpression") callee = callee.callee;
            if (callee.type === "MemberExpression") {
              const method = resolvePropertyName(context.sourceCode, callee.property);
              if (
                Option.exists(method, (value) => CALLBACK_COMBINATORS.has(value)) ||
                (Option.contains(name, "defaultValue") && Option.contains(method, "Reference"))
              ) {
                return;
              }
            }
          }
        } else if (parent.type !== "VariableDeclarator" && parent.type !== "PropertyDefinition") {
          return;
        }
      }
      const body = node.body;
      if (body === null) return;
      let expression: ESTree.Expression | null;
      if (body.type === "BlockStatement") {
        if (body.body.length !== 1 || body.body[0]?.type !== "ReturnStatement") return;
        expression = body.body[0].argument;
      } else {
        expression = body;
      }
      if (expression === null || !isGeneratorCall(expression)) return;
      context.report({
        node,
        message:
          'Use Effect.fn("Service.operation") for reusable Effect functions. Reserve Effect.fnUntraced for documented hot paths or an existing span; keep Effect.gen for inline programs.',
      });
    };

    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
      FunctionDeclaration: check,
    };
  },
});
