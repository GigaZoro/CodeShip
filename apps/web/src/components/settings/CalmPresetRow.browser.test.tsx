import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { __resetCalmPresetForTests } from "./calmPreset";
import { CalmPresetRow } from "./CalmPresetRow";

function setup(overrides: Partial<ClientSettings> = {}) {
  __resetCalmPresetForTests();
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...overrides });
  return {
    [Symbol.dispose]: () => {
      __resetCalmPresetForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

describe("CalmPresetRow", () => {
  it("applies the Calm preset, shows what changed, and restores prior settings on Undo", async () => {
    using _cleanup = setup({
      interfaceDensity: "comfortable",
      threadDetailsItems: { openIn: true },
      foldFinishedWork: "never",
      statusColors: "vivid",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });
    await using screen = await render(<CalmPresetRow />);

    await userEvent.click(screen.getByRole("button", { name: "Apply Calm" }));

    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "compact",
      threadDetailsItems: {},
      foldFinishedWork: "older",
      statusColors: "calm",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });
    await expect.element(screen.getByText("Active")).toBeVisible();
    await expect
      .element(screen.getByText("Interface density: Comfortable → Compact spacing"))
      .toBeVisible();
    await expect.element(screen.getByText("Thread details: 8 of 18 on → Essentials")).toBeVisible();
    await expect.element(screen.getByText("Fold finished work: Never → Older turns")).toBeVisible();
    await expect.element(screen.getByText("Status colors: Vivid → Calm")).toBeVisible();

    const undoButton = screen.getByRole("button", { name: "Undo" });
    await expect.element(undoButton).toHaveFocus();
    await userEvent.click(undoButton);

    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "comfortable",
      threadDetailsItems: { openIn: true },
      foldFinishedWork: "never",
      statusColors: "vivid",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });
    await expect.element(screen.getByRole("button", { name: "Apply Calm" })).toHaveFocus();
  });
});
