import type { ProviderPlugin } from "@t3tools/contracts";

/**
 * Claude lists a plugin once per install scope (user, project, synced) under the same id, and
 * the scope does not reach the client. Fold those into one row that is on if any copy is on and
 * removable if any copy is.
 */
export function uniquePluginsById(
  plugins: ReadonlyArray<ProviderPlugin>,
): ReadonlyArray<ProviderPlugin> {
  const byId = new Map<string, ProviderPlugin>();
  for (const plugin of plugins) {
    const first = byId.get(plugin.id);
    byId.set(
      plugin.id,
      first
        ? {
            ...first,
            enabled: first.enabled || plugin.enabled,
            removable: first.removable || plugin.removable,
          }
        : plugin,
    );
  }
  return [...byId.values()];
}
