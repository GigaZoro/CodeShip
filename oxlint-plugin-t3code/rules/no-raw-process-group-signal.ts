import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const message =
  "Signal a process group through @t3tools/shared/processGroup: spawn it with the server's ChildProcessSpawner and signal it with signalSpawnedGroup, or start it with holdProcessGroup and signal it through ownProcessGroup. Once its leader exited, a group nothing holds can have another program's number.";

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

/** `signalProcessGroup(...)`, also through a namespace import. */
const isRawGroupSignal = (callee: unknown): boolean => {
  const expression = unwrapExpression(callee);
  if (isIdentifier(expression, "signalProcessGroup")) return true;
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  const property = getPropertyName(expression.value.property);
  return Option.isSome(property) && property.value === "signalProcessGroup";
};

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
        "Disallow process.kill(-pgid) and signalProcessGroup outside the shared process group module, which signals a group only while its number is still the spawner's.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isRawGroupSignal(node.callee)) {
          context.report({ node, message });
          return;
        }
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const method = getPropertyName(callee.value.property);
        if (Option.isNone(method) || method.value !== "kill") return;
        if (!isGlobalProcess(callee.value.object)) return;
        if (!isGroupTarget(node.arguments[0])) return;
        context.report({ node, message });
      },
    };
  },
});
