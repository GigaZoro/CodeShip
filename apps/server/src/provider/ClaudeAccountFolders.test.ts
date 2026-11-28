import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";

import { listClaudeAccounts } from "./ClaudeAccountFolders.ts";

describe("listClaudeAccounts", () => {
  it("keeps an enabled account listed while the registry replaces it", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const replaced = ProviderInstanceId.make("claudeAgent_work");
    const turnedOff = ProviderInstanceId.make("claudeAgent_off");
    const added = ProviderInstanceId.make("claudeAgent_new");
    const folder = (instanceId: ProviderInstanceId) => ({
      instanceId,
      displayName: null,
      status: "available" as const,
      configFolder: { kind: "path" as const, path: `/accounts/${instanceId}` },
    });

    const listed = listClaudeAccounts({
      configMap: {
        [replaced]: { driver: claude, config: { homePath: "/accounts/next" } },
        [turnedOff]: { driver: claude, enabled: false, config: {} },
        [added]: { driver: claude, config: {} },
      },
      instances: [],
      unavailable: [],
      published: [folder(replaced), folder(turnedOff)],
    });

    assert.deepStrictEqual(listed.accounts, [folder(replaced)]);
  });
});
