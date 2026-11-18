/** Settings pages a Settings row opens. */
export const SETTINGS_PAGE_TARGETS = [
  "SettingsEnvironments",
  "SettingsNotifications",
  "SettingsThreads",
  "SettingsAppearance",
  "SettingsNavigation",
  "SettingsOrganization",
  "SettingsProjectOverview",
  "SettingsEnvironmentSourceControl",
  "SettingsEnvironmentMaintenance",
  "SettingsProviderAccounts",
  "SettingsScheduledTasks",
  "SettingsCapabilities",
  "SettingsKeyboard",
  "SettingsVoice",
  "SettingsFollowUp",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsUsage",
  "SettingsMachines",
  "SettingsMonitoring",
] as const;

export type SettingsPageTarget = (typeof SETTINGS_PAGE_TARGETS)[number];

export type SettingsLegalDocumentTarget = "SettingsLegal";
