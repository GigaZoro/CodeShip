import { EnvironmentId, ScheduledTaskId, type ScheduledTaskRunStats } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageScheduledTaskGroups } from "./UsageScheduledTaskGroups";

const data = vi.hoisted(() => ({ stats: null as ScheduledTaskRunStats[] | null }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "desk" }] }),
}));
vi.mock("../../state/scheduledTaskStats", () => ({
  supportsScheduledTaskGroups: () => true,
  useScheduledTaskStats: (ids: readonly EnvironmentId[]) =>
    ids.map((environmentId) => ({ environmentId, stats: data.stats, error: null })),
}));

it("keeps scheduled group rows while the hourly range advances for the same selection", async () => {
  const environment: EnvironmentUsageStatus = {
    label: "Desk",
    environmentId: EnvironmentId.make("desk"),
    canReadDiagnostics: true,
    error: null,
    isConnected: true,
    isPending: false,
    summary: null,
    needsCursorKeychainAccess: false,
  };
  const time = Date.parse("2026-11-21T12:00:00Z");
  const groups = (minutes: number, changed = false) => (
    <UsageScheduledTaskGroups
      selectionKey={changed ? "week" : "day"}
      period={makeWindow(changed ? 7 : 1, new Date(time + minutes * 60_000), "hour")}
      environments={[environment]}
      readOnly={false}
    />
  );
  data.stats = [
    {
      id: ScheduledTaskId.make("task"),
      group: "Nightly",
      title: "Scan",
      runs: 3,
      failed: 0,
      usageLimited: 0,
      costUsd: 1,
      unpricedRuns: 0,
    },
  ];
  await using screen = await render(groups(0));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  data.stats = null;
  await screen.rerender(groups(1));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  await expect.element(screen.getByText("Loading…")).not.toBeInTheDocument();
  await screen.rerender(groups(1, true));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Loading…")).toBeVisible();
});
