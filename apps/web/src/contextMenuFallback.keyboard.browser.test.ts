import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  dismissContextMenu,
  isContextMenuOpen,
  showContextMenuFallback,
} from "./contextMenuFallback";

const items = [
  { id: "heading", label: "Thread actions", header: true },
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "rename", label: "Rename" },
  { id: "pin", label: "Pinned", checked: true, separatorBefore: true },
  {
    id: "copy",
    label: "Copy",
    children: [
      { id: "copy-unavailable", label: "Unavailable copy", disabled: true },
      { id: "path", label: "Path" },
      { id: "branch", label: "Branch" },
      { id: "more", label: "More", children: [{ id: "tag", label: "Tag" }] },
    ],
  },
];

async function wideViewport() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  return { [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height) };
}

const menuAt = (level: number) =>
  document.querySelector(`[data-context-menu][data-level="${level}"]`)!.getBoundingClientRect();

function setup() {
  const origin = document.createElement("button");
  origin.textContent = "Selected thread";
  document.body.append(origin);
  origin.focus();
  return {
    origin,
    [Symbol.dispose]() {
      dismissContextMenu();
      origin.remove();
    },
  };
}

function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}

const label = () => document.activeElement?.textContent;

it("starts a keyboard-opened menu on its first action and wraps through enabled actions", () => {
  using _fixture = setup();
  void showContextMenuFallback(items);
  expect(label()).toBe("Rename");
  press("ArrowUp");
  expect(label()).toBe("Copy");
  press("ArrowDown");
  expect(label()).toBe("Rename");
  press("End");
  expect(label()).toBe("Copy");
  press("Home");
  expect(label()).toBe("Rename");
});

it("opens and cancels one submenu level at a time, then returns to the thread", async () => {
  using fixture = setup();
  const result = showContextMenuFallback(items);
  press("End");
  const parent = document.activeElement;
  press("ArrowRight");
  expect(label()).toBe("Path");
  press("ArrowLeft");
  expect(document.activeElement).toBe(parent);
  press("Enter");
  expect(label()).toBe("Path");
  press("Escape");
  expect(document.activeElement).toBe(parent);
  expect(isContextMenuOpen()).toBe(true);
  press("Escape");
  expect(document.activeElement).toBe(fixture.origin);
  await expect(result).resolves.toBeNull();
});

it("keeps nested submenus opening away from the edge, beside their triggers after the next frame", async () => {
  await using _viewport = await wideViewport();
  const frames: FrameRequestCallback[] = [];
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  using _fixture = setup();
  void showContextMenuFallback(items, { x: window.innerWidth, y: 0 });
  press("End");
  const copy = document.activeElement!;
  press("ArrowRight");
  press("End");
  const more = document.activeElement!;
  press("ArrowRight");
  for (const frame of frames.splice(0)) frame(0);

  expect(menuAt(1).right).toBeLessThanOrEqual(copy.getBoundingClientRect().left);
  expect(menuAt(2).right).toBeLessThanOrEqual(more.getBoundingClientRect().left);
});

it("opens submenus toward the end of a right-to-left line, with the arrow that points there", async () => {
  await using _viewport = await wideViewport();
  document.dir = "rtl";
  using _direction = { [Symbol.dispose]: () => document.documentElement.removeAttribute("dir") };
  using _fixture = setup();
  void showContextMenuFallback(items, { x: 640, y: 0 });
  press("End");
  const copy = document.activeElement!;
  press("ArrowRight");
  expect(document.activeElement).toBe(copy);
  press("ArrowLeft");
  expect(label()).toBe("Path");
  expect(menuAt(1).right).toBeLessThanOrEqual(copy.getBoundingClientRect().left);
  press("ArrowRight");
  expect(document.activeElement).toBe(copy);
});

it("activates the focused action with Space or Enter", async () => {
  using _fixture = setup();
  const first = showContextMenuFallback(items);
  press(" ");
  await expect(first).resolves.toBe("rename");
  const second = showContextMenuFallback(items);
  press("Enter");
  await expect(second).resolves.toBe("rename");
});

it("closes on Tab and returns focus to the opener so Tab continues from there", async () => {
  using fixture = setup();
  const result = showContextMenuFallback(items);
  expect(press("Tab").defaultPrevented).toBe(false);
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(fixture.origin);
});

it("closes without taking focus back when focus moves elsewhere", async () => {
  using _fixture = setup();
  const result = showContextMenuFallback(items);
  const destination = document.createElement("button");
  document.body.append(destination);
  using _destination = { [Symbol.dispose]: () => destination.remove() };
  destination.focus();
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(destination);
});

it("takes thumb Back and Forward presses so the app router stays put", () => {
  using _fixture = setup();
  void showContextMenuFallback(items);
  for (const button of [3, 4]) {
    const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    // Chromium runs history back/forward on a thumb-button mouseup nobody cancelled.
    expect(event.defaultPrevented).toBe(true);
  }
  expect(isContextMenuOpen()).toBe(true);
});
