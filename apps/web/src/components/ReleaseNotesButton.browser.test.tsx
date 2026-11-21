import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import releaseNotes from "../../../../docs/release-notes.md?raw";
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
  const entries = releaseNotes.trim().split(/(?=^## )/m);
  const pages = Math.ceil(entries.length / 10);
  await expect.element(dialog.getByText(`Page 1 of ${pages}`)).toBeVisible();
  const noteHeadings = () => dialog.element().querySelectorAll("[data-slot=dialog-panel] h2");
  expect(noteHeadings()).toHaveLength(10);
  const firstHeading = noteHeadings()[0]!.textContent;
  await dialog.getByRole("button", { name: "Next page" }).click();
  await expect.element(dialog.getByText(`Page 2 of ${pages}`)).toBeVisible();
  expect(noteHeadings()[0]!.textContent).not.toBe(firstHeading);
  const search = dialog.getByRole("searchbox", { name: "Search release notes" });
  const oldestHeading = entries.at(-1)!.split("\n")[0]!.slice(3);
  await search.fill(oldestHeading.toUpperCase());
  await expect.element(dialog.getByRole("list").first()).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  expect(noteHeadings()).toHaveLength(1);
  await search.fill("no-such-release-in-this-history");
  await expect.element(dialog.getByText("No results found.")).toBeVisible();
  await search.fill("");
  await expect.element(dialog.getByText(`Page 1 of ${pages}`)).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});
