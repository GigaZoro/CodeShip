import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedScheduledTasks from "./LinkedScheduledTasks.ts";

const PEER = EnvironmentId.make("environment-peer");
const PROJECT = ProjectId.make("project-polybot");

const peerTask = {
  scheduledTaskId: ScheduledTaskId.make("scheduled-task:reviewer"),
  title: "PR Reviewer",
  prompt: "Review open pull requests",
  enabled: true,
  projectId: PROJECT,
  boundThreadId: null,
  schedule: { type: "interval", everyMs: 1_800_000 },
  nextRunAt: "2026-11-07T15:30:00.000Z",
  lastRunStatus: "succeeded",
  lastRun: { at: "2026-11-07T15:00:00.000Z", outcome: "completed" },
  // A later skip is not a run, so it leaves "last run" alone.
  lastSkipped: {
    at: "2026-11-07T15:30:00.000Z",
    scheduledFor: "2026-11-07T15:30:00.000Z",
    reason: "No open pull requests",
  },
};

/** One linked machine, stored as a real link row, that answers while `online` holds. */
const peerLayer = (sql: SqlClient.SqlClient, online: Ref.Ref<boolean>) =>
  Layer.mergeAll(
    Layer.mock(PeerLinks.PeerLinks)({
      enabled: Effect.succeed(true),
      listStored: sql<{ readonly environment_id: string }>`
        SELECT environment_id FROM peer_environment_links
      `.pipe(
        Effect.map((rows) =>
          rows.map(
            (row) =>
              ({
                environmentId: EnvironmentId.make(row.environment_id),
                expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
              }) as never,
          ),
        ),
        Effect.orDie,
      ),
    }),
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: ((input: { readonly tool: string }) =>
        Effect.flatMap(Ref.get(online), (answers) =>
          !answers
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Zoro-PC did not answer.",
                }),
              )
            : Effect.succeed(
                input.tool === "t3_project_list"
                  ? { projects: [{ id: PROJECT, title: "PolyBot" }], nextCursor: null }
                  : { tasks: [peerTask] },
              ),
        )) as never,
    }),
  );

it.effect("keeps a linked machine's tasks while it is offline, until its link is removed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const online = yield* Ref.make(true);
    yield* sql`
      INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
      VALUES (${PEER}, 'peer-link-secret', 'Zoro-PC', '[]', 'auto',
        '2026-11-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')
    `;

    yield* Effect.gen(function* () {
      const service = yield* LinkedScheduledTasks.LinkedScheduledTasks;
      const machines = service.subscribe().pipe(
        Stream.runHead,
        Effect.map((first) => (Option.isSome(first) ? first.value.machines : [])),
      );

      yield* service.refresh;
      const answered = yield* machines;
      expect(answered).toMatchObject([
        {
          environmentId: PEER,
          label: "Zoro-PC",
          error: null,
          tasks: [
            {
              title: "PR Reviewer",
              projectTitle: "PolyBot",
              lastRunAt: "2026-11-07T15:00:00.000Z",
              lastNoWorkSkip: peerTask.lastSkipped,
              shared: false,
            },
          ],
        },
      ]);

      yield* Ref.set(online, false);
      yield* TestClock.adjust("2 minutes");
      yield* service.refresh;
      const offline = yield* machines;
      expect(offline[0]).toMatchObject({
        error: "Zoro-PC did not answer.",
        seenAt: answered[0]!.seenAt,
        tasks: answered[0]!.tasks,
      });
      expect(offline[0]!.checkedAt).not.toBe(answered[0]!.checkedAt);

      yield* sql`DELETE FROM peer_environment_links`;
      yield* service.refresh;
      expect(yield* machines).toEqual([]);
    }).pipe(Effect.provide(LinkedScheduledTasks.layer.pipe(Layer.provide(peerLayer(sql, online)))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
