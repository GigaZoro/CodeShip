import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { MCP_TOOLKITS } from "./toolkits.testkit.ts";

interface JsonSchemaNode {
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
}

// A key path ("target.projectId") or its last segment ("projectId") names a key.
function schemaText(schema: unknown) {
  const keys = new Set<string>();
  const descriptions = new Set<string>();
  const visit = (node: JsonSchemaNode, prefix: string): void => {
    if (node.description) descriptions.add(node.description);
    for (const child of [...(node.items ? [node.items] : []), ...(node.anyOf ?? [])]) {
      visit(child, prefix);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      keys.add(key).add(`${prefix}${key}`);
      visit(child, `${prefix}${key}.`);
    }
  };
  visit(schema as JsonSchemaNode, "");
  return { keys, descriptions };
}
type SchemaText = ReturnType<typeof schemaText>;

const tools = new Map(
  MCP_TOOLKITS.flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools)).map(
    (tool) => [
      tool.name,
      {
        description: Tool.getDescription(tool) ?? "",
        parameters: schemaText(advertisedJsonSchema(tool)),
        result: schemaText(Tool.getJsonSchemaFromSchema(tool.successSchema)),
      },
    ],
  ),
);

// "`tool` with …" or "`tool` takes …" up to the end of its clause; code spans may hold "." or ";".
const TOOL_ARGUMENT_CLAUSE = /`([a-z][a-z0-9_]*)` (?:with|takes)\b((?:`[^`]*`|[^`.;\n])*)/g;
const CODE_SPAN = /`([^`]*)`/g;
// A Windows drive path such as `C:/` is no assignment.
const ASSIGNMENT = /`(?![A-Za-z]:[\\/])([A-Za-z_][\w.]*)\s*[:=][^`]*`/g;

function argumentProblems(
  source: string,
  text: string,
  own?: { readonly parameters: SchemaText; readonly result: SchemaText },
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const [clause, name = "", rest = ""] of text.matchAll(TOOL_ARGUMENT_CLAUSE)) {
    const tool = tools.get(name);
    if (tool === undefined) continue;
    const keys = [...rest.matchAll(CODE_SPAN)].map(
      ([, code = ""]) => code.split(/[\s:=]/)[0] ?? "",
    );
    if (keys.length === 0) problems.push(`${source}: "${clause.trim()}" names no argument key`);
    for (const key of keys) {
      if (!tool.parameters.keys.has(key))
        problems.push(`${source}: \`${name}\` takes no \`${key}\``);
    }
  }
  // A tool's own text may also name a key it returns, such as `wasLinked=false`.
  for (const [, key = ""] of text.replace(TOOL_ARGUMENT_CLAUSE, "").matchAll(ASSIGNMENT)) {
    if (own !== undefined && !own.parameters.keys.has(key) && !own.result.keys.has(key)) {
      problems.push(`${source} takes and returns no \`${key}\``);
    }
  }
  return problems;
}

// Agents call a tool with the keys its text names, so a key the tool lacks fails every call.
it("names only argument keys the tool takes in tool and instruction text", () => {
  const instructions = {
    orchestration: T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    browser: T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
    devices: T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    runtime: buildRuntimeInstructions({ harness: "Claude Code" }),
  };
  const problems = [
    ...Object.entries(instructions).flatMap(([source, text]) => argumentProblems(source, text)),
    ...[...tools].flatMap(([name, tool]) =>
      [tool.description, ...tool.parameters.descriptions].flatMap((text) =>
        argumentProblems(name, text, tool),
      ),
    ),
  ];
  expect(problems).toEqual([]);
});
