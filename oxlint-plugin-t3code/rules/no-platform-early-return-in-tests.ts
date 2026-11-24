import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolvePropertyName } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const PLATFORM_NAMES = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);
const HOST_PLATFORM_MODULE = "@t3tools/shared/testing/hostPlatform";
// A hook that returns early skips its own setup or cleanup, not a test, so it reports no pass.
const LIFECYCLE_HOOKS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "onTestFailed",
  "onTestFinished",
]);

const MESSAGE =
  "Early return on the host platform makes the test report a pass it never earned. Use `it.skipIf(...)`/`it.runIf(...)` (or a gated `describe`) so the run reports a skip; `isWindowsHost` is in `@t3tools/shared/testing/hostPlatform`.";

const isPlatformLiteral = (node: ESTree.Node): boolean =>
  node.type === "Literal" && typeof node.value === "string" && PLATFORM_NAMES.has(node.value);

const containsPlatformLiteralComparison = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(containsPlatformLiteralComparison);
  if (node === null || typeof node !== "object") return false;
  const candidate = node as ESTree.Node;
  if (
    candidate.type === "BinaryExpression" &&
    EQUALITY_OPERATORS.has(candidate.operator) &&
    (isPlatformLiteral(candidate.left) || isPlatformLiteral(candidate.right))
  ) {
    return true;
  }
  return Object.entries(candidate).some(
    ([key, value]) => key !== "parent" && containsPlatformLiteralComparison(value),
  );
};

const collectPlatformHelpers = (program: ESTree.Program): ReadonlySet<string> => {
  const helpers = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.source.value !== HOST_PLATFORM_MODULE) continue;
      for (const specifier of statement.specifiers) helpers.add(specifier.local.name);
      continue;
    }
    const declaration =
      (statement.type === "ExportNamedDeclaration" && statement.declaration) || statement;
    if (declaration.type === "FunctionDeclaration") {
      if (declaration.id && containsPlatformLiteralComparison(declaration.body)) {
        helpers.add(declaration.id.name);
      }
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (
          declarator.id.type === "Identifier" &&
          declarator.init &&
          containsPlatformLiteralComparison(declarator.init)
        ) {
          helpers.add(declarator.id.name);
        }
      }
    }
  }
  return helpers;
};

const comparesPlatform = (node: ESTree.Node, helpers: ReadonlySet<string>): boolean => {
  switch (node.type) {
    case "BinaryExpression":
      return (
        (EQUALITY_OPERATORS.has(node.operator) &&
          (isPlatformLiteral(node.left) || isPlatformLiteral(node.right))) ||
        comparesPlatform(node.left, helpers) ||
        comparesPlatform(node.right, helpers)
      );
    case "LogicalExpression":
      return comparesPlatform(node.left, helpers) || comparesPlatform(node.right, helpers);
    case "UnaryExpression":
    case "AwaitExpression":
    case "YieldExpression":
      return node.argument !== null && comparesPlatform(node.argument, helpers);
    case "ParenthesizedExpression":
      return comparesPlatform(node.expression, helpers);
    case "Identifier":
      return helpers.has(node.name);
    case "MemberExpression":
      return comparesPlatform(node.object, helpers);
    case "CallExpression":
      return comparesPlatform(node.callee, helpers);
    default:
      return false;
  }
};

const isBareReturn = (node: ESTree.Node): boolean =>
  (node.type === "ReturnStatement" && node.argument === null) ||
  (node.type === "BlockStatement" && node.body.length === 1 && isBareReturn(node.body[0]!));

const calleeName = (sourceCode: SourceCode, callee: ESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    return Option.getOrUndefined(resolvePropertyName(sourceCode, callee.property));
  }
  return undefined;
};

const insideLifecycleHook = (sourceCode: SourceCode, node: ESTree.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "CallExpression") continue;
    const name = calleeName(sourceCode, current.callee);
    if (name !== undefined && LIFECYCLE_HOOKS.has(name)) return true;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `if (platform === ...) return;` in tests, including a file-level helper that wraps the comparison and the shared host flags; skip the test with it.skipIf/it.runIf instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    let helpers: ReadonlySet<string> = new Set();

    return {
      Program(node) {
        helpers = collectPlatformHelpers(node);
      },
      IfStatement(node) {
        if (node.alternate) return;
        if (!isBareReturn(node.consequent)) return;
        if (!comparesPlatform(node.test, helpers)) return;
        if (insideLifecycleHook(context.sourceCode, node)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
