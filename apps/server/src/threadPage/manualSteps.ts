import type { ManualStep, ManualStepKind } from "@t3tools/contracts";

/** Agents keep each machine's pending list in `Work/Agent Maintenance/Machine inbox/<machine>`. */
const MACHINE_INBOX_FOLDER_NAME = "Machine inbox";
const MACHINE_INBOX_PARENT_NAME = "Agent Maintenance";
/** ThreadPage's built-in Waiting status keeps this key when the person renames it. */
const WAITING_STATUS = "waiting";

export interface ThreadPageFolder {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly trashed: boolean;
}

export interface ThreadPageThread {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: string;
  readonly archived: boolean;
  readonly trashed: boolean;
  readonly last_activity_at: string;
}

export function findMachineInbox(
  folders: ReadonlyArray<ThreadPageFolder>,
): ThreadPageFolder | null {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const candidates = folders.filter(
    (folder) => !folder.trashed && folder.name === MACHINE_INBOX_FOLDER_NAME,
  );
  return (
    candidates.find(
      (folder) =>
        folder.parent_id !== null && byId.get(folder.parent_id)?.name === MACHINE_INBOX_PARENT_NAME,
    ) ??
    candidates[0] ??
    null
  );
}

/**
 * Every folder below the inbox, by id, with its machine: the name of the inbox's subfolder it
 * sits in. A new machine's folder counts without any change here.
 */
export function machineFolders(
  folders: ReadonlyArray<ThreadPageFolder>,
  inboxId: string,
): ReadonlyMap<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result = new Map<string, string>();
  for (const folder of folders) {
    const seen = new Set<string>();
    let current: ThreadPageFolder | undefined = folder;
    while (current !== undefined && !current.trashed && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parent_id === inboxId) {
        result.set(folder.id, current.name);
        break;
      }
      current = current.parent_id === null ? undefined : byId.get(current.parent_id);
    }
  }
  return result;
}

const PREFIXES: ReadonlyArray<readonly [ManualStepKind, RegExp]> = [
  ["needs-you", /^needs you:\s*/i],
  ["hands-on", /^hands-on:\s*/i],
];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function splitPrefix(text: string): {
  readonly kind: ManualStepKind | null;
  readonly rest: string;
} {
  for (const [kind, prefix] of PREFIXES) {
    const match = prefix.exec(text);
    if (match) return { kind, rest: text.slice(match[0].length) };
  }
  return { kind: null, rest: text };
}

/** A step's kind comes from its description's prefix, else its title's; unmarked steps are hands-on. */
function parseManualStep(input: {
  readonly title: string;
  readonly description: string;
}): Pick<ManualStep, "kind" | "step" | "title"> {
  const title = splitPrefix(oneLine(input.title));
  const description = splitPrefix(oneLine(input.description));
  return {
    kind: description.kind ?? title.kind ?? "hands-on",
    step: description.rest || title.rest,
    title: title.rest,
  };
}

const threadPageThreadUrl = (threadId: string) =>
  `https://thread.page/app/threads/${encodeURIComponent(threadId)}`;

/** The Waiting threads of each machine folder, as manual steps. */
export function selectManualSteps(
  threadsByFolder: ReadonlyArray<{
    readonly machine: string;
    readonly threads: ReadonlyArray<ThreadPageThread>;
  }>,
): ReadonlyArray<ManualStep> {
  const steps = new Map<string, ManualStep>();
  for (const { machine, threads } of threadsByFolder) {
    for (const thread of threads) {
      if (thread.status !== WAITING_STATUS || thread.archived || thread.trashed) continue;
      steps.set(thread.id, {
        threadId: thread.id,
        ...parseManualStep({ title: thread.title, description: thread.description ?? "" }),
        machine,
        updatedAt: thread.last_activity_at,
        url: threadPageThreadUrl(thread.id),
      });
    }
  }
  return [...steps.values()];
}
