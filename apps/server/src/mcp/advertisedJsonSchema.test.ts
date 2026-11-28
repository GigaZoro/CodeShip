import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Tool } from "effect/ai";

import { OrchestratorMcpSaveScheduledTaskInput } from "@t3tools/contracts/orchestratorMcp";

import { advertisedJsonSchema, unknownArguments } from "./advertisedJsonSchema.ts";
import { MCP_TOOLKITS } from "./toolkits.testkit.ts";

/** Each description written on a decoded schema, one of its checks or a key, at any depth. */
const writtenDescriptions = (root: SchemaAST.AST): ReadonlySet<string> => {
  const found = new Set<string>();
  const seen = new Set<SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): void => {
    if (seen.has(ast)) return;
    seen.add(ast);
    for (const annotations of [
      ast.annotations,
      ast.context?.annotations,
      ...(ast.checks ?? []).map((check) => check.annotations),
    ]) {
      if (typeof annotations?.description === "string") found.add(annotations.description);
    }
    if (SchemaAST.isObjects(ast)) {
      for (const property of ast.propertySignatures) visit(property.type);
      for (const index of ast.indexSignatures) visit(index.type);
    } else if (SchemaAST.isArrays(ast)) {
      for (const element of [...ast.elements, ...ast.rest]) visit(element);
    } else if (SchemaAST.isUnion(ast)) {
      for (const member of ast.types) visit(member);
    } else if (SchemaAST.isSuspend(ast)) {
      visit(ast.thunk());
    }
  };
  visit(root);
  return found;
};

const advertisedDescriptions = (node: unknown, found = new Set<string>()): ReadonlySet<string> => {
  if (Array.isArray(node)) for (const item of node) advertisedDescriptions(item, found);
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") found.add(value);
      else advertisedDescriptions(value, found);
    }
  }
  return found;
};

// JSON Schema describes the encoded side, so a description `.annotate` puts on the decoded side of
// a transformation, such as a trimmed string, never reaches the agent; `annotateEncoded` does.
it("advertises every description written on a served tool's input", () => {
  const lost = MCP_TOOLKITS.flatMap((toolkit): ReadonlyArray<Tool.Any> =>
    Object.values(toolkit.tools),
  ).flatMap((tool) => {
    const advertised = [...advertisedDescriptions(advertisedJsonSchema(tool))];
    return [...writtenDescriptions(tool.parametersSchema.ast)]
      .filter((description) => !advertised.some((text) => text.includes(description)))
      .map((description) => `${tool.name}: ${description}`);
  });
  expect(lost).toEqual([]);
});

it("drops JSON noise, merges tagged unions, and keeps null and per-tag requirements", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("url"),
              url: Schema.String.annotate({ description: "Page URL." }),
            }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }).annotate({
              description: "By number.",
            }),
            Schema.Struct({ kind: Schema.Literal("none"), number: Schema.optional(Schema.Int) }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["url", "number", "none"],
            description: "'number': By number.",
          },
          url: { type: "string", description: "Page URL. Required when kind is 'url'." },
          number: { type: "integer", description: "Required when kind is 'number'." },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises the model selection the scheduled-task decoder requires", () => {
  const tool = Tool.make("schedule_task", { parameters: OrchestratorMcpSaveScheduledTaskInput });
  const advertised = advertisedJsonSchema(tool) as {
    properties: { modelSelection: Record<string, unknown> };
  };

  expect(advertised.properties.modelSelection).toMatchObject({
    type: "object",
    required: ["instanceId", "model"],
    properties: {
      instanceId: { type: "string" },
      model: { type: "string", minLength: 1 },
      options: { type: "array" },
      autoAccount: { type: "boolean" },
    },
  });
});

it("finds the arguments a schema does not take, but none under a shape that keeps other keys", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      workspace: Schema.optionalKey(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
      scripts: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
      target: Schema.optionalKey(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("none") }),
        ]),
      ),
      accounts: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
      ),
      config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      options: Schema.optionalKey(Schema.Unknown),
      overrides: Schema.optionalKey(
        Schema.StructWithRest(Schema.Struct({ a: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    }),
  });
  const args = {
    name: "x",
    added: 1,
    workspace: { type: "root", startFromOrigin: false },
    scripts: [{ id: "a" }, { id: "b", async: true }],
    target: { kind: "url", url: "https://example.com", extra: 1 },
    accounts: { claude: { enabled: true, other: 1 } },
    config: { other: 1 },
    options: { other: 1 },
    overrides: { a: "x", other: 1 },
    unset: undefined,
  };
  const unknown = ["added", "workspace.startFromOrigin", "scripts[1].async", "target.extra"];

  // As this version advertises it, and as versions before the compact schemas did.
  expect(unknownArguments(advertisedJsonSchema(tool), args)).toEqual(unknown);
  expect(unknownArguments(Tool.getJsonSchema(tool), args)).toEqual(unknown);
  expect(unknownArguments(Tool.getJsonSchema(Tool.make("none")), { added: 1 })).toEqual(["added"]);
});
