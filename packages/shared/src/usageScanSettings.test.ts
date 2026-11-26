import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageScanSettingsKey } from "./usageScanSettings.ts";

const PERSONAL: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("claudeAgent"),
  config: { homePath: "/accounts/personal" },
};

function withClaude(instance: ProviderInstanceConfig): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [ProviderInstanceId.make("claudeAgent")]: instance },
  };
}

const BASE = withClaude(PERSONAL);

describe("usageScanSettingsKey", () => {
  it.each([
    [
      "a price override",
      {
        ...BASE,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      },
    ],
    ["a model alias", { ...BASE, usageModelAliases: { "custom-model": "gpt-5" } }],
    ["the model filter", { ...BASE, usageModelFilter: { exclude: [{ model: "gpt-5" }] } }],
    ["turning a provider off", withClaude({ ...PERSONAL, enabled: false })],
    [
      "a provider's home folder",
      withClaude({ ...PERSONAL, config: { homePath: "/accounts/work" } }),
    ],
    [
      "a provider's environment",
      withClaude({
        ...PERSONAL,
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/accounts/work", sensitive: false }],
      }),
    ],
  ] as const)("changes with %s", (_setting, next) => {
    expect(usageScanSettingsKey(next)).not.toBe(usageScanSettingsKey(BASE));
  });

  it.each([
    ["a provider's display name", withClaude({ ...PERSONAL, displayName: "Work" })],
    ["a provider's accent color", withClaude({ ...PERSONAL, accentColor: "#ff0000" })],
    ["a setting usage does not read", { ...BASE, reviewGuidesEnabled: !BASE.reviewGuidesEnabled }],
    [
      "the order of a settings snapshot's properties",
      Object.fromEntries(Object.entries(BASE).reverse()) as unknown as ServerSettings,
    ],
  ] as const)("ignores %s", (_setting, next) => {
    expect(usageScanSettingsKey(next)).toBe(usageScanSettingsKey(BASE));
  });
});
