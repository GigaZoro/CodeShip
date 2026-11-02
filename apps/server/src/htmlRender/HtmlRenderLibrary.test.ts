import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as HtmlRenderLibrary from "./HtmlRenderLibrary.ts";

// Each test builds its own database.
const testLayer = HtmlRenderLibrary.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const pageId = (threadId: string, n: number) =>
  `${threadId}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}-html`;

const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project-a', 'Alpha', '/work/alpha', '[]', '2026-01-01', '2026-01-01', NULL)
  `;
  const thread = (
    threadId: string,
    title: string,
    extra: { archived?: boolean; deleted?: boolean },
  ) =>
    sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (${threadId}, 'project-a', ${title}, 'codex', 'full-access', 'default',
        '2026-01-01', '2026-01-01', ${extra.archived ? "2026-01-09" : null},
        ${extra.deleted ? "2026-01-09" : null}, '{"providerInstanceId":"codex"}')
    `;
  yield* thread("thread-a", "Charts", {});
  yield* thread("thread-b", "Mockups", { archived: true });
  yield* thread("thread-fork", "Charts (fork)", {});
  yield* thread("thread-gone", "Deleted", { deleted: true });
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES ('run-undone', 'thread-a', 9, 'codex', 'rolled_back', '2026-01-01', '{}')
  `;
  const item = (input: {
    readonly itemId: string;
    readonly threadId: string;
    readonly completedAt: string;
    readonly htmlRender: Record<string, unknown>;
    readonly toolName?: string;
    readonly runId?: string;
  }) =>
    sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${input.itemId}, ${input.threadId}, ${input.runId ?? null}, 0, 'dynamic_tool',
        'completed', ${input.completedAt}, ${JSON.stringify({
          toolName: input.toolName ?? "mcp__t3-code__html_render",
          completedAt: input.completedAt,
          output: { structuredContent: { htmlRender: input.htmlRender } },
        })})
    `;
  const render = (threadId: string, n: number, title: string, revises?: number) => ({
    attachmentId: pageId(threadId, n),
    title,
    height: 400,
    ...(revises === undefined ? {} : { revises: pageId(threadId, revises) }),
  });
  yield* item({
    itemId: "a1",
    threadId: "thread-a",
    completedAt: "2026-01-02",
    htmlRender: render("thread-a", 1, "Revenue v1"),
  });
  yield* item({
    itemId: "b1",
    threadId: "thread-b",
    completedAt: "2026-01-03",
    htmlRender: render("thread-b", 1, "Settings mockup"),
  });
  yield* item({
    itemId: "a2",
    threadId: "thread-a",
    completedAt: "2026-01-04",
    htmlRender: render("thread-a", 2, "Revenue v2", 1),
  });
  // A fork repeats its source's page, which still belongs to thread-a.
  yield* item({
    itemId: "fork-a2",
    threadId: "thread-fork",
    completedAt: "2026-01-05",
    htmlRender: render("thread-a", 2, "Revenue v2", 1),
  });
  yield* item({
    itemId: "gone1",
    threadId: "thread-gone",
    completedAt: "2026-01-06",
    htmlRender: render("thread-gone", 1, "Deleted page"),
  });
  yield* item({
    itemId: "undone1",
    threadId: "thread-a",
    runId: "run-undone",
    completedAt: "2026-01-07",
    htmlRender: render("thread-a", 3, "Rolled back"),
  });
  yield* item({
    itemId: "other-tool",
    threadId: "thread-a",
    toolName: "mcp__t3-code__preview_snapshot",
    completedAt: "2026-01-08",
    htmlRender: render("thread-a", 4, "Not a page"),
  });
});

const listAfterSeed = (limit: number) =>
  Effect.gen(function* () {
    yield* seed;
    const library = yield* HtmlRenderLibrary.HtmlRenderLibrary;
    return yield* library.list({ limit });
  }).pipe(Effect.provide(testLayer));

it.effect("lists each live thread's newest page version, newest first", () =>
  Effect.gen(function* () {
    const result = yield* listAfterSeed(10);
    assert.deepStrictEqual(result, {
      renders: [
        {
          attachmentId: pageId("thread-a", 2),
          title: "Revenue v2",
          height: 400,
          versions: 2,
          threadId: ThreadId.make("thread-a"),
          threadTitle: "Charts",
          archived: false,
          projectId: ProjectId.make("project-a"),
          projectTitle: "Alpha",
          providerInstanceId: ProviderInstanceId.make("codex"),
          publishedAt: "2026-01-04",
        },
        {
          attachmentId: pageId("thread-b", 1),
          title: "Settings mockup",
          height: 400,
          versions: 1,
          threadId: ThreadId.make("thread-b"),
          threadTitle: "Mockups",
          archived: true,
          projectId: ProjectId.make("project-a"),
          projectTitle: "Alpha",
          providerInstanceId: ProviderInstanceId.make("codex"),
          publishedAt: "2026-01-03",
        },
      ],
      truncated: false,
    });
  }),
);

it.effect("marks the list truncated when more pages exist than the limit", () =>
  Effect.gen(function* () {
    const result = yield* listAfterSeed(1);
    assert.deepStrictEqual(
      result.renders.map((page) => page.attachmentId),
      [pageId("thread-a", 2)],
    );
    assert.isTrue(result.truncated);
  }),
);
