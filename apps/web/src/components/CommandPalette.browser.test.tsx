import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../hooks/useSettings";
import { CommandPalette } from "./CommandPalette";
import { __resetCalmPresetForTests } from "./settings/calmPreset";
import { AnchoredToastProvider, ToastProvider } from "./ui/toast";

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  __resetCalmPresetForTests();
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  return {
    [Symbol.dispose]: () => {
      __resetCalmPresetForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    using _cleanup = setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("opens a search intent with its query in the focused input", async () => {
    using _cleanup = setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("applies the Calm preset from the command palette and offers undo with what changed", async () => {
    using _cleanup = setup();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      interfaceDensity: "comfortable",
      statusColors: "vivid",
      foldFinishedWork: "never",
      notificationMode: "notifications-and-sound",
    });
    await using _screen = await render(
      <ToastProvider>
        <AnchoredToastProvider>
          <CommandPalette>{null}</CommandPalette>
        </AnchoredToastProvider>
      </ToastProvider>,
    );

    openCommandPalette({ query: "> calm preset" });
    await userEvent.click(page.getByText("Apply Calm preset"));

    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "compact",
      threadDetailsItems: {},
      foldFinishedWork: "older",
      statusColors: "calm",
      notificationMode: "notifications-and-sound",
    });
    await expect.element(page.getByText("Calm preset applied")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Interface density: Comfortable → Compact spacing · Fold finished work: Never → Older turns · Status colors: Vivid → Calm",
        ),
      )
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Undo" }));
    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "comfortable",
      statusColors: "vivid",
      foldFinishedWork: "never",
      notificationMode: "notifications-and-sound",
    });
  });
});
