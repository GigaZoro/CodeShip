import {
  OrchestrationV2ListHtmlRendersError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2HtmlRenderList,
  type OrchestrationV2ListHtmlRendersInput,
} from "@t3tools/contracts";
import { HTML_RENDER_TOOL_NAME, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

// Bounds the read for users with thousands of pages; revisions and forks collapse after it.
const SCAN_LIMIT = 1000;

const RenderRow = Schema.Struct({
  threadId: ThreadId,
  toolName: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.String),
  publishedAt: Schema.String,
  threadTitle: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  projectId: ProjectId,
  projectTitle: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  hiddenArtifacts: Schema.NullOr(Schema.String),
  runStatus: Schema.NullOr(Schema.String),
});
type RenderRow = typeof RenderRow.Type;

const isProviderInstanceId = Schema.is(ProviderInstanceId);

const parseOutput = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A payload too malformed to parse has no page to list.
    return undefined;
  }
};

interface PublishedPage {
  readonly row: RenderRow;
  readonly reference: HtmlRenderReference;
}

const hiddenIds = (row: RenderRow): ReadonlySet<string> => {
  const parsed = parseOutput(row.hiddenArtifacts);
  return new Set(
    Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
  );
};

/** Rows newest first; keeps each thread's own pages and only the newest version of each. */
function collectHtmlRenders(
  rows: ReadonlyArray<RenderRow>,
  limit: number,
): OrchestrationV2HtmlRenderList {
  const pages = rows.flatMap((row): Array<PublishedPage> => {
    const reference = htmlRenderFromToolItem({
      toolName: row.toolName,
      output: parseOutput(row.output),
    });
    // A fork repeats its source thread's items; a page belongs to the thread that published it.
    return reference !== undefined &&
      parseThreadSegmentFromAttachmentId(reference.attachmentId) ===
        toSafeThreadAttachmentSegment(row.threadId)
      ? [{ row, reference }]
      : [];
  });
  const byId = new Map(pages.map((page) => [page.reference.attachmentId, page]));
  const live = pages.filter((page) => page.row.runStatus !== "rolled_back");
  const replaced = new Set(live.flatMap((page) => page.reference.revises ?? []));
  // Ids from the page back through everything it revises, itself included.
  const chainOf = (page: PublishedPage) => {
    const seen = new Set([page.reference.attachmentId]);
    let revises = page.reference.revises;
    while (revises !== undefined && !seen.has(revises)) {
      seen.add(revises);
      revises = byId.get(revises)?.reference.revises;
    }
    return seen;
  };
  // Hiding is per thread and names the version that was newest then. The page stays hidden when a
  // later revision builds on it, and after a rollback makes an older version the newest again.
  // Every row of a thread carries the same list, so read it once per thread.
  const hidden = new Set<string>();
  const readThreads = new Set<string>();
  for (const { row } of pages) {
    if (readThreads.has(row.threadId)) continue;
    readThreads.add(row.threadId);
    for (const id of hiddenIds(row)) {
      const target = byId.get(id);
      for (const hiddenId of target === undefined ? [id] : chainOf(target)) hidden.add(hiddenId);
    }
  }
  const current = live.filter(
    (page) =>
      !replaced.has(page.reference.attachmentId) &&
      ![...chainOf(page)].some((id) => hidden.has(id)),
  );
  return {
    renders: current.slice(0, limit).map((page) => {
      const { row, reference } = page;
      return {
        attachmentId: reference.attachmentId,
        title: reference.title,
        height: reference.height,
        ...(reference.heights === undefined ? {} : { heights: reference.heights }),
        versions: chainOf(page).size,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        archived: row.archivedAt !== null,
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        providerInstanceId:
          row.providerInstanceId !== null && isProviderInstanceId(row.providerInstanceId)
            ? row.providerInstanceId
            : null,
        publishedAt: row.publishedAt,
      };
    }),
    truncated: current.length > limit || rows.length === SCAN_LIMIT,
  };
}

export class HtmlRenderLibrary extends Context.Service<
  HtmlRenderLibrary,
  {
    /** Pages agents published with html_render across every thread that still exists, minus those hidden from the gallery. */
    readonly list: (
      input: OrchestrationV2ListHtmlRendersInput,
    ) => Effect.Effect<OrchestrationV2HtmlRenderList, OrchestrationV2ListHtmlRendersError>;
  }
>()("t3/htmlRender/HtmlRenderLibrary") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const renderRows = SqlSchema.findAll({
    Request: Schema.Struct({ scanLimit: Schema.Int }),
    Result: RenderRow,
    execute: ({ scanLimit }) => sql`
      SELECT
        item.thread_id AS "threadId",
        json_extract(item.payload_json, '$.toolName') AS "toolName",
        item.payload_json -> '$.output' AS output,
        COALESCE(json_extract(item.payload_json, '$.completedAt'), item.updated_at)
          AS "publishedAt",
        threads.title AS "threadTitle",
        threads.archived_at AS "archivedAt",
        threads.project_id AS "projectId",
        projects.title AS "projectTitle",
        json_extract(threads.payload_json, '$.providerInstanceId') AS "providerInstanceId",
        json_extract(threads.payload_json, '$.hiddenArtifacts') AS "hiddenArtifacts",
        run.status AS "runStatus"
      FROM orchestration_v2_projection_turn_items AS item
      INNER JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = item.thread_id
      LEFT JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      LEFT JOIN orchestration_v2_projection_runs AS run
        ON run.run_id = item.run_id
      WHERE item.type = 'dynamic_tool'
        AND json_extract(item.payload_json, '$.toolName') LIKE ${`%${HTML_RENDER_TOOL_NAME}`}
        AND threads.deleted_at IS NULL
      ORDER BY "publishedAt" DESC, item.turn_item_id DESC
      LIMIT ${scanLimit}
    `,
  });

  const list = Effect.fn("HtmlRenderLibrary.list")(function* (
    input: OrchestrationV2ListHtmlRendersInput,
  ) {
    const rows = yield* renderRows({ scanLimit: SCAN_LIMIT }).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new OrchestrationV2ListHtmlRendersError({
            message: "Failed to list published pages",
            cause,
          }),
      ),
    );
    return collectHtmlRenders(rows, input.limit);
  });

  return HtmlRenderLibrary.of({ list });
});

export const layer = Layer.effect(HtmlRenderLibrary, make);
