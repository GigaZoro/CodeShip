import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { adjacentFileKey, createCodeViewFileReveal } from "./useCodeViewFileReveal";

function viewer(initialItems: ReadonlyArray<string>, layout?: { tops: number[]; height: number }) {
  const items = new Set(initialItems);
  const scrolls: CodeViewScrollTarget[] = [];
  const viewport = {
    scrollTop: 0,
    getScrollTop: () => viewport.scrollTop,
    getHeight: () => layout?.height ?? 0,
    // Each file is 100px tall.
    getScrollHeight: () => (layout?.tops.at(-1) ?? -100) + 100,
    getTopForItem: (id: string) => layout?.tops[initialItems.indexOf(id)],
  };
  return {
    items,
    scrolls,
    viewport,
    getInstance: () => viewport,
    getItem: (id: string) => (items.has(id) ? {} : undefined),
    scrollTo: (target: CodeViewScrollTarget) => scrolls.push(target),
  };
}

describe("createCodeViewFileReveal", () => {
  it("scrolls at once to a file the viewer holds", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"]);
    reveal.attach(view);

    reveal.request("a");

    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
  });

  it("keeps a missing file pending until a flush finds it, then drops it", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer([]);
    reveal.attach(view);

    reveal.request("a");
    reveal.flush();
    expect(view.scrolls).toEqual([]);

    view.items.add("a");
    reveal.flush();
    reveal.flush();
    expect(view.scrolls).toHaveLength(1);
  });

  it("applies a reveal asked before the viewer mounted once it holds the file", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer([]);

    reveal.request("a");
    reveal.attach(view);
    expect(view.scrolls).toEqual([]);

    view.items.add("a");
    reveal.flush();
    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
  });

  it("drops a pending reveal when its viewer detaches, and positions the next viewer on request", () => {
    const reveal = createCodeViewFileReveal();
    const first = viewer([]);
    const second = viewer(["a"]);
    reveal.attach(first);

    reveal.request("a");
    reveal.attach(null);
    reveal.attach(second);
    reveal.flush();
    expect(second.scrolls).toEqual([]);

    reveal.request("a");
    expect(second.scrolls).toHaveLength(1);
  });

  it("finds the file whose top has reached the top of the viewport", () => {
    const reveal = createCodeViewFileReveal();
    const files = ["a", "b", "c", "d"];
    const view = viewer(files, { tops: [0, 100, 200, 300], height: 150 });
    reveal.attach(view);

    expect(reveal.fileAtTop(files)).toBe("a");
    view.viewport.scrollTop = 150;
    expect(reveal.fileAtTop(files)).toBe("b");
    view.viewport.scrollTop = 200;
    expect(reveal.fileAtTop(files)).toBe("c");
  });

  it("steps through the last files, which cannot scroll to the top, from the one last revealed", () => {
    const reveal = createCodeViewFileReveal();
    const files = ["a", "b", "c", "d"];
    const view = viewer(files, { tops: [0, 100, 200, 300], height: 250 });
    reveal.attach(view);
    view.viewport.scrollTop = 150;

    reveal.request("c");
    expect(reveal.fileAtTop(files)).toBe("c");
    reveal.request("d");
    expect(reveal.fileAtTop(files)).toBe("d");
  });

  it("reads a reveal still waiting for its file as the current file", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"], { tops: [0], height: 100 });
    reveal.attach(view);

    reveal.request("b");
    expect(reveal.fileAtTop(["a", "b"])).toBe("b");
  });
});

describe("adjacentFileKey", () => {
  const files = ["a", "b", "c"];

  it("moves one file either way and stops at the ends", () => {
    expect(adjacentFileKey(files, "b", "next")).toBe("c");
    expect(adjacentFileKey(files, "b", "previous")).toBe("a");
    expect(adjacentFileKey(files, "c", "next")).toBeNull();
    expect(adjacentFileKey(files, "a", "previous")).toBeNull();
  });

  it("starts at the first file when there is no current one", () => {
    expect(adjacentFileKey(files, null, "next")).toBe("a");
    expect(adjacentFileKey(files, null, "previous")).toBeNull();
  });
});
