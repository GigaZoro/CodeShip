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

// Mask only single-line primitive types of existing top-level interface properties. All names,
// directives, comments, runtime statements and line breaks must remain byte-for-byte identical.
function interfaceShape(file: string, text: string) {
  const source = parsed(file, text);
  if (!source || text.includes("\0") || !ts.isExternalModule(source)) return undefined;
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

export function runtimeImportOffsets(file: string, text: string): ReadonlySet<number> {
  try {
    const source = serverTypeScript(file) && parsed(file, text);
    if (!source) return new Set();
    const typeNames = new Set<string>();
    function visit(node: ts.Node, inType: boolean) {
      const type = inType || ts.isTypeNode(node);
      if (type && ts.isIdentifier(node)) typeNames.add(node.text);
      ts.forEachChild(node, (child) => visit(child, type));
    }
    visit(source, false);
    const offsets = new Set<number>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.attributes) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly || (clause?.name && typeNames.has(clause.name.text))) continue;
      const bindings = clause?.namedBindings;
      if (
        bindings &&
        (ts.isNamespaceImport(bindings)
          ? typeNames.has(bindings.name.text)
          : bindings.elements.some((item) => item.isTypeOnly || typeNames.has(item.name.text)))
      )
        continue;
      offsets.add(statement.moduleSpecifier.getStart(source));
    }
    return offsets;
  } catch {
    return new Set();
  }
}
