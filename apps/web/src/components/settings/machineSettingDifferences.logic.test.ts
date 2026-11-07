import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineSettingDifferences } from "./machineSettingDifferences.logic";

const machine = (
  label: string,
  settings: Partial<ServerSettings> = {},
  without?: keyof ServerSettings,
) => {
  const merged: Partial<ServerSettings> = { ...DEFAULT_SERVER_SETTINGS, ...settings };
  if (without) delete merged[without];
  return { environmentId: EnvironmentId.make(label), label, settings: merged as ServerSettings };
};

describe("machineSettingDifferences", () => {
  it("lists only settings whose values differ, with each machine's value and patch", () => {
    const differences = machineSettingDifferences([
      machine("Laptop", { snoozeLimitedThreads: true }),
      machine("Server", { snoozeLimitedThreads: false }),
      machine("Desktop", { snoozeLimitedThreads: true }),
    ]);
    expect(differences).toEqual([
      expect.objectContaining({
        id: "snooze-limited-threads",
        title: "Snooze until limits reset",
        page: "/settings/threads",
        values: [
          {
            environmentId: "Laptop",
            label: "Laptop",
            display: "On",
            patch: { snoozeLimitedThreads: true },
          },
          {
            environmentId: "Server",
            label: "Server",
            display: "Off",
            patch: { snoozeLimitedThreads: false },
          },
          {
            environmentId: "Desktop",
            label: "Desktop",
            display: "On",
            patch: { snoozeLimitedThreads: true },
          },
        ],
      }),
    ]);
  });

  it("finds nothing to compare on a single machine or when every machine matches", () => {
    expect(machineSettingDifferences([machine("Laptop", { snoozeLimitedThreads: true })])).toEqual(
      [],
    );
    expect(machineSettingDifferences([machine("Laptop"), machine("Server")])).toEqual([]);
  });

  it("leaves machine-specific settings out", () => {
    expect(
      machineSettingDifferences([
        machine("Laptop", { worktreesDirectory: "/Users/me/worktrees" }),
        machine("Server", { worktreesDirectory: "/home/me/worktrees" }),
      ]),
    ).toEqual([]);
  });

  it("skips a machine whose server does not report the setting", () => {
    const old = machine("Old", {}, "snoozeLimitedThreads");
    expect(
      machineSettingDifferences([machine("Laptop", { snoozeLimitedThreads: true }), old]),
    ).toEqual([]);
  });

  it("compares idle compaction by the mode each server version resolves to", () => {
    const legacy = machine("Legacy", { compactIdleThreads: true }, "idleCompaction");
    const current = machine("Current", { idleCompaction: "beforeCacheExpires" });
    expect(machineSettingDifferences([current, legacy])).toEqual([]);
    const differences = machineSettingDifferences([
      current,
      legacy,
      machine("Off", { idleCompaction: "off" }),
    ]);
    expect(
      differences.map(({ id, values }) => ({ id, patches: values.map((v) => v.patch) })),
    ).toEqual([
      {
        id: "compact-idle-threads",
        patches: [
          { idleCompaction: "beforeCacheExpires" },
          { idleCompaction: "beforeCacheExpires" },
          { idleCompaction: "off" },
        ],
      },
    ]);
  });
});
