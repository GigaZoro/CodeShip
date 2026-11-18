import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import {
  ANY_KIND,
  applyWrites,
  type ConstWrite,
  findVariable,
  isIdentifier,
  NULLISH,
  operandsTaken,
  overwrittenKinds,
  resolveConstValue,
  resolvePropertyName,
  TRUTHY,
  unwrapExpression,
  valueKinds,
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

/**
 * The keys Node's `listen(options)` reads to choose where it listens. A socket path is none: Node listens on the port
 * when the options name one, and on every interface when they name no host, whatever path they give.
 */
const LISTEN_KEYS = ["port", "host", "fd", "handle", "_handle"] as const;
type ListenKey = (typeof LISTEN_KEYS)[number];

/** Node listens on a handle or descriptor the options give ahead of their port; `ws` reads neither. */
const DESCRIPTOR_KEYS: ReadonlyArray<ListenKey> = ["fd", "handle", "_handle"];

const isListenKey = (key: string): key is ListenKey =>
  (LISTEN_KEYS as ReadonlyArray<string>).includes(key);

/**
 * What a key may hold on a run, as bits: the kinds of value (`TRUTHY`, `FALSY`, `NULLISH`) it may hold that Node does
 * not listen through, and, `USED` bits up, those it does. A key the options lack holds `undefined`.
 */
type Held = number;

const USED = 3;
const ABSENT: Held = NULLISH;
const ANYTHING: Held = ANY_KIND | (ANY_KIND << USED);

const mayBeUsed = (held: Held) => held >> USED !== 0;

/** What each listen key may hold on one run. */
type Keys = Readonly<Record<ListenKey, Held>>;

const NO_KEYS: Keys = { port: ABSENT, host: ABSENT, fd: ABSENT, handle: ABSENT, _handle: ABSENT };

/** The runs the changes through the options' name may leave, one entry for each distinct `Keys`. */
type Reachable = ReadonlyMap<string, Keys>;

const reachable = (runs: Iterable<Keys>): Reachable =>
  new Map([...runs].map((keys) => [LISTEN_KEYS.map((key) => keys[key]).join(), keys]));

const eitherReachable = (first: Reachable, second: Reachable): Reachable =>
  reachable([...first.values(), ...second.values()]);

/** The primitive a literal shows, a signed number included, through `const` names; none for any other value. */
const shownPrimitive = (sourceCode: SourceCode, node: unknown): Option.Option<unknown> => {
  const shown = Option.getOrUndefined(resolveConstValue(sourceCode, node).value);
  if (shown?.type === "Literal") return Option.some(shown.value);
  if (shown?.type !== "UnaryExpression" || (shown.operator !== "-" && shown.operator !== "+")) {
    return Option.none();
  }
  const sign = shown.operator === "-" ? -1 : 1;
  return Option.flatMap(shownPrimitive(sourceCode, shown.argument), (value) =>
    typeof value === "number" ? Option.some(sign * value) : Option.none(),
  );
};

/**
 * The kinds of `node`'s value Node listens through as `key`: any port, a host or handle that is truthy, and an fd that
 * is a number of at least 0, 0 among them. An fd the source does not show may be any value that is not nullish.
 */
const usedKinds = (sourceCode: SourceCode, key: ListenKey, node: ESTree.Node, kinds: number) => {
  switch (key) {
    case "port":
      return kinds;
    case "fd":
      return Option.match(shownPrimitive(sourceCode, node), {
        onNone: () => kinds & ~NULLISH,
        onSome: (value) => (typeof value === "number" && value >= 0 ? kinds : 0),
      });
    default:
      return kinds & TRUTHY;
  }
};

/** What giving `key` a value leaves it holding: anything for a getter's or `+=`'s, which the source does not show. */
const heldBy = (sourceCode: SourceCode, key: ListenKey, value: Option.Option<ESTree.Node>): Held =>
  Option.match(value, {
    onNone: () => ANYTHING,
    onSome: (node) => {
      const kinds = valueKinds(sourceCode, node);
      const used = usedKinds(sourceCode, key, node, kinds);
      return (kinds & ~used) | (used << USED);
    },
  });

/** One key a literal or a change gives a value: none for a getter's or `+=`'s, which the source does not show. */
type KeyValue = { readonly key: string; readonly value: Option.Option<ESTree.Node> };

/** What giving keys values in order leaves of `keys`, the last value given winning. */
const giveKeys = (sourceCode: SourceCode, keys: Keys, values: ReadonlyArray<KeyValue>): Keys => {
  const given: Record<ListenKey, Held> = { ...keys };
  for (const { key, value } of values)
    if (isListenKey(key)) given[key] = heldBy(sourceCode, key, value);
  return given;
};

/** What `key &&= value`, `||=` or `??=` leaves of `held`: the kinds it writes over hold `given`, the others stay. */
const logicallyHeld = (
  held: Held,
  operator: ESTree.LogicalExpression["operator"],
  given: Held,
): Held => {
  const over = overwrittenKinds(operator);
  const overwritten = over | (over << USED);
  return (held & ~overwritten) | ((held & overwritten) !== 0 ? given : 0);
};

/** The keys an object literal gives values, in order; none when it may give any, through a spread or a bracketed key the source cannot read. */
const literalKeys = (
  sourceCode: SourceCode,
  expression: ESTree.ObjectExpression,
): Option.Option<ReadonlyArray<KeyValue>> => {
  const keys: Array<KeyValue> = [];
  for (const property of expression.properties) {
    if (property.type !== "Property") return Option.none();
    const key = resolvePropertyName(sourceCode, property.key);
    if (Option.isNone(key) && property.computed) return Option.none();
    const value = property.kind === "init" ? Option.some(property.value) : Option.none();
    Option.map(key, (name) => keys.push({ key: name, value }));
  }
  return Option.some(keys);
};

/**
 * The keys `Object.assign(options, ...sources)` copies onto the options; none when it may copy any, as every source
 * but a literal that no name changes may.
 */
const assignedKeys = (
  sourceCode: SourceCode,
  sources: ReadonlyArray<ESTree.Node>,
): Option.Option<ReadonlyArray<KeyValue>> =>
  Option.all(
    sources.map((source) => {
      const copied = resolveConstValue(sourceCode, source);
      return Option.flatMap(copied.value, (object) =>
        object.type === "ObjectExpression" && copied.writes.length === 0
          ? literalKeys(sourceCode, object)
          : Option.none(),
      );
    }),
  ).pipe(Option.map((keys) => keys.flat()));

/**
 * What one change through the options' name leaves of `keys`, on a run that makes it. A change whose key the source
 * cannot read may name the host, so it may give it anything, but not the port, which the rule reports only where the
 * source shows one.
 */
const changeKeys = (sourceCode: SourceCode, keys: Keys, write: ConstWrite): Keys => {
  const mayNameHost: Keys = { ...keys, host: ANYTHING };
  switch (write._tag) {
    case "Delete":
      // One whose key the source cannot read may delete any key or none, which shows no run lacks the host.
      return Option.match(write.key, {
        onNone: () => keys,
        onSome: (key) => (isListenKey(key) ? { ...keys, [key]: ABSENT } : keys),
      });
    case "Property":
      return Option.match(write.key, {
        onNone: () => mayNameHost,
        onSome: (key) => {
          if (!isListenKey(key)) return keys;
          const given = heldBy(sourceCode, key, write.value);
          const held = Option.match(write.logical, {
            onNone: () => given,
            onSome: (operator) => logicallyHeld(keys[key], operator, given),
          });
          return { ...keys, [key]: held };
        },
      });
    case "Assign":
      return Option.match(assignedKeys(sourceCode, write.sources), {
        onNone: () => mayNameHost,
        onSome: (given) => giveKeys(sourceCode, keys, given),
      });
  }
};

/**
 * Port options that name no host on some run: `{ port }` without a host Node may use, in the keys the changes through
 * the options' name may leave, in the order a run makes them, and, where Node reads them, with no handle or descriptor
 * it may use. A spread or bracketed key the source cannot read may carry the host, and so may a change whose key it
 * cannot read.
 */
const isPortWithoutHost = (
  sourceCode: SourceCode,
  { value, writes }: ArgumentValue,
  readsDescriptors: boolean,
) =>
  Option.exists(value, (expression) => {
    if (expression.type !== "ObjectExpression") return false;
    return Option.exists(literalKeys(sourceCode, expression), (own) => {
      const runs = applyWrites<Reachable>(
        writes,
        reachable([giveKeys(sourceCode, NO_KEYS, own)]),
        (current, write) =>
          reachable([...current.values()].map((keys) => changeKeys(sourceCode, keys, write))),
        eitherReachable,
      );
      const listensOnPort = (keys: Keys) =>
        mayBeUsed(keys.port) &&
        !mayBeUsed(keys.host) &&
        !(readsDescriptors && DESCRIPTOR_KEYS.some((key) => mayBeUsed(keys[key])));
      return [...runs.values()].some(listensOnPort);
    });
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

/** How far conditions and logical expressions inside one another are followed; a value deeper may be a host. */
const MAX_OPERAND_DEPTH = 4;

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
          if (def?.type === "Parameter" && isPromiseExecutor(def.node)) return def.node;
          return expression;
        }),
        writes,
      };
    };

    /**
     * Whether some run may give `node` a nonempty string, which Node takes for the host: a value the source does not
     * show may be one, and so may each operand a condition or logical expression may take, but the falsy left side
     * `a && b` takes.
     */
    const mayBeHost = (node: unknown, depth = 0): boolean => {
      const { value } = valueOf(node);
      const expression = Option.getOrUndefined(value);
      if (
        expression?.type === "ConditionalExpression" ||
        expression?.type === "LogicalExpression"
      ) {
        if (depth >= MAX_OPERAND_DEPTH) return true;
        return operandsTaken(sourceCode, expression).some(
          (operand) =>
            !(
              expression.type === "LogicalExpression" &&
              expression.operator === "&&" &&
              operand === expression.left
            ) && mayBeHost(operand, depth + 1),
        );
      }
      const kind = kindOf(value);
      return (
        (kind === "text" || kind === "unknown") && (valueKinds(sourceCode, node) & TRUTHY) !== 0
      );
    };

    /**
     * `server.listen(port)`, `server.listen(port, callback)` or `server.listen({ port })`: a port with no host, which
     * Node reads from a second argument only when it is a nonempty string. A bare `listen()` is left alone: servers
     * such as Vite's take their address when they are made. A first argument the source cannot tell from a socket path is too.
     */
    const listensOnEveryInterface = (args: ReadonlyArray<unknown>) => {
      const first = valueOf(args[0]);
      switch (kindOf(first.value)) {
        case "options":
          return isPortWithoutHost(sourceCode, first, true);
        case "port":
          return args.length === 1 || !mayBeHost(args[1]);
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
            isPortWithoutHost(sourceCode, valueOf(node.arguments[1]), true));
        if (listens) context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        // `ws` passes Node only the options' port and host, as `listen(port, host)`.
        if (
          isWebSocketServer(sourceCode, node.callee) &&
          isPortWithoutHost(sourceCode, valueOf(node.arguments[0]), false)
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
