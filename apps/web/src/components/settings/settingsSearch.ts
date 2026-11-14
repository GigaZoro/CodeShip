import { HOSTED_APP_CHANNEL } from "~/branding";
import { msg, t, type Message } from "~/i18n";
import { isElectron, isSecretsFeatureEnabled } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";
import type { ExtensionsTab } from "../extensions/extensionsSearch";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/threads"
  | "/settings/browser"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/secrets"
  | "/settings/maintenance";

/** Pages outside Settings that people still look for from its search. */
type SettingsSearchAppPage = "/scheduled-tasks" | "/extensions" | "/usage";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: Message;
  readonly to: SettingsPath | SettingsSearchAppPage;
  readonly extensionsTab?: ExtensionsTab;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  /** Null marks a device setting on a page whose other rows are scoped. */
  readonly scope?: SettingsSearchScope | null;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly macOrWindowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly secretsFeatureOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly peerLinksOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

type SettingsPageSearchItem = SettingsSearchItem & { readonly to: SettingsPath };

export function isSettingsPageSearchItem(item: SettingsSearchItem): item is SettingsPageSearchItem {
  return item.to.startsWith("/settings/");
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
  readonly hasPeerLinkHost?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, Message>> = {
  "/settings/diagnostics": msg("Diagnostics"),
  "/settings/projects": msg("Projects"),
  "/settings/general": msg("General"),
  "/settings/appearance": msg("Appearance"),
  "/settings/chat": msg("Chat & diffs"),
  "/settings/keybindings": msg("Keybindings"),
  "/settings/providers": msg("Providers & models"),
  "/settings/threads": msg("Threads"),
  "/settings/browser": msg("Browser & devices"),
  "/settings/source-control": msg("Source control & worktrees"),
  "/settings/connections": msg("Machines & access"),
  "/settings/secrets": msg("Secrets"),
  "/settings/maintenance": msg("Maintenance & about"),
};

const SETTINGS_SEARCH_APP_PAGE_LABELS: Readonly<Record<SettingsSearchAppPage, Message>> = {
  "/scheduled-tasks": msg("Scheduled tasks"),
  "/extensions": msg("Extensions"),
  "/usage": msg("Usage"),
};

export function settingsSearchSectionLabel(to: SettingsSearchItem["to"]): Message {
  return to.startsWith("/settings/")
    ? SETTINGS_SECTION_LABELS[to as SettingsPath]
    : SETTINGS_SEARCH_APP_PAGE_LABELS[to as SettingsSearchAppPage];
}

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: Message | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: null,
    paths: ["/settings/general", "/settings/appearance", "/settings/chat", "/settings/keybindings"],
  },
  {
    heading: msg("Agents"),
    paths: ["/settings/providers", "/settings/threads", "/settings/browser"],
  },
  {
    heading: msg("Code"),
    paths: ["/settings/projects", "/settings/source-control"],
  },
  {
    heading: msg("Connections"),
    paths: [
      "/settings/connections",
      ...(isSecretsFeatureEnabled ? (["/settings/secrets"] as const) : []),
    ],
  },
  {
    heading: null,
    paths: ["/settings/maintenance"],
  },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command) as Message,
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsPageSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: (credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`) as Message,
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: msg("Keep worktrees with local changes"),
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: msg("Delete now"),
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: msg("Worktree cleanup"),
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "disk storage automatic delete deleted archived threads old inactive merged settled unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: msg("Worktree location"),
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: msg("Artifacts and logs"),
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "disk storage delete old browser artifacts screenshots captures rotated logs cleanup retention",
    ],
  },
  {
    id: "project-defaults",
    title: msg("Project defaults and overrides"),
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: msg("Project overview"),
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: msg("Default for new threads"),
    to: "/settings/providers",
    scope: "project-defaults",
    searchTerms: [
      "model new thread project provider reasoning effort fallback out of usage models role",
    ],
  },
  {
    id: "last-picked-model",
    title: msg("Use the last picked model"),
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["remember sticky recent previous model new threads default"],
    environmentOnly: true,
  },
  {
    id: "scheduled-task-model",
    title: msg("Scheduled tasks"),
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["scheduled task automation model default all tasks same as default"],
    environmentOnly: true,
  },
  {
    id: "fallback-model",
    title: msg("Fallback model"),
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["fallback agent provider out of usage new threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    title: msg("Permissions"),
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: msg("Color scheme"),
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: msg("Themes"),
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    id: "device-settings-profile",
    title: msg("Use the same appearance and layout on all my devices"),
    to: "/settings/appearance",
    searchTerms: [
      "sync share follow profile fonts sidebar confirmations diff language this device other devices",
    ],
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: msg("Contrast"),
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: msg("Glass opacity"),
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    title: msg("Diff colors"),
    to: "/settings/chat",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: msg("Chat width"),
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    title: msg("Thread details"),
    to: "/settings/chat",
    searchTerms: [
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "agent-actions",
    title: msg("Ask the agent"),
    to: "/settings/chat",
    searchTerms: [
      "custom actions buttons requests prompts shortcuts commit pull request tests review thread details card command palette",
    ],
  },
  {
    id: "effort-display",
    title: msg("Effort display"),
    to: "/settings/appearance",
    searchTerms: ["reasoning effort thinking bars graph word label level composer"],
  },
  {
    id: "math-rendering",
    title: msg("Render math"),
    to: "/settings/chat",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    title: msg("Panel animations"),
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: msg("Environment identification"),
    to: "/settings/appearance",
    searchTerms: ["dev nightly latest channel artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    title: msg("Interface font"),
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: msg("Prompt font"),
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: msg("Code font"),
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: msg("Terminal font"),
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    title: msg("Separate fonts"),
    to: "/settings/appearance",
    searchTerms: ["typography advanced prompt code terminal font family size individually"],
  },
  {
    id: "font-smoothing",
    title: msg("Font smoothing"),
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    title: msg("Word wrap"),
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "project-grouping",
    title: msg("Combine matching projects"),
    to: "/settings/general",
    searchTerms: [
      "project grouping merge same repository machines environments paths monorepo sidebar",
    ],
  },
  {
    id: "snooze-options",
    title: msg("Snooze options"),
    to: "/settings/threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "usage-limit-recovery",
    title: msg("When a thread hits a usage limit"),
    to: "/settings/threads",
    searchTerms: [
      "snooze resume failover switch accounts usage quota rate limit reset wake recover continue",
    ],
  },
  {
    id: "threadpage-token",
    title: msg("ThreadPage token"),
    to: "/settings/threads",
    scope: "environment",
    searchTerms: ["threadpage thread.page manual steps hands-on machine inbox pending token api"],
  },
  {
    id: "working-shelf",
    title: msg("Working section"),
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "manual-steps-sidebar",
    title: msg("Manual steps"),
    to: "/settings/general",
    searchTerms: ["hide show manual steps hands-on threadpage pending sidebar box details column"],
  },
  {
    id: "sidebar-grouping",
    title: msg("Group threads"),
    to: "/settings/general",
    searchTerms: ["group by project folders tree boring legacy classic sidebar"],
  },
  {
    id: "scheduled-task-default-placement",
    title: msg("Show new scheduled tasks in"),
    to: "/settings/general",
    scope: "environment",
    searchTerms: ["auto pin scheduled tasks automations recurring sidebar placement window"],
  },
  {
    id: "sidebar-group-by-machine",
    title: msg("Group threads by machine"),
    to: "/settings/general",
    searchTerms: ["group by machine device environment folders tree nested projects sidebar"],
  },
  {
    id: "boring-sidebar-multiline",
    title: msg("Two-line folder rows"),
    to: "/settings/general",
    searchTerms: ["beta grouped sidebar folder rows multiline branch pull request details"],
  },
  {
    id: "guest-links",
    title: msg("Guest links"),
    to: "/settings/connections",
    scope: "connections",
    searchTerms: ["beta share guest invite link teammate watch t3 connect tunnel"],
  },
  {
    id: "linked-environments-beta",
    title: msg("Allow linked environments"),
    to: "/settings/connections",
    scope: "connections",
    searchTerms: ["beta link another machine vps peer agents work there delegate"],
  },
  {
    id: "follow-shared-settings",
    title: msg("Follow shared settings"),
    to: "/settings/connections",
    scope: "connections",
    searchTerms: ["sync all machines catch up offline same settings every machine global default"],
  },
  {
    id: "simlock-hosts",
    title: msg("Simlock device hosts (alpha)"),
    to: "/settings/browser",
    scope: "environment",
    searchTerms: ["beta alpha simlock callstack simulator emulator ios android pool lease gateway"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: msg("Auto-settle inactive threads"),
    to: "/settings/threads",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    title: msg("Compact idle threads"),
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["claude context compaction idle cache tokens usage summary resume"],
  },
  {
    id: "auto-settle-merged-threads",
    title: msg("Auto-settle merged threads"),
    to: "/settings/threads",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "auto-settle-opens-pull-requests",
    title: msg("Open a PR for unmerged work"),
    to: "/settings/threads",
    searchTerms: ["pull request worktree unmerged commit auto-settle sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    title: msg("Keep threads with a PR"),
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["pull request inactivity auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: msg("Days of inactivity before auto-settle"),
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: msg("Thread notifications"),
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop in-app toasts popup"],
  },
  {
    id: "language",
    title: msg("Language"),
    to: "/settings/general",
    searchTerms: ["locale translation ukrainian english interface display"],
  },
  {
    id: "time-format",
    title: msg("Time format"),
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: msg("Response streaming"),
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: msg("Hide whitespace changes"),
    to: "/settings/chat",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    title: msg("Default diff file state"),
    to: "/settings/chat",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: msg("Diff layout"),
    to: "/settings/chat",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: msg("Open pull requests and changes panels proactively"),
    to: "/settings/chat",
    searchTerms: ["proactive automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skill-availability",
    title: msg("Skill availability"),
    to: "/settings/chat",
    scope: "project-defaults",
    searchTerms: ["skills shared across models by provider dollar $ slash /"],
  },
  {
    id: "skills-in-slash-menu",
    title: msg("Show skills in slash menu"),
    to: "/settings/chat",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: msg("Rich text composer"),
    to: "/settings/chat",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    title: msg("Send shortcut"),
    to: "/settings/keybindings",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: msg("Follow-up behavior"),
    to: "/settings/chat",
    searchTerms: ["queue steer stop and send restart interrupt running turn default composer"],
  },
  {
    id: "provider-updates",
    title: msg("Provider updates"),
    to: "/settings/maintenance",
    searchTerms: [
      "check notify automatically install update provider cli launch startup model catalog versions",
    ],
    scope: "environment-defaults",
  },
  {
    id: "install-updates-automatically",
    title: msg("Install updates automatically when idle"),
    to: "/settings/maintenance",
    searchTerms: [
      "automatic auto install update release restart idle background service server desktop",
    ],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: msg("Continue threads after restarts"),
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "retry-threads-after-network-errors",
    title: msg("Retry threads after network errors"),
    to: "/settings/threads",
    searchTerms: [
      "resume continue failed work internet connection offline outage power cut wifi dns lost network automatically",
    ],
  },
  {
    id: "background-activity",
    title: msg("Background activity"),
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: msg("New threads"),
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: msg("Submodules"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    title: msg("Start from remote"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    title: msg("Add project starts in"),
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "import-agent-conversations",
    title: msg("Import conversations"),
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: [
      "claude code codex history sessions transcripts sync existing past old chats bring in",
    ],
  },
  {
    id: "ghq-clone-layout",
    title: msg("Clone into host folders"),
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: ["ghq clone destination host owner repository root layout"],
  },
  {
    id: "unpin-confirmation",
    title: msg("Unpin confirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: msg("Archive confirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: msg("Delete confirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: msg("Quit shortcut"),
    to: "/settings/keybindings",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "close-window-to-tray",
    title: msg("Keep running in the tray"),
    to: "/settings/keybindings",
    searchTerms: ["close window quit exit system tray notification area background agents"],
    desktopOnly: true,
    windowsOnly: true,
  },
  {
    id: "text-generation-model",
    title: msg("Titles and background text"),
    to: "/settings/providers",
    scope: "project-defaults",
    searchTerms: [
      "text generation model generated thread titles source control content default provider",
    ],
  },
  {
    id: "thread-title-instructions",
    title: msg("Thread title instructions"),
    to: "/settings/providers",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    title: msg("Version"),
    to: "/settings/maintenance",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    title: msg("Update track"),
    to: "/settings/maintenance",
    searchTerms: ["release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    title: msg("t3 command"),
    to: "/settings/maintenance",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "open-at-login",
    title: msg("Open at login"),
    to: "/settings/maintenance",
    searchTerms: ["start launch automatically sign in startup boot login items run"],
    desktopOnly: true,
    macOrWindowsOnly: true,
  },
  {
    id: "mobile-app",
    title: msg("Mobile app"),
    to: "/settings/maintenance",
    searchTerms: ["phone tablet iPhone iPad iOS Android App Store Google Play QR"],
  },
  {
    id: "privacy-policy",
    title: msg("Privacy policy"),
    to: "/settings/maintenance",
    searchTerms: ["telemetry analytics usage data tracking legal opt out"],
  },
  {
    id: "telemetry-export",
    title: msg("OpenTelemetry export"),
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: msg("Diagnostics"),
    to: "/settings/diagnostics",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: msg("Open source licenses"),
    to: "/settings/maintenance",
  },
  {
    id: "setup-wizard",
    title: msg("Setup wizard"),
    to: "/settings/maintenance",
    searchTerms: ["onboarding welcome first run import projects agents connect run setup again"],
  },
  {
    id: "keybindings",
    title: msg("Keybindings"),
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: msg("Window capture"),
    searchTerms: ["snapshots snapshot window capture screenshot attach draft"],
    to: "/settings/chat",
    desktopOnly: true,
  },
  {
    id: "snap-shot-accessibility",
    title: msg("Include app text"),
    to: "/settings/chat",
    desktopOnly: true,
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    title: msg("Capture shortcut"),
    to: "/settings/chat",
    desktopOnly: true,
  },
  {
    id: "snap-shot-sound",
    title: msg("Capture sound"),
    to: "/settings/chat",
    desktopOnly: true,
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    title: msg("Capture flash"),
    to: "/settings/chat",
    desktopOnly: true,
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    title: msg("Capture animations"),
    to: "/settings/chat",
    desktopOnly: true,
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    title: msg("Providers"),
    to: "/settings/providers",
    searchTerms: [
      "agents cli codex claude cursor grok fx opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "auto-mode",
    title: msg("Auto mode"),
    to: "/settings/providers",
    searchTerms: [
      "auto model coordinator cheaper model subagent primary provider default model effort models role",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "account-failover",
    title: msg("Account order"),
    to: "/settings/providers",
    searchTerms: [
      "account order failover switch accounts usage limit quota multiple accounts priority second account auto mode",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "final-review",
    title: msg("Final review"),
    to: "/settings/providers",
    searchTerms: [
      "final review reviewer reviewers review instructions cross model second opinion gates checks quality pre-merge code review after request",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "delegated-task-models",
    title: msg("Delegated tasks"),
    to: "/settings/providers",
    searchTerms: [
      "delegate subagent child task coordinator implementer implementation research review design test role primary secondary model provider",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "usage-providers",
    title: msg("Usage providers"),
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "cursor-keychain-usage",
    title: msg("Cursor account usage"),
    to: "/settings/providers",
    searchTerms: ["cursor macOS keychain usage tokens cost limits permission"],
    providerSettingsOnly: true,
    macProviderSettingsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: msg("Health check interval"),
    to: "/settings/maintenance",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "automated-start-memory-guard",
    title: msg("Wait for memory before automated starts"),
    to: "/settings/maintenance",
    searchTerms: [
      "memory ram out of memory pressure compressor swap scheduled tasks delegated tasks emulator simulator kernel panic crash hold skip",
    ],
    environmentOnly: true,
    scope: "environment",
  },
  {
    id: "automated-start-memory-limits",
    title: msg("Memory limits for automated starts"),
    to: "/settings/maintenance",
    searchTerms: ["memory compressor share percent reserve gib available threshold"],
    environmentOnly: true,
    scope: "environment",
  },
  {
    id: "agent-browser-access",
    title: msg("Agent browser access"),
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "agent-terminal-access",
    title: msg("Agent terminal access"),
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: [
      "allow disable enable read run type commands terminal output shell dev server logs project override",
    ],
  },
  {
    id: "device-sources",
    title: msg("Device sources"),
    to: "/settings/browser",
    searchTerms: [
      "device hosts ssh remote mac mini identity key connection eas expo cloud simlock pool gateway local simulators",
    ],
  },
  {
    id: "agent-device-access",
    title: msg("Agents can use devices"),
    to: "/settings/browser",
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: msg("Use devices"),
    to: "/settings/browser",
    targetId: "devices",
    searchTerms: ["device hub simulator emulator ios android install start version"],
  },
  {
    id: "device-platform-support",
    title: msg("Local simulators"),
    to: "/settings/browser",
    targetId: "device-sources",
    searchTerms: ["simulator support xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    title: msg("Browser profiles"),
    to: "/settings/browser",
    targetId: "browser",
    desktopOnly: true,
  },
  {
    id: "browser-assistants",
    title: msg("Web assistants"),
    to: "/settings/browser",
    searchTerms: ["chatgpt dot dots claude duet openai anthropic assistant agent account"],
    desktopOnly: true,
  },
  {
    id: "browser-default-profile",
    title: msg("Default browser profile"),
    to: "/settings/browser",
    targetId: "browser-profiles",
    desktopOnly: true,
  },
  {
    id: "browser-default-viewport",
    title: msg("Default browser viewport"),
    to: "/settings/browser",
    searchTerms: ["preview size width height device desktop mobile rotate"],
    desktopOnly: true,
  },
  {
    id: "browser-default-zoom",
    title: msg("Default browser zoom"),
    to: "/settings/browser",
    searchTerms: ["preview page scale tabs percent"],
    desktopOnly: true,
  },
  {
    id: "browser-default-appearance",
    title: msg("Default browser appearance"),
    to: "/settings/browser",
    searchTerms: ["preview color scheme light dark system os"],
    desktopOnly: true,
  },
  {
    id: "browser-recording-frame-rate",
    title: msg("Browser recording frame rate"),
    to: "/settings/browser",
    desktopOnly: true,
  },
  {
    id: "browser-recording-key-presses",
    title: msg("Show key presses in recordings"),
    to: "/settings/browser",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
    desktopOnly: true,
  },
  {
    id: "browser-recording-mouse-presses",
    title: msg("Show mouse presses in recordings"),
    to: "/settings/browser",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
    desktopOnly: true,
  },
  {
    id: "browser-link-target",
    title: msg("Open links in"),
    to: "/settings/browser",
    searchTerms: ["links default browser in-app browser external open"],
    desktopOnly: true,
  },
  {
    id: "browser-search-engine",
    title: msg("Search engine"),
    to: "/settings/browser",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom url"],
  },
  {
    id: "pull-request-links-open-in-app",
    title: msg("Open pull requests in T3.CodeShip"),
    to: "/settings/source-control",
    searchTerms: [
      `pr commit links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
    scope: null,
  },
  {
    id: "browser-auto-show-floating-preview",
    title: msg("Auto-show floating preview"),
    to: "/settings/browser",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
    desktopOnly: true,
  },
  {
    id: "automatic-pull",
    title: msg("Automatically pull"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: msg("Remove agent credits when merging"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    title: msg("Default merge method"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: msg("Source control"),
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: msg("Git fetch interval"),
    to: "/settings/maintenance",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: msg("Worktree branch naming"),
    to: "/settings/source-control",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: msg("Source control writing style"),
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: msg("Follow change request templates"),
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: msg("Commit and pull request writing"),
    to: "/settings/providers",
    searchTerms: [
      "source control writer model override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    title: msg("Review guides (beta)"),
    to: "/settings/source-control",
    searchTerms: ["pull request pr guided review guide tour beta experimental"],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    title: msg("Review guides"),
    to: "/settings/providers",
    searchTerms: ["review guide model pull request pr guided review guide brief maintainer"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    title: msg("Review guide instructions"),
    to: "/settings/source-control",
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide preferences taste prompt custom"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: msg("Actions"),
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: msg("Environment icon"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: msg("Local environment"),
    to: "/settings/connections",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: msg("Network access"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: msg("Tailscale HTTPS"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: msg("WSL backend"),
    to: "/settings/connections",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: msg("T3 Connect"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote tunnels limit t3 chat"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: msg("Hold webhooks while offline"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: msg("Publish agent activity"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: msg("This machine"),
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "linked-environments",
    peerLinksOnly: true,
    title: msg("Linked environments"),
    to: "/settings/connections",
    targetId: "linked-environments",
    searchTerms: ["link peer another machine vps agents work there handoff pairing code"],
  },
  {
    id: "remote-environments",
    title: msg("Environments"),
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "machine-setting-differences",
    title: msg("Differences between machines"),
    to: "/settings/connections",
    searchTerms: [
      "compare machines environments settings mismatch sync same settings everywhere copy value",
    ],
  },
  {
    id: "load-balancing",
    title: msg("Load balancing"),
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    title: msg("Pull request sharing"),
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "secret-providers",
    title: msg("Secret providers"),
    to: "/settings/secrets",
    searchTerms: ["1password vault credentials api key"],
    secretsFeatureOnly: true,
  },
  {
    id: "secret-providers-add",
    title: msg("Add secret provider"),
    to: "/settings/secrets",
    targetId: "secret-providers",
    searchTerms: ["new 1password vault op cli account"],
    secretsFeatureOnly: true,
  },
  {
    id: "archive",
    title: msg("Archived threads"),
    to: "/settings/threads",
    searchTerms: ["archive restore reopen deleted history projects search open read delete"],
  },
] as const satisfies ReadonlyArray<SettingsPageSearchItem>;

export const SETTINGS_SEARCH_APP_PAGES: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "scheduled-tasks-page",
    title: msg("Scheduled tasks"),
    to: "/scheduled-tasks",
    searchTerms: ["automations recurring cron schedule webhook run history"],
  },
  {
    id: "mcp-servers-page",
    title: msg("MCP servers"),
    to: "/extensions",
    extensionsTab: "mcp",
    searchTerms: [
      "mcp model context protocol servers tools connectors turn off disable enable edit",
    ],
  },
  {
    id: "plugins-page",
    title: msg("Plugins"),
    to: "/extensions",
    extensionsTab: "plugins",
    searchTerms: ["plugins marketplace extensions install"],
  },
  {
    id: "skills-page",
    title: msg("Skills"),
    to: "/extensions",
    extensionsTab: "skills",
    searchTerms: ["skills slash commands agents"],
  },
  {
    id: "usage-page",
    title: msg("Usage"),
    to: "/usage",
    searchTerms: ["usage limits tokens cost spend rate limit account failover"],
  },
];

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/threads": null,
  "/settings/browser": null,
  "/settings/source-control": "environment-defaults",
  "/settings/connections": "connections",
  "/settings/secrets": null,
  "/settings/maintenance": null,
};

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, SettingsPath>> = {
  "/settings/integrations": "/settings/browser",
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/general",
  "/settings/labs": "/settings/general",
  "/settings/diffs": "/settings/chat",
  "/settings/snap-shot": "/settings/chat",
  "/settings/devices": "/settings/browser",
  "/settings/worktrees": "/settings/source-control",
  "/settings/access": "/settings/connections",
  "/settings/about": "/settings/maintenance",
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  "/settings/threads",
  "/settings/maintenance",
  "/settings/chat",
  "/settings/providers",
  "/settings/keybindings",
  "/settings/browser",
  "/settings/projects",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "storage-cleanup": "/settings/maintenance",
  "storage-artifacts": "/settings/maintenance",
  recovery: "/settings/threads",
  "diagnostics-section": "/settings/diagnostics",
  "authorized-clients": "/settings/connections",
  "new-thread-models": "/settings/providers",
  "text-generation": "/settings/providers",
  "source-control-models": "/settings/providers",
  "new-projects": "/settings/projects",
  "agent-conversations": "/settings/projects",
  "worktree-creation": "/settings/source-control",
  "worktree-branches": "/settings/source-control",
  about: "/settings/maintenance",
  legal: "/settings/maintenance",
  devices: "/settings/browser",
  "device-sources": "/settings/browser",
  "snap-shot": "/settings/chat",
  diffs: "/settings/chat",
  "pull-requests": "/settings/chat",
};

const CONSOLIDATED_SETTING_ANCHORS: Readonly<Record<string, string>> = {
  "usage-limits": "recovery",
  "auto-resume-limited-threads": "usage-limit-recovery",
  "snooze-limited-threads": "usage-limit-recovery",
  "in-app-notifications": "thread-notifications",
  "provider-update-checks": "provider-updates",
  "auto-update-providers": "provider-updates",
};

export const consolidatedSettingsAnchor = (hash: string) =>
  CONSOLIDATED_SETTING_ANCHORS[hash] ?? hash;

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  hash = consolidatedSettingsAnchor(hash);
  const items: readonly SettingsPageSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? RENAMED_SETTINGS_PATHS[pathname] ?? null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  targetId = consolidatedSettingsAnchor(targetId);
  const items: readonly SettingsPageSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: t(item.title),
        scope: item.scope !== undefined ? item.scope : SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title: t(title) };
}

export function settingsSearchItemPage(id: SettingsSearchItemId): SettingsPath {
  return SEARCH_ITEMS_BY_ID.get(id)!.to;
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsPageSearchItem> {
  const items: ReadonlyArray<SettingsPageSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.peerLinksOnly || availability.hasPeerLinkHost === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform<Item extends SettingsSearchItem>(
  items: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.secretsFeatureOnly || isSecretsFeatureEnabled) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)) &&
      (!item.macOrWindowsOnly || isMacPlatform(platform) || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = [
    ...SETTINGS_SEARCH_APP_PAGES,
    ...SETTINGS_SEARCH_ITEMS,
  ],
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(t(item.title));
      const englishTitle = normalizeSearchText(item.title);
      const sectionLabel = settingsSearchSectionLabel(item.to);
      const fields = [
        title,
        englishTitle,
        normalizeSearchText(t(sectionLabel)),
        normalizeSearchText(sectionLabel),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery || englishTitle === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery) || englishTitle.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery) || englishTitle.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token) || englishTitle.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

// These rows only exist with separate fonts on, so a search jump to one turns them on.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
]);

export function isAdvancedTypographyTarget(targetId: string): boolean {
  return ADVANCED_TYPOGRAPHY_TARGET_IDS.has(targetId);
}

/**
 * Opens the persisted section a search result lives in before jumping to it, so
 * its row is mounted to scroll to. The terminal reads the same flag, so it must
 * stay on after the jump.
 */
export function revealSettingsSearchTarget(targetId: string): void {
  if (isAdvancedTypographyTarget(targetId)) {
    writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, true, false, Schema.Boolean);
  }
}
