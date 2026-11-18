import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import {
  type ConstWrite,
  findVariable,
  isIdentifier,
  resolveConstValue,
  resolvePropertyName,
  unwrapExpression,
} from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  'Test server listens on all interfaces, so another program\'s 127.0.0.1 listener on the same port answers in its place. Pass host "127.0.0.1", the address its client dials.';

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

/** An argument's value, with the changes the program makes to it through the `const` names that hold it. */
type ArgumentValue = {
  readonly value: Option.Option<ESTree.Node>;
  readonly writes: ReadonlyArray<ConstWrite>;
};

const ADDRESS_KEYS = new Set(["host", "path"]);

/** A change that may give the options an address: `options.host = ...`, a key the source cannot read, or `Object.assign`. */
const mayAddAddress = (write: ConstWrite) =>
  write._tag === "Assign" ||
  (write._tag === "Property" && !Option.exists(write.key, (key) => !ADDRESS_KEYS.has(key)));

/**
 * Port options that name no address on some run: `{ port }` without `host`, `path`, a spread or bracketed key the
 * source cannot read, which may carry one, or a change through the options' name that may add one. A port set, or an
 * address deleted, through the name counts, since the change may run before the server listens.
 */
const isPortWithoutHost = (sourceCode: SourceCode, { value, writes }: ArgumentValue) =>
  Option.exists(value, (expression) => {
    if (expression.type !== "ObjectExpression" || writes.some(mayAddAddress)) return false;
    const keys = new Set<string>();
    for (const property of expression.properties) {
      if (property.type !== "Property") return false;
      const key = resolvePropertyName(sourceCode, property.key);
      if (Option.isNone(key) && property.computed) return false;
      Option.map(key, (name) => keys.add(name));
    }
    const changed = (tag: ConstWrite["_tag"], key: string) =>
      writes.some(
        (write) => write._tag !== "Assign" && write._tag === tag && Option.contains(write.key, key),
      );
    return (
      (keys.has("port") || changed("Property", "port")) &&
      ![...ADDRESS_KEYS].some((key) => keys.has(key) && !changed("Delete", key))
    );
  });

const memberName = (sourceCode: SourceCode, node: unknown) =>
  Option.flatMap(unwrapExpression(node), (callee) =>
    callee.type === "MemberExpression"
      ? resolvePropertyName(sourceCode, callee.property)
      : Option.none(),
  );

const isWebSocketServer = (sourceCode: SourceCode, node: unknown) =>
  Option.exists(unwrapExpression(node), (callee) =>
    callee.type === "Identifier"
      ? callee.name === "WebSocketServer"
      : Option.contains(memberName(sourceCode, callee), "WebSocketServer"),
  );

const isNodeHttpServerLayer = (sourceCode: SourceCode, node: unknown) =>
  Option.exists(
    unwrapExpression(node),
    (callee) =>
      callee.type === "MemberExpression" &&
      isIdentifier(unwrapExpression(callee.object), "NodeHttpServer") &&
      Option.contains(resolvePropertyName(sourceCode, callee.property), "layer"),
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
    const sourceCode = context.sourceCode;

    /**
     * The value an argument stands for: a `const` is followed to its initializer, a function
     * name to its declaration, and a `new Promise` executor's `resolve` or `reject` to the
     * executor, which is as much a function as they are.
     */
    const valueOf = (node: unknown): ArgumentValue => {
      const { value, writes } = resolveConstValue(sourceCode, node);
      return {
        value: Option.map(value, (expression) => {
          if (expression.type !== "Identifier") return expression;
          const defs = findVariable(sourceCode.getScope(expression), expression.name)?.defs ?? [];
          const def = defs.length === 1 ? defs[0] : undefined;
          if (def?.type === "FunctionName") return def.node;
          if (def?.type === "Parameter" && isPromiseExecutor(def.node)) return def.node;
          return expression;
        }),
        writes,
      };
    };

    /**
     * `server.listen(port)`, `server.listen(port, callback)` or `server.listen({ port })`: a port
     * with no address. A bare `listen()` is left alone: servers such as Vite's take their address
     * when they are made. A first argument the source cannot tell from a socket path is too.
     */
    const listensOnEveryInterface = (args: ReadonlyArray<unknown>) => {
      const first = valueOf(args[0]);
      switch (kindOf(first.value)) {
        case "options":
          return isPortWithoutHost(sourceCode, first);
        case "port":
          return args.length === 1 || kindOf(valueOf(args[1]).value) === "function";
        default:
          return false;
      }
    };

    return {
      CallExpression(node) {
        const listens =
          (Option.contains(memberName(sourceCode, node.callee), "listen") &&
            listensOnEveryInterface(node.arguments)) ||
          (isNodeHttpServerLayer(sourceCode, node.callee) &&
            isPortWithoutHost(sourceCode, valueOf(node.arguments[1])));
        if (listens) context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        if (
          isWebSocketServer(sourceCode, node.callee) &&
          isPortWithoutHost(sourceCode, valueOf(node.arguments[0]))
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
