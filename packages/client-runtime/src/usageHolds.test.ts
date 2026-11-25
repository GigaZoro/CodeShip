import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  creditGrantLeftText,
  describeRetryOutcome,
  describeUsageHold,
  heldAccountsForDriver,
} from "./usageHolds.ts";

const codex = ProviderDriverKind.make("codex");
const provider = (instanceId: string, driver = codex) =>
  ({ instanceId: ProviderInstanceId.make(instanceId), driver }) as ServerProvider;
const formatTime = (isoDate: string) => `at ${isoDate}`;

describe("heldAccountsForDriver", () => {
  it("keeps holds of the driver's listed accounts only", () => {
    const providers = [
      provider("codex"),
      provider("claudeAgent", ProviderDriverKind.make("claudeAgent")),
    ];
    const held = heldAccountsForDriver(
      providers,
      [
        { instanceId: ProviderInstanceId.make("codex") },
        { instanceId: ProviderInstanceId.make("claudeAgent") },
        { instanceId: ProviderInstanceId.make("removed") },
      ],
      codex,
    );
    expect(held.map((entry) => entry.hold.instanceId)).toEqual(["codex"]);
  });
});

describe("creditGrantLeftText", () => {
  it("rounds a part credit down, so it never shows more than is left", () => {
    expect(creditGrantLeftText({ capCredits: 3000, remainingCredits: 2399.99 })).toBe(
      "Prepaid credits left: 2,399 of 3,000",
    );
  });
});

describe("describeUsageHold", () => {
  const instanceId = ProviderInstanceId.make("codex");
  it.each([
    [
      { instanceId, appCap: true as const, heldUntil: "2026-11-13T00:00:00.000Z" as never },
      "ChatGPT's app limit stopped it",
    ],
    [{ instanceId }, "Held until its next turn"],
    [
      { instanceId, heldUntil: "2026-11-13T00:00:00.000Z" as never },
      "Held until at 2026-11-13T00:00:00.000Z",
    ],
    [
      { instanceId, heldUntil: "2026-11-13T00:00:00.000Z" as never, estimated: true as const },
      "Held until about at 2026-11-13T00:00:00.000Z",
    ],
  ])("describes %j", (hold, text) => {
    expect(describeUsageHold(hold, formatTime)).toBe(text);
  });
});

describe("describeRetryOutcome", () => {
  it.each([
    [{}, false, "Account released", "Send a message to try the account again."],
    [
      { credits: "spending" as const },
      true,
      "Account released",
      "The chat continues on it within a minute, on its prepaid credits.",
    ],
    [
      {
        limitedUntil: "2026-11-27T00:00:00.000Z",
        estimated: true as const,
        credits: "not_enabled" as const,
      },
      true,
      "Account still limited",
      "Its usage limit still holds it until about at 2026-11-27T00:00:00.000Z. Its prepaid credits are not used: Spend prepaid credits is off in Settings → Providers & models.",
    ],
  ])("reports what admission does with %j", (result, resumes, title, description) => {
    expect(describeRetryOutcome(result, resumes, formatTime)).toMatchObject({ title, description });
  });
});
