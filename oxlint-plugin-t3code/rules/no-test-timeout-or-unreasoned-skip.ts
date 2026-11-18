import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import {
  ANY_KIND,
  applyWrites,
  type ConstWrite,
  isGlobal,
  isObjectAssign,
  operandsTaken,
  overwrittenKinds,
  resolveConstAliases,
  resolveConstValue,
  resolvePropertyName,
  sharingReadBudget,
  TRUTHY,
  unwrapExpression,
  valueKinds,
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

const isFunctionValue = (node: ESTree.Node) =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration";

const isTestChain = (node: unknown) =>
  Option.exists(chainRoot(node), (name) => TEST_FUNCTIONS.has(name));

/** How far spreads and conditional branches inside one another are followed; options deeper count as unknown. */
const MAX_DEPTH = 4;

/**
 * What an object holds of one option across the runs: whether some run may hold a value the source shows, whether some
 * run may lack it, the kinds of value the runs that hold it may hold, and whether some run holds it through a getter or
 * setter. The rule reports only what it can see: an option of an object it cannot see is no value shown, of any kind.
 */
type OptionState = {
  readonly present: boolean;
  readonly absent: boolean;
  readonly kinds: number;
  readonly accessor: boolean;
};

/** Every run lacks the option. */
const UNSET: OptionState = { present: false, absent: true, kinds: 0, accessor: false };

/** Every run holds the option, truthy: `test.skip` as an option. */
const isEnabled = (state: OptionState) => !state.absent && state.kinds === TRUTHY;

/** Either of two runs may happen. */
const either = (first: OptionState, second: OptionState): OptionState => ({
  present: first.present || second.present,
  absent: first.absent || second.absent,
  kinds: first.kinds | second.kinds,
  accessor: first.accessor || second.accessor,
});

/** A change the rule cannot read, such as a spread of an object it cannot see, may leave the option as anything. */
const unknownChange = (state: OptionState): OptionState => ({ ...state, kinds: ANY_KIND });

const UNKNOWN = unknownChange(UNSET);

/** Every run holds the option, with a value of `kinds`. */
const holding = (kinds: number): OptionState => ({
  present: true,
  absent: false,
  kinds,
  accessor: false,
});

/** A getter or setter: the option's value is whatever the getter returns when the test reads it. */
const ACCESSOR: OptionState = { present: true, absent: false, kinds: ANY_KIND, accessor: true };

/** What setting the option to `next` leaves of `current`: on a run that holds a getter, its setter runs instead. */
const setting = (current: OptionState, next: OptionState) =>
  current.accessor ? either(current, next) : next;

/** What a spread of `source` leaves on `target`: the source's option, read through any getter, where it has one. */
const copyOver = (target: OptionState, source: OptionState): OptionState =>
  source.absent
    ? {
        present: source.present || target.present,
        absent: target.absent,
        kinds: source.kinds | target.kinds,
        accessor: target.accessor,
      }
    : { ...source, accessor: false };

/**
 * What `name.key &&= value`, `||=` or `??=` leaves of the option `current` holds, `written` on a run it writes: it
 * writes over the kinds of value `overwrittenKinds` gives and keeps the others. A run that lacks the option reads
 * `undefined`, which all but `&&=` write over.
 */
const logicallyAssigned = (
  current: OptionState,
  operator: ESTree.LogicalExpression["operator"],
  written: OptionState,
): OptionState => {
  const over = overwrittenKinds(operator);
  const kept = current.kinds & ~over;
  const writes = (current.kinds & over) !== 0 || (current.absent && operator !== "&&");
  return {
    present: (kept !== 0 && current.present) || (writes && written.present),
    absent: current.absent && operator === "&&",
    kinds: kept | (writes ? written.kinds : 0),
    accessor: false,
  };
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
const NUMBER_FUNCTIONS = new Set(["Number", "parseFloat", "parseInt"]);
const NUMBER_PARSERS = new Set(["parseFloat", "parseInt"]);

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

    /** `Number(text)`, `parseInt(text)`, `Number.parseFloat(text)` or a `Math` function, which give a number. */
    const returnsNumber = (callee: unknown) =>
      Option.exists(unwrapExpression(callee), (fn) => {
        if (fn.type === "Identifier") {
          return NUMBER_FUNCTIONS.has(fn.name) && isGlobal(context.sourceCode, fn, fn.name);
        }
        return (
          fn.type === "MemberExpression" &&
          Option.exists(
            unwrapExpression(fn.object),
            (object) =>
              isGlobal(context.sourceCode, object, "Math") ||
              (isGlobal(context.sourceCode, object, "Number") &&
                Option.exists(resolvePropertyName(context.sourceCode, fn.property), (name) =>
                  NUMBER_PARSERS.has(name),
                )),
          )
        );
      });

    /**
     * Whether some run may pass a number, as a time limit is passed: `5_000`, `60 * 1_000`, `Number(text)`, a const
     * holding one, or `slow ? 5_000 : undefined`.
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
          return operandsTaken(context.sourceCode, expression).some(number);
        case "CallExpression":
          return returnsNumber(expression.callee);
        default:
          return false;
      }
    };

    /**
     * A function, `Object.assign` onto one, which returns it, or a condition whose every value a run may take is one:
     * passed to a test, its body and never its options.
     */
    const isTestBody = (node: unknown, depth = 0): boolean =>
      depth <= MAX_DEPTH &&
      Option.exists(resolveConstValue(context.sourceCode, node).value, (expression) => {
        switch (expression.type) {
          case "CallExpression":
            return (
              isObjectAssign(context.sourceCode, expression.callee) &&
              isTestBody(expression.arguments[0], depth + 1)
            );
          case "ConditionalExpression":
          case "LogicalExpression":
            return operandsTaken(context.sourceCode, expression).every((operand) =>
              isTestBody(operand, depth + 1),
            );
          default:
            return isFunctionValue(expression);
        }
      });

    /**
     * What `node`, as a test's argument (`toTest`) or an object copied into its options, holds of the option `name`. A
     * branch the source shows a run never takes, as in `options || { timeout }` with `options` an object, counts for
     * nothing, and a test's body holds no options, whatever changes through its name give it.
     */
    const optionOf = (node: unknown, name: string, toTest: boolean, depth = 0): OptionState => {
      if (depth > MAX_DEPTH) return UNKNOWN;
      if (toTest && isTestBody(node)) return UNSET;
      const of = (child: unknown, asToTest = false) => optionOf(child, name, asToTest, depth + 1);
      // A spread or `Object.assign` source copies what its object holds after that object's own changes, which change
      // no other object; `Object.assign` sets each option, through a setter where the target has one.
      const copy = (into: OptionState, source: unknown) => copyOver(into, of(source));
      const assign = (into: OptionState, source: unknown) => setting(into, copy(into, source));
      const { value, writes } = resolveConstValue(context.sourceCode, node);
      const expression = Option.getOrUndefined(value);
      let state: OptionState;
      switch (expression?.type) {
        case "ObjectExpression":
          state = expression.properties.reduce((current, property) => {
            if (property.type !== "Property") return copy(current, property.argument);
            const key = resolvePropertyName(context.sourceCode, property.key);
            if (Option.isNone(key)) return property.computed ? unknownChange(current) : current;
            if (key.value !== name) return current;
            return property.kind === "init"
              ? holding(valueKinds(context.sourceCode, property.value))
              : ACCESSOR;
          }, UNSET);
          break;
        case "CallExpression": {
          // `Object.assign(target, ...sources)` gives its target with each source's options assigned over in turn.
          const [target, ...sources] = expression.arguments;
          state = isObjectAssign(context.sourceCode, expression.callee)
            ? sources.reduce(assign, of(target, toTest))
            : UNKNOWN;
          break;
        }
        case "ConditionalExpression":
        case "LogicalExpression":
          state = operandsTaken(context.sourceCode, expression)
            .map((operand) =>
              // The `a` of `a && b` that is the value is falsy, which holds no option.
              expression.type === "LogicalExpression" &&
              expression.operator === "&&" &&
              operand === expression.left
                ? UNSET
                : of(operand, toTest),
            )
            .reduce(either);
          break;
        case "Literal":
          state = UNSET;
          break;
        case "ArrowFunctionExpression":
        case "FunctionDeclaration":
        case "FunctionExpression":
          // A function holds only the options changes through its name give it, which a spread of it copies.
          state = UNSET;
          break;
        default:
          // `undefined` holds no option, while a value the rule cannot see may hold any.
          state = Option.exists(value, (shown) => isGlobal(context.sourceCode, shown, "undefined"))
            ? UNSET
            : UNKNOWN;
      }
      const change = (current: OptionState, write: ConstWrite): OptionState => {
        switch (write._tag) {
          case "Assign":
            return write.sources.reduce(assign, current);
          case "Delete":
            return Option.match(write.key, {
              onNone: () => either(current, UNSET),
              onSome: (key) => (key === name ? UNSET : current),
            });
          case "Property": {
            if (Option.isNone(write.key)) return unknownChange(current);
            if (write.key.value !== name) return current;
            const written = holding(
              Option.match(write.value, {
                onNone: () => ANY_KIND,
                onSome: (value) => valueKinds(context.sourceCode, value),
              }),
            );
            return setting(
              current,
              Option.match(write.logical, {
                onNone: () => written,
                onSome: (operator) => logicallyAssigned(current, operator, written),
              }),
            );
          }
        }
      };
      // A change made through the const's name, as in `options.skip = false`, replaces what the options held, in the
      // order the changes run, on the runs that make it before the test registers.
      return applyWrites(writes, state, change, either);
    };

    /**
     * Whether an option in `names` is set, if only on some runs: an override on some runs is still one. A function
     * passed to a test (`toTest`) is its body, while `vi.setConfig` reads options from any object, a function too.
     * Each source a change copies is resolved afresh, its own changes copying sources in turn, so the whole evaluation
     * shares one budget of reads, past which a change counts as one the rule cannot read.
     */
    const hasOption = (node: unknown, names: ReadonlySet<string>, toTest: boolean) =>
      sharingReadBudget(() => [...names].some((name) => optionOf(node, name, toTest).present));

    /** Whether an option in `names` is truthy on every run, as `test.skip` is, read within one budget as above. */
    const hasEnabledOption = (node: unknown, names: ReadonlySet<string>) =>
      sharingReadBudget(() => [...names].some((name) => isEnabled(optionOf(node, name, true))));

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
          if (checkTimeouts && hasOption(node.arguments[0], SET_CONFIG_OPTIONS, false)) {
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
        const [, second, third, fourth] = node.arguments;
        // `it.prop(name, arbitraries, fn, limit)` takes its time limit or options fourth: its second argument maps
        // names to arbitraries, not options. Other tests take them third, or second as `test(name, { timeout }, fn)`.
        const isProperty =
          callee.value.type === "MemberExpression" &&
          Option.contains(resolvePropertyName(context.sourceCode, callee.value.property), "prop");
        const limit = isProperty ? fourth : third;
        const options = isProperty ? [fourth] : [second, third];
        if (
          checkTimeouts &&
          (mayBeNumber(limit) ||
            options.some((argument) => hasOption(argument, TIMEOUT_OPTIONS, true)))
        ) {
          context.report({ node, message: TIMEOUT_MESSAGE });
        }
        // `test(name, { skip: true }, fn)` is the options spelling of `test.skip`. A computed value
        // such as `{ skip: windowsHost }` is a platform gate, the same as `skipIf`, and stays allowed.
        if (options.some((argument) => hasEnabledOption(argument, FOCUS_OR_SKIP_MODIFIERS))) {
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
