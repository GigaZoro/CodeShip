import {
  defineRule,
  type Definition,
  type ESTree,
  type Reference,
  type Scope,
  type SourceCode,
  type Variable,
} from "@oxlint/plugins";
import * as Option from "effect/Option";

import { isExpressionWrapper, isGlobal, resolvePropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const PLATFORM_NAMES = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);
const HOST_PLATFORM_MODULE = "@t3tools/shared/testing/hostPlatform";
const HOST_PROCESS_MODULE = "@t3tools/shared/HostProcess";
// Effects exported by HostProcess that answer which platform the host is.
const HOST_PROCESS_PLATFORM_PREDICATES = new Set(["isWindows"]);
const TEST_REGISTRARS = new Set(["describe", "it", "suite", "test"]);
// `Effect.gen` and `Effect.map` give what their function returns, and `pipe` what its last stage gives.
const LAST_ARGUMENT_GIVES_VALUE = new Set(["gen", "map", "pipe"]);
// Calls whose outcome is that of the effect they wrap, given first, curried or as a pipe stage, so a
// return there ends the body. A call that sequences, such as `Effect.andThen`, runs more after it.
const BODY_WRAPPERS = new Set([
  "annotateLogs",
  "asVoid",
  "ensuring",
  "orDie",
  "provide",
  "provideService",
  "scoped",
  "timeout",
  "uninterruptible",
  "withSpan",
]);
// A type of the same name shares a value's variable but gives it no value.
const TYPE_DECLARATIONS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"]);
// Deeper nesting of expressions and aliases counts as no check, so a generated file cannot exhaust
// the stack.
const MAX_DEPTH = 200;

const MESSAGE =
  "Early return on the host platform makes the test report a pass it never earned. Use `it.skipIf(...)`/`it.runIf(...)` (or a gated `describe`) so the run reports a skip; `isWindowsHost` is in `@t3tools/shared/testing/hostPlatform`.";

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

const isFunction = (node: ESTree.Node): node is FunctionNode =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression";

const unwrap = (node: ESTree.Node): ESTree.Node =>
  Option.getOrElse(unwrapExpression(node), () => node);

const isPlatformLiteral = (node: ESTree.Node): boolean => {
  const value = unwrap(node);
  return (
    value.type === "Literal" && typeof value.value === "string" && PLATFORM_NAMES.has(value.value)
  );
};

const isBareReturn = (node: ESTree.Node): boolean =>
  (node.type === "ReturnStatement" && node.argument === null) ||
  (node.type === "BlockStatement" && node.body.length === 1 && isBareReturn(node.body[0]!));

const propertyName = (sourceCode: SourceCode, key: ESTree.Node): string | undefined =>
  Option.getOrUndefined(resolvePropertyName(sourceCode, key));

const calleeName = (sourceCode: SourceCode, callee: ESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  return callee.type === "MemberExpression" ? propertyName(sourceCode, callee.property) : undefined;
};

const enclosingFunction = (node: ESTree.Node): FunctionNode | undefined => {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current)) return current;
  }
  return undefined;
};

// A call applied to a subject later: a stage of `x.pipe(...)` or `pipe(subject, ...)`, or a curried
// call such as `Effect.ensuring(finalizer)(body)`.
const isPartialApplication = (sourceCode: SourceCode, call: ESTree.Node): boolean => {
  const outer = call.parent;
  if (outer?.type !== "CallExpression") return false;
  if (outer.callee === call) return true;
  if (calleeName(sourceCode, outer.callee) !== "pipe") return false;
  const index = outer.arguments.findIndex((argument) => argument === call);
  return index > 0 || (index === 0 && outer.callee.type === "MemberExpression");
};

const isBodyWrapper = (sourceCode: SourceCode, callee: ESTree.Node): boolean =>
  BODY_WRAPPERS.has(calleeName(sourceCode, callee) ?? "");

// A pipe stage such as `Effect.provide(layer)` or `Effect.scoped`.
const keepsOutcome = (sourceCode: SourceCode, stage: ESTree.Node): boolean => {
  const node = unwrap(stage);
  return isBodyWrapper(sourceCode, node.type === "CallExpression" ? node.callee : node);
};

// The call whose outcome is that of `subject`: a body wrapper given it first or curried, or a pipe
// whose every stage keeps the outcome.
const callWrapping = (sourceCode: SourceCode, subject: ESTree.Node): ESTree.Node | undefined => {
  const keeps = (stage: ESTree.Node) => keepsOutcome(sourceCode, stage);
  const { parent } = subject;
  if (parent?.type === "MemberExpression" && parent.object === subject) {
    const call = parent.parent;
    return calleeName(sourceCode, parent) === "pipe" &&
      call?.type === "CallExpression" &&
      call.callee === parent &&
      call.arguments.every(keeps)
      ? call
      : undefined;
  }
  if (parent?.type !== "CallExpression" || parent.arguments[0] !== subject) return undefined;
  const { callee } = parent;
  if (calleeName(sourceCode, callee) === "pipe") {
    return callee.type === "Identifier" && parent.arguments.slice(1).every(keeps)
      ? parent
      : undefined;
  }
  if (callee.type === "CallExpression") {
    return isBodyWrapper(sourceCode, callee.callee) ? parent : undefined;
  }
  return isBodyWrapper(sourceCode, callee) && !isPartialApplication(sourceCode, parent)
    ? parent
    : undefined;
};

// The function whose result is `expression`, through the calls that keep its outcome and expression
// wrappers. Any other call argument, such as a finalizer or an iteration callback, does not give
// its call its value.
const functionReturning = (
  sourceCode: SourceCode,
  expression: ESTree.Node,
): FunctionNode | undefined => {
  let current: ESTree.Node | undefined = expression;
  while (current) {
    const parent: ESTree.Node["parent"] = current.parent;
    if (parent?.type === "ArrowFunctionExpression") {
      return parent.body === current ? parent : undefined;
    }
    if (parent?.type === "ReturnStatement") return enclosingFunction(parent);
    current = parent && isExpressionWrapper(parent) ? parent : callWrapping(sourceCode, current);
  }
  return undefined;
};

// A function's own return statements, not those of functions nested in it.
const ownReturns = (body: ESTree.FunctionBody): ESTree.ReturnStatement[] => {
  const returns: ESTree.ReturnStatement[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const candidate = node as ESTree.Node;
    if (isFunction(candidate)) return;
    if (candidate.type === "ReturnStatement") {
      returns.push(candidate);
      return;
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (key !== "parent") visit(value);
    }
  };
  body.body.forEach(visit);
  return returns;
};

// The value each read of a property gets: the last one written, unless a spread or a computed key
// after it may replace it.
const indexProperties = (
  sourceCode: SourceCode,
  object: ESTree.ObjectExpression,
): Map<string, ESTree.Node> => {
  const values = new Map<string, ESTree.Node>();
  for (const property of object.properties) {
    const key =
      property.type === "SpreadElement" ? undefined : propertyName(sourceCode, property.key);
    if (key === undefined) values.clear();
    else if (property.type === "Property") values.set(key, property.value);
  }
  return values;
};

// A destructuring default applies when the property is missing or holds `undefined`.
const isUndefinedValue = (sourceCode: SourceCode, node: ESTree.Node | undefined): boolean => {
  if (node === undefined) return true;
  const value = unwrap(node);
  return (
    isGlobal(sourceCode, value, "undefined") ||
    (value.type === "UnaryExpression" && value.operator === "void")
  );
};

const runtimeImportSource = (def: Definition): string | undefined => {
  if (def.type !== "ImportBinding" || def.parent?.type !== "ImportDeclaration") return undefined;
  if (def.parent.importKind === "type") return undefined;
  if (def.node.type === "ImportSpecifier" && def.node.importKind === "type") return undefined;
  return def.parent.source.value;
};

const onlyDefinition = (variable: Variable | null | undefined): Definition | undefined => {
  const defs = variable?.defs.filter((def) => !TYPE_DECLARATIONS.has(def.node.type));
  return defs?.length === 1 ? defs[0] : undefined;
};

const isUnwritten = (variable: Variable): boolean =>
  variable.references.every((reference) => reference.init || !reference.isWrite());

// Whether `node` is what the expression or pattern around it writes.
const isWriteTarget = (node: ESTree.Node): boolean => {
  const { parent } = node;
  switch (parent?.type) {
    case "AssignmentExpression":
    case "AssignmentPattern":
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    case "ArrayPattern":
    case "RestElement":
    case "UpdateExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "Property":
      return parent.parent?.type === "ObjectPattern" && parent.value === node;
    default:
      return false;
  }
};

// Whether some reference writes into the object the binding holds, such as `state.skip = false`.
const writesIntoObject = (variable: Variable): boolean =>
  variable.references.some((reference) => {
    let target: ESTree.Node = reference.identifier;
    let throughMember = false;
    for (let parent = target.parent; parent; target = parent, parent = parent.parent) {
      if (parent.type === "MemberExpression" && parent.object === target) throughMember = true;
      else if (!isExpressionWrapper(parent)) break;
    }
    return throughMember && isWriteTarget(target);
  });

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `if (platform === ...) return;` in a test or suite body, including a helper or local that gives the comparison, the shared host flags and the HostProcess platform predicates; skip the test with it.skipIf/it.runIf instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    const { sourceCode } = context;

    // The reference a read makes, which a type of the same name cannot shadow.
    const referencesByScope = new Map<Scope, Map<ESTree.Node, Reference>>();
    const referenceOf = (identifier: ESTree.Node): Reference | undefined => {
      const scope = sourceCode.getScope(identifier);
      let references = referencesByScope.get(scope);
      if (references === undefined) {
        references = new Map(
          scope.references.map((reference) => [reference.identifier, reference] as const),
        );
        referencesByScope.set(scope, references);
      }
      return references.get(identifier);
    };

    // The binding a read gets, unless the read runs before its declaration in the same function.
    const bindingRead = (identifier: ESTree.Node): Variable | undefined => {
      const reference = referenceOf(identifier);
      const variable = reference?.resolved;
      if (!reference || !variable) return undefined;
      const def = onlyDefinition(variable);
      const readsBeforeDeclaration =
        def?.type === "Variable" &&
        reference.from.variableScope === variable.scope.variableScope &&
        identifier.start < def.node.start;
      return readsBeforeDeclaration ? undefined : variable;
    };

    // A registrar counts by the name it was exported as, so `import { it as effectIt }` and
    // `vitest.it` register.
    const isTestRegistrar = (callee: ESTree.Node): boolean => {
      let root = callee;
      let member: ESTree.MemberExpression | undefined;
      while (root.type === "MemberExpression" || root.type === "CallExpression") {
        if (root.type === "MemberExpression") member = root;
        root = root.type === "MemberExpression" ? root.object : root.callee;
      }
      if (root.type !== "Identifier") return false;
      const def = onlyDefinition(referenceOf(root)?.resolved);
      let name: string | undefined = root.name;
      if (def?.node.type === "ImportSpecifier") name = propertyName(sourceCode, def.node.imported);
      else if (def?.node.type === "ImportNamespaceSpecifier") {
        name = member?.object === root ? propertyName(sourceCode, member.property) : undefined;
      }
      return name !== undefined && TEST_REGISTRARS.has(name);
    };

    const isRegistrarArgument = (node: ESTree.Node): boolean => {
      const call = node.parent;
      return (
        call?.type === "CallExpression" &&
        call.arguments.some((argument) => argument === node) &&
        isTestRegistrar(call.callee)
      );
    };

    // The bindings that name `fn`: its declaration, or the variable it initializes.
    const bindingsNaming = (fn: FunctionNode): Variable[] => {
      if (fn.type === "FunctionDeclaration") {
        return sourceCode
          .getDeclaredVariables(fn)
          .filter((variable) => variable.defs.some((def) => def.type === "FunctionName"));
      }
      const declarator = fn.parent;
      return declarator?.type === "VariableDeclarator" && declarator.init === fn
        ? sourceCode.getDeclaredVariables(declarator)
        : [];
    };

    // Returning from a test or suite callback makes the run count what it skipped as passed; a
    // return from a hook, helper, finalizer or iteration callback ends only that callback.
    const endsTestBody = (fn: FunctionNode): boolean => {
      if (isRegistrarArgument(fn)) return true;
      const registeredByName = bindingsNaming(fn).some((variable) =>
        variable.references.some((reference) => isRegistrarArgument(reference.identifier)),
      );
      if (registeredByName) return true;
      const call = fn.parent;
      if (
        call?.type !== "CallExpression" ||
        calleeName(sourceCode, call.callee) !== "gen" ||
        !call.arguments.some((argument) => argument === fn)
      ) {
        return false;
      }
      const outer = functionReturning(sourceCode, call);
      return outer !== undefined && endsTestBody(outer);
    };

    // Each binding and property value is judged once per file; one being judged counts as no check,
    // so a cycle ends.
    const judged = new Map<Variable | ESTree.Node, boolean>();
    const following = new Set<Variable | ESTree.Node>();
    let depth = 0;
    const descend = <T>(next: () => T, tooDeep: T): T => {
      if (depth >= MAX_DEPTH) return tooDeep;
      depth += 1;
      try {
        return next();
      } finally {
        depth -= 1;
      }
    };
    const judge = (key: Variable | ESTree.Node, decide: () => boolean): boolean => {
      const known = judged.get(key);
      if (known !== undefined) return known;
      judged.set(key, false);
      const result = descend(decide, false);
      judged.set(key, result);
      return result;
    };
    const follow = <T>(key: Variable | ESTree.Node, next: () => T | undefined): T | undefined => {
      if (following.has(key)) return undefined;
      following.add(key);
      try {
        return descend(next, undefined);
      } finally {
        following.delete(key);
      }
    };

    // Whether nothing reassigns the binding or writes into the object it holds; scanned once each.
    const unmodified = new Map<Variable, boolean>();
    const isUnmodified = (variable: Variable): boolean => {
      let known = unmodified.get(variable);
      if (known === undefined) {
        known = isUnwritten(variable) && !writesIntoObject(variable);
        unmodified.set(variable, known);
      }
      return known;
    };

    // Each object literal's properties are indexed once, however many reads look into it.
    const propertyIndexes = new Map<ESTree.ObjectExpression, Map<string, ESTree.Node>>();
    const propertyValue = (
      object: ESTree.ObjectExpression,
      name: string,
    ): ESTree.Node | undefined => {
      let values = propertyIndexes.get(object);
      if (values === undefined) {
        values = indexProperties(sourceCode, object);
        propertyIndexes.set(object, values);
      }
      return values.get(name);
    };

    // The object literal an expression reads, through constants and nested properties no code writes.
    const objectLiteralOf = (input: ESTree.Node): ESTree.ObjectExpression | undefined => {
      const node = unwrap(input);
      if (node.type === "ObjectExpression") return node;
      if (node.type === "MemberExpression") {
        const name = propertyName(sourceCode, node.property);
        const parent = name === undefined ? undefined : objectLiteralOf(node.object);
        const value = parent && name !== undefined ? propertyValue(parent, name) : undefined;
        return value && follow(value, () => objectLiteralOf(value));
      }
      if (node.type !== "Identifier") return undefined;
      const variable = bindingRead(node);
      const def = onlyDefinition(variable);
      if (!variable || def?.node.type !== "VariableDeclarator") return undefined;
      const { id, init } = def.node;
      if (id.type !== "Identifier" || !init || !isUnmodified(variable)) return undefined;
      return follow(variable, () => objectLiteralOf(init));
    };

    // The value reading `name` from `object` gets, when the object is a literal that has it.
    const knownProperty = (object: ESTree.Node, name: string): ESTree.Node | undefined => {
      const literal = objectLiteralOf(object);
      return literal && propertyValue(literal, name);
    };

    // Whether reading the property `name` of `object` gives a platform check.
    const selectsPlatformCheck = (object: ESTree.Node, name: string): boolean => {
      const target = unwrap(object);
      if (target.type === "Identifier") {
        const def = onlyDefinition(referenceOf(target)?.resolved);
        if (def?.node.type === "ImportNamespaceSpecifier") {
          const source = runtimeImportSource(def);
          return (
            source === HOST_PLATFORM_MODULE ||
            (source === HOST_PROCESS_MODULE && HOST_PROCESS_PLATFORM_PREDICATES.has(name))
          );
        }
      }
      const value = knownProperty(target, name);
      return value !== undefined && judge(value, () => comparesPlatform(value));
    };

    // Whether a value `fn` returns depends on the platform.
    const returnsPlatformCheck = (fn: FunctionNode): boolean => {
      const { body } = fn;
      if (body === null) return false;
      if (body.type !== "BlockStatement") return comparesPlatform(body);
      return ownReturns(body).some(
        (statement) => statement.argument !== null && comparesPlatform(statement.argument),
      );
    };

    const definesPlatformCheck = (def: Definition): boolean => {
      switch (def.type) {
        case "ImportBinding": {
          const source = runtimeImportSource(def);
          if (source === HOST_PLATFORM_MODULE) return true;
          return (
            source === HOST_PROCESS_MODULE &&
            def.node.type === "ImportSpecifier" &&
            HOST_PROCESS_PLATFORM_PREDICATES.has(propertyName(sourceCode, def.node.imported) ?? "")
          );
        }
        case "FunctionName":
          return isFunction(def.node) && returnsPlatformCheck(def.node);
        case "Variable": {
          const declarator = def.node;
          if (declarator.type !== "VariableDeclarator" || declarator.init === null) return false;
          if (declarator.id.type === "Identifier") return comparesPlatform(declarator.init);
          if (declarator.id.type !== "ObjectPattern") return false;
          const init = declarator.init;
          return declarator.id.properties.some((property) => {
            if (property.type !== "Property") return false;
            const { value } = property;
            const binding = value.type === "AssignmentPattern" ? value.left : value;
            if (binding !== def.name) return false;
            const name = propertyName(sourceCode, property.key);
            if (name !== undefined && selectsPlatformCheck(init, name)) return true;
            return (
              value.type === "AssignmentPattern" &&
              (name === undefined || isUndefinedValue(sourceCode, knownProperty(init, name))) &&
              comparesPlatform(value.right)
            );
          });
        }
        default:
          return false;
      }
    };

    const isPlatformBinding = (variable: Variable): boolean =>
      judge(variable, () => {
        const def = onlyDefinition(variable);
        return def !== undefined && isUnwritten(variable) && definesPlatformCheck(def);
      });

    // A local function named like `Effect.map` or `pipe` is judged by what it returns instead.
    const givesLastArgument = (callee: ESTree.Node): boolean => {
      const name = calleeName(sourceCode, callee);
      if (name === undefined || !LAST_ARGUMENT_GIVES_VALUE.has(name)) return false;
      if (callee.type !== "Identifier") return true;
      const variable = referenceOf(callee)?.resolved;
      return (
        !variable ||
        variable.defs.every(
          (def) => def.type === "ImportBinding" || TYPE_DECLARATIONS.has(def.node.type),
        )
      );
    };

    // Whether the value of `input` depends on which platform the host is.
    const comparesPlatform = (input: ESTree.Node): boolean =>
      descend(() => valueComparesPlatform(unwrap(input)), false);

    const valueComparesPlatform = (node: ESTree.Node): boolean => {
      switch (node.type) {
        case "BinaryExpression":
          return (
            (EQUALITY_OPERATORS.has(node.operator) &&
              (isPlatformLiteral(node.left) || isPlatformLiteral(node.right))) ||
            comparesPlatform(node.left) ||
            comparesPlatform(node.right)
          );
        case "LogicalExpression":
          return comparesPlatform(node.left) || comparesPlatform(node.right);
        case "ConditionalExpression":
          return comparesPlatform(node.consequent) || comparesPlatform(node.alternate);
        case "UnaryExpression":
        case "AwaitExpression":
        case "YieldExpression":
          return node.argument !== null && comparesPlatform(node.argument);
        case "ArrowFunctionExpression":
        case "FunctionExpression":
          return returnsPlatformCheck(node);
        case "Identifier": {
          const variable = bindingRead(node);
          return variable !== undefined && isPlatformBinding(variable);
        }
        case "MemberExpression": {
          const name = propertyName(sourceCode, node.property);
          return name !== undefined && selectsPlatformCheck(node.object, name);
        }
        case "CallExpression": {
          if (!givesLastArgument(node.callee)) return comparesPlatform(node.callee);
          const last = node.arguments.at(-1);
          return last !== undefined && last.type !== "SpreadElement" && comparesPlatform(last);
        }
        default:
          return false;
      }
    };

    return {
      IfStatement(node) {
        if (node.alternate) return;
        if (!isBareReturn(node.consequent)) return;
        const body = enclosingFunction(node);
        if (!body || !endsTestBody(body)) return;
        if (!comparesPlatform(node.test)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
