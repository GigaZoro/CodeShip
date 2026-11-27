import { assert, describe, it } from "vite-plus/test";

import { uiFeedbackMarkdown } from "./exportMarkdown";

describe("uiFeedbackMarkdown", () => {
  it("lists captures oldest first and counters by area, most clicked first", () => {
    const capture = {
      route: "/threads/1",
      componentIds: ["button[data-composer-shortcut=composer.mode]"],
      notices: ["alert: Provider signed out"],
      panels: ["chat"],
      viewport: { width: 1440, height: 900 },
      theme: "dark",
      density: "compact",
      hasScreenshot: false,
    };
    const markdown = uiFeedbackMarkdown({
      exportedAt: "2026-11-27T20:00:00.000Z",
      captures: [
        { ...capture, id: "b", createdAt: "2026-11-27T10:00:00.000Z", note: "second | note" },
        { ...capture, id: "a", createdAt: "2026-11-26T10:00:00.000Z", note: "first" },
      ],
      counters: {
        since: "2026-11-20T00:00:00.000Z",
        counts: { "nav:usage": 1, "nav:settings": 5, "composer:a|b": 2 },
      },
    });

    assert.isBelow(markdown.indexOf(": first"), markdown.indexOf(": second | note"));
    assert.include(
      markdown,
      "### Nav rail\n\n| Control | Clicks |\n| --- | ---: |\n| settings | 5 |\n| usage | 1 |",
    );
    assert.include(markdown, "| a\\|b | 2 |");
  });
});
