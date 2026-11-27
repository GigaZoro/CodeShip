import { describe, expect, it } from "vite-plus/test";

import { collectCaptureContext } from "./captureContext";

describe("collectCaptureContext", () => {
  it("records the marked components under the focus, visible notices and open panels", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <section data-workspace-area="chat" data-state="open">
        <div data-thread-details-panel="inline">
          <span data-markdown-copy="abc123" data-changed-file-row="README.md" data-prompt="deploy">
            <button id="focus" data-composer-shortcut="composer.mode">Mode</button>
          </span>
        </div>
      </section>
      <section data-workspace-area="terminal" hidden></section>
      <div data-slot="alert-title">Provider signed out</div>
      <div data-slot="toast-title" hidden>Old toast</div>
    `;
    document.body.append(root);
    const focus = root.querySelector<HTMLButtonElement>("#focus")!;
    focus.focus();
    try {
      const context = collectCaptureContext({ document, route: "/threads/1", pointer: null });
      expect({
        route: context.route,
        componentIds: context.componentIds.slice(0, 4),
        notices: context.notices,
        panels: context.panels,
      }).toEqual({
        route: "/threads/1",
        componentIds: [
          "button[data-composer-shortcut=composer.mode]",
          "span[data-markdown-copy data-changed-file-row data-prompt]",
          "div[data-thread-details-panel=inline]",
          "section[data-workspace-area=chat]",
        ],
        notices: ["alert: Provider signed out"],
        panels: ["chat"],
      });
    } finally {
      root.remove();
    }
  });
});
