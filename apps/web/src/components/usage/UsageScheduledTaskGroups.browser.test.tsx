import { EnvironmentId, ScheduledTaskId, type ScheduledTaskRunStats } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageScheduledTaskGroups } from "./UsageScheduledTaskGroups";

const data = vi.hoisted(() => ({
  stats: new Map<string, ScheduledTaskRunStats[] | null>(),
  errors: new Map<string, string>(),
  denied: new Set<string>(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "desk" }, { environmentId: "laptop" }],
  }),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentsWithScope: (entries: readonly { environmentId: EnvironmentId }[]) =>
    new Set(entries.map(({ environmentId }) => environmentId).filter((id) => !data.denied.has(id))),
}));
vi.mock("../../state/scheduledTaskStats", () => ({
  supportsScheduledTaskGroups: () => true,
  useScheduledTaskStats: (ids: readonly EnvironmentId[]) =>
    ids.map((environmentId) => ({
      environmentId,
      stats: data.stats.get(environmentId) ?? null,
      error: data.errors.get(environmentId) ?? null,
    })),
}));

function groups(minutes: number, changed = false, withLaptop = false) {
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
  return (
    <UsageScheduledTaskGroups
      selectionKey={changed ? "week" : "day"}
      period={makeWindow(changed ? 7 : 1, new Date(time + minutes * 60_000), "hour")}
      environments={
        withLaptop
          ? [
              environment,
              { ...environment, label: "Laptop", environmentId: EnvironmentId.make("laptop") },
            ]
          : [environment]
      }
      readOnly={false}
    />
  );
}

function readyStats() {
  data.stats.clear();
  data.errors.clear();
  data.denied.clear();
  data.stats.set("desk", [
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
  ]);
}

it("keeps scheduled group rows while the hourly range advances for the same selection", async () => {
  readyStats();
  await using screen = await render(groups(0));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  data.stats.clear();
  await screen.rerender(groups(1));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  await expect.element(screen.getByText("Loading…")).not.toBeInTheDocument();
  await screen.rerender(groups(1, true));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Loading…")).toBeVisible();
});

it("drops a denied environment's scheduled rows while another read is pending", async () => {
  readyStats();
  const desk = data.stats.get("desk")![0]!;
  data.stats.set("laptop", [
    { ...desk, id: ScheduledTaskId.make("laptop-task"), group: "Laptop jobs" },
  ]);
  await using screen = await render(groups(0, false, true));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  await expect.element(screen.getByRole("row", { name: /Laptop jobs/ })).toBeVisible();

  data.stats.clear();
  data.denied.add("desk");
  data.errors.set("desk", "Missing orchestration:read");
  await screen.rerender(groups(1, false, true));
  await expect.element(screen.getByText(/Missing orchestration:read/)).toBeVisible();
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("row", { name: /Laptop jobs/ })).toBeVisible();

  data.stats.set("laptop", [{ ...desk, group: "Current jobs" }]);
  await screen.rerender(groups(1, false, true));
  await expect.element(screen.getByRole("row", { name: /Current jobs/ })).toBeVisible();
  await expect
    .element(screen.getByRole("row", { name: /Nightly|Laptop jobs/ }))
    .not.toBeInTheDocument();
});
