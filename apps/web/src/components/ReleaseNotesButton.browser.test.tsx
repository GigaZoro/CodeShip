import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { ReleaseNotesButton } from "./ReleaseNotesButton";

it("opens the bundled history and returns keyboard focus when dismissed", async () => {
  await using screen = await render(<ReleaseNotesButton />);
  const trigger = screen.getByRole("button", { name: "Release notes", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Release notes", exact: true });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByRole("list").first()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});
