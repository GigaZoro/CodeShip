import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { SettingsTestWorkspace } from "./settingsTestWorkspace";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";

vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

it("Esc in the license search closes it without passing Escape to the workspace", async () => {
  const entry = {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "MIT License",
    sourceUrl: null,
    version: "19.0.0",
  };
  const realFetch = globalThis.fetch.bind(globalThis);
  using _fetch = stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (input instanceof Request ? input.url : String(input)).endsWith("/third-party-licenses.json")
      ? Promise.resolve(Response.json({ schemaVersion: 1, entries: [entry] }))
      : realFetch(input, init),
  );
  await using _screen = await render(
    <SettingsTestWorkspace>
      <OpenSourceLicensesPanel />
    </SettingsTestWorkspace>,
    { router: "/settings/open-source-licenses" },
  );
  const settings = page.getByRole("region", { name: "Settings content" });
  const search = page.getByRole("searchbox", { name: "Search open-source licenses" });
  const openSearch = async () => {
    const button = page.getByRole("button", { name: "Search open-source licenses" });
    await expect.element(button).toBeVisible();
    (button.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(search).toHaveFocus();
  };
  await openSearch();
  await search.fill("react");

  await userEvent.keyboard("{Escape}");

  await expect.element(settings).not.toHaveAttribute("data-unhandled-escape");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(settings).toHaveFocus();

  await openSearch();
  await expect.element(search).toHaveValue("");
  await userEvent.keyboard("{Escape}");

  await expect.element(settings).not.toHaveAttribute("data-unhandled-escape");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(settings).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  await expect.element(settings).toHaveAttribute("data-unhandled-escape", "true");
});
