import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { OrchestratorMcpSaveScheduledTaskInput } from "@t3tools/contracts";

import { advertisedJsonSchema, unknownArguments } from "./advertisedJsonSchema.ts";

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
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
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
          kind: { type: "string", enum: ["url", "number", "none"] },
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
