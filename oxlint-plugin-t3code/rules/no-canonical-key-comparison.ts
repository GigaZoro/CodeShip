import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec|testkit)\.[cm]?[jt]sx?$/u;
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

const MESSAGE =
  "Match a repository across machines with repositoryMatchRank or repositoryKeysOf from @t3tools/contracts: canonicalKey is a fork's upstream remote, which its copy on another machine may lack. Code that means the upstream itself, such as pull request targets, can disable this with its reason.";

const readsCanonicalKey = (node: unknown) =>
  Option.exists(
    unwrapExpression(node),
    (expression) =>
      expression.type === "MemberExpression" &&
      Option.contains(getPropertyName(expression.property), "canonicalKey"),
  );

const isNullish = (node: unknown) =>
  Option.exists(
    unwrapExpression(node),
    (expression) =>
      (expression.type === "Literal" && expression.value === null) ||
      (expression.type === "Identifier" && expression.name === "undefined"),
  );

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comparing repositoryIdentity.canonicalKey directly; match repositories with repositoryMatchRank or repositoryKeysOf.",
    },
  },
  create(context) {
    if (TEST_FILE_PATTERN.test(context.filename)) return {};
    return {
      BinaryExpression(node) {
        if (!EQUALITY_OPERATORS.has(node.operator)) return;
        if (isNullish(node.left) || isNullish(node.right)) return;
        if (!readsCanonicalKey(node.left) && !readsCanonicalKey(node.right)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
