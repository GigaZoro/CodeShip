import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  'Test server listens on all interfaces, so another program\'s 127.0.0.1 listener on the same port answers in its place. Pass host "127.0.0.1", the address its client dials.';

/** How far a chain of `const` aliases is followed before the value counts as unknown. */
const MAX_ALIAS_DEPTH = 4;

/** What a `listen` argument is; "unknown" when the source cannot tell, which is never reported. */
type ArgumentKind = "port" | "text" | "function" | "options" | "unknown";

const kindOf = (node: Option.Option<ESTree.Node>): ArgumentKind => {
  if (Option.isNone(node)) return "unknown";
  const value = node.value;
  switch (value.type) {
    case "Literal":
      if (typeof value.value === "number") return "port";
      return typeof value.value === "string" ? "text" : "unknown";
    case "TemplateLiteral":
      return "text";
    case "ObjectExpression":
      return "options";
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration":
      return "function";
    default:
      return "unknown";
  }
};

/** Port options that name no address: `{ port }` without `host`, `path` or a spread that may carry one. */
const isPortWithoutHost = (node: Option.Option<ESTree.Node>) =>
  Option.exists(node, (expression) => {
    if (expression.type !== "ObjectExpression") return false;
    const keys = new Set<string>();
    for (const property of expression.properties) {
      if (property.type !== "Property") return false;
      Option.map(getPropertyName(property.key), (key) => keys.add(key));
    }
    return keys.has("port") && !keys.has("host") && !keys.has("path");
  });

const memberName = (node: unknown) =>
  Option.flatMap(unwrapExpression(node), (callee) =>
    callee.type === "MemberExpression" ? getPropertyName(callee.property) : Option.none(),
  );

const isWebSocketServer = (node: unknown) =>
  Option.exists(unwrapExpression(node), (callee) =>
    callee.type === "Identifier"
      ? callee.name === "WebSocketServer"
      : Option.contains(memberName(callee), "WebSocketServer"),
  );

const isNodeHttpServerLayer = (node: unknown) =>
  Option.exists(
    unwrapExpression(node),
    (callee) =>
      callee.type === "MemberExpression" &&
      isIdentifier(unwrapExpression(callee.object), "NodeHttpServer") &&
      Option.contains(getPropertyName(callee.property), "layer"),
  );

/** `fn` is the executor of `new Promise(fn)`, whose parameters are `resolve` and `reject`. */
const isPromiseExecutor = (fn: ESTree.Node) =>
  "parent" in fn &&
  fn.parent?.type === "NewExpression" &&
  isIdentifier(unwrapExpression(fn.parent.callee), "Promise") &&
  fn.parent.arguments[0] === fn;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow test servers that listen on a port without a host, which another program can shadow on 127.0.0.1.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const variableOf = (identifier: ESTree.Node & { readonly name: string }) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined || scope.upper === null) return variable;
        scope = scope.upper;
      }
    };

    /**
     * The value an argument stands for: a `const` is followed to its initializer, a function
     * name to its declaration, and a `new Promise` executor's `resolve` or `reject` to the
     * executor, which is as much a function as they are.
     */
    const valueOf = (node: unknown, depth = 0): Option.Option<ESTree.Node> =>
      Option.flatMap(unwrapExpression(node), (expression) => {
        if (expression.type !== "Identifier" || depth >= MAX_ALIAS_DEPTH) {
          return Option.some(expression);
        }
        const defs = variableOf(expression)?.defs ?? [];
        const def = defs.length === 1 ? defs[0] : undefined;
        if (def === undefined) return Option.some(expression);
        if (def.type === "FunctionName") return Option.some(def.node);
        if (def.type === "Parameter" && isPromiseExecutor(def.node)) return Option.some(def.node);
        if (
          def.type === "Variable" &&
          def.node.type === "VariableDeclarator" &&
          def.node.id.type === "Identifier" &&
          def.parent?.type === "VariableDeclaration" &&
          def.parent.kind === "const" &&
          def.node.init !== null
        ) {
          return valueOf(def.node.init, depth + 1);
        }
        return Option.some(expression);
      });

    /**
     * `server.listen(port)`, `server.listen(port, callback)` or `server.listen({ port })`: a port
     * with no address. A bare `listen()` is left alone: servers such as Vite's take their address
     * when they are made. A first argument the source cannot tell from a socket path is too.
     */
    const listensOnEveryInterface = (args: ReadonlyArray<unknown>) => {
      const first = valueOf(args[0]);
      switch (kindOf(first)) {
        case "options":
          return isPortWithoutHost(first);
        case "port":
          return args.length === 1 || kindOf(valueOf(args[1])) === "function";
        default:
          return false;
      }
    };

    return {
      CallExpression(node) {
        const listens =
          (Option.contains(memberName(node.callee), "listen") &&
            listensOnEveryInterface(node.arguments)) ||
          (isNodeHttpServerLayer(node.callee) && isPortWithoutHost(valueOf(node.arguments[1])));
        if (listens) context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        if (isWebSocketServer(node.callee) && isPortWithoutHost(valueOf(node.arguments[0]))) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
