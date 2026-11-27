import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { minuteTick } from "@t3tools/client-runtime/clock";
import { UsageLimitsSection } from "../usage/UsageLimits";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { collectLimitAccounts, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { UsageLimitsGlance } from "../usage/UsageLimitsGlance";
import { SidebarNavRailUsageItem } from "./SidebarNavRail";

const state = vi.hoisted(() => ({ presentations: new Map() as LimitPresentations }));

vi.mock("../../state/presentation", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await importOriginal<typeof import("../../state/presentation")>();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsWithProvidersAtom: Atom.make(() => state.presentations),
    },
  };
});

function readings(checkedAt: string, resetsAt?: string): LimitPresentations {
  return new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        serverConfig: {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt,
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt,
                windows: [
                  {
                    id: "primary",
                    kind: "session",
                    label: "5-hour",
                    usedPercent: 90,
                    ...(resetsAt === undefined ? {} : { resetsAt }),
                  },
                  { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 80 },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
}

it.each(["timer", "focus", "visibilitychange"] as const)(
  "updates the closed Usage rail badge at resets after %s without minute renders",
  async (wake) => {
    const checkedAt = "2026-11-21T12:00:00.000Z";
    state.presentations = readings(checkedAt, "2026-11-21T12:02:30.000Z");
    using _timers = fakeTimers();
    vi.setSystemTime(new Date(checkedAt));
    const rendered = vi.fn();
    await using screen = await render(
      <SidebarProvider>
        <SidebarMenu>
          <Profiler id="usage" onRender={rendered}>
            <SidebarNavRailUsageItem isActive={false} onClick={() => {}} />
          </Profiler>
        </SidebarMenu>
      </SidebarProvider>,
      { router: "/projects" },
    );
    await expect.element(screen.getByRole("button", { name: /Usage:.*10% left/ })).toBeVisible();
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
    rendered.mockClear();

    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(rendered).not.toHaveBeenCalled();
    if (wake === "timer") {
      await act(() => vi.advanceTimersByTimeAsync(30_000));
    } else {
      await act(() => {
        vi.setSystemTime(new Date("2026-11-21T13:02:00.000Z"));
        if (wake === "focus") globalThis.window.dispatchEvent(new Event("focus"));
        else document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Usage:.*20% left/ }).query()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(rendered).toHaveBeenCalledTimes(1);
  },
);

it("an open Usage glance with no future reset does not subscribe to minute ticks", async () => {
  const checkedAt = "2026-11-21T12:00:00.000Z";
  state.presentations = readings(checkedAt);
  using _timers = fakeTimers();
  vi.setSystemTime(new Date(checkedAt));
  const rendered = vi.fn();
  await using screen = await render(
    <Profiler id="glance" onRender={rendered}>
      <UsageLimitsGlance accounts={collectLimitAccounts(state.presentations)} />
    </Profiler>,
  );
  await expect.element(screen.getByText("20% left")).toBeVisible();
  rendered.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(rendered).not.toHaveBeenCalled();
});

it("an empty web Limits section displays its message without a minute subscription", async () => {
  const serverConfig = {
    providers: [],
    environment: { capabilities: {} },
    settings: DEFAULT_SERVER_SETTINGS,
  };
  state.presentations = new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        serverConfig,
        connection: { phase: "connected" },
      },
    ],
  ]);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using minute = vi.spyOn(minuteTick, "subscribe");
  await using screen = await render(
    <RegistryContext value={registry}>
      <UsageLimitsSection selectedEnvironmentIds={null} hiddenProviders={new Set()} />
    </RegistryContext>,
  );
  expect(screen.container.textContent).toMatch(/No provider/);
  expect(minute).not.toHaveBeenCalled();
});
