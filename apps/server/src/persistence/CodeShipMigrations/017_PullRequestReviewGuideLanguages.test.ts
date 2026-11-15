import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("017_PullRequestReviewGuideLanguages", (it) => {
  it.effect("keeps each stored guide as the English one and stores languages apart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(93);
      yield* sql`
        INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
        VALUES ('github.com', 'acme/app', 7, '{"written":"before"}')
      `;

      yield* runMigrations();
      yield* sql`
        INSERT INTO pull_request_review_guides (host, repository, number, language, guide_json)
        VALUES ('github.com', 'acme/app', 7, 'uk', '{"written":"after"}')
      `;

      const rows = yield* sql<{ language: string; guide_json: string }>`
        SELECT language, guide_json FROM pull_request_review_guides ORDER BY language
      `;
      assert.deepStrictEqual(rows, [
        { language: "en", guide_json: '{"written":"before"}' },
        { language: "uk", guide_json: '{"written":"after"}' },
      ]);
    }),
  );
});
