import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec|testkit)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  "Test makes a temp folder inside the checkout, which `vp run check:changed` sees as a change while it runs. Make it under os.tmpdir(); for a folder that is gitignored, disable this line and say so.";

/** How far a chain of `const` aliases is followed before the value counts as unknown. */
const MAX_ALIAS_DEPTH = 4;

const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\])/u;

const calleeName = (callee: unknown) =>
  Option.flatMap(unwrapExpression(callee), (expression) =>
    expression.type === "MemberExpression"
      ? getPropertyName(expression.property)
      : getPropertyName(expression),
  );

const isImportMetaDirname = (node: ESTree.Node) =>
  node.type === "MemberExpression" &&
  node.object.type === "MetaProperty" &&
  Option.contains(getPropertyName(node.property), "dirname");

const isProcessCwd = (node: ESTree.Node) =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  isIdentifier(unwrapExpression(node.callee.object), "process") &&
  Option.contains(getPropertyName(node.callee.property), "cwd");

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow temp folders that tests make inside the checkout, where check:changed sees them as changed files.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const constInitializer = (identifier: ESTree.Node & { readonly name: string }) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined || scope.upper === null) {
          const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
          return def?.type === "Variable" &&
            def.node.type === "VariableDeclarator" &&
            def.parent?.type === "VariableDeclaration" &&
            def.parent.kind === "const"
            ? Option.fromNullishOr(def.node.init)
            : Option.none();
        }
        scope = scope.upper;
      }
    };

    /**
     * Whether a path the source spells out starts in the checkout: a relative string, which
     * resolves against cwd, `import.meta.dirname`, `__dirname`, `process.cwd()`, or a
     * `join`/`resolve` that starts with one. Anything else, such as os.tmpdir(), is left alone.
     */
    const inCheckout = (node: unknown, depth = 0): boolean =>
      Option.exists(unwrapExpression(node), (expression) => {
        switch (expression.type) {
          case "Literal":
            return typeof expression.value === "string" && !ABSOLUTE_PATH.test(expression.value);
          case "TemplateLiteral": {
            const head = expression.quasis[0]?.value.cooked ?? "";
            return head !== "" && !ABSOLUTE_PATH.test(head);
          }
          case "Identifier":
            if (expression.name === "__dirname") return true;
            return (
              depth < MAX_ALIAS_DEPTH &&
              Option.exists(constInitializer(expression), (init) => inCheckout(init, depth + 1))
            );
          case "MemberExpression":
            return isImportMetaDirname(expression);
          case "CallExpression":
            if (isProcessCwd(expression)) return true;
            return (
              Option.exists(calleeName(expression.callee), (name) =>
                ["join", "resolve"].includes(name),
              ) && inCheckout(expression.arguments[0], depth)
            );
          default:
            return false;
        }
      });

    const directoryOption = (options: unknown) =>
      Option.flatMap(unwrapExpression(options), (expression) => {
        if (expression.type !== "ObjectExpression") return Option.none();
        for (const property of expression.properties) {
          if (
            property.type === "Property" &&
            Option.contains(getPropertyName(property.key), "directory")
          ) {
            return Option.some(property.value);
          }
        }
        return Option.none();
      });

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const reported =
          ((Option.contains(name, "mkdtemp") || Option.contains(name, "mkdtempSync")) &&
            inCheckout(node.arguments[0])) ||
          ((Option.contains(name, "makeTempDirectory") ||
            Option.contains(name, "makeTempDirectoryScoped")) &&
            Option.exists(directoryOption(node.arguments[0]), (directory) =>
              inCheckout(directory),
            ));
        if (reported) context.report({ node, message: MESSAGE });
      },
    };
  },
});
