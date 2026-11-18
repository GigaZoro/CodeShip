import { ProviderInstanceId, type ApiCreditUsageRow } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ApiCreditRows } from "./ApiCredits";

it("distinguishes unlinked plans from spent credits and exposes loading, retry, and empty states", async () => {
  const onRefresh = vi.fn();
  const props = { label: "Desk", onRefresh, loading: false, error: false };
  const rows: ReadonlyArray<ApiCreditUsageRow> = [
    {
      planInstanceId: ProviderInstanceId.make("personal"),
      planName: "Personal plan",
      suggestedGrantUsd: 100,
      apiAccounts: [],
    },
    {
      planInstanceId: ProviderInstanceId.make("work"),
      planName: "Work plan",
      suggestedGrantUsd: 100,
      apiAccounts: [
        {
          instanceId: ProviderInstanceId.make("work_api"),
          displayName: "Work API",
          credit: {
            linkedPlanInstanceId: ProviderInstanceId.make("work"),
            grantUsd: 50,
            cycleStart: "2026-11-01T00:00:00.000Z",
            cycleEnd: "2026-12-01T00:00:00.000Z",
            checkedAt: "2026-11-19T00:00:00.000Z",
            meteringStartedAt: "2026-11-01T00:00:00.000Z",
            balanceState: "exhausted",
            spendUsd: 50,
            estimatedRemainingUsd: 0,
            spendSource: "metered",
            unpricedUsage: false,
          },
        },
      ],
    },
  ];
  await using screen = await render(<ApiCreditRows {...props} rows={null} loading />);
  await expect.element(screen.getByRole("status", { name: "Loading API credits" })).toBeVisible();
  await screen.rerender(<ApiCreditRows {...props} rows={null} error />);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not load API credits. Try refreshing.");
  await screen.getByRole("button", { name: "Refresh credits" }).click();
  expect(onRefresh).toHaveBeenCalledOnce();
  await screen.rerender(<ApiCreditRows {...props} rows={[]} />);
  await expect
    .element(screen.getByText("Add a Claude subscription account", { exact: false }))
    .toBeVisible();
  await screen.rerender(<ApiCreditRows {...props} rows={rows} />);
  await expect.element(screen.getByText("Not linked", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Spent", { exact: true })).toBeVisible();
  await screen.getByText("Claim and link API credits", { exact: true }).click();
  await expect
    .element(screen.getByText("Link an Anthropic Console organization", { exact: false }))
    .toBeVisible();
});
