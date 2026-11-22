import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SUITES = new Set(["describe", "suite"]);
const TESTS = new Set(["it", "test"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

// A merge that keeps both sides of a test file leaves two tests that Vitest reports under one name.
// oxlint's vitest/no-identical-title skips it.effect and it.live, which most of our tests use.
const callKind = (sourceCode: SourceCode, callee: unknown): "suite" | "test" | undefined => {
  let current = unwrapExpression(callee);
  while (Option.isSome(current) && current.value.type === "MemberExpression") {
    if (Option.isNone(resolvePropertyName(sourceCode, current.value.property))) return undefined;
    current = unwrapExpression(current.value.object);
  }
  if (Option.isNone(current) || current.value.type !== "Identifier") return undefined;
  if (SUITES.has(current.value.name)) return "suite";
  return TESTS.has(current.value.name) ? "test" : undefined;
};

const staticTitle = (node: ESTree.CallExpression): string | undefined => {
  const first = node.arguments[0];
  if (first?.type === "Literal" && typeof first.value === "string") return first.value;
  if (first?.type === "TemplateLiteral" && first.expressions.length === 0) {
    return first.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const enclosingSuite = (sourceCode: SourceCode, node: ESTree.Node): ESTree.Node | undefined => {
  let current = node.parent;
  while (current) {
    if (
      FUNCTIONS.has(current.type) &&
      current.parent?.type === "CallExpression" &&
      callKind(sourceCode, current.parent.callee) === "suite"
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
    const { sourceCode } = context;
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const seen = new Map<ESTree.Node | undefined, Set<string>>();

    return {
      CallExpression(node) {
        const kind = callKind(sourceCode, node.callee);
        if (kind !== "test") return;
        const title = staticTitle(node);
        if (title === undefined) return;

        const scope = enclosingSuite(sourceCode, node);
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
