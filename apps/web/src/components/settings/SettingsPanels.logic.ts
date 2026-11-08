import {
  isProjectScopedSettingKey,
  isStorableInProjectScope,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import type { ProjectScopedServerSettingKey } from "@t3tools/contracts";
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
  getBackgroundActivityPresetSettings,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { msg, t, type Message } from "~/i18n";

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
      ? [t("Interface font")]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? [t("Prompt font")]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? [t("Code font")]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? [t("Terminal font")]
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
      : [t("Browser viewport")]),
    ...(settings.browserDefaultZoomFactor !== DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor
      ? [t("Browser zoom")]
      : []),
    ...(settings.browserDefaultAppearance !== DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance
      ? [t("Browser appearance")]
      : []),
    ...(settings.browserRecordingFrameRate !== DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate
      ? [t("Recording frame rate")]
      : []),
    ...(settings.browserRecordingShowKeyPresses ? [t("Recording key presses")] : []),
    ...(settings.browserRecordingShowMousePresses ? [t("Recording mouse presses")] : []),
    ...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget
      ? [t("Open links in")]
      : []),
    ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ||
    settings.browserCustomSearchUrl !== DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl
      ? [t("Search engine")]
      : []),
    ...(settings.browserAutoShowFloatingPreview !==
    DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
      ? [t("Floating preview")]
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
  /** Set for single-row entries, so a project reset can name what it clears. */
  readonly label?: Message;
  readonly changedLabels: (settings: UnifiedSettings) => ReadonlyArray<string>;
  /** Replaces "every key to its default" for entries that restore only part of a key. */
  readonly patch?: (settings: UnifiedSettings) => ScopedSettingsPatch;
  /** Already restored by another entry's full reset, so a reset of every page skips it. */
  readonly partOfAnotherEntry?: true;
}

function entryPatch(entry: RestorableSettings, settings: UnifiedSettings): ScopedSettingsPatch {
  return (
    entry.patch?.(settings) ??
    (Object.fromEntries(
      entry.keys.map((key) => [key, DEFAULT_UNIFIED_SETTINGS[key]] as const),
    ) as ScopedSettingsPatch)
  );
}

type BackgroundIntervalKey = "automaticGitFetchInterval" | "providerHealthRefreshInterval";

/** Whether the interval differs from its profile's preset, which is what clearing its override restores. */
export function isBackgroundIntervalOverridden(
  settings: ServerSettings,
  key: BackgroundIntervalKey,
): boolean {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  return (
    durationToSeconds(resolved[key]) !==
    durationToSeconds(getBackgroundActivityPresetSettings(resolved.profile)[key])
  );
}

/** Only this interval's override clears; the rest of the background policy stays. */
function backgroundIntervalEntry(
  page: SettingsPath,
  label: Message,
  key: BackgroundIntervalKey,
): RestorableSettings {
  return {
    page,
    keys: ["backgroundActivity"],
    label,
    partOfAnotherEntry: true,
    changedLabels: (settings) => (isBackgroundIntervalOverridden(settings, key) ? [t(label)] : []),
    patch: (settings) =>
      backgroundActivityOverrideSettings(
        settings.backgroundActivity,
        resolveServerBackgroundActivitySettings(settings),
        { [key]: undefined },
      ),
  };
}

function restorable(
  page: SettingsPath,
  label: Message,
  keys: ReadonlyArray<RestorableKey>,
): RestorableSettings {
  return {
    page,
    keys,
    label,
    changedLabels: (settings) =>
      keys.some((key) => !Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key]))
        ? [t(label)]
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
  restorable("/settings/appearance", msg("Contrast"), ["appearanceContrast"]),
  restorable("/settings/appearance", msg("Glass opacity"), ["glassOpacity"]),
  restorable("/settings/appearance", msg("Diff colors"), ["diffColorScheme"]),
  restorable("/settings/appearance", msg("Chat width"), ["chatWidth"]),
  restorable("/settings/appearance", msg("Effort display"), ["effortDisplay"]),
  restorable("/settings/appearance", msg("Render math"), ["mathRenderingEnabled"]),
  restorable("/settings/appearance", msg("Panel animations"), ["panelAnimationDurationMs"]),
  restorable("/settings/appearance", msg("Environment identification"), [
    "environmentIdentificationMode",
  ]),
  restorable("/settings/appearance", msg("Word wrap"), ["wordWrap"]),
  {
    page: "/settings/appearance",
    keys: TYPOGRAPHY_KEYS,
    changedLabels: getChangedTypographySettingLabels,
  },
  restorable("/settings/general", msg("Time format"), ["timestampFormat"]),
  restorable("/settings/general", msg("Thread notifications"), ["notificationMode"]),
  restorable("/settings/general", msg("In-app notifications"), ["inAppNotificationsEnabled"]),
  restorable("/settings/general", msg("Project grouping"), ["sidebarProjectGroupingMode"]),
  restorable("/settings/general", msg("Project order"), ["sidebarProjectSortOrder"]),
  restorable("/settings/general", msg("Working section"), ["sidebarWorkingShelfEnabled"]),
  restorable("/settings/general", msg("Manual steps"), ["sidebarManualStepsEnabled"]),
  restorable("/settings/general", msg("Unpin confirmation"), ["confirmThreadUnpin"]),
  restorable("/settings/general", msg("Archive confirmation"), ["confirmThreadArchive"]),
  restorable("/settings/general", msg("Delete confirmation"), ["confirmThreadDelete"]),
  restorable("/settings/keybindings", msg("Send shortcut"), ["sendShortcut"]),
  restorable("/settings/keybindings", msg("Quit shortcut"), ["confirmQuit"]),
  restorable("/settings/keybindings", msg("Keep running in the tray"), ["closeWindowToTray"]),
  restorable("/settings/chat", msg("Default diff file state"), ["diffFilesCollapsed"]),
  restorable("/settings/chat", msg("Diff whitespace changes"), ["diffIgnoreWhitespace"]),
  restorable("/settings/chat", msg("Diff layout"), ["diffLayout"]),
  restorable("/settings/chat", msg("Open pull requests and changes panels proactively"), [
    "proactivePanelsEnabled",
  ]),
  restorable("/settings/chat", msg("Skill availability"), ["skillAvailability"]),
  restorable("/settings/chat", msg("Show skills in slash menu"), ["showSkillsInSlashMenu"]),
  restorable("/settings/chat", msg("Rich text composer"), ["composerRichTextEnabled"]),
  restorable("/settings/chat", msg("Follow-up behavior"), ["followUpBehavior"]),
  restorable("/settings/threads", msg("Auto-settle inactive threads"), [
    "sidebarAutoSettleAfterDays",
  ]),
  restorable("/settings/threads", msg("Keep threads with a PR"), [
    "sidebarAutoSettleKeepPullRequests",
  ]),
  restorable("/settings/threads", msg("Open a PR for unmerged work"), [
    "sidebarAutoSettleOpensPullRequests",
  ]),
  restorable("/settings/threads", msg("Auto-settle merged threads"), ["sidebarAutoSettleOnMerge"]),
  restorable("/settings/threads", msg("Resume after usage limits"), ["autoResumeLimitedThreads"]),
  restorable("/settings/threads", msg("Snooze until limits reset"), ["snoozeLimitedThreads"]),
  restorable("/settings/threads", msg("Snooze options"), ["snoozePresets"]),
  restorable("/settings/threads", msg("Response streaming"), ["responseStreamingMode"]),
  restorable("/settings/threads", msg("New thread workspace"), ["defaultThreadEnvMode"]),
  restorable("/settings/maintenance", msg("Provider update checks"), [
    "enableProviderUpdateChecks",
  ]),
  restorable("/settings/maintenance", msg("Update providers automatically"), [
    "autoUpdateProviders",
  ]),
  restorable("/settings/maintenance", msg("Continue threads after restarts"), [
    "continueThreadsAfterServerUpdate",
  ]),
  restorable("/settings/maintenance", msg("Retry threads after network errors"), [
    "retryThreadsAfterNetworkErrors",
  ]),
  {
    page: "/settings/maintenance",
    keys: BACKGROUND_ACTIVITY_KEYS,
    changedLabels: (settings) =>
      hasChangedBackgroundActivitySettings(settings) ? [t("Background activity")] : [],
  },
  restorable("/settings/source-control", msg("New worktrees start from remote"), [
    "newWorktreesStartFromOrigin",
  ]),
  restorable("/settings/source-control", msg("Open pull requests in T3.CodeShip"), [
    "pullRequestLinksOpenInApp",
  ]),
  backgroundIntervalEntry(
    "/settings/source-control",
    msg("Git fetch interval"),
    "automaticGitFetchInterval",
  ),
  restorable("/settings/projects", msg("Add project base directory"), ["addProjectBaseDirectory"]),
  restorable("/settings/projects", msg("Clone into host folders"), ["ghqCloneLayout"]),
  restorable("/settings/projects", msg("Import conversations"), ["importAgentConversations"]),
  restorable("/settings/providers", msg("Default model"), ["defaultModelSelection"]),
  restorable("/settings/providers", msg("Use last picked model"), ["newThreadsUseLastModel"]),
  restorable("/settings/providers", msg("Fallback model"), ["fallbackModelSelection"]),
  restorable("/settings/providers", msg("Scheduled tasks model"), ["scheduledTaskModelSelection"]),
  restorable("/settings/providers", msg("Text generation model"), ["textGenerationModelSelection"]),
  restorable("/settings/providers", msg("Thread title instructions"), ["threadTitleInstructions"]),
  restorable("/settings/providers", msg("Source control writer model"), [
    "sourceControlWriterModelSelection",
  ]),
  restorable("/settings/providers", msg("Review guide model"), ["reviewGuideModelSelection"]),
  backgroundIntervalEntry(
    "/settings/providers",
    msg("Health check interval"),
    "providerHealthRefreshInterval",
  ),
  {
    page: "/settings/browser",
    keys: BROWSER_DEFAULT_KEYS,
    changedLabels: getChangedBrowserSettingLabels,
  },
  restorable("/settings/browser", msg("Agent browser access"), ["enableAgentBrowserAccess"]),
  restorable("/settings/browser", msg("Agent terminal access"), ["agentTerminalAccess"]),
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
      ? RESTORABLE_SETTINGS.filter((entry) => !entry.partOfAnotherEntry)
      : RESTORABLE_SETTINGS.filter((entry) => entry.page === page);
  return projectScoped
    ? onPage.filter((entry) => entry.keys.every(isStorableInProjectScope))
    : onPage;
}

export function hasRestorableSettings(page: string): boolean {
  return page === "/settings/appearance" || restorableSettingsFor(page, false).length > 0;
}

/**
 * Every machine contributes the rows it has changed, and each machine's patch is built from its own
 * values, so one machine's partial restore cannot copy another machine's remaining settings.
 */
export function pageRestorePlan<Id>(
  targets: ReadonlyArray<{ readonly environmentId: Id; readonly settings: UnifiedSettings }>,
  page: string | null,
): { readonly labels: string[]; readonly patches: ReadonlyMap<Id, ScopedSettingsPatch> } {
  const entries = restorableSettingsFor(page, false);
  const labels = new Set(
    entries.flatMap((entry) => targets.flatMap(({ settings }) => entry.changedLabels(settings))),
  );
  const patches = new Map(
    targets.map(({ environmentId, settings }) => [
      environmentId,
      Object.assign(
        {},
        ...entries
          .filter((entry) => entry.changedLabels(settings).length > 0)
          .map((entry) => entryPatch(entry, settings)),
      ) as ScopedSettingsPatch,
    ]),
  );
  return { labels: [...labels], patches };
}

/**
 * Under a project or checkout scope, a reset clears that project's own overrides so it inherits
 * again, rather than pinning defaults as new overrides, and resets this device's settings.
 */
export function projectScopedRestorePlan(
  settings: UnifiedSettings,
  page: string | null,
  overriddenKeys: ReadonlySet<string>,
): {
  readonly labels: string[];
  readonly clearKeys: ProjectScopedServerSettingKey[];
  readonly devicePatch: ScopedSettingsPatch;
} {
  const labels: string[] = [];
  const clearKeys: ProjectScopedServerSettingKey[] = [];
  const deviceEntries: RestorableSettings[] = [];
  for (const entry of restorableSettingsFor(page, true)) {
    const projectKeys = entry.keys.filter(isProjectScopedSettingKey);
    if (projectKeys.length === 0) {
      deviceEntries.push(entry);
      labels.push(...entry.changedLabels(settings));
      continue;
    }
    const overridden = projectKeys.filter((key) => overriddenKeys.has(key));
    if (overridden.length === 0) continue;
    clearKeys.push(...overridden);
    if (entry.label !== undefined) labels.push(t(entry.label));
  }
  const devicePatch = Object.assign(
    {},
    ...deviceEntries.map((entry) => entryPatch(entry, settings)),
  ) as ScopedSettingsPatch;
  return { labels, clearKeys, devicePatch };
}
