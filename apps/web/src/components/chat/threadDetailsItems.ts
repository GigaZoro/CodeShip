import type { ClientSettings } from "@t3tools/contracts";
import { msg } from "~/i18n";

// Ids are stored in client settings, so never rename one. Settings keep only choices that differ
// from these defaults, so a changed default reaches everyone who never touched that item.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: msg("Environment and worktree"), defaultVisible: true },
  { id: "openIn", label: msg("Open in editor"), defaultVisible: false },
  { id: "scripts", label: msg("Project scripts"), defaultVisible: false },
  { id: "assistants", label: msg("Web assistants"), defaultVisible: false },
  { id: "branch", label: msg("Branch and pull request"), defaultVisible: true },
  { id: "gitActions", label: msg("Git actions"), defaultVisible: false },
  { id: "changes", label: msg("Changes"), defaultVisible: true },
  { id: "status", label: msg("Agent status"), defaultVisible: true },
  { id: "context", label: msg("Context window"), defaultVisible: true },
  { id: "usage", label: msg("Usage limits"), defaultVisible: false },
  { id: "tasks", label: msg("Tasks"), defaultVisible: true },
  { id: "lineage", label: msg("Lineage"), defaultVisible: true },
  { id: "sideChats", label: msg("Side chats"), defaultVisible: false },
  { id: "outline", label: msg("Your prompts"), defaultVisible: false },
  { id: "machineLoad", label: msg("Machine load"), defaultVisible: false },
  { id: "servers", label: msg("Servers"), defaultVisible: false },
  { id: "automations", label: msg("Automations"), defaultVisible: false },
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

export const THREAD_DETAILS_PRESETS = [
  {
    id: "essentials",
    label: msg("Essentials"),
    items: THREAD_DETAILS_ITEMS.filter((item) => item.defaultVisible).map((item) => item.id),
  },
  {
    id: "review",
    label: msg("Review"),
    items: ["branch", "changes", "gitActions"] satisfies ThreadDetailsItemId[],
  },
  { id: "debug", label: msg("Debug"), items: THREAD_DETAILS_ITEMS.map((item) => item.id) },
] as const satisfies ReadonlyArray<{
  id: string;
  label: unknown;
  items: ReadonlyArray<ThreadDetailsItemId>;
}>;

export type ThreadDetailsPreset = (typeof THREAD_DETAILS_PRESETS)[number];

/** The stored choices that make the card show exactly the preset's items. */
export function threadDetailsItemsForPreset(
  preset: ThreadDetailsPreset,
): ClientSettings["threadDetailsItems"] {
  const shown = new Set<ThreadDetailsItemId>(preset.items);
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.flatMap((item) =>
      shown.has(item.id) === item.defaultVisible ? [] : [[item.id, shown.has(item.id)]],
    ),
  );
}

export function matchingThreadDetailsPreset(
  visibility: ThreadDetailsVisibility,
): ThreadDetailsPreset | null {
  return (
    THREAD_DETAILS_PRESETS.find((preset) => {
      const shown = new Set<ThreadDetailsItemId>(preset.items);
      return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === shown.has(item.id));
    }) ?? null
  );
}
