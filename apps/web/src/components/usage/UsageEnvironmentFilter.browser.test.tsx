import { EnvironmentId, USAGE_CONTRACT_VERSION, UsageDay } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageEnvironmentFilter } from "./UsagePage";

it("shows an incomplete status for settled scanTimedOut figures in the web selector", async () => {
  const environments: readonly EnvironmentUsageStatus[] = [
    {
      environmentId: EnvironmentId.make("fixture"),
      label: "Fixture environment",
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
  ];
  await using screen = await render(
    <UsageEnvironmentFilter
      environments={environments}
      selectedEnvironments={environments}
      selectedEnvironmentIds={null}
      onSelectionChange={vi.fn()}
      showUsageStatus
      refreshing={false}
      isPartial={false}
      duplicateSources={[]}
      contractMismatches={[]}
      onOpenModelPrices={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "All environments" }).click();
  await expect.element(page.getByText("Usage figures may be incomplete")).toBeVisible();
});
