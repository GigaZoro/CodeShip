import { loadMessageCatalog } from "@t3tools/client-runtime/i18n/catalogs";
import { activateLanguage } from "@t3tools/shared/i18n";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

it.each([
  { lineEnd: 7, label: "Термінал 2, рядок 7" },
  { lineEnd: 9, label: "Термінал 2, рядки 7–9" },
])("shows the exact Ukrainian line label $label", async ({ lineEnd, label }) => {
  activateLanguage({
    language: "uk",
    catalog: await loadMessageCatalog("uk"),
    formattingLocale: "uk-UA",
  });
  await using screen = await render(
    <TerminalContextInlineChip
      terminalLabel="Термінал 2"
      lineStart={7}
      lineEnd={lineEnd}
      text="terminal output"
      detailsMode="popover"
    />,
  );

  await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
});
