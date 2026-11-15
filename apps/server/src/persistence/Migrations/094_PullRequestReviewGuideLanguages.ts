import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A guide is written in its reader's language, so each language keeps its own. The stored
  // guides came from an English prompt with no language rule; they stay as the English ones,
  // since each took minutes of a model's time to write.
  yield* sql`
    CREATE TABLE pull_request_review_guides_next (
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      language TEXT NOT NULL,
      guide_json TEXT NOT NULL,
      PRIMARY KEY (host, repository, number, language)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO pull_request_review_guides_next (host, repository, number, language, guide_json)
    SELECT host, repository, number, 'en', guide_json
    FROM pull_request_review_guides
  `;
  yield* sql`DROP TABLE pull_request_review_guides`;
  yield* sql`ALTER TABLE pull_request_review_guides_next RENAME TO pull_request_review_guides`;
});
