import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SUITES = new Set(["describe", "suite"]);
const TESTS = new Set(["it", "test"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const EFFECT_VITEST = "@effect/vitest";

/** Local names bound to @effect/vitest's `it` (such as `it as effectIt`) and `layer`. */
interface EffectVitestBindings {
  readonly tests: Set<string>;
  readonly layers: Set<string>;
}

// A merge that keeps both sides of a test file leaves two tests that Vitest reports under one name.
// oxlint's vitest/no-identical-title skips it.effect and it.live, which most of our tests use.
const callKind = (
  callee: unknown,
  bindings: EffectVitestBindings,
): "suite" | "test" | undefined => {
  let current = unwrapExpression(callee);
  while (Option.isSome(current) && current.value.type === "MemberExpression") {
    if (Option.isNone(getPropertyName(current.value.property))) return undefined;
    current = unwrapExpression(current.value.object);
  }
  if (Option.isNone(current) || current.value.type !== "Identifier") return undefined;
  const { name } = current.value;
  if (SUITES.has(name)) return "suite";
  return TESTS.has(name) || bindings.tests.has(name) ? "test" : undefined;
};

// @effect/vitest's layer(L)("name", (it) => …) and it.layer(L)("name", (it) => …) open a describe
// block; without a name they add their tests to the enclosing one. A local helper named `layer` may not.
const isNamedLayerSuite = (
  call: ESTree.CallExpression,
  bindings: EffectVitestBindings,
): boolean => {
  if (call.arguments.length < 2) return false;
  const factory = unwrapExpression(call.callee);
  if (Option.isNone(factory) || factory.value.type !== "CallExpression") return false;
  const target = unwrapExpression(factory.value.callee);
  if (Option.isNone(target)) return false;
  if (target.value.type === "Identifier") return bindings.layers.has(target.value.name);
  return (
    target.value.type === "MemberExpression" &&
    Option.getOrUndefined(getPropertyName(target.value.property)) === "layer" &&
    callKind(target.value.object, bindings) === "test"
  );
};

const staticTitle = (node: ESTree.CallExpression): string | undefined => {
  const first = node.arguments[0];
  if (first?.type === "Literal" && typeof first.value === "string") return first.value;
  if (first?.type === "TemplateLiteral" && first.expressions.length === 0) {
    return first.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const enclosingSuite = (
  node: ESTree.Node,
  bindings: EffectVitestBindings,
): ESTree.Node | undefined => {
  let current = node.parent;
  while (current) {
    if (
      FUNCTIONS.has(current.type) &&
      current.parent?.type === "CallExpression" &&
      (callKind(current.parent.callee, bindings) === "suite" ||
        isNamedLayerSuite(current.parent, bindings))
    ) {
      return current;
    }
    current = current.parent;
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

    const bindings: EffectVitestBindings = { tests: new Set(), layers: new Set() };
    const seen = new Map<ESTree.Node | undefined, Set<string>>();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== EFFECT_VITEST) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = Option.getOrUndefined(getPropertyName(specifier.imported));
          if (imported === "it") bindings.tests.add(specifier.local.name);
          if (imported === "layer") bindings.layers.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const kind = callKind(node.callee, bindings);
        if (kind !== "test") return;
        const title = staticTitle(node);
        if (title === undefined) return;

        const scope = enclosingSuite(node, bindings);
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
