import { defineRule, type ESTree } from "@oxlint/plugins";

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

const MESSAGE =
  "Early return on the host platform makes the test report a pass it never earned. Use `it.skipIf(...)`/`it.runIf(...)` (or a gated `describe`) so the run reports a skip; `isWindowsHost` is in `@t3tools/shared/testing/hostPlatform`.";

const isPlatformLiteral = (node: ESTree.Node): boolean =>
  node.type === "Literal" && typeof node.value === "string" && PLATFORM_NAMES.has(node.value);

const comparesPlatform = (node: ESTree.Node): boolean => {
  switch (node.type) {
    case "BinaryExpression":
      return (
        (EQUALITY_OPERATORS.has(node.operator) &&
          (isPlatformLiteral(node.left) || isPlatformLiteral(node.right))) ||
        comparesPlatform(node.left) ||
        comparesPlatform(node.right)
      );
    case "LogicalExpression":
      return comparesPlatform(node.left) || comparesPlatform(node.right);
    case "UnaryExpression":
      return comparesPlatform(node.argument);
    case "ParenthesizedExpression":
      return comparesPlatform(node.expression);
    default:
      return false;
  }
};

const isBareReturn = (node: ESTree.Node): boolean =>
  (node.type === "ReturnStatement" && node.argument === null) ||
  (node.type === "BlockStatement" && node.body.length === 1 && isBareReturn(node.body[0]!));

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `if (platform === ...) return;` in tests; skip the test with it.skipIf/it.runIf instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      IfStatement(node) {
        if (node.alternate) return;
        if (!isBareReturn(node.consequent)) return;
        if (!comparesPlatform(node.test)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
