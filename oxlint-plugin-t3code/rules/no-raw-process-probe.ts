import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const message =
  "Probe a pid with probeProcess or isProcessAlive from @t3tools/shared/processProbe. Only ESRCH proves a process gone; a local copy that reads another error as gone stops or forgets live processes.";

const isGlobalProcess = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "process")) return true;
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  const property = getPropertyName(expression.value.property);
  return (
    isIdentifier(unwrapExpression(expression.value.object), "globalThis") &&
    Option.isSome(property) &&
    property.value === "process"
  );
};

const isZero = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    Option.isSome(expression) && expression.value.type === "Literal" && expression.value.value === 0
  );
};

// kill(-pgid, 0) probes a process group, which the shared probe does not cover.
const isGroupTarget = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    Option.isSome(expression) &&
    expression.value.type === "UnaryExpression" &&
    expression.value.operator === "-"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow probing a pid with process.kill(pid, 0) outside the shared process probe, so every caller reads the result the same way.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || method.value !== "kill") return;
        if (!isGlobalProcess(callee.value.object)) return;
        const [target, signal] = node.arguments;
        if (!isZero(signal) || isGroupTarget(target)) return;
        context.report({ node, message });
      },
    };
  },
});
