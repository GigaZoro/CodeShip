import {
  CommandId,
  MAX_SAVED_THREAD_FOLDERS,
  ThreadFolderError,
  type ThreadFolderRenameInput,
  type ThreadFolderRenameResult,
  type ThreadFolderSaveInput,
  type ThreadFolderSaveResult,
  ThreadId,
  renameSavedThreadFolder,
  sameThreadFolder,
  saveThreadFolders,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadFolderService extends Context.Service<
  ThreadFolderService,
  {
    /**
     * Renames a folder on this environment, or removes it with a null `to`: every thread in it,
     * archived ones included, moves, and so do the group of each scheduled task named for it and
     * the saved folder. Running it again finishes a partial move.
     */
    readonly rename: (
      input: ThreadFolderRenameInput,
      by: ScheduledTaskService.ScheduledTaskChanger,
    ) => Effect.Effect<ThreadFolderRenameResult, ThreadFolderError>;
    /** Saves folders so they stay while empty and keep their order; it never drops one. */
    readonly save: (
      input: ThreadFolderSaveInput,
    ) => Effect.Effect<ThreadFolderSaveResult, ThreadFolderError>;
  }
>()("t3/orchestration-v2/ThreadFolderService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;

  const fail = (message: string) => (cause: unknown) => new ThreadFolderError({ message, cause });

  // The change reads the list under the settings write lock, so changes from two clients both land.
  const changeSaved = Effect.fn("ThreadFolderService.changeSaved")(function* (
    change: (saved: ReadonlyArray<string>) => ReadonlyArray<string>,
  ) {
    let tooMany = false;
    const stored = yield* settings
      .updateSettings(
        {},
        {
          prepare: (current) =>
            Effect.sync(() => {
              const next = change(current.threadFolders);
              tooMany = next.length > MAX_SAVED_THREAD_FOLDERS;
              const same =
                next.length === current.threadFolders.length &&
                next.every((name, index) => name === current.threadFolders[index]);
              return tooMany || same ? undefined : { patch: {}, replace: { threadFolders: next } };
            }),
        },
      )
      .pipe(Effect.mapError(fail("Could not save the folders.")));
    if (tooMany) {
      return yield* new ThreadFolderError({
        message: `A machine keeps at most ${MAX_SAVED_THREAD_FOLDERS} folders.`,
      });
    }
    return stored.threadFolders;
  });

  const rename: ThreadFolderService["Service"]["rename"] = Effect.fn("ThreadFolderService.rename")(
    function* (input, by) {
      // Candidates are narrowed to threads with a folder in SQL; the name match is in JS because
      // names match ignoring case and repeated spaces.
      const candidates = yield* sql<{ readonly thread_id: string; readonly folder: string }>`
        SELECT thread_id, json_extract(payload_json, '$.folder') AS folder
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.folder') IS NOT NULL
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(fail("Could not list the threads in the folder.")),
      );
      const threadIds: ThreadId[] = [];
      let sequence = 0;
      for (const candidate of candidates) {
        if (!sameThreadFolder(candidate.folder, input.from)) continue;
        const threadId = ThreadId.make(candidate.thread_id);
        // `from` leaves a thread that was moved out of the folder since the read where it went.
        const dispatched = yield* crypto.randomUUIDv4().pipe(
          Effect.flatMap((uuid) =>
            threads.dispatch({
              type: "thread.folder.set",
              commandId: CommandId.make(`thread-folder-rename:${uuid}`),
              threadId,
              folder: input.to,
              from: input.from,
            }),
          ),
          Effect.map((result) => result.sequence),
          Effect.catchIf(Orchestrator.isStaleDispatchError, () => Effect.succeed(null)),
          Effect.tapError((cause) =>
            Effect.logWarning("Could not move a thread to its renamed folder", { threadId, cause }),
          ),
          Effect.mapError(fail("Could not move a thread to the folder.")),
        );
        if (dispatched === null) continue;
        sequence = Math.max(sequence, dispatched);
        threadIds.push(threadId);
      }

      const { tasks } = yield* scheduledTasks
        .list({ resolveModels: false })
        .pipe(Effect.mapError(fail("Could not list the scheduled tasks.")));
      const taskIds: Array<(typeof tasks)[number]["id"]> = [];
      for (const task of tasks) {
        if (!sameThreadFolder(task.group, input.from)) continue;
        yield* scheduledTasks.setGroup({ id: task.id, group: input.to }, by).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Could not move a scheduled task to its renamed folder", {
              taskId: task.id,
              cause,
            }),
          ),
          Effect.mapError(fail("Could not move a scheduled task to the folder.")),
        );
        taskIds.push(task.id);
      }
      // Last, so a move that fails part way leaves the folder saved beside its remaining threads.
      const folders = yield* changeSaved((saved) =>
        renameSavedThreadFolder(saved, input.from, input.to),
      );
      return { threadIds, taskIds, sequence, folders };
    },
  );

  const save: ThreadFolderService["Service"]["save"] = Effect.fn("ThreadFolderService.save")(
    function* (input) {
      return { folders: yield* changeSaved((saved) => saveThreadFolders(saved, input.folders)) };
    },
  );

  return ThreadFolderService.of({ rename, save });
});

export const layer = Layer.effect(ThreadFolderService, make);
