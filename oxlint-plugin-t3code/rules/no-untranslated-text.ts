import { defineRule, type ESTree } from "@oxlint/plugins";

// Two letters in a row make a word; glyphs, numbers, and punctuation need no translation.
const WORD = /\p{L}{2}/u;

const JSX_TEXT_PROPS = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "cancelLabel",
  "confirmLabel",
  "description",
  "emptyMessage",
  "heading",
  "helperText",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "title",
  "tooltip",
]);

// Object fields that toasts, dialogs, menus, and option tables show as copy.
const OBJECT_TEXT_KEYS = new Set([
  ...JSX_TEXT_PROPS,
  "ariaLabel",
  "detail",
  "failureTitle",
  "successTitle",
]);

// Calls whose first argument is shown or spoken as is.
const TEXT_CALLS = new Set([
  "Alert.alert",
  "Dialog.alert",
  "alert",
  "announce",
  "confirm",
  "window.alert",
  "window.confirm",
]);

// Commands and queries whose `label` option only names them in console reports.
const LOGGED_LABEL_CALLS = new Set([
  "executeAtomQuery",
  "reportAtomCommandResult",
  "runAtomCommand",
  "useAtomCommand",
  "useOrchestrationCommand",
]);

// Names that read the same in every language. Text made only of these needs no translation.
const UNTRANSLATED_NAMES = new Set([
  "1Password",
  "ACP",
  "Android",
  "Antigravity",
  "Azure DevOps",
  "Bitbucket",
  "ChatGPT",
  "Claude",
  "Claude Code",
  "Clerk",
  "CodeShip",
  "T3.CodeShip",
  "Codex",
  "Cursor",
  "Expo",
  "Forgejo",
  "Git",
  "GitHub",
  "GitLab",
  "Grok",
  "JSON",
  "Linux",
  "MCP",
  "OpenCode",
  "SSH",
  "SnapShot",
  "T3",
  "T3 Connect",
  "Tailscale",
  "ThreadPage",
  "URL",
  "VS Code",
  "Windows",
  "iOS",
  "macOS",
]);

// Variables named for what they hold, such as `sidebarLabel` or `emptyTitle`.
const TEXT_VARIABLE = /(?:label|title|description|message|placeholder|tooltip)$/i;

// Outside JSX a string is copy when it reads like a phrase or a capitalized word, so
// identifiers such as "primary" or "codex" in option tables stay quiet.
const PHRASE = /\s|^\p{Lu}\p{Ll}/u;

const MESSAGE =
  'Translate UI text with t() from the app\'s i18n module, or msg() in a module-level table. Text that stays as written (a brand, code, a command) goes in a JSX expression: {"GitHub"}.';

function calleeName(callee: ESTree.Node): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.property.type === "Identifier"
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return undefined;
}

function propertyKey(node: {
  readonly computed: boolean;
  readonly key: ESTree.PropertyKey;
}): string | undefined {
  if (node.computed) return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return undefined;
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require user-facing text to go through the translator.",
    },
  },
  create(context) {
    const isCopy = (text: string | null | undefined, phraseOnly: boolean) => {
      const trimmed = text?.trim() ?? "";
      if (!WORD.test(trimmed) || UNTRANSLATED_NAMES.has(trimmed)) return false;
      return !phraseOnly || PHRASE.test(trimmed);
    };
    const report = (node: ESTree.Node) => context.report({ node, message: MESSAGE });

    // A plain string literal in a JSX expression is the opt-out; built-up and branching text is not.
    const checkExpression = (expression: ESTree.Node, phraseOnly: boolean) => {
      switch (expression.type) {
        case "TemplateLiteral":
          if (
            isCopy(expression.quasis.map((quasi) => quasi.value.cooked ?? "").join(" "), phraseOnly)
          ) {
            report(expression);
          }
          return;
        case "ConditionalExpression":
          checkBranch(expression.consequent, phraseOnly);
          checkBranch(expression.alternate, phraseOnly);
          return;
        case "LogicalExpression":
          checkBranch(expression.right, phraseOnly);
          return;
        default:
          return;
      }
    };
    const checkBranch = (branch: ESTree.Node, phraseOnly: boolean) => {
      if (branch.type === "Literal" && typeof branch.value === "string") {
        if (isCopy(branch.value, phraseOnly)) report(branch);
      } else {
        checkExpression(branch, phraseOnly);
      }
    };

    return {
      JSXText(node) {
        if (isCopy(node.value, false)) report(node);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !JSX_TEXT_PROPS.has(node.name.name)) return;
        const value = node.value;
        if (value?.type === "Literal" && typeof value.value === "string") {
          if (isCopy(value.value, false)) report(value);
        } else if (value?.type === "JSXExpressionContainer") {
          checkExpression(value.expression, false);
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent.type !== "JSXElement" && node.parent.type !== "JSXFragment") return;
        checkExpression(node.expression, false);
      },
      Property(node) {
        if (node.parent.type !== "ObjectExpression") return;
        const key = propertyKey(node);
        if (key === undefined || !OBJECT_TEXT_KEYS.has(key)) return;
        const call = node.parent.parent;
        if (
          key === "label" &&
          call.type === "CallExpression" &&
          LOGGED_LABEL_CALLS.has(calleeName(call.callee) ?? "")
        ) {
          return;
        }
        checkBranch(node.value, true);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init && TEXT_VARIABLE.test(node.id.name)) {
          checkBranch(node.init, true);
        }
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === undefined || !TEXT_CALLS.has(name)) return;
        const [first, second] = node.arguments;
        if (first) checkBranch(first, true);
        if (second && name === "Alert.alert") checkBranch(second, true);
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Notification") {
          const [first] = node.arguments;
          if (first) checkBranch(first, true);
        }
      },
    };
  },
});
