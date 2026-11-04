export const PROVIDERS_SETTINGS_TABS = ["providers", "models"] as const;
export type ProvidersSettingsTab = (typeof PROVIDERS_SETTINGS_TABS)[number];

// Anchors on the Models tab, so a search result or old link there opens that tab.
const MODELS_TAB_TARGETS: ReadonlySet<string> = new Set([
  "new-thread-models",
  "default-model",
  "last-picked-model",
  "scheduled-task-model",
  "fallback-model",
  "text-generation",
  "text-generation-model",
  "thread-title-instructions",
  "source-control-models",
  "source-control-writer-model",
  "review-guide-model",
  "account-failover",
  "delegated-task-models",
  "final-review",
]);

export function resolveProvidersSettingsTab(tab: unknown, hash: string): ProvidersSettingsTab {
  if (tab === "models" || tab === "providers") return tab;
  return MODELS_TAB_TARGETS.has(hash.replace(/^#/, "")) ? "models" : "providers";
}
