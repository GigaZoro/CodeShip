import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { describeUnavailableInstance } from "./ModelPickerSidebar";

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("describeUnavailableInstance", () => {
  it("says a provider the project turned off is disabled, as settings does", () => {
    const [entry] = deriveProviderInstanceEntries([codex]);
    expect(describeUnavailableInstance({ ...entry!, enabled: false })).toBe(
      "Codex: Disabled. This provider is installed but disabled for new sessions in T3.CodeShip.",
    );
  });
});
