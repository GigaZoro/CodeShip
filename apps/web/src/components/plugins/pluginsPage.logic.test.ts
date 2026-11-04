import type { ProviderPlugin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { uniquePluginsById } from "./pluginsPage.logic";

const plugin = (overrides: Partial<ProviderPlugin>): ProviderPlugin => ({
  id: "frontend-design@claude-plugins-official",
  name: "frontend-design",
  marketplace: "claude-plugins-official",
  installed: true,
  enabled: false,
  removable: false,
  ...overrides,
});

describe("uniquePluginsById", () => {
  it("folds one plugin installed in two scopes into a single row", () => {
    const result = uniquePluginsById([
      plugin({ enabled: false, removable: false }),
      plugin({ enabled: true, removable: true }),
      plugin({ id: "other@claude-plugins-official", name: "other" }),
    ]);
    expect(result.map((entry) => [entry.id, entry.enabled, entry.removable])).toEqual([
      ["frontend-design@claude-plugins-official", true, true],
      ["other@claude-plugins-official", false, false],
    ]);
  });
});
