import { describe, expect, it } from "vite-plus/test";

import { resolveThreadRowStatus } from "./threadRowStatus";

const base = { goalActive: false, isWoke: false, isUnread: false } as const;

describe("resolveThreadRowStatus on an unreachable machine", () => {
  it.each([
    ["working", "offline", "Offline · Working"],
    ["approval", "reconnecting", "Reconnecting · Approval"],
    ["input", "error", "Can't connect · Question"],
  ] as const)("shows %s on a %s machine as last known", (status, machine, label) => {
    expect(resolveThreadRowStatus({ ...base, status, machine })).toMatchObject({
      label,
      icon: "offline",
      lastKnown: { label: expect.stringContaining("last known status") },
    });
  });

  it.each([
    ["working", "live"],
    ["working", "connecting"],
    ["failed", "offline"],
  ] as const)("keeps %s as it is on a %s machine", (status, machine) => {
    expect(resolveThreadRowStatus({ ...base, status, machine })).toEqual(
      resolveThreadRowStatus({ ...base, status }),
    );
  });
});
