import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { usageEnvironmentStatus } from "./usageEnvironmentStatus";

const unreadableTranscript: UsageSummary["sources"][number] = {
  fingerprint: {
    hostId: "fixture-host",
    provider: "claude",
    resolvedHomePath: "/home/fixture/.claude",
    volumeId: "1:2",
  },
  status: "partial",
  scannedFiles: 3,
  skippedFiles: 1,
  malformedRecords: 0,
  distinctSessions: 2,
  message: "One transcript could not be read.",
};

it.each([
  ["settled scanTimedOut figures", { partialReason: "scanTimedOut" as const, sources: [] }],
  ["a transcript the scan could not read", { sources: [unreadableTranscript] }],
  ["a source that failed", { sources: [{ ...unreadableTranscript, status: "failed" as const }] }],
])("labels %s as incomplete in the mobile selector", (_case, figures) => {
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
        usageSettingsKey: "settings",
        summary: {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-11-21T12:00:00.000Z",
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-11-21"),
          untilDay: UsageDay.make("2026-11-21"),
          buckets: [],
          pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 30_000,
          ...figures,
        },
      },
      false,
      (provider) => provider,
    ),
  ).toBe("Usage figures may be incomplete");
});
