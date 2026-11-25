import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTaskRunStats,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
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
  configPending: false,
  grantFailures: new Set<string>(),
  recovering: null as null | ReturnType<typeof recoveryGrant>,
  requests: new Set<string>(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["desk", "laptop"].map((environmentId) => ({
      environmentId,
      serverConfig: data.configPending
        ? null
        : { environment: { capabilities: { scheduledTaskGroups: true } } },
    })),
  }),
}));
vi.mock("../../state/session", async (importOriginal) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/session")>()),
    environmentSession: {
      sessionStateAtom: () => data.recovering ?? Atom.make(AsyncResult.initial()),
    },
    environmentSessionStatesAtom: (key: string) =>
      Atom.make((get) =>
        data.recovering
          ? [get(data.recovering)]
          : key === ""
            ? []
            : key.split("\n").map((id) =>
                data.checking.has(id)
                  ? AsyncResult.initial(true)
                  : data.grantFailures.has(id)
                    ? AsyncResult.fail(new Error("Session request failed"))
                    : AsyncResult.success({
                        authenticated: true,
                        scopes: data.denied.has(id) ? [] : [AuthOrchestrationReadScope],
                      }),
              ),
      ),
  };
});
vi.mock("../../state/scheduledTaskStats", async (original) => ({
  ...(await original<typeof import("../../state/scheduledTaskStats")>()),
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
    />
  );
}

function readyStats() {
  data.configPending = false;
  data.stats.clear();
  data.errors.clear();
  data.denied.clear();
  data.checking.clear();
  data.grantFailures.clear();
  data.recovering = null;
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

function recoveryGrant() {
  let checks = 0;
  return Atom.make(() =>
    ++checks === 1
      ? AsyncResult.fail(new Error("Session request failed"))
      : AsyncResult.success({ authenticated: true, scopes: [AuthOrchestrationReadScope] }),
  );
}

it("restores scheduled rows and focus by retrying the observed session grant", async () => {
  readyStats();
  data.recovering = recoveryGrant();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const refresh = vi.spyOn(registry, "refresh");
  await using screen = await render(
    <RegistryContext value={registry}>{groups(0)}</RegistryContext>,
  );
  expect(data.requests.size).toBe(0);
  expect(screen.container.textContent).toContain(
    "Could not check access to scheduled task runs on Desk.",
  );
  const retry = screen.getByRole("button", { name: "Retry" });
  (retry.element() as HTMLButtonElement).focus();
  await retry.click();
  expect(refresh).toHaveBeenCalledWith(data.recovering);
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Scheduled task groups" }).element(),
  );
});

it("moves focus to the heading when a stats retry clears its error", async () => {
  readyStats();
  data.recovering = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: [AuthOrchestrationReadScope] }),
  );
  data.errors.set("desk", "Stats read failed.");
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const refresh = vi.spyOn(registry, "refresh").mockImplementation(() => {});
  const view = () => <RegistryContext value={registry}>{groups(0)}</RegistryContext>;
  await using screen = await render(view());
  const retry = screen.getByRole("button", { name: "Retry" });
  (retry.element() as HTMLButtonElement).focus();
  await retry.click();
  expect(refresh).toHaveBeenCalledTimes(1);

  data.errors.clear();
  await screen.rerender(view());
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Scheduled task groups" }).element(),
  );
});

it("checks scheduled task support while the connected server config is missing", async () => {
  readyStats();
  data.configPending = true;
  await using screen = await render(groups(0));
  expect(screen.container.textContent).toContain("Checking scheduled task support on Desk…");
  expect(screen.container.textContent).not.toContain("older T3.CodeShip");
  expect(data.requests.size).toBe(0);
  data.configPending = false;
  await screen.rerender(groups(0));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
});

it("keeps each environment's status outside the busy results", async () => {
  readyStats();
  data.configPending = true;
  await using screen = await render(groups(0, false, true));
  const statuses = () => [...screen.container.querySelectorAll('[role="status"]')];
  expect(statuses().map((status) => status.textContent)).toEqual([
    "Checking scheduled task support on Desk…",
    "Checking scheduled task support on Laptop…",
  ]);
  for (const status of statuses()) expect(status.closest('[aria-busy="true"]')).toBeNull();

  data.configPending = false;
  data.errors.set("laptop", "Stats read failed.");
  await screen.rerender(groups(0, false, true));
  await expect.element(screen.getByRole("row", { name: /Nightly/ })).toBeVisible();
  expect(statuses().map((status) => status.textContent)).toEqual([
    "Could not load scheduled task runs: Laptop: Stats read failed.Retry",
  ]);
  for (const status of statuses()) expect(status.closest('[aria-busy="true"]')).toBeNull();

  data.stats.delete("laptop");
  data.errors.clear();
  await screen.rerender(groups(0, false, true));
  expect(
    screen
      .getByRole("row", { name: /Nightly/ })
      .element()
      .closest('[aria-busy="true"]'),
  ).not.toBeNull();
});
