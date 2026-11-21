import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTaskRunStats,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageScheduledTaskGroups } from "./UsageScheduledTaskGroups";

const data = vi.hoisted(() => ({
  stats: new Map<string, ScheduledTaskRunStats[] | null>(),
  errors: new Map<string, string>(),
  denied: new Set<string>(),
  checking: new Set<string>(),
  requests: new Set<string>(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "desk" }, { environmentId: "laptop" }],
  }),
}));
vi.mock("../../state/session", async (importOriginal) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/session")>()),
    environmentSessionStatesAtom: (key: string) =>
      Atom.make(
        key === ""
          ? []
          : key.split("\n").map((id) =>
              data.checking.has(id)
                ? AsyncResult.initial(true)
                : AsyncResult.success({
                    authenticated: true,
                    scopes: data.denied.has(id) ? [] : [AuthOrchestrationReadScope],
                  }),
            ),
      ),
  };
});
vi.mock("../../state/scheduledTaskStats", () => ({
  supportsScheduledTaskGroups: () => true,
  useScheduledTaskStats: (ids: readonly EnvironmentId[]) =>
    ids.map((environmentId) => {
      data.requests.add(environmentId);
      return {
        environmentId,
        stats: data.stats.get(environmentId) ?? null,
        error: data.errors.get(environmentId) ?? null,
      };
    }),
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
  data.checking.clear();
  data.requests.clear();
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

  data.stats.delete("laptop");
  data.denied.add("desk");
  data.requests.clear();
  await screen.rerender(groups(1, false, true));
  await expect
    .element(screen.getByText(/lacks permission to read scheduled task runs on Desk/))
    .toBeVisible();
  expect(data.requests).toEqual(new Set(["laptop"]));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("row", { name: /Laptop jobs/ })).toBeVisible();

  data.stats.set("laptop", [{ ...desk, group: "Current jobs" }]);
  await screen.rerender(groups(1, false, true));
  await expect.element(screen.getByRole("row", { name: /Current jobs/ })).toBeVisible();
  await expect
    .element(screen.getByRole("row", { name: /Nightly|Laptop jobs/ }))
    .not.toBeInTheDocument();
});

it("waits for the scheduled-task grant before requesting stats or reporting a denial", async () => {
  readyStats();
  data.checking.add("desk");
  await using screen = await render(groups(0));
  await expect
    .element(screen.getByText("Checking access to scheduled task runs on Desk…"))
    .toBeVisible();
  await expect.element(screen.getByText(/lacks permission/)).not.toBeInTheDocument();
  expect(data.requests.size).toBe(0);
  data.checking.clear();
  await screen.rerender(groups(0));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  expect(data.requests).toEqual(new Set(["desk"]));
});
