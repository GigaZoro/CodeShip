import { useAtomValue } from "@effect/atom-react";
import { olderSettledFolderNames } from "@t3tools/client-runtime/state/threads";
import { resolveThreadFolders } from "@t3tools/client-runtime/thread-folders";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentThreadShells, olderSettledThreads, savedThreadFoldersAtom } from "./threads";

const NAME_SEPARATOR = "\u0000";

/**
 * The saved folders and those that have chats, older ones not loaded too, by name, as one string:
 * atoms compare strings by value, so rows that read this rerender only when the folders change,
 * not on every thread update.
 */
const threadFolderNamesKeyAtom = Atom.make((get): string => {
  const threads = get(environmentThreadShells.threadShellsAtom);
  const names = threads.flatMap((thread) => (thread.archivedAt === null ? [thread.folder] : []));
  // A machine with older settled chats holds its newest settled ones, so its shells name it.
  const olderNames = olderSettledFolderNames({
    olderSettled: (environmentId) => get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(threads.map((thread) => thread.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: null,
    })),
  });
  return resolveThreadFolders(get(savedThreadFoldersAtom), [...names, ...olderNames])
    .map((entry) => entry.name)
    .join(NAME_SEPARATOR);
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-folders:names"));

/** The folders saved on every machine, which show while empty. */
export function useSavedThreadFolders(): ReadonlyArray<string> {
  return useAtomValue(savedThreadFoldersAtom);
}

/** Folder names saved or in use on any connected machine, in sidebar order. */
export function useThreadFolderNames(): ReadonlyArray<string> {
  const key = useAtomValue(threadFolderNamesKeyAtom);
  return useMemo(() => (key.length === 0 ? [] : key.split(NAME_SEPARATOR)), [key]);
}
