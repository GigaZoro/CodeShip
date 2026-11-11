import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { providerLoginExpiry } from "./providerLoginExpiry.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const IN = (days: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + days * 86_400_000));

describe("providerLoginExpiry", () => {
  it.each([
    [undefined, undefined],
    ["not a date", undefined],
    [IN(-0.001), { state: "expired" }],
    [IN(0.2), { state: "expiring", daysLeft: 1 }],
    [IN(7), { state: "expiring", daysLeft: 7 }],
    [IN(7.2), { state: "valid", daysLeft: 8 }],
  ])("reads %s as %j", (loginExpiresAt, expected) => {
    expect(providerLoginExpiry(loginExpiresAt, NOW)).toEqual(
      expected && { ...expected, expiresAt: loginExpiresAt },
    );
  });
});
