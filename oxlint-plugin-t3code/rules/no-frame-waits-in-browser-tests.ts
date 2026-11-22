import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { isIdentifier, resolvePropertyName, unwrapExpression } from "../utils.ts";

const BROWSER_TEST_FILE_PATTERN = /\.browser\.test\.[cm]?[jt]sx?$/u;
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window"]);
const TIMER_FUNCTIONS = new Set(["setInterval", "setTimeout"]);
const TRANSITION_EVENTS = new Set(["animationend", "transitionend"]);
const MOCK_FACTORIES = new Set(["fn", "spyOn", "stubGlobal"]);
const MOCK_IMPLEMENTATIONS = new Set(["mockImplementation", "mockImplementationOnce"]);
const USE_FAKE_TIMERS = new Set(["useFakeTimers"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

const MESSAGE =
  "Frame and transition waits race the renderer. Assert with `expect.element`/`vi.waitFor` (auto-retry), or install `fakeTimers()` (full set) and advance the timer the component sets.";

/** Name of a bare global (`requestAnimationFrame`) or one read off `window`/`globalThis`/`self`. */
const globalName = (sourceCode: SourceCode, node: unknown): Option.Option<string> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return Option.none();
  if (expression.value.type === "Identifier") return Option.some(expression.value.name);
  if (expression.value.type !== "MemberExpression") return Option.none();
  const object = unwrapExpression(expression.value.object);
  if (Option.isNone(object) || object.value.type !== "Identifier") return Option.none();
  if (!GLOBAL_OBJECTS.has(object.value.name)) return Option.none();
  return resolvePropertyName(sourceCode, expression.value.property);
};

const isViCall = (sourceCode: SourceCode, callee: unknown, names: ReadonlySet<string>): boolean => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  const property = resolvePropertyName(sourceCode, expression.value.property);
  return (
    isIdentifier(unwrapExpression(expression.value.object), "vi") &&
    Option.isSome(property) &&
    names.has(property.value)
  );
};

const isMockingCall = (sourceCode: SourceCode, node: ESTree.CallExpression): boolean => {
  if (isViCall(sourceCode, node.callee, MOCK_FACTORIES)) return true;
  const callee = unwrapExpression(node.callee);
  if (isIdentifier(callee, "stubGlobal")) return true;
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;
  const property = resolvePropertyName(sourceCode, callee.value.property);
  return Option.isSome(property) && MOCK_IMPLEMENTATIONS.has(property.value);
};

const EXECUTOR_WAITS = new Set(["requestAnimationFrame", "setTimeout", "setInterval"]);

const isPromiseConstructor = (node: ESTree.Node | null | undefined): node is ESTree.NewExpression =>
  node?.type === "NewExpression" && isIdentifier(unwrapExpression(node.callee), "Promise");

// A frame call inside a mock is the fake's implementation, not the test waiting on a frame.
const isInsideMock = (sourceCode: SourceCode, node: ESTree.Node): boolean => {
  let child: ESTree.Node = node;
  let current = node.parent;
  while (current) {
    if (
      current.type === "CallExpression" &&
      current.callee !== child &&
      isMockingCall(sourceCode, current)
    ) {
      return true;
    }
    child = current;
    current = current.parent;
  }
  return false;
};

const isInsidePromiseExecutor = (node: ESTree.Node): boolean => {
  let current = node.parent;
  while (current) {
    if (
      FUNCTIONS.has(current.type) &&
      isPromiseConstructor(current.parent) &&
      current.parent.arguments[0] === current
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const hasToFakeOption = (sourceCode: SourceCode, argument: unknown): boolean => {
  const expression = unwrapExpression(argument);
  if (Option.isNone(expression) || expression.value.type !== "ObjectExpression") return false;
  return expression.value.properties.some((property) => {
    if (property.type !== "Property") return false;
    const key = resolvePropertyName(sourceCode, property.key);
    return Option.isSome(key) && key.value === "toFake";
  });
};

const isTransitionEventListener = (
  sourceCode: SourceCode,
  node: ESTree.CallExpression,
): boolean => {
  const callee = unwrapExpression(node.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;
  const method = resolvePropertyName(sourceCode, callee.value.property);
  if (Option.isNone(method) || method.value !== "addEventListener") return false;
  const eventName = unwrapExpression(node.arguments[0]);
  return (
    Option.isSome(eventName) &&
    eventName.value.type === "Literal" &&
    typeof eventName.value.value === "string" &&
    TRANSITION_EVENTS.has(eventName.value.value)
  );
};

const isFrameOrTimerWait = (sourceCode: SourceCode, node: ESTree.CallExpression): boolean => {
  const name = globalName(sourceCode, node.callee);
  if (Option.isNone(name)) return false;
  if (name.value === "requestAnimationFrame") return !isInsideMock(sourceCode, node);
  if (TIMER_FUNCTIONS.has(name.value)) return isInsidePromiseExecutor(node);
  if (name.value === "fakeTimers") return hasToFakeOption(sourceCode, node.arguments[0]);
  return false;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow waiting on animation frames, transitions, or real timers in browser tests, and partial fake-timer sets.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    if (!BROWSER_TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      NewExpression(node) {
        if (!isPromiseConstructor(node) || isInsideMock(sourceCode, node)) return;
        const executor = node.arguments[0];
        // `new Promise(setTimeout)` resolves on the next macrotask; `new Promise(requestAnimationFrame)`
        // on the next frame. Both are the same wait with the function passed straight through.
        const name = globalName(sourceCode, executor);
        if (executor && Option.isSome(name) && EXECUTOR_WAITS.has(name.value)) {
          context.report({ node: executor, message: MESSAGE });
        }
      },
      CallExpression(node) {
        if (
          isFrameOrTimerWait(sourceCode, node) ||
          isViCall(sourceCode, node.callee, USE_FAKE_TIMERS) ||
          isTransitionEventListener(sourceCode, node)
        ) {
          context.report({ node: node.callee, message: MESSAGE });
        }
      },
    };
  },
});
