import ts from "typescript-legacy";

// Server .ts modules use plain TypeScript erasure. Client compilers and non-source inputs may
// transform types, so a change involving those inputs retains the ordinary walk.
export const serverTypeScript = (file: string) =>
  file.startsWith("apps/server/src/") && file.endsWith(".ts") && !file.endsWith(".d.ts");

function parsed(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const diagnostics: unknown = Reflect.get(source, "parseDiagnostics");
  const decorated = (node: ts.Node): boolean =>
    ts.isDecorator(node) || !!ts.forEachChild(node, decorated);
  if (!Array.isArray(diagnostics) || diagnostics.length || decorated(source)) return undefined;
  return source;
}

// A consumer can read source indirectly by calling an imported function. Restrict the source
// module to data and zero-argument factories of data, with no executable dependencies.
function literalData(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return literalData(node.expression);
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && literalData(p.initializer),
    );
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function dataDeclaration(statement: ts.Statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    statement.declarationList.declarations.every(
      ({ name, initializer }) =>
        ts.isIdentifier(name) &&
        initializer &&
        (literalData(initializer) ||
          (ts.isArrowFunction(initializer) &&
            initializer.parameters.length === 0 &&
            literalData(initializer.body))),
    )
  );
}

// Mask only single-line primitive types of existing top-level interface properties. All names,
// directives, comments, runtime statements and line breaks must remain byte-for-byte identical.
function interfaceShape(file: string, text: string) {
  const source = parsed(file, text);
  if (
    !source ||
    text.includes("\0") ||
    !ts.isExternalModule(source) ||
    !source.statements.every(dataDeclaration)
  )
    return undefined;
  const parts = [];
  let end = 0;
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const primitiveUnion =
        /^(?:string|number|boolean|null|undefined)(?:[ \t]*\|[ \t]*(?:string|number|boolean|null|undefined))*$/;
      if (!primitiveUnion.test(member.type.getText(source))) continue;
      parts.push(text.slice(end, member.type.getStart(source)), "\0");
      end = member.type.end;
    }
  }
  return parts.join("") + text.slice(end);
}

export function erasedInterfaceEdit(file: string, before: string, after: string) {
  if (before === after || !serverTypeScript(file)) return false;
  try {
    const shape = interfaceShape(file, before);
    return shape !== undefined && shape === interfaceShape(file, after);
  } catch {
    return false;
  }
}

// Only discard the edge of a terminal test whose *whole body* is accounted for. A helper's
// import may be the only path to a downstream reader, even if its own use looks ordinary.
export function runtimeImportOffset(file: string, text: string): number | undefined {
  try {
    if (!serverTypeScript(file) || !file.endsWith(".test.ts") || /\/\*|\/\//.test(text)) return;
    const source = parsed(file, text);
    if (!source) return;
    const imports = source.statements.filter(ts.isImportDeclaration);
    const runner = imports.find(
      (s) => ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "vitest",
    );
    const runnerBindings = runner?.importClause?.namedBindings;
    let test: string | undefined;
    if (runner) {
      if (
        runner.attributes ||
        runner.importClause?.name ||
        runner.importClause?.isTypeOnly ||
        !runnerBindings ||
        !ts.isNamedImports(runnerBindings) ||
        runnerBindings.elements.length !== 1
      )
        return;
      const [binding] = runnerBindings.elements;
      if (
        !binding ||
        binding.isTypeOnly ||
        !["it", "test"].includes((binding.propertyName ?? binding.name).text)
      )
        return;
      test = binding.name.text;
    }
    const [imported, extra] = imports.filter((s) => s !== runner);
    if (!imported || extra || imported.attributes) return;
    const clause = imported.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || clause.isTypeOnly || clause.name) return;
    const names = new Set<string>();
    if (ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (item.isTypeOnly) return;
        names.add(item.name.text);
      }
    }
    const isValue = (value: ts.Expression) =>
      ts.isIdentifier(value)
        ? names.has(value.text)
        : ts.isPropertyAccessExpression(value) &&
          ts.isNamespaceImport(bindings) &&
          ts.isIdentifier(value.expression) &&
          value.expression.text === bindings.name.text;
    const isRuntimeUse = (value: ts.Expression) =>
      ts.isCallExpression(value)
        ? !value.typeArguments && !value.arguments.length && isValue(value.expression)
        : isValue(value);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) continue;
      if (!ts.isExpressionStatement(statement)) return;
      const value = statement.expression;
      if (isRuntimeUse(value)) continue;
      if (
        !ts.isCallExpression(value) ||
        !ts.isIdentifier(value.expression) ||
        value.expression.text !== test ||
        value.typeArguments ||
        value.arguments.length !== 2
      )
        return;
      const [title, callback] = value.arguments;
      if (
        !title ||
        !ts.isStringLiteral(title) ||
        !callback ||
        !ts.isArrowFunction(callback) ||
        callback.parameters.length ||
        callback.typeParameters ||
        callback.type ||
        !ts.isBlock(callback.body) ||
        !callback.body.statements.every(
          (s) => ts.isExpressionStatement(s) && isRuntimeUse(s.expression),
        )
      )
        return;
    }
    return imported.moduleSpecifier.getStart(source);
  } catch {
    return undefined;
  }
}
