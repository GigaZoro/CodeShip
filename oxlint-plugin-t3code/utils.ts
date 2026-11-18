import type { ESTree, Reference, Scope, SourceCode, Variable } from "@oxlint/plugins";
import * as Option from "effect/Option";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion;

type AstNode = ESTree.Node;

const asAstNode = (node: unknown): Option.Option<AstNode> =>
  typeof node === "object" && node !== null && "type" in node && typeof node.type === "string"
    ? Option.some(node as AstNode)
    : Option.none();

const isExpressionWrapper = (node: AstNode): node is ExpressionWrapper =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "TSTypeAssertion";

export function unwrapExpression(node: unknown): Option.Option<AstNode> {
  let current = asAstNode(node);

  while (Option.isSome(current) && isExpressionWrapper(current.value)) {
    current = asAstNode(current.value.expression);
  }

  return current;
}

/** `a[b]` and `{ [b]: v }` read the variable `b`: an identifier in brackets names no property. */
const isBracketedKey = (node: AstNode): boolean => {
  const parent: unknown = node.parent;
  return (
    typeof parent === "object" &&
    parent !== null &&
    "computed" in parent &&
    parent.computed === true &&
    (("key" in parent && parent.key === node) || ("property" in parent && parent.property === node))
  );
};

/** The string a literal holds: `"b"`, or `` `b` `` with nothing substituted into it. */
const stringLiteralValue = (node: AstNode): Option.Option<string> => {
  if (node.type === "Literal" && typeof node.value === "string") return Option.some(node.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return Option.fromNullishOr(node.quasis[0]?.value.cooked);
  }
  return Option.none();
};

/**
 * The property a key or member names: an identifier written as one, or a string, bracketed or not. A rule that can
 * read scopes resolves a bracketed variable with `resolvePropertyName`.
 */
export function getPropertyName(node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (expression) => {
    if (expression.type === "Identifier" && typeof expression.name === "string") {
      return isBracketedKey(expression) ? Option.none() : Option.some(expression.name);
    }
    if (expression.type === "PrivateIdentifier" && typeof expression.name === "string") {
      return Option.some(expression.name);
    }
    return stringLiteralValue(expression);
  });
}

export function isIdentifier(node: Option.Option<AstNode>, name?: string): boolean {
  if (Option.isNone(node)) return false;
  const expression = node.value;
  return (
    expression.type === "Identifier" &&
    typeof expression.name === "string" &&
    (name === undefined || expression.name === name)
  );
}

/** The variable `name` stands for from `scope`: the one the nearest enclosing scope declares. */
export function findVariable(scope: Scope, name: string): Variable | undefined {
  for (let current: Scope | null = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable;
  }
  return undefined;
}

/**
 * A change the program makes, through a const's name, to the object the const holds. `Property` is `name.key = value`
 * or `name[key]++`: `key` is none where the source cannot tell which, and `value` is what a plain assignment sets, none
 * for any other change. `Delete` is `delete name.key`, which leaves the property unset. `Assign` is
 * `Object.assign(name, ...sources)`.
 */
export type ConstWrite =
  | {
      readonly _tag: "Property";
      readonly key: Option.Option<string>;
      readonly value: Option.Option<AstNode>;
    }
  | { readonly _tag: "Delete"; readonly key: Option.Option<string> }
  | { readonly _tag: "Assign"; readonly sources: ReadonlyArray<AstNode> };

/** A change the source cannot read, which may set any property to anything. */
const UNREADABLE_WRITE: ConstWrite = {
  _tag: "Property",
  key: Option.none(),
  value: Option.none(),
};

/** The outermost of the parentheses, `as`, `satisfies` and `!` around `node`: `(name as T).key` uses `name`. */
const outermostWrapper = (node: AstNode): AstNode => {
  let current = node;
  while (
    current.parent !== null &&
    current.parent !== undefined &&
    isExpressionWrapper(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
};

const isObjectAssign = (sourceCode: SourceCode, callee: AstNode): boolean =>
  callee.type === "MemberExpression" &&
  isIdentifier(unwrapExpression(callee.object), "Object") &&
  Option.contains(resolvePropertyName(sourceCode, callee.property), "assign");

/** The change `reference` makes to the object its name holds, if it makes one. */
const writeThrough = (
  sourceCode: SourceCode,
  { identifier }: Reference,
): Option.Option<ConstWrite> => {
  const target = outermostWrapper(identifier);
  const use = target.parent;
  if (use?.type === "CallExpression") {
    return use.arguments[0] === target && isObjectAssign(sourceCode, use.callee)
      ? Option.some({ _tag: "Assign", sources: use.arguments.slice(1) })
      : Option.none();
  }
  if (use?.type !== "MemberExpression" || use.object !== target) return Option.none();
  const member = outermostWrapper(use);
  const write = member.parent;
  // A read such as `name[key]` needs no key, and reading one can lead back here, as in `key[key] = 1`.
  const key = () => resolvePropertyName(sourceCode, use.property);
  if (write?.type === "AssignmentExpression" && write.left === member) {
    const value = write.operator === "=" ? Option.some(write.right) : Option.none();
    return Option.some({ _tag: "Property", key: key(), value });
  }
  if (write?.type === "UpdateExpression" && write.argument === member) {
    return Option.some({ _tag: "Property", key: key(), value: Option.none() });
  }
  return write?.type === "UnaryExpression" &&
    write.operator === "delete" &&
    write.argument === member
    ? Option.some({ _tag: "Delete", key: key() })
    : Option.none();
};

/** `const name = value`, whose one name every use reads the same value through. */
const isConstDeclarator = (node: AstNode | null | undefined): node is ESTree.VariableDeclarator =>
  node?.type === "VariableDeclarator" &&
  node.id.type === "Identifier" &&
  node.parent?.type === "VariableDeclaration" &&
  node.parent.kind === "const";

/** The variable `node` names when it is declared once as `const name = value`, which every use of the name stands for. */
function declaredConst(
  sourceCode: SourceCode,
  node: AstNode,
): Option.Option<{ readonly variable: Variable; readonly value: AstNode }> {
  if (node.type !== "Identifier") return Option.none();
  const variable = findVariable(sourceCode.getScope(node), node.name);
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  return variable !== undefined &&
    def?.type === "Variable" &&
    isConstDeclarator(def.node) &&
    def.node.init !== null
    ? Option.some({ variable, value: def.node.init })
    : Option.none();
}

/** The variable a reference declares as `const alias = name`, which holds the object `name` holds. */
const aliasDeclaredBy = (
  sourceCode: SourceCode,
  { identifier }: Reference,
): Variable | undefined => {
  const target = outermostWrapper(identifier);
  const declarator = target.parent;
  return isConstDeclarator(declarator) && declarator.init === target
    ? sourceCode.getDeclaredVariables(declarator)[0]
    : undefined;
};

/** How far a chain of `const` aliases is followed before the value counts as unknown. */
const MAX_ALIAS_DEPTH = 4;

/** The variables whose changes are being read: a key read meanwhile through one of them, as in `name[name] = 1`. */
const readingWrites = new Set<Variable>();

/**
 * The changes the program makes to the object `variable` holds, through its name and through every `const` alias of
 * it, `const alias = name`, which holds the same object. An alias too deep to follow, or a key read through the
 * object while its changes are read, is a change the source cannot read.
 */
function writesThrough(
  sourceCode: SourceCode,
  variable: Variable,
  depth = 0,
): ReadonlyArray<ConstWrite> {
  if (depth >= MAX_ALIAS_DEPTH || readingWrites.has(variable)) return [UNREADABLE_WRITE];
  readingWrites.add(variable);
  try {
    return variable.references.flatMap((reference) => {
      const alias = aliasDeclaredBy(sourceCode, reference);
      return alias === undefined
        ? Option.toArray(writeThrough(sourceCode, reference))
        : writesThrough(sourceCode, alias, depth + 1);
    });
  } finally {
    readingWrites.delete(variable);
  }
}

/**
 * What an expression stands for once `const` aliases are followed, with every change the program makes to that object
 * through any of its names.
 */
export function resolveConstValue(
  sourceCode: SourceCode,
  node: unknown,
): { readonly value: Option.Option<AstNode>; readonly writes: ReadonlyArray<ConstWrite> } {
  let current = unwrapExpression(node);
  // The last const followed declares the object, and every name followed on the way is an alias of it.
  let holder: Variable | undefined;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    const declared = Option.flatMap(current, (expression) => declaredConst(sourceCode, expression));
    if (Option.isNone(declared)) break;
    holder = declared.value.variable;
    current = unwrapExpression(declared.value.value);
  }
  return { value: current, writes: holder === undefined ? [] : writesThrough(sourceCode, holder) };
}

/**
 * What an expression stands for once `const` aliases are followed: `options` after
 * `const options = { timeout: 1 }` is the object. Anything else is the expression itself, and so is a name whose
 * object the program changes, as in `options.skip = false`: `resolveConstValue` gives such a value with its changes.
 */
export function resolveConstAliases(sourceCode: SourceCode, node: unknown): Option.Option<AstNode> {
  const { value, writes } = resolveConstValue(sourceCode, node);
  return writes.length > 0 ? unwrapExpression(node) : value;
}

/**
 * The property a key or member names, with a bracketed key read through the `const` it holds: `a[key]` after
 * `const key = "b"` names `b`. None where the source cannot tell, which for a bracketed key means it may name any.
 */
export function resolvePropertyName(sourceCode: SourceCode, node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (key) =>
    isBracketedKey(key)
      ? Option.flatMap(resolveConstAliases(sourceCode, key), stringLiteralValue)
      : getPropertyName(key),
  );
}
