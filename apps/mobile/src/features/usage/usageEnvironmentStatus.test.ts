import { EnvironmentId, USAGE_CONTRACT_VERSION, UsageDay } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { usageEnvironmentStatus } from "./usageEnvironmentStatus";

it("labels settled scanTimedOut figures as incomplete in the mobile selector", () => {
  expect(
    usageEnvironmentStatus(
      {
        environmentId: EnvironmentId.make("fixture"),
        label: "Fixture",
        isConnected: true,
        isPending: false,
        canReadDiagnostics: true,
        error: null,
        needsCursorKeychainAccess: false,
        summary: {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-11-21T12:00:00.000Z",
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-11-21"),
          untilDay: UsageDay.make("2026-11-21"),
          buckets: [],
          sources: [],
          pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 30_000,
          partialReason: "scanTimedOut",
        },
      },
      false,
      (provider) => provider,
    ),
  ).toBe("Usage figures may be incomplete");
});
