import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
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

it("updates the closed Usage rail badge at resets without rendering on minute ticks", async () => {
  const checkedAt = "2026-11-21T12:00:00.000Z";
  state.presentations = new Map([
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
                    usedPercent: 20,
                    resetsAt: "2026-11-21T12:02:30.000Z",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
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
  await expect.element(screen.getByRole("button", { name: /Usage:.*80% left/ })).toBeVisible();
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  rendered.mockClear();

  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(rendered).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(rendered).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(rendered).toHaveBeenCalledTimes(1);
});
