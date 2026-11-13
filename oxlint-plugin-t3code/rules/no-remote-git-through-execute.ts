import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const REMOTE_SUBCOMMANDS = new Set(["fetch", "ls-remote", "pull", "push", "clone"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  "Run remote Git commands with GitVcsDriver.executeRemote: it never prompts for credentials, names the cause and the phase that hung, and lets isLostConnection tell a lost network from a real failure.";

const literalString = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) => {
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return Option.some(expression.value);
    }
    if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
      return Option.fromNullishOr(expression.quasis[0]?.value.cooked);
    }
    return Option.none();
  });

const firstArgsElement = (input: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(input), (object) => {
    if (object.type !== "ObjectExpression") return Option.none();
    for (const property of object.properties) {
      if (property.type !== "Property") continue;
      const name = getPropertyName(property.key);
      if (Option.isNone(name) || name.value !== "args") continue;
      const value = unwrapExpression(property.value);
      if (Option.isNone(value) || value.value.type !== "ArrayExpression") return Option.none();
      const first = value.value.elements[0];
      return first ? literalString(first) : Option.none();
    }
    return Option.none();
  });

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running fetch, ls-remote, pull, push and clone through GitVcsDriver.execute; use executeRemote.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) return {};
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || method.value !== "execute") return;
        const subcommand = firstArgsElement(node.arguments[0]);
        if (Option.isNone(subcommand) || !REMOTE_SUBCOMMANDS.has(subcommand.value)) return;
        // Reported on the property so a disable comment sits right above `.execute(` in a chain.
        context.report({ node: callee.value.property, message: MESSAGE });
      },
    };
  },
});
