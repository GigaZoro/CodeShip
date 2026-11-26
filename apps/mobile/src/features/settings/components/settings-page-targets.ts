type SettingsRouteWithoutParams = {
  [
    Name in keyof ReactNavigation.RootParamList
  ]: undefined extends ReactNavigation.RootParamList[Name] ? Name : never;
}[keyof ReactNavigation.RootParamList];

/** Settings pages a Settings row opens. */
export const SETTINGS_PAGE_TARGETS = [
  "SettingsEnvironments",
  "SettingsNotifications",
  "SettingsThreads",
  "SettingsWorktrees",
  "SettingsLabs",
  "SettingsArchive",
  "SettingsAppearance",
  "SettingsLanguage",
  "SettingsAbout",
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
] as const satisfies readonly SettingsRouteWithoutParams[];

export type SettingsPageTarget = (typeof SETTINGS_PAGE_TARGETS)[number];

export type SettingsLegalDocumentTarget = "SettingsLegal";
