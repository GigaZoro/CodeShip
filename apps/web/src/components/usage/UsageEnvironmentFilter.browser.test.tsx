import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageEnvironmentFilter } from "./UsagePage";

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
])("shows an incomplete status for %s in the web selector", async (_case, figures) => {
  const environments: readonly EnvironmentUsageStatus[] = [
    {
      environmentId: EnvironmentId.make("fixture"),
      label: "Fixture environment",
      isConnected: true,
      isPending: false,
      canReadDiagnostics: true,
      error: null,
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
  ];
  await using screen = await render(
    <UsageEnvironmentFilter
      environments={environments}
      selectedEnvironments={environments}
      selectedEnvironmentIds={null}
      onSelectionChange={vi.fn()}
      showUsageStatus
      refreshingEnvironmentIds={new Set()}
      duplicateSources={[]}
      coverage={null}
      onOpenModelPrices={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "All environments" }).click();
  await expect.element(page.getByText("Usage figures may be incomplete")).toBeVisible();
});
