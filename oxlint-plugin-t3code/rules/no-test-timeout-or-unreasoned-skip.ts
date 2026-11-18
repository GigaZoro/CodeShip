import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import {
  isIdentifier,
  resolveConstAliases,
  resolveConstValue,
  resolvePropertyName,
  unwrapExpression,
} from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
// Opt-in suites that drive real provider agents through whole turns; minutes are the
// expected cost there, not a hidden wait.
const LIVE_TEST_FILE_PATTERN = /\.live\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_FUNCTIONS = new Set(["describe", "it", "suite", "test"]);
const HOOK_FUNCTIONS = new Set(["afterAll", "afterEach", "beforeAll", "beforeEach"]);
const FOCUS_OR_SKIP_MODIFIERS = new Set(["only", "skip", "todo"]);
const FOCUS_OR_SKIP_FUNCTIONS = new Set(["fdescribe", "fit", "xdescribe", "xit", "xtest"]);
const TIMEOUT_OPTIONS = new Set(["retry", "timeout"]);
const SET_CONFIG_OPTIONS = new Set(["hookTimeout", "retry", "testTimeout"]);
const QUARANTINE_PATTERN =
  /quarantine:\s*#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/u;

const TIMEOUT_MESSAGE =
  "Per-test timeouts and retries hide waits that should be event-driven; the project timeout is the ceiling. Remove the override and await the milestone.";
const SKIP_MESSAGE =
  "A skipped test needs a tracking issue in the comment above it: `// quarantine: #1234 <why>`.";

// Walks `it.effect.each(cases)` / `describe.skipIf(x)` / `it.layer(L)` down to the
// identifier that registers the test.
const chainRoot = (node: unknown): Option.Option<string> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return Option.none();
  const value = expression.value;
  if (value.type === "Identifier") return Option.some(value.name);
  if (value.type === "MemberExpression") return chainRoot(value.object);
  if (value.type === "CallExpression") return chainRoot(value.callee);
  return Option.none();
};

const isTestChain = (node: unknown) =>
  Option.exists(chainRoot(node), (name) => TEST_FUNCTIONS.has(name));

/** How far spreads and conditional branches inside one another are followed; options deeper count as unknown. */
const MAX_DEPTH = 4;

/**
 * What the options leave of one option: whether some run sets it, to anything, and whether every run leaves it
 * literally `true`. The rule reports only what it can see, so an option it cannot tell is not set and not `true`.
 */
type OptionState = { readonly set: boolean; readonly on: boolean };

const UNSET: OptionState = { set: false, on: false };

/** Either of two runs may happen: the option is set if either sets it, and `true` only if both leave it so. */
const either = (first: OptionState, second: OptionState): OptionState => ({
  set: first.set || second.set,
  on: first.on && second.on,
});

/** A change the rule cannot read, such as a spread of an object it cannot see, may leave the option as anything. */
const unknownChange = (state: OptionState): OptionState => ({ set: state.set, on: false });

/** Whether a value is truthy and whether it is nullish. */
type Truth = { readonly truthy: boolean; readonly nullish: boolean };

const TRUTHY: Option.Option<Truth> = Option.some({ truthy: true, nullish: false });

/** The truth of a value that is one of two, where both have the same one. */
const sameTruth = (first: Option.Option<Truth>, second: Option.Option<Truth>) =>
  Option.isSome(first) &&
  Option.isSome(second) &&
  first.value.truthy === second.value.truthy &&
  first.value.nullish === second.value.nullish
    ? first
    : Option.none<Truth>();

/** `a && b` is `b` when `a` is truthy, `a || b` when `a` is falsy and `a ?? b` when `a` is nullish; otherwise `a`. */
const takesRight = (operator: ESTree.LogicalExpression["operator"], left: Truth) =>
  operator === "&&" ? left.truthy : operator === "||" ? !left.truthy : left.nullish;

/** The operands whose value a condition or logical expression takes on some run: the one `truthOf` shows every run takes, or both. */
const operandsTaken = (
  expression: ESTree.ConditionalExpression | ESTree.LogicalExpression,
  truthOf: (node: ESTree.Expression) => Option.Option<Truth>,
): ReadonlyArray<ESTree.Expression> => {
  if (expression.type === "ConditionalExpression") {
    const { test, consequent, alternate } = expression;
    return Option.match(truthOf(test), {
      onNone: () => [consequent, alternate],
      onSome: ({ truthy }) => [truthy ? consequent : alternate],
    });
  }
  const { left, operator, right } = expression;
  return Option.match(truthOf(left), {
    onNone: () => [left, right],
    onSome: (known) => [takesRight(operator, known) ? right : left],
  });
};

const NUMBER_UNARY_OPERATORS = new Set(["-", "+", "~"]);
// `+` joins strings too, so a sum is a number only when both of its sides may be.
const NUMBER_BINARY_OPERATORS = new Set([
  "-",
  "*",
  "/",
  "%",
  "**",
  "<<",
  ">>",
  ">>>",
  "&",
  "|",
  "^",
]);

const enclosingStatement = (node: ESTree.Node): ESTree.Node => {
  let current: ESTree.Node = node;
  while (current.parent && !/(?:Statement|Declaration)$/u.test(current.type)) {
    current = current.parent;
  }
  return current;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow per-test timeouts and retries, and require a tracking issue for skipped or focused tests.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    const checkTimeouts = !LIVE_TEST_FILE_PATTERN.test(context.filename);

    // `const options = { timeout: 30_000 }` passed by name, or spread into another object, is the
    // same override as the literal.
    const valueOf = (node: unknown) => resolveConstAliases(context.sourceCode, node);

    const isTrue = (node: unknown) =>
      Option.exists(
        valueOf(node),
        (expression) => expression.type === "Literal" && expression.value === true,
      );

    /**
     * Whether a value is truthy and whether it is nullish, where the source tells: through a branch the source shows a
     * run takes, and where every branch a run may take agrees.
     */
    const knownTruth = (node: unknown, depth = 0): Option.Option<Truth> => {
      if (depth > MAX_DEPTH) return Option.none();
      const truth = (child: unknown) => knownTruth(child, depth + 1);
      // A change through a name, as in `options.skip = false`, leaves an object an object.
      const value = resolveConstValue(context.sourceCode, node).value;
      const expression = Option.getOrUndefined(value);
      switch (expression?.type) {
        case "ArrayExpression":
        case "ArrowFunctionExpression":
        case "ClassExpression":
        case "FunctionExpression":
        case "ObjectExpression":
          return TRUTHY;
        case "Literal": {
          if (expression.raw === "null") return Option.some({ truthy: false, nullish: true });
          const literal = expression.value;
          return typeof literal === "boolean" ||
            typeof literal === "number" ||
            typeof literal === "string"
            ? Option.some({ truthy: Boolean(literal), nullish: false })
            : Option.none();
        }
        case "ConditionalExpression":
        case "LogicalExpression":
          return operandsTaken(expression, truth)
            .map((operand) =>
              // The `a` of `a || b` is the value only when it is truthy.
              expression.type === "LogicalExpression" &&
              expression.operator === "||" &&
              operand === expression.left
                ? TRUTHY
                : truth(operand),
            )
            .reduce(sameTruth);
      }
      return isIdentifier(value, "undefined")
        ? Option.some({ truthy: false, nullish: true })
        : Option.none();
    };

    /**
     * Whether some run may pass a number, as a time limit is passed: `5_000`, `60 * 1_000`, a const holding one, or
     * `slow ? 5_000 : undefined`.
     */
    const mayBeNumber = (node: unknown, depth = 0): boolean => {
      if (depth > MAX_DEPTH) return false;
      const number = (child: unknown) => mayBeNumber(child, depth + 1);
      const expression = Option.getOrUndefined(valueOf(node));
      switch (expression?.type) {
        case "Literal":
          return typeof expression.value === "number";
        case "UnaryExpression":
          return NUMBER_UNARY_OPERATORS.has(expression.operator);
        case "BinaryExpression":
          return expression.operator === "+"
            ? number(expression.left) && number(expression.right)
            : NUMBER_BINARY_OPERATORS.has(expression.operator);
        case "ConditionalExpression":
        case "LogicalExpression":
          return operandsTaken(expression, (operand) => knownTruth(operand)).some(number);
        default:
          return false;
      }
    };

    /**
     * What `node`, as a test's options or spread over options that leave the option `name` at `before`, leaves of it.
     * A branch the source shows a run never takes, as in `options || { timeout }` with `options` an object, counts
     * for nothing.
     */
    const optionAfter = (
      node: unknown,
      name: string,
      before: OptionState,
      depth = 0,
    ): OptionState => {
      if (depth > MAX_DEPTH) return unknownChange(before);
      const after = (child: unknown, from: OptionState = before) =>
        optionAfter(child, name, from, depth + 1);
      const { value, writes } = resolveConstValue(context.sourceCode, node);
      const expression = Option.getOrUndefined(value);
      let state: OptionState;
      switch (expression?.type) {
        case "ObjectExpression":
          state = expression.properties.reduce((current, property) => {
            if (property.type !== "Property") return after(property.argument, current);
            const key = resolvePropertyName(context.sourceCode, property.key);
            if (Option.isNone(key)) return property.computed ? unknownChange(current) : current;
            return key.value === name ? { set: true, on: isTrue(property.value) } : current;
          }, before);
          break;
        case "ConditionalExpression":
        case "LogicalExpression":
          state = operandsTaken(expression, (operand) => knownTruth(operand))
            .map((operand) =>
              // The `a` of `a && b` that is the value is falsy, which sets no option.
              expression.type === "LogicalExpression" &&
              expression.operator === "&&" &&
              operand === expression.left
                ? before
                : after(operand),
            )
            .reduce(either);
          break;
        case "Literal":
          state = before;
          break;
        case "ArrowFunctionExpression":
        case "FunctionExpression":
          // The test's body, not its options: neither it nor a change made through its name sets an option.
          return before;
        default:
          // `undefined` sets no option. Neither does a test argument that is no object, such as the test function,
          // while a spread of a value the rule cannot see may set any.
          state = isIdentifier(value, "undefined") ? before : unknownChange(before);
      }
      // A change made through the const's name, as in `options.skip = false`, may run before the test registers or
      // after it, so a run may or may not have it.
      return writes.reduce((current, write) => {
        switch (write._tag) {
          case "Assign":
            return either(
              current,
              write.sources.reduce((from, source) => after(source, from), current),
            );
          case "Delete":
            return Option.exists(write.key, (key) => key !== name)
              ? current
              : either(current, UNSET);
          case "Property":
            return Option.match(write.key, {
              onNone: () => unknownChange(current),
              onSome: (key) =>
                key === name
                  ? either(current, { set: true, on: Option.exists(write.value, isTrue) })
                  : current,
            });
        }
      }, state);
    };

    /** Whether an option in `names` is set, if only on some runs: an override on some runs is still one. */
    const hasOption = (node: unknown, names: ReadonlySet<string>) =>
      [...names].some((name) => optionAfter(node, name, UNSET).set);

    /** Whether an option in `names` is `true` on every run, as `test.skip` is. */
    const hasEnabledOption = (node: unknown, names: ReadonlySet<string>) =>
      [...names].some((name) => optionAfter(node, name, UNSET).on);

    const reportUnlessQuarantined = (node: ESTree.Node) => {
      const comments = context.sourceCode.getCommentsBefore(enclosingStatement(node));
      if (comments.some((comment) => QUARANTINE_PATTERN.test(comment.value))) return;
      context.report({ node, message: SKIP_MESSAGE });
    };

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;

        if (
          callee.value.type === "MemberExpression" &&
          Option.exists(chainRoot(callee.value.object), (name) => name === "vi") &&
          Option.contains(
            resolvePropertyName(context.sourceCode, callee.value.property),
            "setConfig",
          )
        ) {
          if (checkTimeouts && hasOption(node.arguments[0], SET_CONFIG_OPTIONS)) {
            context.report({ node, message: TIMEOUT_MESSAGE });
          }
          return;
        }

        if (callee.value.type === "Identifier" && HOOK_FUNCTIONS.has(callee.value.name)) {
          if (checkTimeouts && mayBeNumber(node.arguments[1])) {
            context.report({ node, message: TIMEOUT_MESSAGE });
          }
          return;
        }

        if (!isTestChain(callee.value)) return;
        const [, second, third] = node.arguments;
        // `test(name, { timeout }, fn)` is the options-first spelling of the same override.
        if (
          checkTimeouts &&
          (mayBeNumber(third) ||
            hasOption(third, TIMEOUT_OPTIONS) ||
            hasOption(second, TIMEOUT_OPTIONS))
        ) {
          context.report({ node, message: TIMEOUT_MESSAGE });
        }
        // `test(name, { skip: true }, fn)` is the options spelling of `test.skip`. A computed value
        // such as `{ skip: windowsHost }` is a platform gate, the same as `skipIf`, and stays allowed.
        if (
          hasEnabledOption(second, FOCUS_OR_SKIP_MODIFIERS) ||
          hasEnabledOption(third, FOCUS_OR_SKIP_MODIFIERS)
        ) {
          reportUnlessQuarantined(node);
        }
      },
      Identifier(node) {
        if (!FOCUS_OR_SKIP_FUNCTIONS.has(node.name)) return;
        const parent = node.parent;
        if (parent?.type !== "CallExpression" || parent.callee !== node) return;
        reportUnlessQuarantined(node);
      },
      MemberExpression(node) {
        // `it["skip"](...)`, or a key held in a const, is the same registration; only a dynamic key is unknowable here.
        if (
          !Option.exists(resolvePropertyName(context.sourceCode, node.property), (name) =>
            FOCUS_OR_SKIP_MODIFIERS.has(name),
          )
        ) {
          return;
        }
        if (!isTestChain(node.object)) return;
        reportUnlessQuarantined(node);
      },
    };
  },
});
