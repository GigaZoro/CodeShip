import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, importBinding, resolvePropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SUITES = new Set(["describe", "suite"]);
const TESTS = new Set(["it", "test"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const EFFECT_VITEST = "@effect/vitest";

const staticTitle = (node: ESTree.CallExpression): string | undefined => {
  const first = node.arguments[0];
  if (first?.type === "Literal" && typeof first.value === "string") return first.value;
  if (first?.type === "TemplateLiteral" && first.expressions.length === 0) {
    return first.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow two tests with the same title in one describe block or file.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    // Only these names can resolve to @effect/vitest's exports, so other calls skip scope analysis.
    const effectVitestNames = new Set<string>();

    /** The @effect/vitest export a call's name resolves to: `it` for `it as effectIt`. */
    const effectVitestExport = (identifier: ESTree.Node & { readonly name: string }) => {
      if (!effectVitestNames.has(identifier.name)) return undefined;
      return importBinding(context.sourceCode, identifier).pipe(
        Option.flatMap(({ source, specifier }) =>
          source === EFFECT_VITEST && specifier.type === "ImportSpecifier"
            ? getPropertyName(specifier.imported)
            : Option.none(),
        ),
        Option.getOrUndefined,
      );
    };

    // A merge that keeps both sides of a test file leaves two tests that Vitest reports under one name.
    // oxlint's vitest/no-identical-title skips it.effect and it.live, which most of our tests use.
    const callKind = (callee: unknown): "suite" | "test" | undefined => {
      let current = unwrapExpression(callee);
      while (Option.isSome(current) && current.value.type === "MemberExpression") {
        if (Option.isNone(resolvePropertyName(context.sourceCode, current.value.property)))
          return undefined;
        current = unwrapExpression(current.value.object);
      }
      if (Option.isNone(current) || current.value.type !== "Identifier") return undefined;
      const identifier = current.value;
      if (SUITES.has(identifier.name)) return "suite";
      return TESTS.has(identifier.name) || effectVitestExport(identifier) === "it"
        ? "test"
        : undefined;
    };

    // @effect/vitest's layer(L)("name", (it) => …) and it.layer(L)("name", (it) => …) open a describe
    // block; without a name they add their tests to the enclosing one. A local helper named `layer` may not.
    const isNamedLayerSuite = (call: ESTree.CallExpression): boolean => {
      if (call.arguments.length < 2) return false;
      const factory = unwrapExpression(call.callee);
      if (Option.isNone(factory) || factory.value.type !== "CallExpression") return false;
      const target = unwrapExpression(factory.value.callee);
      if (Option.isNone(target)) return false;
      if (target.value.type === "Identifier") return effectVitestExport(target.value) === "layer";
      return (
        target.value.type === "MemberExpression" &&
        Option.getOrUndefined(resolvePropertyName(context.sourceCode, target.value.property)) ===
          "layer" &&
        callKind(target.value.object) === "test"
      );
    };

    const enclosingSuite = (node: ESTree.Node): ESTree.Node | undefined => {
      let current = node.parent;
      while (current) {
        if (
          FUNCTIONS.has(current.type) &&
          current.parent?.type === "CallExpression" &&
          (callKind(current.parent.callee) === "suite" || isNamedLayerSuite(current.parent))
        ) {
          return current;
        }
        current = current.parent;
      }
      return undefined;
    };

    const seen = new Map<ESTree.Node | undefined, Set<string>>();

    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration" || statement.source.value !== EFFECT_VITEST) {
            continue;
          }
          for (const specifier of statement.specifiers) {
            if (specifier.type === "ImportSpecifier") effectVitestNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const kind = callKind(node.callee);
        if (kind !== "test") return;
        const title = staticTitle(node);
        if (title === undefined) return;

        const scope = enclosingSuite(node);
        const titles = seen.get(scope) ?? new Set<string>();
        seen.set(scope, titles);
        if (titles.has(title)) {
          context.report({
            node: node.arguments[0] ?? node,
            message: `Two tests in this scope are named "${title}". Vitest reports them under one name, so a stale copy hides; rename one or delete the duplicate.`,
          });
        }
        titles.add(title);
      },
    };
  },
});
