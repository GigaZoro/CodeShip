import { isStorableInProjectScope, type ScopedSettingsPatch } from "./scopedSettings";
import type { SettingsPath } from "./settingsSearch";
import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ProviderInstanceConfig,
  PreviewViewportSetting,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {}
}

export function hasChangedBackgroundActivitySettings(
  settings: Pick<
    UnifiedSettings,
    | "backgroundActivity"
    | "backgroundActivityProfile"
    | "automaticGitFetchInterval"
    | "providerHealthRefreshInterval"
  >,
): boolean {
  return (
    !Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity) ||
    settings.backgroundActivityProfile !== DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile ||
    !Equal.equals(
      settings.automaticGitFetchInterval,
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    ) ||
    !Equal.equals(
      settings.providerHealthRefreshInterval,
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    )
  );
}

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal"
>;

function getChangedTypographySettingLabels(settings: TypographySettings): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? ["Interface font"]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? ["Prompt font"]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? ["Code font"]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? ["Terminal font"]
      : []),
  ];
}

export type BrowserDefaultSettings = Pick<
  UnifiedSettings,
  | "browserDefaultViewport"
  | "browserDefaultZoomFactor"
  | "browserDefaultAppearance"
  | "browserRecordingFrameRate"
  | "browserRecordingShowKeyPresses"
  | "browserRecordingShowMousePresses"
  | "browserLinkTarget"
  | "browserSearchEngine"
  | "browserCustomSearchUrl"
  | "browserAutoShowFloatingPreview"
>;

function isSamePreviewViewport(
  left: PreviewViewportSetting,
  right: PreviewViewportSetting,
): boolean {
  if (left._tag !== right._tag) return false;
  if (left._tag === "fill" || right._tag === "fill") return true;
  if (left.width !== right.width || left.height !== right.height) return false;
  return left._tag === "preset" && right._tag === "preset"
    ? left.presetId === right.presetId
    : true;
}

export function getChangedBrowserSettingLabels(settings: BrowserDefaultSettings): string[] {
  return [
    ...(isSamePreviewViewport(
      settings.browserDefaultViewport,
      DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
    )
      ? []
      : ["Browser viewport"]),
    ...(settings.browserDefaultZoomFactor !== DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor
      ? ["Browser zoom"]
      : []),
    ...(settings.browserDefaultAppearance !== DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance
      ? ["Browser appearance"]
      : []),
    ...(settings.browserRecordingFrameRate !== DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate
      ? ["Recording frame rate"]
      : []),
    ...(settings.browserRecordingShowKeyPresses ? ["Recording key presses"] : []),
    ...(settings.browserRecordingShowMousePresses ? ["Recording mouse presses"] : []),
    ...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget
      ? ["Open links in"]
      : []),
    ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ||
    settings.browserCustomSearchUrl !== DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl
      ? ["Search engine"]
      : []),
    ...(settings.browserAutoShowFloatingPreview !==
    DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
      ? ["Floating preview"]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

type RestorableKey = keyof UnifiedSettings;

/** One row (or a few related rows) that a page's reset restores. */
interface RestorableSettings {
  readonly page: SettingsPath;
  readonly keys: ReadonlyArray<RestorableKey>;
  readonly changedLabels: (settings: UnifiedSettings) => ReadonlyArray<string>;
}

function restorable(
  page: SettingsPath,
  label: string,
  keys: ReadonlyArray<RestorableKey>,
): RestorableSettings {
  return {
    page,
    keys,
    changedLabels: (settings) =>
      keys.some((key) => !Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key]))
        ? [label]
        : [],
  };
}

const BACKGROUND_ACTIVITY_KEYS = [
  "backgroundActivity",
  "backgroundActivityProfile",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
] as const satisfies ReadonlyArray<RestorableKey>;
const TYPOGRAPHY_KEYS = [
  "fontFamilySans",
  "fontFamilyComposer",
  "fontFamilyCode",
  "fontFamilyTerminal",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
] as const satisfies ReadonlyArray<RestorableKey>;
const BROWSER_DEFAULT_KEYS = [
  "browserDefaultViewport",
  "browserDefaultZoomFactor",
  "browserDefaultAppearance",
  "browserRecordingFrameRate",
  "browserRecordingShowKeyPresses",
  "browserRecordingShowMousePresses",
  "browserLinkTarget",
  "browserSearchEngine",
  "browserCustomSearchUrl",
  "browserAutoShowFloatingPreview",
] as const satisfies ReadonlyArray<RestorableKey>;

/** Every setting a reset restores, by the page that shows it. Theme lives in local storage and is handled apart. */
const RESTORABLE_SETTINGS: ReadonlyArray<RestorableSettings> = [
  restorable("/settings/appearance", "Contrast", ["appearanceContrast"]),
  restorable("/settings/appearance", "Glass opacity", ["glassOpacity"]),
  restorable("/settings/appearance", "Diff colors", ["diffColorScheme"]),
  restorable("/settings/appearance", "Chat width", ["chatWidth"]),
  restorable("/settings/appearance", "Effort display", ["effortDisplay"]),
  restorable("/settings/appearance", "Render math", ["mathRenderingEnabled"]),
  restorable("/settings/appearance", "Panel animations", ["panelAnimationDurationMs"]),
  restorable("/settings/appearance", "Environment identification", [
    "environmentIdentificationMode",
  ]),
  restorable("/settings/appearance", "Word wrap", ["wordWrap"]),
  {
    page: "/settings/appearance",
    keys: TYPOGRAPHY_KEYS,
    changedLabels: getChangedTypographySettingLabels,
  },
  restorable("/settings/general", "Time format", ["timestampFormat"]),
  restorable("/settings/general", "Thread notifications", ["notificationMode"]),
  restorable("/settings/general", "In-app notifications", ["inAppNotificationsEnabled"]),
  restorable("/settings/general", "Project grouping", ["sidebarProjectGroupingMode"]),
  restorable("/settings/general", "Project order", ["sidebarProjectSortOrder"]),
  restorable("/settings/general", "Working section", ["sidebarWorkingShelfEnabled"]),
  restorable("/settings/general", "Unpin confirmation", ["confirmThreadUnpin"]),
  restorable("/settings/general", "Archive confirmation", ["confirmThreadArchive"]),
  restorable("/settings/general", "Delete confirmation", ["confirmThreadDelete"]),
  restorable("/settings/keybindings", "Send shortcut", ["sendShortcut"]),
  restorable("/settings/keybindings", "Quit shortcut", ["confirmQuit"]),
  restorable("/settings/chat", "Default diff file state", ["diffFilesCollapsed"]),
  restorable("/settings/chat", "Diff whitespace changes", ["diffIgnoreWhitespace"]),
  restorable("/settings/chat", "Diff layout", ["diffLayout"]),
  restorable("/settings/chat", "Open pull requests and changes panels proactively", [
    "proactivePanelsEnabled",
  ]),
  restorable("/settings/chat", "Show skills in slash menu", ["showSkillsInSlashMenu"]),
  restorable("/settings/chat", "Rich text composer", ["composerRichTextEnabled"]),
  restorable("/settings/chat", "Follow-up behavior", ["followUpBehavior"]),
  restorable("/settings/threads", "Auto-settle inactive threads", ["sidebarAutoSettleAfterDays"]),
  restorable("/settings/threads", "Keep threads with a PR", ["sidebarAutoSettleKeepPullRequests"]),
  restorable("/settings/threads", "Open a PR for unmerged work", [
    "sidebarAutoSettleOpensPullRequests",
  ]),
  restorable("/settings/threads", "Auto-settle merged threads", ["sidebarAutoSettleOnMerge"]),
  restorable("/settings/threads", "Resume after usage limits", ["autoResumeLimitedThreads"]),
  restorable("/settings/threads", "Snooze until limits reset", ["snoozeLimitedThreads"]),
  restorable("/settings/threads", "Snooze options", ["snoozePresets"]),
  restorable("/settings/threads", "Response streaming", ["responseStreamingMode"]),
  restorable("/settings/threads", "New thread workspace", ["defaultThreadEnvMode"]),
  restorable("/settings/maintenance", "Provider update checks", ["enableProviderUpdateChecks"]),
  restorable("/settings/maintenance", "Update providers automatically", ["autoUpdateProviders"]),
  restorable("/settings/maintenance", "Continue threads after restarts", [
    "continueThreadsAfterServerUpdate",
  ]),
  {
    page: "/settings/maintenance",
    keys: BACKGROUND_ACTIVITY_KEYS,
    changedLabels: (settings) =>
      hasChangedBackgroundActivitySettings(settings) ? ["Background activity"] : [],
  },
  restorable("/settings/source-control", "New worktrees start from remote", [
    "newWorktreesStartFromOrigin",
  ]),
  restorable("/settings/source-control", "Open pull requests in CodeShip", [
    "pullRequestLinksOpenInApp",
  ]),
  restorable("/settings/projects", "Add project base directory", ["addProjectBaseDirectory"]),
  restorable("/settings/projects", "Clone into host folders", ["ghqCloneLayout"]),
  restorable("/settings/projects", "Import conversations", ["importAgentConversations"]),
  restorable("/settings/providers", "Text generation model", ["textGenerationModelSelection"]),
  restorable("/settings/providers", "Thread title instructions", ["threadTitleInstructions"]),
  {
    page: "/settings/browser",
    keys: BROWSER_DEFAULT_KEYS,
    changedLabels: getChangedBrowserSettingLabels,
  },
  restorable("/settings/browser", "Agent browser access", ["enableAgentBrowserAccess"]),
];

/**
 * Null covers every page, for a full reset. Under a project or checkout scope only entries that scope
 * can store remain, so the confirmation and the patch agree and the server write is not dropped whole.
 */
function restorableSettingsFor(
  page: string | null,
  projectScoped: boolean,
): ReadonlyArray<RestorableSettings> {
  const onPage =
    page === null
      ? RESTORABLE_SETTINGS
      : RESTORABLE_SETTINGS.filter((entry) => entry.page === page);
  return projectScoped
    ? onPage.filter((entry) => entry.keys.every(isStorableInProjectScope))
    : onPage;
}

export function hasRestorableSettings(page: string): boolean {
  return page === "/settings/appearance" || restorableSettingsFor(page, false).length > 0;
}

export function changedRestorableSettingLabels(
  settings: UnifiedSettings,
  page: string | null,
  projectScoped = false,
): string[] {
  return restorableSettingsFor(page, projectScoped).flatMap((entry) =>
    entry.changedLabels(settings),
  );
}

export function restorableSettingsPatch(
  page: string | null,
  projectScoped = false,
): ScopedSettingsPatch {
  // Every key comes from UnifiedSettings, and each value is that key's own default.
  return Object.fromEntries(
    restorableSettingsFor(page, projectScoped).flatMap((entry) =>
      entry.keys.map((key) => [key, DEFAULT_UNIFIED_SETTINGS[key]] as const),
    ),
  ) as ScopedSettingsPatch;
}
