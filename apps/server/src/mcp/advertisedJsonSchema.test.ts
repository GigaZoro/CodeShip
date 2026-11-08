import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

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
