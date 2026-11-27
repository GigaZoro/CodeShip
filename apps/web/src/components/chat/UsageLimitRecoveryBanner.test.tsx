import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isActiveUsageLimitRecoveryState,
  usageLimitRecoveryBannerItem,
} from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("isActiveUsageLimitRecoveryState", () => {
  it("is true only while the latest run is still failed with usage_limit", () => {
    expect(
      isActiveUsageLimitRecoveryState({
        runtimeStatus: "failed",
        lastErrorClass: "usage_limit",
        latestRun: { status: "failed" },
      }),
    ).toBe(true);

    for (const status of ["starting", "running", "waiting", "completed", "cancelled"] as const) {
      expect(
        isActiveUsageLimitRecoveryState({
          runtimeStatus: "failed",
          lastErrorClass: "usage_limit",
          latestRun: { status },
        }),
      ).toBe(false);
    }

    expect(
      isActiveUsageLimitRecoveryState({
        runtimeStatus: "failed",
        lastErrorClass: "provider_error",
        latestRun: { status: "failed" },
      }),
    ).toBe(false);
    expect(
      isActiveUsageLimitRecoveryState({
        runtimeStatus: "running",
        lastErrorClass: "usage_limit",
        latestRun: { status: "failed" },
      }),
    ).toBe(false);
    expect(
      isActiveUsageLimitRecoveryState({
        runtimeStatus: "failed",
        lastErrorClass: "usage_limit",
        latestRun: null,
      }),
    ).toBe(false);
  });
});

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
