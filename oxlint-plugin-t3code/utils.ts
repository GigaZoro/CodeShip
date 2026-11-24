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
 * The property a key or member names: an identifier written as one, or a string, bracketed or not. A private name,
 * as in `this.#x`, names none. A rule that can read scopes resolves a bracketed variable with `resolvePropertyName`.
 */
export function getPropertyName(node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (expression) => {
    if (expression.type === "Identifier" && typeof expression.name === "string") {
      return isBracketedKey(expression) ? Option.none() : Option.some(expression.name);
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
 * A change that may have been made by the time the program reads the object at one use of its name, with the nodes it
 * is `within`, outermost first, from the one that does not hold the use down to the change: they tell whether a run
 * makes it. `readConstValue` says when it is made.
 */
export type ConstWrite = Change & { readonly within: ReadonlyArray<AstNode> };

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

let writeVisits = 0;
/** How many changes the reads of names have visited so far, which a test bounds to keep a file's reads linear. */
export const countWriteVisits = () => writeVisits;

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
 * What an expression stands for once `const` aliases are followed, and the const that declares the object it names. A
 * const that holds `Object.assign(name, ...sources)` holds the object of the const `name`, which the call changes. The
 * name of a function declaration nothing assigns over stands for that function, as a const's stands for its value.
 */
function followConsts(
  sourceCode: SourceCode,
  node: unknown,
): { readonly value: Option.Option<AstNode>; readonly holder: Variable | undefined } {
  let current = unwrapExpression(node);
  // The last const followed declares the object, and every name followed on the way is an alias of it.
  let holder: Variable | undefined;
  let aliases = 0;
  for (;;) {
    const declared = Option.flatMap(current, (expression) => declaredOnce(sourceCode, expression));
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
  return { value: current, holder };
}

/**
 * What an expression stands for once `const` aliases are followed, as `followConsts` finds it, whatever the program
 * changes on that object through its names: `readConstValue` reads those changes.
 */
export const resolveConstValue = (sourceCode: SourceCode, node: unknown): Option.Option<AstNode> =>
  sharingReadBudget(() => followConsts(sourceCode, node).value);

/**
 * A change as one statement list it is in sees it: the statement it is in, -1 for a switch case's test, with `within`
 * the nodes from that statement down to the change, its place among the object's changes in source order, and the
 * next list down it is in.
 */
type Placed = {
  readonly write: ConstWrite;
  readonly node: AstNode;
  readonly order: number;
  readonly statement: number;
  readonly below: AstNode | undefined;
};

/**
 * The changes in one statement list's statements, each in source order, by what stands between them and the list:
 * nothing deferred (`direct`, which run in turn, a statement's `runs` together), the value of an instance field, which
 * runs later in the same function (`field`), or a function (`called`). `tested` are in a switch case's test, and
 * `byStatement` holds each statement's by the next list down they are in.
 */
type ListChanges = {
  readonly direct: Array<Placed>;
  readonly field: Array<Placed>;
  readonly called: Array<Placed>;
  readonly tested: Array<Placed>;
  readonly runs: Array<{ readonly statement: number; readonly writes: Array<ConstWrite> }>;
  readonly byStatement: Map<number, Map<AstNode | undefined, Array<Placed>>>;
};

/**
 * An object's changes placed in every statement list each is in, with those the source cannot read, which may be made
 * at any time, and what each reading of the object has found of them so far.
 */
type ChangeIndex = {
  readonly lists: Map<AstNode, ListChanges>;
  readonly unread: ReadonlyArray<ConstWrite>;
  readonly memos: WeakMap<object, unknown>;
  readonly uses: WeakMap<AstNode, NamedUse>;
};

/** A use of an object's name: the statement lists it is in, and the changes that may be made by then at no set time. */
type NamedUse = {
  readonly levels: ReadonlyArray<UseLevel>;
  readonly anytime: ReadonlyArray<ConstWrite>;
};

const changeIndexes = new WeakMap<ReadonlyArray<Write>, ChangeIndex>();

/**
 * `writes` placed once for each walk of them: a use of the name then finds the changes that run before it, after it
 * and at no time the source shows by the statements it is in, without visiting each change again.
 */
function changeIndex(writes: ReadonlyArray<Write>): ChangeIndex {
  const known = changeIndexes.get(writes);
  if (known !== undefined) return known;
  const lists = new Map<AstNode, ListChanges>();
  const unread: Array<ConstWrite> = [];
  // An alias's changes are read where it is declared, among the object's own: sorted, the changes made in source
  // order are in the order they run in.
  const read = writes.flatMap(({ change, node }) => {
    if (Option.isSome(node)) return [{ change, node: node.value }];
    unread.push({ ...change, within: [] });
    return [];
  });
  read.sort((first, second) => first.node.start - second.node.start);
  read.forEach(({ change, node }, order) => {
    const path: Array<AstNode> = [];
    let deferred = false;
    let called = false;
    let below: AstNode | undefined;
    for (let child = node, list = node.parent; list; child = list, list = list.parent) {
      path.push(child);
      if (isDeferred(child)) deferred = true;
      if (isFunction(child)) called = true;
      const statements = statementList(list);
      if (statements === undefined) continue;
      writeVisits++;
      const statement = indexInList(statements, child);
      const write = { ...change, within: [...path].reverse() };
      const placed = { write, node, order, statement, below };
      let changes = lists.get(list);
      if (changes === undefined) {
        changes = {
          direct: [],
          field: [],
          called: [],
          tested: [],
          runs: [],
          byStatement: new Map(),
        };
        lists.set(list, changes);
      }
      if (statement < 0) changes.tested.push(placed);
      else if (called) changes.called.push(placed);
      else if (deferred) changes.field.push(placed);
      else {
        changes.direct.push(placed);
        const run = changes.runs.at(-1);
        if (run?.statement === statement) run.writes.push(write);
        else changes.runs.push({ statement, writes: [write] });
      }
      const inStatement = changes.byStatement.get(statement) ?? new Map();
      changes.byStatement.set(statement, inStatement);
      const alongside = inStatement.get(below);
      if (alongside === undefined) inStatement.set(below, [placed]);
      else alongside.push(placed);
      below = list;
    }
  });
  const index: ChangeIndex = {
    lists,
    unread,
    memos: new WeakMap<object, unknown>(),
    uses: new WeakMap<AstNode, NamedUse>(),
  };
  changeIndexes.set(writes, index);
  return index;
}

/** How many of `placed`, in order of statement, are in a statement before `statement`. */
const countBefore = (placed: ReadonlyArray<{ readonly statement: number }>, statement: number) => {
  let low = 0;
  let high = placed.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((placed[middle]?.statement ?? Infinity) < statement) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * A statement list a use is in, innermost first: the statement that holds the use, -1 for a switch case's test, and
 * the next list down it is in. A statement ahead of the use's runs first (`ordered`) unless the use is in a hoisted
 * function declaration; one after it runs later when both run (`skipsAfter`), outside any loop, in the function that
 * makes the object afresh each run: the program, or the one that declares the object.
 */
type UseLevel = {
  readonly list: AstNode;
  readonly statement: number;
  readonly below: AstNode | undefined;
  readonly ordered: boolean;
  readonly skipsAfter: boolean;
};

function useLevels(use: AstNode, holder: Variable): ReadonlyArray<UseLevel> {
  const levels: Array<UseLevel> = [];
  const declared = holder.defs[0]?.node;
  const declaring = declared === undefined ? undefined : runningFunction(declared);
  let below: AstNode | undefined;
  let hoisted = false;
  let inFunction = false;
  for (let child = use, list = use.parent; list; child = list, list = list.parent) {
    if (child.type === "FunctionDeclaration") hoisted = true;
    if (isFunction(child)) inFunction = true;
    const statements = statementList(list);
    if (statements === undefined) continue;
    const running = runningFunction(list);
    levels.push({
      list,
      statement: indexInList(statements, child),
      below,
      ordered: !hoisted,
      skipsAfter:
        !inFunction &&
        !enclosing(list, (node) => node === running).some(isLoop) &&
        (running.type === "Program" || declaring === running),
    });
    below = list;
  }
  return levels;
}

/**
 * The changes that may be made before `use` at no time the source shows, in source order: all but those that run in
 * turn before it and those that run after it. One in the use's own statement that no list below holds with it is in
 * a node the use is in too, which it is `within` from there.
 */
function anytimeChanges(
  index: ChangeIndex,
  use: AstNode,
  levels: ReadonlyArray<UseLevel>,
): ReadonlyArray<ConstWrite> {
  const found: Array<Placed> = [];
  let useAncestors: ReadonlySet<AstNode> | undefined;
  for (const { list, statement, below, ordered, skipsAfter } of levels) {
    const changes = index.lists.get(list);
    if (changes === undefined) continue;
    for (const [next, placed] of changes.byStatement.get(statement) ?? []) {
      if (below !== undefined && next === below) continue;
      const ancestors = (useAncestors ??= new Set(enclosing(use, () => false)));
      for (const each of placed) {
        const within = enclosing(each.node, (node) => ancestors.has(node)).reverse();
        found.push({ ...each, write: { ...each.write, within } });
      }
    }
    if (statement < 0) {
      found.push(...changes.direct, ...changes.field, ...changes.called);
      continue;
    }
    const before = (placed: Array<Placed>) => placed.slice(0, countBefore(placed, statement));
    const after = (placed: Array<Placed>) => placed.slice(countBefore(placed, statement + 1));
    found.push(...changes.tested, ...before(changes.field), ...before(changes.called));
    found.push(...after(changes.called));
    if (!ordered) found.push(...before(changes.direct));
    if (!skipsAfter) found.push(...after(changes.direct), ...after(changes.field));
  }
  writeVisits += found.length;
  found.sort((first, second) => first.order - second.order);
  return [...found.map(({ write }) => write), ...index.unread];
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
  const expression = Option.getOrUndefined(resolveConstValue(sourceCode, node));
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
 * Whether some run may enter `node` from the node it is in: no run enters an arm of an `if` or `a ? b : c` its test's
 * kinds never lead to, nor a right side its left's kinds never pass over for.
 */
const mayEnter = (sourceCode: SourceCode, node: AstNode): boolean => {
  const parent = node.parent;
  switch (parent?.type) {
    case "IfStatement":
    case "ConditionalExpression": {
      if (node === parent.test) return true;
      const ways = waysTaken(valueKinds(sourceCode, parent.test), TRUTHY);
      return node === parent.consequent ? ways.over : ways.other;
    }
    case "LogicalExpression":
      return (
        node !== parent.right ||
        waysTaken(valueKinds(sourceCode, parent.left), overwrittenKinds(parent.operator)).over
      );
    default:
      return true;
  }
};

/** Whether a run may go on to make `write` from the node above `within[from]`, entering each node from there down. */
const mayBeMade = (sourceCode: SourceCode, write: ConstWrite, from: number) =>
  write.within.slice(from).every((node) => mayEnter(sourceCode, node));

/**
 * How a rule reads what an object holds: `initial` from the value its const gives it, `change` on a run that makes one
 * change, and `either` for a run that may be either of two. A rule passes one reading for every use it reads alike, so
 * the state each statement leaves is found once for all the uses after it.
 */
export type ConstReading<State> = {
  readonly initial: (value: Option.Option<AstNode>) => State;
  readonly change: (state: State, write: ConstWrite) => State;
  readonly either: (first: State, second: State) => State;
};

/** A state, with whether it is the one a reading remembers, which the states after it are remembered from. */
type Entered<State> = { readonly state: State; readonly remembered: boolean };

/** The states one list's runs leave in turn from the state the list is entered with, and the reads each charged in all. */
type Prefix<State> = { readonly states: Array<State>; readonly reads: Array<number> };

/** What a reading has found of one object's changes: the state its value gives, and the states each list's runs leave. */
type ReadingMemo<State> = {
  initial: { readonly state: State; readonly reads: number } | undefined;
  readonly entered: Map<State, Map<AstNode, Prefix<State>>>;
};

const memoOf = <State>(index: ChangeIndex, reading: ConstReading<State>): ReadingMemo<State> => {
  // A reading's memo is stored under the reading, so it holds that reading's states only.
  const known = index.memos.get(reading) as ReadingMemo<State> | undefined;
  if (known !== undefined) return known;
  const memo: ReadingMemo<State> = { initial: undefined, entered: new Map() };
  index.memos.set(reading, memo);
  return memo;
};

/**
 * Whether a state computed with `reads` reads, none refused, is what computing it afresh now gives at the same charge:
 * always where it read nothing, and otherwise where its reads fit the budget and no cycle can refuse one.
 */
const reusable = (reads: number) =>
  reads === 0 || (readingWrites.size === 0 && writeReads + reads <= MAX_WRITE_READS);

/** The state `reading` gives the value a const declares, remembered when no read was refused computing it. */
function initialState<State>(
  memo: ReadingMemo<State>,
  reading: ConstReading<State>,
  value: Option.Option<AstNode>,
): Entered<State> {
  const known = memo.initial;
  if (known !== undefined && reusable(known.reads)) {
    writeReads += known.reads;
    return { state: known.state, remembered: true };
  }
  const reads = writeReads;
  const refused = refusedReads;
  const state = reading.initial(value);
  const remembered = known === undefined && refusedReads === refused;
  if (remembered) memo.initial = { state, reads: writeReads - reads };
  return { state, remembered };
}

/**
 * The state the first `count` of a list's `runs` leave of `entering`: from the furthest the reading remembers that is
 * `reusable`, remembering each after it that no refused read made, as `entering` is.
 */
function runFrom<State>(
  memo: ReadingMemo<State>,
  run: (inside: ReadonlyArray<ConstWrite>, state: State, depth: number) => State,
  list: AstNode,
  runs: ListChanges["runs"],
  count: number,
  entering: Entered<State>,
): Entered<State> {
  if (count === 0) return entering;
  let prefix: Prefix<State> | undefined;
  if (entering.remembered) {
    const lists = memo.entered.get(entering.state) ?? new Map<AstNode, Prefix<State>>();
    memo.entered.set(entering.state, lists);
    prefix = lists.get(list) ?? { states: [entering.state], reads: [0] };
    lists.set(list, prefix);
  }
  let step = 0;
  let state = entering.state;
  if (prefix !== undefined) {
    // The reads only grow along the runs, so halving finds the furthest state that is reusable.
    let high = Math.min(count, prefix.states.length - 1);
    while (step < high) {
      const middle = (step + high + 1) >> 1;
      if (reusable(prefix.reads[middle] ?? Infinity)) step = middle;
      else high = middle - 1;
    }
    writeReads += prefix.reads[step] ?? 0;
    if (step < prefix.states.length) state = prefix.states[step] as State;
  }
  let remembering = true;
  for (; step < count; step++) {
    const reads = writeReads;
    const refused = refusedReads;
    state = run(runs[step]?.writes ?? [], state, 0);
    // A state is remembered only right after the one it was made from, which a change reading the object
    // again with this reading could have moved on from meanwhile.
    remembering &&= refusedReads === refused && prefix?.states.length === step + 1;
    if (remembering && prefix !== undefined) {
      prefix.reads.push((prefix.reads[step] ?? 0) + writeReads - reads);
      prefix.states.push(state);
    }
  }
  return {
    state,
    remembered:
      prefix !== undefined && prefix.states.length > count && prefix.states[count] === state,
  };
}

/** What changes leave of a state on a run, as `readConstValue` applies them, counting each change applied. */
const runner = <State>(sourceCode: SourceCode, reading: ConstReading<State>) => {
  const change = (state: State, write: ConstWrite) => {
    writeVisits++;
    return reading.change(state, write);
  };
  const maybe = (state: State, write: ConstWrite) => reading.either(state, change(state, write));
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
        return reading.either(made(node.consequent, tested), made(node.alternate, tested));
      }
      case "LogicalExpression": {
        const left = made(node.left, state);
        const ways = waysTaken(valueKinds(sourceCode, node.left), overwrittenKinds(node.operator));
        if (!ways.other) return made(node.right, left);
        return ways.over ? reading.either(left, made(node.right, left)) : left;
      }
      default:
        return runsEveryPart(node)
          ? parts.reduce((current, group) => run(group, current, depth + 1), state)
          : inside.filter((write) => mayBeMade(sourceCode, write, depth + 1)).reduce(maybe, state);
    }
  };
  return { run, maybe };
};

/** The value an expression stands for and, when a const declares the object it names, its changes and the use's lists. */
function namedObject(sourceCode: SourceCode, node: unknown) {
  const { value, holder } = followConsts(sourceCode, node);
  const use = asAstNode(node);
  if (holder === undefined || Option.isNone(use)) return { value, named: undefined };
  const index = changeIndex(cachedWritesThrough(sourceCode, holder));
  let known = index.uses.get(use.value);
  if (known === undefined) {
    const levels = useLevels(use.value, holder);
    known = { levels, anytime: anytimeChanges(index, use.value, levels) };
    index.uses.set(use.value, known);
  }
  return { value, named: { index, ...known } };
}

/**
 * What the object an expression stands for holds as `reading` reads it, after the changes made through its names by
 * then: those ahead of the use in the order they run, then each made at no time the source shows, as it may be last.
 * An `if`, `a ? b : c` or logical expression runs only the parts its test's or left side's kinds may lead to; a
 * change in any other node may be skipped or repeated, but none in a part no run enters is made.
 */
export function readConstValue<State>(
  sourceCode: SourceCode,
  node: unknown,
  reading: ConstReading<State>,
): State {
  return sharingReadBudget(() => {
    const { value, named } = namedObject(sourceCode, node);
    return named === undefined
      ? reading.initial(value)
      : readNamed(sourceCode, value, named, reading);
  });
}

function readNamed<State>(
  sourceCode: SourceCode,
  value: Option.Option<AstNode>,
  { index, levels, anytime }: NamedUse & { readonly index: ChangeIndex },
  reading: ConstReading<State>,
): State {
  const memo = memoOf(index, reading);
  const { run, maybe } = runner(sourceCode, reading);
  let entered = initialState(memo, reading, value);
  for (const { list, statement, ordered } of [...levels].reverse()) {
    const runs = index.lists.get(list)?.runs ?? [];
    if (ordered && statement >= 0) {
      entered = runFrom(memo, run, list, runs, countBefore(runs, statement), entered);
    }
  }
  return anytime.filter((write) => mayBeMade(sourceCode, write, 0)).reduce(maybe, entered.state);
}

/** Whether a run may have changed an object by a use, read as `readConstValue` reads its changes. */
const CHANGED: ConstReading<boolean> = {
  initial: () => false,
  change: () => true,
  either: (first, second) => first || second,
};

/**
 * What an expression stands for once `const` aliases are followed: `options` after
 * `const options = { timeout: 1 }` is the object. Anything else is the expression itself, and so is a name whose
 * object the program may have changed by then, as in `options.skip = false`: `readConstValue` reads such a value.
 */
export function resolveConstAliases(sourceCode: SourceCode, node: unknown): Option.Option<AstNode> {
  return sharingReadBudget(() => {
    const { value, named } = namedObject(sourceCode, node);
    if (named === undefined) return value;
    return readNamed(sourceCode, value, named, CHANGED) ? unwrapExpression(node) : value;
  });
}

/** The string an expression holds once `const` aliases are followed: `key` after `const key = "b"` holds `b`. */
export const resolveStringValue = (sourceCode: SourceCode, node: unknown): Option.Option<string> =>
  Option.flatMap(resolveConstAliases(sourceCode, node), stringLiteralValue);

/**
 * The property a key or member names, with a bracketed key read through the `const` it holds: `a[key]` after
 * `const key = "b"` names `b`. None where the source cannot tell, which for a bracketed key means it may name any.
 */
export function resolvePropertyName(sourceCode: SourceCode, node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (key) =>
    isBracketedKey(key) ? resolveStringValue(sourceCode, key) : getPropertyName(key),
  );
}
