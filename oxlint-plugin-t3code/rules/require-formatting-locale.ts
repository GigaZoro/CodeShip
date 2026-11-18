import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const INTL_FORMATTERS = new Set([
  "DateTimeFormat",
  "NumberFormat",
  "RelativeTimeFormat",
  "ListFormat",
]);

const MESSAGE =
  "Formatting without a locale follows the runtime default, not the language the user chose. Pass `getFormattingLocale()` (an explicit tag is fine for fixed-language text), and create the formatter where it is used, not at module scope.";

const isMissingLocale = (argument: ESTree.Node | undefined): boolean => {
  if (!argument) return true;
  const expression = unwrapExpression(argument);
  if (Option.isNone(expression)) return false;
  if (isIdentifier(expression, "undefined")) return true;
  return expression.value.type === "ArrayExpression" && expression.value.elements.length === 0;
};

// `Intl.DateTimeFormat().resolvedOptions()` reads the runtime default on purpose; nothing is displayed.
const isOnlyRead = (node: ESTree.Node): boolean =>
  node.parent?.type === "MemberExpression" &&
  node.parent.object === node &&
  Option.exists(getPropertyName(node.parent.property), (name) => name === "resolvedOptions");

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require client date, time and number formatting to pass a locale, so it follows the chosen language.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || !LOCALE_METHODS.has(method.value)) return;
        if (!isMissingLocale(node.arguments[0])) return;
        context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.value.object), "Intl")) return;
        const formatter = getPropertyName(callee.value.property);
        if (Option.isNone(formatter) || !INTL_FORMATTERS.has(formatter.value)) return;
        if (!isMissingLocale(node.arguments[0])) return;
        if (isOnlyRead(node)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
