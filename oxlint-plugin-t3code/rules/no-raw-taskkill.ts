import { defineRule } from "@oxlint/plugins";

const message =
  "End a Windows process tree with endingWindowsTrees, withWindowsTreeStop or windowsTreeStopper from @t3tools/shared/windowsProcessTree. taskkill /T finds descendants only through a running leader, so what a leader that exited left running survives it.";

const TASKKILL = /^taskkill(?:\.exe)?$/i;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running taskkill outside the shared Windows process tree stop, which also reaches what an exited leader left running.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && TASKKILL.test(node.value)) {
          context.report({ node, message });
        }
      },
      TemplateLiteral(node) {
        const [quasi] = node.quasis;
        if (node.expressions.length === 0 && quasi && TASKKILL.test(quasi.value.cooked ?? "")) {
          context.report({ node, message });
        }
      },
    };
  },
});
