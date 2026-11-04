import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerNamingByInstance } from "./providerNaming";

const entry = (instanceId: string, driver: string, displayName: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName,
});

describe("providerNamingByInstance", () => {
  it("names the provider first and adds the account only when the driver has several", () => {
    const alone = providerNamingByInstance([entry("claudeAgent", "claudeAgent", "akucheri")]);
    expect(alone.get("claudeAgent")?.title).toBe("Claude");

    const several = providerNamingByInstance([
      entry("claudeAgent", "claudeAgent", "Claude"),
      entry("claudeAgent_akucheri", "claudeAgent", "akucheri"),
      // The same instance on a second machine counts once.
      entry("claudeAgent_akucheri", "claudeAgent", "akucheri"),
    ]);
    expect([...several.values()].map((naming) => naming.title)).toEqual([
      "Claude",
      "Claude · akucheri",
    ]);
  });
});
