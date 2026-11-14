import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonNegativeInt, ScheduledTaskId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_THREAD_FOLDER_LENGTH = 60;
/** How many folders one environment keeps saved. */
export const MAX_SAVED_THREAD_FOLDERS = 100;

/** A sidebar folder such as "Autopilot". A scheduled task's group is the folder of its chats. */
export const ThreadFolder = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_THREAD_FOLDER_LENGTH),
);
export type ThreadFolder = typeof ThreadFolder.Type;

/** A folder read back from storage or a peer. Lenient so a later folder rule never fails a whole thread. */
export const StoredThreadFolder = Schema.NullOr(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

/** Names match ignoring case and repeated spaces, so "Machine care" and "machine  Care" are one folder. */
export function threadFolderKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** The key of an optional folder name, or null when it names no folder. */
export function threadFolderKeyOf(folder: string | null | undefined): string | null {
  return folder?.trim() ? threadFolderKey(folder) : null;
}

/** Whether two optional folder names are the same folder; no folder matches only no folder. */
export function sameThreadFolder(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return threadFolderKeyOf(left) === threadFolderKeyOf(right);
}

/**
 * The saved folders after a save: `folders` in their order, then the saved ones they leave out.
 * Saving never drops a folder, so two clients saving at once both keep theirs.
 */
export function saveThreadFolders(
  saved: ReadonlyArray<string>,
  folders: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const name of [...folders, ...saved]) {
    const key = threadFolderKeyOf(name);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    next.push(name.trim());
  }
  return next;
}

/**
 * Renames a saved folder in place, or drops it with a null `to`. A rename onto another saved
 * folder merges the two at the first one's place.
 */
export function renameSavedThreadFolder(
  saved: ReadonlyArray<string>,
  from: string,
  to: string | null,
): ReadonlyArray<string> {
  const fromKey = threadFolderKeyOf(from);
  const toKey = to === null ? null : threadFolderKeyOf(to);
  const next: string[] = [];
  let placed = false;
  for (const entry of saved) {
    const key = threadFolderKeyOf(entry);
    if (key === null) continue;
    if (key !== fromKey && key !== toKey) {
      next.push(entry);
    } else if (toKey !== null && !placed) {
      next.push(to!.trim());
      placed = true;
    }
  }
  return next;
}

/** The saved folders as stored. Lenient so one name a later rule refuses never drops the rest. */
export const StoredSavedThreadFolders = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, ReadonlyArray<unknown>>({
      decode: (values) =>
        values.filter((value): value is string => typeof value === "string" && !!value.trim()),
      encode: (values) => values,
    }),
  ),
);

/**
 * Saves folders on one environment, so they stay while empty and keep their order: these first,
 * in this order, then the ones already saved that this leaves out.
 */
export const ThreadFolderSaveInput = Schema.Struct({
  folders: Schema.Array(ThreadFolder).check(Schema.isMaxLength(MAX_SAVED_THREAD_FOLDERS)),
});
export type ThreadFolderSaveInput = typeof ThreadFolderSaveInput.Type;

export const ThreadFolderSaveResult = Schema.Struct({
  /** The environment's saved folders after the change, in order. */
  folders: Schema.Array(Schema.String),
});
export type ThreadFolderSaveResult = typeof ThreadFolderSaveResult.Type;

/** Renames a folder on one environment, or removes it with a null `to`. */
export const ThreadFolderRenameInput = Schema.Struct({
  from: ThreadFolder,
  /** Null takes every thread out of the folder and clears the group of its scheduled tasks. */
  to: Schema.NullOr(ThreadFolder),
});
export type ThreadFolderRenameInput = typeof ThreadFolderRenameInput.Type;

export const ThreadFolderRenameResult = Schema.Struct({
  /** The threads that moved, archived ones included. */
  threadIds: Schema.Array(ThreadId),
  /** The scheduled tasks whose group changed. */
  taskIds: Schema.Array(ScheduledTaskId),
  /** The event sequence once every thread moved; 0 when none did. */
  sequence: NonNegativeInt,
  /** The environment's saved folders after the change, in order. */
  folders: Schema.Array(Schema.String),
});
export type ThreadFolderRenameResult = typeof ThreadFolderRenameResult.Type;

export class ThreadFolderError extends Schema.TaggedError<ThreadFolderError>()(
  "ThreadFolderError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
