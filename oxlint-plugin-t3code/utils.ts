import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";
import * as Option from "effect/Option";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
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
  node.type === "TSTypeAssertion";

export function unwrapExpression(node: unknown): Option.Option<AstNode> {
  let current = asAstNode(node);

  while (Option.isSome(current) && isExpressionWrapper(current.value)) {
    current = asAstNode(current.value.expression);
  }

  return current;
}

export function getPropertyName(node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (expression) => {
    if (expression.type === "Identifier" && typeof expression.name === "string") {
      return Option.some(expression.name);
    }
    if (expression.type === "PrivateIdentifier" && typeof expression.name === "string") {
      return Option.some(expression.name);
    }
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return Option.some(expression.value);
    }
    return Option.none();
  });
}

/**
 * The import a name resolves to where it is used. A value reference resolves only to a value, so a
 * parameter of that name hides the import and a local type of that name does not.
 */
export function importBinding(
  sourceCode: SourceCode,
  identifier: AstNode,
): Option.Option<{ readonly source: string; readonly specifier: AstNode }> {
  // getScope can return a scope nested in the reference's, as a switch's is for its discriminant.
  for (let scope: Scope | null = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const reference = scope.references.find((candidate) => candidate.identifier === identifier);
    if (reference === undefined) continue;
    // A type declared beside the import merges into its variable, so its definition can come first.
    const def = reference.resolved?.defs.find((candidate) => candidate.type === "ImportBinding");
    return def?.parent?.type === "ImportDeclaration"
      ? Option.some({ source: def.parent.source.value, specifier: def.node })
      : Option.none();
  }
  return Option.none();
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
