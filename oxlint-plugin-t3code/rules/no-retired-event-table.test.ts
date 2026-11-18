import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-retired-event-table");

describe("t3code/no-retired-event-table", () => {
  rule.valid(
    "allows the live events table",
    `
      declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
      export const read = (threadId: string) => sql\`
        SELECT COUNT(*) FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = \${threadId}
      \`;
    `,
  );

  rule.invalid(
    "reports a query on the retired table",
    `
      declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
      export const read = (threadId: string) => sql\`
        SELECT COUNT(*) FROM orchestration_v2_events WHERE thread_id = \${threadId}
      \`;
    `,
    (output) => {
      assert.match(output, /orchestration_events/);
    },
  );

  rule.invalid(
    "reports the table name in a plain string",
    `
      export const table = "orchestration_v2_events";
    `,
  );
});
