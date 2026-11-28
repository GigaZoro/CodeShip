import { foldSearchQuery, rankSearchItems, scoreSearchTerms } from "@t3tools/shared/paletteSearch";

import { msg, t, type Message } from "../../lib/i18n";
import type { SettingsPageTarget } from "./components/settings-page-targets";

/** What each page holds besides its row's label, so search finds a setting by its own name. */
const SETTINGS_SEARCH_TERMS = {
  account: [msg("sign in"), msg("sign out"), msg("login"), msg("clerk"), msg("connect")],
  SettingsEnvironments: [
    msg("servers"),
    msg("connections"),
    msg("pair"),
    msg("add environment"),
    msg("remote"),
    msg("tailscale"),
  ],
  SettingsNotifications: [msg("push"), msg("alerts"), msg("live activity"), msg("agent activity")],
  SettingsAppearance: [
    msg("theme"),
    msg("dark mode"),
    msg("light mode"),
    msg("colors"),
    msg("font size"),
    msg("text size"),
    msg("code"),
    msg("diffs"),
    msg("terminal"),
    msg("word break"),
    msg("math"),
    msg("tool calls in chat"),
    msg("hide tool calls"),
    msg("commands edits searches"),
    msg("work log"),
    msg("zen"),
    msg("final answers only"),
    msg("language"),
    msg("translation"),
    msg("calm preset"),
    msg("compact"),
    msg("status colors"),
  ],
  SettingsNavigation: [msg("tabs"), msg("tab order"), msg("reorder"), msg("hide tabs")],
  SettingsKeyboard: [
    msg("return key"),
    msg("send message"),
    msg("new line"),
    msg("hardware keyboard"),
  ],
  SettingsVoice: [
    msg("microphone"),
    msg("dictation"),
    msg("transcription"),
    msg("transcribe on"),
    msg("transcription model"),
    msg("this device"),
    msg("environment"),
    msg("on-device"),
    msg("audio input"),
    msg("preferred microphone"),
    msg("microphone order"),
    msg("bluetooth"),
  ],
  SettingsCapabilities: [
    msg("mcp"),
    msg("mcp servers"),
    msg("skills"),
    msg("tools"),
    msg("extensions"),
    msg("plugins"),
  ],
  SettingsScheduledTasks: [
    msg("automations"),
    msg("schedule"),
    msg("cron"),
    msg("recurring"),
    msg("webhook"),
  ],
  SettingsMonitoring: [
    msg("process"),
    msg("chats"),
    msg("time"),
    msg("weak points"),
    msg("findings"),
    msg("analysis"),
    msg("cost"),
  ],
  SettingsMachines: [
    msg("resources"),
    msg("cpu"),
    msg("memory"),
    msg("ram"),
    msg("swap"),
    msg("disk"),
    msg("storage"),
    msg("load"),
    msg("uptime"),
    msg("servers"),
  ],
  SettingsProjectOverview: [
    msg("project"),
    msg("overview"),
    msg("checkouts"),
    msg("delete project"),
    msg("actions"),
    msg("scripts"),
    msg("t3.json"),
  ],
  SettingsOrganization: [
    msg("project grouping"),
    msg("combine matching projects"),
    msg("group projects"),
    msg("group threads"),
    msg("folders"),
    msg("by machine"),
    msg("organization"),
    msg("sidebar"),
    msg("automatically pin scheduled tasks"),
    msg("auto pin automations"),
    msg("working section"),
    msg("new threads"),
    msg("last project"),
    msg("language"),
    msg("locale"),
    msg("translation"),
    msg("english"),
  ],
  SettingsThreads: [
    msg("new threads"),
    msg("default workspace"),
    msg("default permissions"),
    msg("access"),
    msg("response streaming"),
    msg("preview browser"),
    msg("browser access"),
    msg("import conversations"),
    msg("claude code history"),
    msg("codex history"),
    msg("auto-settle"),
    msg("settle"),
    msg("snooze"),
    msg("usage limits"),
    msg("auto-resume"),
    msg("Recovery"),
    msg("restart"),
    msg("Retry after network errors"),
    msg("thread behavior"),
  ],
  SettingsFollowUp: [
    msg("follow-ups"),
    msg("queue"),
    msg("steer"),
    msg("while the agent is running"),
  ],
  SettingsProviderAccounts: [
    msg("provider accounts"),
    msg("codex"),
    msg("claude"),
    msg("cursor"),
    msg("opencode"),
    msg("sign in"),
    msg("login"),
    msg("auth"),
  ],
  SettingsEnvironmentSourceControl: [
    msg("git"),
    msg("pull requests"),
    msg("co-authors"),
    msg("agent credits"),
    msg("default branch"),
    msg("automatically pull"),
    msg("clone into host folders"),
    msg("ghq"),
  ],
  SettingsEnvironmentMaintenance: [
    msg("updates"),
    msg("provider updates"),
    msg("manage environments"),
    msg("about"),
  ],
  SettingsArchive: [msg("archive"), msg("archived"), msg("restore"), msg("unarchive")],
  SettingsWorktrees: [
    msg("worktree"),
    msg("branch naming"),
    msg("branch prefix"),
    msg("submodules"),
    msg("start from remote"),
  ],
  SettingsLabs: [
    msg("beta"),
    msg("linked environments"),
    msg("link machine"),
    msg("fast worktree checkout"),
    msg("clone cache"),
    msg("agent feedback"),
  ],
  SettingsAbout: [
    msg("version"),
    msg("diagnostics"),
    msg("client storage"),
    msg("cache"),
    msg("legal"),
    msg("privacy"),
    msg("terms"),
    msg("open source licenses"),
  ],
  SettingsLanguage: [msg("language"), msg("locale"), msg("translation"), msg("english")],
} satisfies Partial<Record<SettingsPageTarget | "account", readonly Message[]>>;
const termsById: ReadonlyMap<string, readonly Message[]> = new Map(
  Object.entries(SETTINGS_SEARCH_TERMS),
);

export interface SettingsSearchRow {
  readonly id: string;
  readonly label: Message;
}

export interface SettingsSearchSection<Row extends SettingsSearchRow> {
  readonly title?: Message;
  readonly rows: readonly Row[];
}

/** English source text and its translation, so a query in either language finds the row. */
function searchTermsOf(row: SettingsSearchRow, section: Message | undefined): string[] {
  const sources = [row.label, ...(section ? [section] : []), ...(termsById.get(row.id) ?? [])];
  return sources.flatMap((source) => {
    const translated = t(source);
    return translated === source ? [source] : [source, translated];
  });
}

/**
 * Keeps the rows whose label, section, or page contents match `query`, in list order, and drops
 * sections left empty. Labels and terms are English source text; the query matches them and their
 * translations. Matching is the command palette's, so both searches agree.
 */
export function filterSettingsSections<
  Row extends SettingsSearchRow,
  Section extends SettingsSearchSection<Row>,
>(sections: readonly Section[], query: string): Section[] {
  const normalizedQuery = foldSearchQuery(query);
  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, section: section.title })),
  );
  const matched = normalizedQuery
    ? new Set(
        rankSearchItems(rows, ({ row, section }, options) =>
          scoreSearchTerms(normalizedQuery, searchTermsOf(row, section), options),
        ).map(({ item }) => item.row),
      )
    : null;
  return sections.flatMap((section) => {
    const kept = matched ? section.rows.filter((row) => matched.has(row)) : section.rows;
    return kept.length ? [{ ...section, rows: kept }] : [];
  });
}
