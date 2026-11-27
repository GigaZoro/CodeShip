import { describe, expect, it } from "vite-plus/test";

import { OWNS_LETTER_KEYS_ATTRIBUTE, shouldTypeToFocusComposer } from "./composerFocusRedirect";

function typeOn(target: HTMLElement, key: string) {
  let redirected: boolean | undefined;
  const listener = (event: KeyboardEvent) => {
    redirected = shouldTypeToFocusComposer(event);
  };
  window.addEventListener("keydown", listener, true);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  window.removeEventListener("keydown", listener, true);
  return redirected;
}

describe("shouldTypeToFocusComposer", () => {
  it("leaves letters to a list that answers them itself, and types the rest", () => {
    const list = document.createElement("ul");
    const row = document.createElement("li");
    row.tabIndex = -1;
    list.append(row);
    document.body.append(list);
    try {
      expect(typeOn(row, "a")).toBe(true);
      list.setAttribute(OWNS_LETTER_KEYS_ATTRIBUTE, "");
      expect(typeOn(row, "a")).toBe(false);
    } finally {
      list.remove();
    }
  });
});
