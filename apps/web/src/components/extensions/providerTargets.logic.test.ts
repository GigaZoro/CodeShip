import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildProviderMachines, pickProviderTarget } from "./providerTargets.logic";

function entry(
  instanceId: string,
  driver: string,
  displayName: string,
  options: { readonly home?: string; readonly mcp?: boolean } = {},
): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driver),
    displayName,
    continuationGroupKey: options.home,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    snapshot: { supportsMcpServers: options.mcp ?? true } as ServerProvider,
    models: [],
  };
}

const mac = { environmentId: EnvironmentId.make("mac"), label: "Mac" };
const pc = { environmentId: EnvironmentId.make("pc"), label: "PC" };

const entriesByEnvironment = new Map([
  [
    mac.environmentId,
    [
      entry("claudeAgent", "claudeAgent", "Claude", { home: "claude:home:/u/.claude" }),
      entry("claudeAgent_akucheri", "claudeAgent", "akucheri", {
        home: "claude:home:/u/.claude",
      }),
      entry("codex", "codex", "Codex", { home: "codex:home:/u/.codex" }),
      entry("codex_work", "codex", "work", { home: "codex:home:/u/.codex-work" }),
    ],
  ],
  [pc.environmentId, [entry("grok", "grok", "Grok", { mcp: false })]],
]);
const machines = buildProviderMachines({
  machines: [mac, pc],
  entriesByEnvironment,
  capability: "supportsMcpServers",
  mergeAccounts: () => true,
});

describe("buildProviderMachines", () => {
  it("merges accounts that share a home unless told not to, and drops machines without one", () => {
    expect(machines.map(({ machine }) => machine.label)).toEqual(["Mac"]);
    expect(machines[0]!.targets.map((target) => [target.label, target.accounts.length])).toEqual([
      ["Claude", 2],
      ["Codex", 1],
      ["Codex · work", 1],
    ]);
    const separate = buildProviderMachines({
      machines: [mac],
      entriesByEnvironment,
      capability: "supportsMcpServers",
      mergeAccounts: () => false,
    });
    expect(separate[0]!.targets.map((target) => target.label)).toEqual([
      "Claude",
      "Claude · akucheri",
      "Codex",
      "Codex · work",
    ]);
  });
});

describe("pickProviderTarget", () => {
  it("finds a merged account's target, then falls back to the same kind of provider", () => {
    const targets = machines[0]!.targets;
    expect(
      pickProviderTarget(targets, { instanceId: "claudeAgent_akucheri", driverKind: "claudeAgent" })
        ?.naming.title,
    ).toBe("Claude");
    expect(
      pickProviderTarget(targets, { instanceId: "codex_gone", driverKind: "codex" })?.naming.title,
    ).toBe("Codex");
  });
});
