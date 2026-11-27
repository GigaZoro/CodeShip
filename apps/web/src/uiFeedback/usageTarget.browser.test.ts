import { describe, expect, it } from "vite-plus/test";

import { resolveUsageTarget } from "./usageTarget";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function target(root: HTMLElement, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

describe("resolveUsageTarget", () => {
  it("keys each counted area by the control's id, never its text", () => {
    const root = mount(`
      <nav data-ui-usage-area="nav-rail">
        <button data-ui-usage="usage" aria-label="Usage: Claude 40% left"><svg id="nav-icon"></svg></button>
      </nav>
      <div data-slot="composer-shell">
        <button data-composer-shortcut="composer.mode composer.cycle" id="mode">Plan</button>
        <button aria-label="3 queued" id="queued">3</button>
        <textarea id="prompt"></textarea>
      </div>
      <aside data-thread-details-panel="inline">
        <div data-thread-details-pr-list><button id="pr">#1234 Fix the build</button></div>
        <div data-thread-relationships-panel>
          <button aria-label="Fix the auth token leak running" title="Fix the auth token leak" id="related">Fix</button>
        </div>
        <button id="branch">feature/secret-branch</button>
      </aside>
      <button aria-label="Outside" id="outside"></button>
    `);
    try {
      expect(
        ["#nav-icon", "#mode", "#queued", "#prompt", "#pr", "#related", "#branch", "#outside"].map(
          (selector) => resolveUsageTarget(target(root, selector)),
        ),
      ).toEqual([
        "nav:usage",
        "composer:composer.mode",
        "composer:unlabeled button",
        null,
        "details:thread-details-pr-list button",
        "details:thread-relationships-panel button",
        "details:unlabeled button",
        null,
      ]);
    } finally {
      root.remove();
    }
  });
});
