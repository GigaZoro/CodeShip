import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** ThreadPage's integration API, described at https://thread.page/llms.txt. */
export const THREADPAGE_API_URL = "https://thread.page/api/integrations/v1";
export const THREADPAGE_PAGE_SIZE = "50";

export const threadPageRequestHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  // ThreadPage's edge refuses requests without a named client.
  "User-Agent": "T3.CodeShip",
});

export interface ThreadPageListPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly next_cursor: string | null;
}

export const threadPageListPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), next_cursor: Schema.NullOr(Schema.String) });

/** Follows a list's `next_cursor` for at most `maxPages` pages. */
export const readThreadPagePages = Effect.fn("ThreadPage.readPages")(function* <A, E>(
  maxPages: number,
  readPage: (cursor: string | null) => Effect.Effect<ThreadPageListPage<A>, E>,
) {
  const items: A[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < maxPages; index += 1) {
    const result: ThreadPageListPage<A> = yield* readPage(cursor);
    items.push(...result.items);
    cursor = result.next_cursor;
    if (cursor === null) break;
  }
  return items;
});
