import type { ManualStep, ManualStepKind, ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";

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

const CHAT_LINE = /^\s*chat:.*?(t3-thread:\/\/v2\/[^\s<>()[\]]+)/i;

function chatOf(line: string): ScopedThreadRef | null {
  const href = CHAT_LINE.exec(line)?.[1];
  const link = href === undefined ? null : parseThreadLinkHref(href);
  return link?.environmentId == null
    ? null
    : { environmentId: link.environmentId, threadId: link.threadId };
}

/** Agents add `Chat: <t3-thread://v2/…>` to a step's description; a line that does not parse stays text. */
function splitChat(description: string): {
  readonly chat: ScopedThreadRef | null;
  readonly rest: string;
} {
  const lines = description.split("\n");
  for (const [index, line] of lines.entries()) {
    const chat = chatOf(line);
    if (chat !== null) return { chat, rest: lines.toSpliced(index, 1).join("\n") };
  }
  return { chat: null, rest: description };
}

/** A step's kind comes from its description's prefix, else its title's; unmarked steps are hands-on. */
function parseManualStep(input: {
  readonly title: string;
  readonly description: string;
}): Pick<ManualStep, "kind" | "step" | "title" | "chat"> {
  const title = splitPrefix(oneLine(input.title));
  const { chat, rest } = splitChat(input.description);
  const description = splitPrefix(oneLine(rest));
  return {
    kind: description.kind ?? title.kind ?? "hands-on",
    step: description.rest || title.rest,
    title: title.rest,
    ...(chat === null ? {} : { chat }),
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

export interface ThreadPageNoteSummary {
  readonly id: string;
  readonly created_at: string;
  readonly trashed: boolean;
}

export interface ThreadPageNote {
  readonly createdAt: string;
  readonly markdown: string;
}

const RECENT_NOTE_COUNT = 3;
const NOTE_CHAR_LIMIT = 8_000;
const NOTES_CHAR_LIMIT = 24_000;

/** The notes worth reading: the first one (the work order) and the newest few, oldest first. */
export function selectNotesToRead(
  notes: ReadonlyArray<ThreadPageNoteSummary>,
): ReadonlyArray<string> {
  const ordered = notes
    .filter((note) => !note.trashed)
    .toSorted((a, b) => a.created_at.localeCompare(b.created_at));
  const first = ordered.slice(0, 1);
  const recent = ordered.slice(Math.max(1, ordered.length - RECENT_NOTE_COUNT));
  return [...first, ...recent].map((note) => note.id);
}

const capNote = (note: ThreadPageNote): ThreadPageNote => ({
  createdAt: note.createdAt,
  markdown:
    note.markdown.length > NOTE_CHAR_LIMIT
      ? `${note.markdown.slice(0, NOTE_CHAR_LIMIT - 1)}…`
      : note.markdown,
});

/**
 * Caps each note, then the set. The oldest note (the work order) and the newest always stay;
 * the middle notes fill the rest of the budget, newest first.
 */
export function limitNotes(notes: ReadonlyArray<ThreadPageNote>): ReadonlyArray<ThreadPageNote> {
  const ordered = notes.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).map(capNote);
  if (ordered.length <= 2) return ordered;
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  let budget = NOTES_CHAR_LIMIT - first.markdown.length - last.markdown.length;
  const middle: ThreadPageNote[] = [];
  for (const note of ordered.slice(1, -1).toReversed()) {
    if (note.markdown.length > budget) continue;
    middle.push(note);
    budget -= note.markdown.length;
  }
  return [first, ...middle.toReversed(), last];
}
