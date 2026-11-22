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

/** Whether `node` names the global `name`, not a variable the file declares under that name. */
export const isGlobal = (sourceCode: SourceCode, node: AstNode, name: string): boolean =>
  isIdentifier(Option.some(node), name) &&
  (findVariable(sourceCode.getScope(node), name)?.defs.length ?? 0) === 0;

type LogicalOperator = ESTree.LogicalExpression["operator"];

const LOGICAL_ASSIGNMENTS = new Map<string, LogicalOperator>([
  ["&&=", "&&"],
  ["||=", "||"],
  ["??=", "??"],
]);

/**
 * A change the program makes, through a const's name, to the object the const holds. `Property` is `name.key = value`,
 * `name.key ??= value` or `name[key]++`: `key` is none where the source cannot tell which, `value` none for `+=` or `++`,
 * and `logical` the operator of `&&=`, `||=` or `??=`, which writes only where the old value is truthy, falsy or nullish.
 * `Delete` is `delete name.key`, which leaves the property unset. `Assign` is `Object.assign(name, ...sources)`.
 */
type Change =
  | {
      readonly _tag: "Property";
      readonly key: Option.Option<string>;
      readonly value: Option.Option<AstNode>;
      readonly logical: Option.Option<LogicalOperator>;
    }
  | { readonly _tag: "Delete"; readonly key: Option.Option<string> }
  | { readonly _tag: "Assign"; readonly sources: ReadonlyArray<AstNode> };

/**
 * A change that may have been made by the time the program reads the object at one use of its name. `ordered`: in a
 * statement ahead of the use's with no function between, it runs in source order, and the nodes it is `within` tell
 * whether a run makes it. `anytime`: it may be made at any point before the use, or not at all, as a callback's is,
 * and so is one the source does not show the order of.
 */
export type ConstWrite = Change & {
  readonly made: "ordered" | "anytime";
  /** Outermost first, the nodes from the statement ahead of the use's down to the change; none for one made `anytime`. */
  readonly within: ReadonlyArray<AstNode>;
};

/** A change and the expression that makes it; none for one the source cannot read. */
type Write = { readonly change: Change; readonly node: Option.Option<AstNode> };

/** A change the source cannot read, which may set any property to anything. */
const UNREADABLE_WRITE: Write = {
  change: { _tag: "Property", key: Option.none(), value: Option.none(), logical: Option.none() },
  node: Option.none(),
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

/** The global `Object.assign`, which copies its sources' properties onto its first argument and returns it. */
export const isObjectAssign = (sourceCode: SourceCode, callee: AstNode): boolean =>
  callee.type === "MemberExpression" &&
  Option.exists(unwrapExpression(callee.object), (object) =>
    isGlobal(sourceCode, object, "Object"),
  ) &&
  Option.contains(resolvePropertyName(sourceCode, callee.property), "assign");

/** The change `reference` makes to the object its name holds, if it makes one. */
const writeThrough = (sourceCode: SourceCode, { identifier }: Reference): Option.Option<Write> => {
  const target = outermostWrapper(identifier);
  const use = target.parent;
  const made = (change: Change, node: AstNode) => Option.some({ change, node: Option.some(node) });
  if (use?.type === "CallExpression") {
    return use.arguments[0] === target && isObjectAssign(sourceCode, use.callee)
      ? made({ _tag: "Assign", sources: use.arguments.slice(1) }, use)
      : Option.none();
  }
  if (use?.type !== "MemberExpression" || use.object !== target) return Option.none();
  const member = outermostWrapper(use);
  const write = member.parent;
  // A read such as `name[key]` needs no key, and reading one can lead back here, as in `key[key] = 1`.
  const key = () => resolvePropertyName(sourceCode, use.property);
  if (write?.type === "AssignmentExpression" && write.left === member) {
    const logical = Option.fromNullishOr(LOGICAL_ASSIGNMENTS.get(write.operator));
    const value =
      write.operator === "=" || Option.isSome(logical) ? Option.some(write.right) : Option.none();
    return made({ _tag: "Property", key: key(), value, logical }, write);
  }
  if (write?.type === "UpdateExpression" && write.argument === member) {
    return made(
      { _tag: "Property", key: key(), value: Option.none(), logical: Option.none() },
      write,
    );
  }
  return write?.type === "UnaryExpression" &&
    write.operator === "delete" &&
    write.argument === member
    ? made({ _tag: "Delete", key: key() }, write)
    : Option.none();
};

/** The statements a list runs one after another, in order: a program's, a block's or a switch case's. */
const statementList = (node: AstNode): ReadonlyArray<AstNode> | undefined => {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
    case "StaticBlock":
      return node.body;
    case "SwitchCase":
      return node.consequent;
    default:
      return undefined;
  }
};

const statementIndexes = new WeakMap<ReadonlyArray<AstNode>, Map<AstNode, number>>();

/** Where `statement` stands in `statements`, or -1; the positions of a list are found once, as a file may hold thousands of changes. */
const indexInList = (statements: ReadonlyArray<AstNode>, statement: AstNode): number => {
  let indexes = statementIndexes.get(statements);
  if (indexes === undefined) {
    indexes = new Map(statements.map((each, index) => [each, index]));
    statementIndexes.set(statements, indexes);
  }
  return indexes.get(statement) ?? -1;
};

const isFunction = (node: AstNode) =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration";

/** Code that runs when something calls it, not where it stands: a function, or the value of an instance field. */
const isDeferred = (node: AstNode) =>
  isFunction(node) ||
  ((node.type === "PropertyDefinition" || node.type === "AccessorProperty") && !node.static);

const isLoop = (node: AstNode) =>
  node.type === "ForStatement" ||
  node.type === "ForInStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "WhileStatement" ||
  node.type === "DoWhileStatement";

/** `node` and the nodes it is in, innermost first, up to the one `stop` holds true of, which is left out. */
const enclosing = (node: AstNode, stop: (ancestor: AstNode) => boolean): Array<AstNode> => {
  const nodes: Array<AstNode> = [];
  for (let current: AstNode | null | undefined = node; current; current = current.parent) {
    if (stop(current)) break;
    nodes.push(current);
  }
  return nodes;
};

/** The function `node` runs in: the nearest function it is in, or the program. */
const runningFunction = (node: AstNode): AstNode => {
  let current = node;
  while (current.parent && !isFunction(current.parent)) current = current.parent;
  return current.parent ?? current;
};

/**
 * When a run makes a change relative to one use of the object: `after`, no run before it, or as `ConstWrite` says.
 * Only a statement ahead of the use's in one list runs first, unless the use is in a hoisted function declaration;
 * one after the use's runs later when both run, outside any loop, in the function that makes the object afresh each
 * run: the program, or the one that declares `holder`.
 */
const writeOrder = (
  write: AstNode,
  use: AstNode,
  holder: Variable,
): Pick<ConstWrite, "made" | "within"> | "after" => {
  const anytime = { made: "anytime", within: [] } as const;
  const useAncestors = new Set(enclosing(use, () => false));
  const writePath = enclosing(write, (node) => useAncestors.has(node));
  const writeStatement = writePath.at(-1);
  const list = writeStatement?.parent;
  const statements = list ? statementList(list) : undefined;
  if (writeStatement === undefined || !list || statements === undefined) {
    return anytime;
  }
  const usePath = enclosing(use, (node) => node === list);
  const useStatement = usePath.at(-1);
  const writeIndex = indexInList(statements, writeStatement);
  const useIndex = useStatement === undefined ? -1 : indexInList(statements, useStatement);
  if (writeIndex < 0 || useIndex < 0) return anytime;
  if (writeIndex < useIndex) {
    if (writePath.some(isDeferred) || usePath.some((node) => node.type === "FunctionDeclaration")) {
      return anytime;
    }
    return { made: "ordered", within: [...writePath].reverse() };
  }
  const running = runningFunction(list);
  const declared = holder.defs[0]?.node;
  return runningFunction(use) === running &&
    runningFunction(write) === running &&
    !enclosing(list, (node) => node === running).some(isLoop) &&
    (running.type === "Program" ||
      (declared !== undefined && runningFunction(declared) === running))
    ? "after"
    : anytime;
};

/** `const name = value`, whose one name every use reads the same value through. */
const isConstDeclarator = (node: AstNode | null | undefined): node is ESTree.VariableDeclarator =>
  node?.type === "VariableDeclarator" &&
  node.id.type === "Identifier" &&
  node.parent?.type === "VariableDeclaration" &&
  node.parent.kind === "const";

/**
 * The variable `node` names when every use of the name stands for one value: `const name = value`, or a function
 * declaration nothing assigns the name over, whose properties a spread copies as an object's.
 */
function declaredOnce(
  sourceCode: SourceCode,
  node: AstNode,
): Option.Option<{ readonly variable: Variable; readonly value: AstNode }> {
  if (node.type !== "Identifier") return Option.none();
  const variable = findVariable(sourceCode.getScope(node), node.name);
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (variable === undefined || def === undefined) return Option.none();
  if (def.type === "Variable") {
    return isConstDeclarator(def.node) && def.node.init !== null
      ? Option.some({ variable, value: def.node.init })
      : Option.none();
  }
  return def.type === "FunctionName" && variable.references.every((use) => !use.isWrite())
    ? Option.some({ variable, value: def.node })
    : Option.none();
}

/** The const `Object.assign(name, ...sources)` copies onto and returns, when its first argument names one. */
const assignedConst = (sourceCode: SourceCode, node: AstNode): Option.Option<AstNode> =>
  node.type === "CallExpression" && isObjectAssign(sourceCode, node.callee)
    ? Option.filter(unwrapExpression(node.arguments[0]), (target) =>
        Option.isSome(declaredOnce(sourceCode, target)),
      )
    : Option.none();

/**
 * The variable a reference declares as `const alias = name`, or as `const alias = Object.assign(name, ...sources)`,
 * which returns the object it copies onto: either way the alias holds the object `name` holds.
 */
const aliasDeclaredBy = (
  sourceCode: SourceCode,
  { identifier }: Reference,
): Variable | undefined => {
  const target = outermostWrapper(identifier);
  const call = target.parent;
  const value =
    call?.type === "CallExpression" &&
    call.arguments[0] === target &&
    isObjectAssign(sourceCode, call.callee)
      ? outermostWrapper(call)
      : target;
  const declarator = value.parent;
  return isConstDeclarator(declarator) && declarator.init === value
    ? sourceCode.getDeclaredVariables(declarator)[0]
    : undefined;
};

/** How far a chain of `const` aliases is followed before the value counts as unknown. */
const MAX_ALIAS_DEPTH = 4;

/** The variables whose changes are being read: a key read meanwhile through one of them, as in `name[name] = 1`. */
const readingWrites = new Set<Variable>();

/**
 * How many variables' changes one evaluation reads, its aliases' and those of the keys its changes name included.
 * A key of a change is read through its own changes, so `a[b] = 1; a[b] = 2` reads `b`'s twice, and a chain of such
 * keys would read the last one's exponentially often; past this many, a change counts as one the source cannot read.
 */
const MAX_WRITE_READS = 64;
let writeReads = 0;
/** How many times a read was refused for a limit or a cycle: a result computed across none of them holds in any context. */
let refusedReads = 0;
/** How many evaluations are under way, one inside another: the outermost one starts the count of reads afresh. */
let evaluating = 0;

/**
 * Runs `evaluate` with every resolution it makes sharing one count of reads, as resolutions inside one another do. A
 * rule that resolves each value a change copies, whose own changes copy values in turn, stays bounded that way.
 */
export function sharingReadBudget<A>(evaluate: () => A): A {
  if (evaluating === 0) writeReads = 0;
  evaluating++;
  try {
    return evaluate();
  } finally {
    evaluating--;
  }
}

/**
 * The changes the program makes to the object `variable` holds, through its name and through every `const` alias of
 * it, which holds the same object. An alias too deep to follow, a key read through the object while its changes are
 * read, or a read past the evaluation's budget, is a change the source cannot read.
 */
function writesThrough(
  sourceCode: SourceCode,
  variable: Variable,
  depth = 0,
): ReadonlyArray<Write> {
  writeReads++;
  if (depth >= MAX_ALIAS_DEPTH || readingWrites.has(variable) || writeReads > MAX_WRITE_READS) {
    refusedReads++;
    return [UNREADABLE_WRITE];
  }
  readingWrites.add(variable);
  try {
    return variable.references.flatMap((reference) => {
      const alias = aliasDeclaredBy(sourceCode, reference);
      const own = Option.toArray(writeThrough(sourceCode, reference));
      return alias === undefined ? own : [...own, ...writesThrough(sourceCode, alias, depth + 1)];
    });
  } finally {
    readingWrites.delete(variable);
  }
}

const writesOfVariable = new WeakMap<
  Variable,
  { readonly writes: ReadonlyArray<Write>; readonly reads: number }
>();

/**
 * `writesThrough` for a variable, remembered when it was read outside any other read and met no limit or cycle, so
 * the same changes are not walked again for each use of the name. A remembered result still counts its reads against
 * the budget, and is used only where the whole walk would fit in it, so the outcome is the one a fresh walk gives.
 */
function cachedWritesThrough(sourceCode: SourceCode, variable: Variable): ReadonlyArray<Write> {
  const outermost = readingWrites.size === 0;
  const known = outermost ? writesOfVariable.get(variable) : undefined;
  if (known !== undefined && writeReads + known.reads <= MAX_WRITE_READS) {
    writeReads += known.reads;
    return known.writes;
  }
  const readsBefore = writeReads;
  const refusedBefore = refusedReads;
  const writes = writesThrough(sourceCode, variable);
  if (outermost && refusedReads === refusedBefore) {
    writesOfVariable.set(variable, { writes, reads: writeReads - readsBefore });
  }
  return writes;
}

/**
 * What an expression stands for once `const` aliases are followed, with the changes the program makes to that object
 * through any of its names that may have been made by the time the expression is read, in source order. A const that
 * holds `Object.assign(name, ...sources)` holds the object of the const `name`, which the call changes. The name of a
 * function declaration nothing assigns over stands for that function, as a const's stands for its value.
 */
export function resolveConstValue(
  sourceCode: SourceCode,
  node: unknown,
): { readonly value: Option.Option<AstNode>; readonly writes: ReadonlyArray<ConstWrite> } {
  return sharingReadBudget(() => {
    let current = unwrapExpression(node);
    // The last const followed declares the object, and every name followed on the way is an alias of it.
    let holder: Variable | undefined;
    let aliases = 0;
    for (;;) {
      const declared = Option.flatMap(current, (expression) =>
        declaredOnce(sourceCode, expression),
      );
      if (Option.isNone(declared)) break;
      // Only const names count against the depth: a function's ends the chain, as its declaration names no other.
      const { variable } = declared.value;
      if (variable.defs[0]?.type === "Variable" && aliases++ === MAX_ALIAS_DEPTH) break;
      holder = variable;
      const value = unwrapExpression(declared.value.value);
      current = Option.orElse(
        Option.flatMap(value, (expression) => assignedConst(sourceCode, expression)),
        () => value,
      );
    }
    const use = asAstNode(node);
    if (holder === undefined || Option.isNone(use)) return { value: current, writes: [] };
    const object = holder;
    // An alias's changes are read where it is declared, among the object's own: sorted, the changes made in source
    // order are in the order they run in.
    const writes = cachedWritesThrough(sourceCode, object)
      .flatMap(({ change, node: write }) => {
        const order = Option.match(write, {
          onNone: () => ({ made: "anytime", within: [] }) as const,
          onSome: (changed) => writeOrder(changed, use.value, object),
        });
        const at = Option.match(write, {
          onNone: () => Infinity,
          onSome: (changed) => changed.start,
        });
        return order === "after" ? [] : [{ write: { ...change, ...order }, at }];
      })
      .sort((first, second) => first.at - second.at)
      .map(({ write }) => write);
    return { value: current, writes };
  });
}

/** The kinds of value a run may give an expression, one bit each: falsy, `FALSY`, is the falsy value that is not nullish. */
export const TRUTHY = 1;
export const FALSY = 2;
export const NULLISH = 4;
export const ANY_KIND = TRUTHY | FALSY | NULLISH;

/**
 * The kinds of left value `a && b`, `a || b` or `a ?? b` passes over for `b`, and that `&&=`, `||=` or `??=` writes
 * over: truthy, falsy or nullish, where `undefined` and `null` are falsy too.
 */
export const overwrittenKinds = (operator: LogicalOperator): number =>
  operator === "&&" ? TRUTHY : operator === "||" ? FALSY | NULLISH : NULLISH;

/** How far conditions and logical expressions inside one another are followed; values deeper may be of any kind. */
const MAX_KIND_DEPTH = 4;

/** Which ways a branch goes on some run, from the kinds its test or left side may have: where `over` leads, and where the rest do. */
const waysTaken = (kinds: number, over: number) => ({
  over: (kinds & over) !== 0,
  other: (kinds & ~over) !== 0,
});

/**
 * The operands whose value a condition or logical expression takes on some run: both, unless the kinds the source
 * shows its test or left side may have pick one on every run.
 */
export function operandsTaken(
  sourceCode: SourceCode,
  expression: ESTree.ConditionalExpression | ESTree.LogicalExpression,
  depth = 0,
): ReadonlyArray<ESTree.Expression> {
  if (expression.type === "ConditionalExpression") {
    const { test, consequent, alternate } = expression;
    const ways = waysTaken(valueKinds(sourceCode, test, depth + 1), TRUTHY);
    if (!ways.other) return [consequent];
    return ways.over ? [consequent, alternate] : [alternate];
  }
  const { left, operator, right } = expression;
  const ways = waysTaken(valueKinds(sourceCode, left, depth + 1), overwrittenKinds(operator));
  if (!ways.other) return [right];
  return ways.over ? [left, right] : [left];
}

/**
 * The kinds of value `node` may have on some run, through `const` names and the branches the source shows a run may
 * take; every kind where the source does not tell. `undefined` is nullish only as the global.
 */
export function valueKinds(sourceCode: SourceCode, node: unknown, depth = 0): number {
  if (depth > MAX_KIND_DEPTH) return ANY_KIND;
  const kinds = (child: unknown) => valueKinds(sourceCode, child, depth + 1);
  // A change through a name, as in `options.skip = false`, leaves an object an object.
  const expression = Option.getOrUndefined(resolveConstValue(sourceCode, node).value);
  switch (expression?.type) {
    case "ArrayExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ObjectExpression":
      return TRUTHY;
    case "Literal": {
      // A regular expression the parser cannot build has the value null too.
      if (expression.raw === "null") return NULLISH;
      const literal = expression.value;
      return typeof literal === "boolean" ||
        typeof literal === "number" ||
        typeof literal === "string"
        ? literal
          ? TRUTHY
          : FALSY
        : ANY_KIND;
    }
    case "UnaryExpression":
      return expression.operator === "void" ? NULLISH : ANY_KIND;
    case "ConditionalExpression":
      return operandsTaken(sourceCode, expression, depth).reduce(
        (all, operand) => all | kinds(operand),
        0,
      );
    case "LogicalExpression": {
      // The left side is the value only on runs it is not passed over, so of the kinds it is not passed over for.
      const kept = ~overwrittenKinds(expression.operator);
      return operandsTaken(sourceCode, expression, depth).reduce(
        (all, operand) =>
          all | (operand === expression.left ? kinds(operand) & kept : kinds(operand)),
        0,
      );
    }
    case "Identifier":
      return isGlobal(sourceCode, expression, "undefined") ? NULLISH : ANY_KIND;
    default:
      return ANY_KIND;
  }
}

/** Nodes that run each of their parts once, in order, whenever they run. */
const runsEveryPart = (node: AstNode) =>
  node.type === "BlockStatement" ||
  node.type === "ExpressionStatement" ||
  node.type === "VariableDeclaration" ||
  node.type === "VariableDeclarator" ||
  isExpressionWrapper(node);

/** `writes` in runs of those within the same node at `depth`: in source order, each run's are next to each other. */
const groupedWithin = (writes: ReadonlyArray<ConstWrite>, depth: number) =>
  writes.reduce<Array<Array<ConstWrite>>>((groups, write) => {
    const last = groups.at(-1);
    if (last !== undefined && last[0]?.within[depth] === write.within[depth]) last.push(write);
    else groups.push([write]);
    return groups;
  }, []);

/**
 * What `writes` leave of `initial`, `change` giving what one leaves of a state and `either` what holds of one of two:
 * those in source order in turn, then each `anytime` one after them all, as it may be the last. An `if` or `a ? b : c`
 * runs its test, then an arm the test's kinds may lead to, whose changes hold together, and a logical expression its
 * left side, then its right where the left's kinds may; a change in any other statement may be skipped or repeated.
 */
export function applyWrites<State>(
  sourceCode: SourceCode,
  writes: ReadonlyArray<ConstWrite>,
  initial: State,
  change: (state: State, write: ConstWrite) => State,
  either: (first: State, second: State) => State,
): State {
  const maybe = (state: State, write: ConstWrite) => either(state, change(state, write));
  // `inside` holds the changes made within one node, the one at `depth` of each change's `within`.
  const run = (inside: ReadonlyArray<ConstWrite>, state: State, depth: number): State => {
    const [first] = inside;
    const node = first?.within[depth];
    if (first === undefined || node === undefined) return inside.reduce(maybe, state);
    if (inside.length === 1 && first.within.length === depth + 1) return change(state, first);
    const parts = groupedWithin(inside, depth + 1);
    const made = (part: AstNode | null, from: State) => {
      const group = parts.find((changes) => changes[0]?.within[depth + 1] === part);
      return group === undefined ? from : run(group, from, depth + 1);
    };
    switch (node.type) {
      case "IfStatement":
      case "ConditionalExpression": {
        const tested = made(node.test, state);
        const ways = waysTaken(valueKinds(sourceCode, node.test), TRUTHY);
        if (!ways.other) return made(node.consequent, tested);
        if (!ways.over) return made(node.alternate, tested);
        return either(made(node.consequent, tested), made(node.alternate, tested));
      }
      case "LogicalExpression": {
        const left = made(node.left, state);
        const ways = waysTaken(valueKinds(sourceCode, node.left), overwrittenKinds(node.operator));
        if (!ways.other) return made(node.right, left);
        return ways.over ? either(left, made(node.right, left)) : left;
      }
      default:
        return runsEveryPart(node)
          ? parts.reduce((current, group) => run(group, current, depth + 1), state)
          : inside.reduce(maybe, state);
    }
  };
  const ordered = groupedWithin(
    writes.filter((write) => write.made !== "anytime"),
    0,
  ).reduce((state, group) => run(group, state, 0), initial);
  return writes.filter((write) => write.made === "anytime").reduce(maybe, ordered);
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
