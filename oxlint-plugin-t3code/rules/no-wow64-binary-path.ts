import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { resolveStringValue } from "../utils.ts";

// fspy traces cached `vp run` tasks by injecting an x64-only DLL. For a 32-bit (WOW64) child,
// Detours falls back to a 32-bit rundll32 that cannot load it and shows a dialog nobody sees, so
// CreateProcessW, and with it the whole `vp run`, waits forever (AB#7374).
const message =
  "This names a 32-bit Windows binary location. A process started from it runs under WOW64, and fspy, which traces cached `vp run` tasks, hangs `vp run` on WOW64 children. Use the 64-bit location: System32, the 64-bit Program Files, or the Microsoft.NET Framework64 directory.";

const WOW64_LOCATION = /SysWOW64|Program Files \(x86\)|Microsoft\.NET[\\/]+Framework(?![0-9a-z])/i;
const DOTNET_DIRECTORY = /^Microsoft\.NET$/i;
const FRAMEWORK_32_DIRECTORY = /^Framework$/i;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string literals naming 32-bit Windows binary locations, whose WOW64 processes hang fspy-traced `vp run` tasks.",
    },
  },
  create(context) {
    const isSegment = (node: ESTree.Node | null | undefined, pattern: RegExp) =>
      node != null &&
      Option.exists(resolveStringValue(context.sourceCode, node), (value) => pattern.test(value));
    // Catches the segment form, such as path.join(root, "Microsoft.NET", "Framework", ...).
    const reportFrameworkSegment = (nodes: ReadonlyArray<ESTree.Node | null>) => {
      for (let index = 1; index < nodes.length; index++) {
        const node = nodes[index];
        if (
          node &&
          isSegment(nodes[index - 1], DOTNET_DIRECTORY) &&
          isSegment(node, FRAMEWORK_32_DIRECTORY)
        ) {
          context.report({ node, message });
        }
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string" && WOW64_LOCATION.test(node.value)) {
          context.report({ node, message });
        }
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => WOW64_LOCATION.test(quasi.value.cooked ?? ""))) {
          context.report({ node, message });
        }
      },
      CallExpression(node) {
        reportFrameworkSegment(node.arguments);
      },
      ArrayExpression(node) {
        reportFrameworkSegment(node.elements);
      },
    };
  },
});
