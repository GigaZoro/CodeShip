import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SettingsTestWorkspace } from "./settingsTestWorkspace";
import { EnvironmentsMap } from "./EnvironmentsMap";
import { FleetDetails } from "./EnvironmentsMapDetails";
import { buildFleetGraph, type FleetEnvironmentInput, fleetStacks } from "./environmentsMap.logic";

vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

const linkedAt = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const hub: FleetEnvironmentInput = {
  environmentId: EnvironmentId.make("hub"),
  label: "hub",
  machine: "server",
  phase: "connected",
  enabled: true,
  routes: [],
  activeRouteId: null,
  refusedRouteIds: [],
  offersLinks: true,
  canWriteAccess: true,
  hasLinkAddress: true,
  outgoing: {
    state: "loaded",
    links: Array.from({ length: 10 }, (_, index) => ({
      environmentId: EnvironmentId.make(`vm-${index + 1}`),
      label: `vm-${index + 1}`,
      urls: [],
      access: "approval-required",
      linkedAt,
      expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
      lastReachedAt: null,
      lastError: null,
      status: "reachable",
    })),
  },
};

const renderSettingsMap = () =>
  render(
    <SettingsTestWorkspace>
      <EnvironmentsMap
        onAddEnvironment={() => {}}
        renderSavedEnvironment={() => null}
        renderConnectMachine={() => null}
      />
    </SettingsTestWorkspace>,
    { router: "/settings/connections" },
  );

describe("EnvironmentsMap", () => {
  it("clears the selection on Esc before Escape reaches the workspace", async () => {
    await using _screen = await renderSettingsMap();
    const settings = page.getByRole("region", { name: "Settings content" });
    const browser = page.getByRole("button", { name: "This browser", exact: true });

    await expect.element(settings).toHaveFocus();
    await browser.click();
    await expect.element(browser).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");

    await expect.element(browser).toHaveAttribute("aria-pressed", "false");
    // Clearing the selection consumes Escape before it reaches the workspace.
    expect(settings.element()).not.toHaveAttribute("data-unhandled-escape");

    await userEvent.keyboard("{Escape}");
    await expect.element(settings).toHaveAttribute("data-unhandled-escape", "true");
  });

  it("clears the selection on Esc when a click does not focus the machine", async () => {
    await using _screen = await renderSettingsMap();
    // Safari leaves focus where it was when a button is clicked.
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("mousedown", keepFocus, true);
    using _keepFocus = {
      [Symbol.dispose]: () => document.removeEventListener("mousedown", keepFocus, true),
    };
    const settings = page.getByRole("region", { name: "Settings content" });
    const browser = page.getByRole("button", { name: "This browser", exact: true });

    await expect.element(settings).toHaveFocus();
    await browser.click();
    await expect.element(browser).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");

    await expect.element(browser).toHaveAttribute("aria-pressed", "false");
    expect(settings.element()).not.toHaveAttribute("data-unhandled-escape");
  });

  it("clears the selection on Esc from the details before Escape reaches the workspace", async () => {
    await using _screen = await renderSettingsMap();
    const settings = page.getByRole("region", { name: "Settings content" });
    const browser = page.getByRole("button", { name: "This browser", exact: true });
    const details = page.getByRole("group", { name: "Details" });

    await expect.element(settings).toHaveFocus();
    await browser.click();
    await expect.element(browser).toHaveAttribute("aria-pressed", "true");
    // Choosing a machine or link inside the details leaves focus on the panel.
    (details.element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(browser).toHaveAttribute("aria-pressed", "false");
    expect(settings.element()).not.toHaveAttribute("data-unhandled-escape");

    await userEvent.keyboard("{Escape}");
    await expect.element(settings).toHaveAttribute("data-unhandled-escape", "true");
  });

  it("clears a stack's filter on Esc before Escape reaches the workspace", async () => {
    const graph = buildFleetGraph({
      clientLabel: "This browser",
      environments: [hub],
      connectMachines: [],
      now: linkedAt,
    });
    const [stack] = fleetStacks(graph, new Set());
    const onSelect = vi.fn();
    await using _screen = await render(
      <SettingsTestWorkspace>
        <FleetDetails
          graph={graph}
          stacks={[stack!]}
          environments={[]}
          connectProblem={null}
          selection={{ kind: "stack", id: stack!.id }}
          found={null}
          onSelect={onSelect}
          onLinkFrom={() => {}}
          onLinkBack={() => {}}
          onToggleStack={() => {}}
          renderSavedEnvironment={() => null}
          renderConnectMachine={() => null}
          onAddEnvironment={() => {}}
        />
      </SettingsTestWorkspace>,
      { router: "/settings/connections" },
    );
    const settings = page.getByRole("region", { name: "Settings content" });
    const filter = page.getByRole("searchbox", { name: "Filter these machines by name" });

    await filter.fill("vm-1");
    await expect.element(page.getByRole("status")).toHaveTextContent("2 of 10");
    await userEvent.keyboard("{Escape}");

    await expect.element(filter).toHaveValue("");
    expect(settings.element()).not.toHaveAttribute("data-unhandled-escape");
    expect(onSelect).not.toHaveBeenCalled();

    await filter.fill("vm-1");
    // An Escape that cancels an IME composition (Safari reports keyCode 229) belongs to the IME.
    for (const composition of [
      { isComposing: true, keyCode: 27 },
      { isComposing: false, keyCode: 229 },
    ]) {
      await act(() => {
        filter
          .element()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", ...composition, bubbles: true }),
          );
      });
      await expect.element(filter).toHaveValue("vm-1");
      expect(settings.element()).not.toHaveAttribute("data-unhandled-escape");
    }

    await userEvent.keyboard("{Escape}");
    await expect.element(filter).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    await expect.element(settings).toHaveAttribute("data-unhandled-escape", "true");
  });
});
