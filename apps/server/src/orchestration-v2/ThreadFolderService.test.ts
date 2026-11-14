import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { MAX_SAVED_THREAD_FOLDERS, ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadFolderService from "./ThreadFolderService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const SAVED = ["Other", "autopilot", "Ideas"];

it.effect(
  "renaming a folder moves its threads, tasks and saved place, archived ones included, and leaves a thread moved meanwhile",
  () =>
    Effect.gen(function* () {
      const dispatched: Array<{
        threadId: string;
        folder: string | null;
        from: string | null | undefined;
      }> = [];
      const taskMoves: Array<{ id: string; group: string | null; by: unknown }> = [];
      let sequence = 10;
      const layer = ThreadFolderService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.ServerSettingsService.layerTest({ threadFolders: SAVED }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              dispatch: (command) =>
                // The user moved this thread out of the folder after the rename read it.
                command.type === "thread.folder.set" && command.threadId === "thread:moved"
                  ? Effect.fail(
                      new Orchestrator.OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        stale: true,
                      }),
                    )
                  : Effect.sync(() => {
                      if (command.type === "thread.folder.set") {
                        dispatched.push({
                          threadId: command.threadId,
                          folder: command.folder,
                          from: command.from,
                        });
                      }
                      sequence += 1;
                      return { sequence, storedEvents: [] };
                    }),
            }),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () =>
                Effect.succeed({
                  tasks: [
                    { id: ScheduledTaskId.make("task:in"), group: "AUTOPILOT" },
                    { id: ScheduledTaskId.make("task:out"), group: "Other" },
                  ],
                } as never),
              setGroup: ({ id, group }, by) =>
                Effect.sync(() => {
                  taskMoves.push({ id, group, by });
                }),
            }),
            NodeCrypto.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-10T12:00:00.000Z";
        const rows: ReadonlyArray<readonly [string, string | null, string | null]> = [
          ["thread:active", "autopilot", null],
          ["thread:moved", "Autopilot", null],
          ["thread:archived", "Autopilot", at],
          ["thread:other", "Other", null],
          ["thread:none", null, null],
        ];
        for (const [id, folder, archivedAt] of rows) {
          const payload = JSON.stringify(folder === null ? {} : { folder });
          yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, archived_at, payload_json
          ) VALUES (${id}, 'project-1', ${id}, 'codex', 'full-access', 'default', ${at}, ${at},
            ${archivedAt}, ${payload})
        `;
        }
        const service = yield* ThreadFolderService.ThreadFolderService;
        const result = yield* service.rename(
          { from: "Autopilot", to: null },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.deepEqual(
          { result, dispatched, taskMoves },
          {
            result: {
              threadIds: ["thread:active", "thread:archived"],
              taskIds: ["task:in"],
              sequence: 12,
              folders: ["Other", "Ideas"],
            },
            dispatched: [
              { threadId: "thread:active", folder: null, from: "Autopilot" },
              { threadId: "thread:archived", folder: null, from: "Autopilot" },
            ],
            taskMoves: [{ id: "task:in", group: null, by: ScheduledTaskService.CHANGED_IN_APP }],
          },
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("saving folders puts them first and keeps the ones it leaves out, up to the limit", () =>
  Effect.gen(function* () {
    const service = yield* ThreadFolderService.ThreadFolderService;
    const saved = yield* service.save({ folders: ["ideas", "New"] });
    const tooMany = yield* service
      .save({ folders: Array.from({ length: MAX_SAVED_THREAD_FOLDERS }, (_, i) => `F${i}`) })
      .pipe(Effect.flip);
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepEqual(
      { saved, refused: tooMany._tag, stored: (yield* settings.getSettings).threadFolders },
      {
        saved: { folders: ["ideas", "New", "Other", "autopilot"] },
        refused: "ThreadFolderError",
        stored: ["ideas", "New", "Other", "autopilot"],
      },
    );
  }).pipe(
    Effect.provide(
      ThreadFolderService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.ServerSettingsService.layerTest({ threadFolders: SAVED }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeCrypto.layer,
          ),
        ),
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);
