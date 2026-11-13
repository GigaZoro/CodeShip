import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-json-wrapped-subquery");

describe("t3code/require-json-wrapped-subquery", () => {
  rule.valid(
    "allows a subquery wrapped in json()",
    "sql`UPDATE t SET j = json_set(j, '$.a', json((SELECT json_group_array(x) FROM y)))`;",
  );

  rule.valid(
    "allows a subquery inside another expression and parentheses in SQL strings",
    "sql`UPDATE t SET j = json_object('a(', COALESCE((SELECT name FROM y), 'none'))`;",
  );

  rule.valid(
    "ignores templates that are not SQL",
    "other`json_set(j, '$.a', (SELECT json_group_array(x) FROM y))`;",
  );

  rule.invalid(
    "reports a bare subquery passed to json_set",
    "sql`UPDATE t SET j = json_set(j, '$.a', (\n  SELECT json_group_array(x) FROM y\n))`;",
  );

  rule.invalid(
    "reports a bare subquery beside an interpolated value",
    "sql`SELECT json_object('id', ${id}, 'items', (SELECT json_group_array(x) FROM y))`;",
  );
});
