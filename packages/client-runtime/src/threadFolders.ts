import {
  type EnvironmentId,
  type ServerConfig,
  sameThreadFolder,
  saveThreadFolders,
  threadFolderKeyOf,
} from "@t3tools/contracts";

export interface ThreadFolderEntry {
  readonly key: string;
  /** The saved spelling, else the first thread's. */
  readonly name: string;
  /** Saved folders stay while empty; the others go with their last thread. */
  readonly saved: boolean;
}

type FolderServerConfig = Pick<ServerConfig, "environment">;

/** A server older than chat folders cannot store a folder, so its threads offer none. */
export function environmentSupportsThreadFolders(config: FolderServerConfig | undefined): boolean {
  return config?.environment.capabilities.threadFolders === true;
}

/** Whether any machine can keep folders, so creating one is offered at all. */
export function anyEnvironmentSupportsThreadFolders(
  configs: ReadonlyMap<EnvironmentId, FolderServerConfig>,
): boolean {
  return [...configs.values()].some(environmentSupportsThreadFolders);
}

/** The machines a folder change reaches: connected, new enough to keep folders, and writable here. */
export function threadFolderTargets(input: {
  readonly configs: ReadonlyMap<EnvironmentId, FolderServerConfig>;
  readonly connected: Iterable<EnvironmentId>;
  readonly canWrite: (environmentId: EnvironmentId) => boolean;
}): ReadonlyArray<EnvironmentId> {
  const connected = new Set(input.connected);
  return [...input.configs].flatMap(([environmentId, config]) =>
    connected.has(environmentId) &&
    environmentSupportsThreadFolders(config) &&
    input.canWrite(environmentId)
      ? [environmentId]
      : [],
  );
}

/** A thread as a folder rename leaves it: one in `from` moves to `to`, the others stay. */
export function renameThreadFolderOf<T extends { readonly folder?: string | null | undefined }>(
  thread: T,
  rename: { readonly from: string; readonly to: string | null },
): T {
  return sameThreadFolder(thread.folder, rename.from) ? { ...thread, folder: rename.to } : thread;
}

/** One list of the folders each machine saved: the first machine's order, then what others add. */
export function mergeSavedThreadFolders(
  lists: Iterable<ReadonlyArray<string>>,
): ReadonlyArray<string> {
  let merged: ReadonlyArray<string> = [];
  for (const list of lists) merged = saveThreadFolders(list, merged);
  return merged;
}

/** Sidebar folders: the saved ones in their order, then those only threads name, by name. */
export function resolveThreadFolders(
  saved: ReadonlyArray<string>,
  threadFolders: Iterable<string | null | undefined>,
): ReadonlyArray<ThreadFolderEntry> {
  const entries: ThreadFolderEntry[] = [];
  const seen = new Set<string>();
  for (const name of saved) {
    const key = threadFolderKeyOf(name);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, name: name.trim(), saved: true });
  }
  const named: ThreadFolderEntry[] = [];
  for (const name of threadFolders) {
    const key = threadFolderKeyOf(name);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    named.push({ key, name: name!.trim(), saved: false });
  }
  named.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }),
  );
  return [...entries, ...named];
}

/** Saves a folder at the end of the list; a name already saved, in any case, changes nothing. */
export function addSavedThreadFolder(
  saved: ReadonlyArray<string>,
  name: string,
): ReadonlyArray<string> {
  const key = threadFolderKeyOf(name);
  if (key === null || saved.some((entry) => threadFolderKeyOf(entry) === key)) return saved;
  return [...saved, name.trim()];
}

/** Moves a folder one place up or down; the whole order is saved, so the folder stays when empty. */
export function moveThreadFolder(
  folders: ReadonlyArray<ThreadFolderEntry>,
  key: string,
  offset: -1 | 1,
): ReadonlyArray<string> {
  const names = folders.map((folder) => folder.name);
  const index = folders.findIndex((folder) => folder.key === key);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= names.length) return names;
  [names[index], names[target]] = [names[target]!, names[index]!];
  return names;
}
