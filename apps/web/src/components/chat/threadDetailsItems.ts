import type { ClientSettings } from "@t3tools/contracts";
import { msg } from "~/i18n";

// Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: msg("Environment and worktree"), defaultVisible: true },
  { id: "openIn", label: msg("Open in editor"), defaultVisible: true },
  { id: "scripts", label: msg("Project scripts"), defaultVisible: true },
  { id: "assistants", label: msg("Web assistants"), defaultVisible: true },
  { id: "branch", label: msg("Branch and pull request"), defaultVisible: true },
  { id: "gitActions", label: msg("Git actions"), defaultVisible: false },
  { id: "changes", label: msg("Changes"), defaultVisible: true },
  { id: "status", label: msg("Agent status"), defaultVisible: true },
  { id: "context", label: msg("Context window"), defaultVisible: true },
  { id: "usage", label: msg("Usage limits"), defaultVisible: true },
  { id: "tasks", label: msg("Tasks"), defaultVisible: true },
  { id: "lineage", label: msg("Lineage"), defaultVisible: true },
  { id: "sideChats", label: msg("Side chats"), defaultVisible: true },
  { id: "outline", label: msg("Your prompts"), defaultVisible: true },
  { id: "machineLoad", label: msg("Machine load"), defaultVisible: true },
  { id: "servers", label: msg("Servers"), defaultVisible: true },
  { id: "automations", label: msg("Automations"), defaultVisible: true },
  { id: "agentActions", label: msg("Ask the agent"), defaultVisible: false },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

// A draft has no run yet, so it shows only the controls for choosing where it runs.
const DRAFT_THREAD_DETAILS_ITEMS: ReadonlySet<ThreadDetailsItemId> = new Set([
  "environment",
  "branch",
]);

type ThreadDetailsItem = (typeof THREAD_DETAILS_ITEMS)[number];
type ThreadDetailsItemSettings = Pick<ClientSettings, "threadDetailsItems">;

export function resolveThreadDetailsVisibility(
  settings: ThreadDetailsItemSettings,
): ThreadDetailsVisibility {
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      settings.threadDetailsItems[item.id] ?? item.defaultVisible,
    ]),
  ) as Record<ThreadDetailsItemId, boolean>;
}

/** The items a thread's card shows: a draft keeps only the chosen ones that pick where it runs. */
export function threadDetailsVisibilityFor(
  visibility: ThreadDetailsVisibility,
  isDraft: boolean,
): ThreadDetailsVisibility {
  if (!isDraft) return visibility;
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      visibility[item.id] && DRAFT_THREAD_DETAILS_ITEMS.has(item.id),
    ]),
  ) as Record<ThreadDetailsItemId, boolean>;
}

/** Stores only choices that differ from the default, so a later default change reaches everyone else. */
export function setThreadDetailsItem(
  settings: ThreadDetailsItemSettings,
  item: ThreadDetailsItem,
  visible: boolean,
): ClientSettings["threadDetailsItems"] {
  const { [item.id]: _previous, ...rest } = settings.threadDetailsItems;
  return visible === item.defaultVisible ? rest : { ...rest, [item.id]: visible };
}

export function isDefaultThreadDetailsVisibility(visibility: ThreadDetailsVisibility) {
  return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
} satisfies Partial<ClientSettings>;
