/** What was on screen when the capture key was pressed, read from the DOM alone. */
export interface UiCaptureContext {
  readonly route: string;
  /** Nearest elements under the pointer that carry data-* ids, innermost first. */
  readonly componentIds: ReadonlyArray<string>;
  readonly notices: ReadonlyArray<string>;
  readonly panels: ReadonlyArray<string>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly theme: string;
  readonly density: string;
}

const MAX_COMPONENT_IDS = 8;
const MAX_ATTRIBUTES_PER_ELEMENT = 3;
const MAX_VALUE_LENGTH = 60;
const MAX_NOTICES = 12;
// Styling hooks say nothing about which component it is.
const IGNORED_DATA_ATTRIBUTES = new Set([
  "data-state",
  "data-side",
  "data-align",
  "data-open",
  "data-closed",
  "data-pressed",
  "data-highlighted",
  "data-disabled",
  "data-checked",
  "data-unchecked",
  "data-focused",
  "data-hovered",
  "data-starting-style",
  "data-ending-style",
  "data-ui-usage-area",
  "data-workspace-order",
]);

function clip(value: string): string {
  const flat = value.trim().replace(/\s+/g, " ");
  return flat.length > MAX_VALUE_LENGTH ? `${flat.slice(0, MAX_VALUE_LENGTH - 1)}…` : flat;
}

// Only these hold ids the app chose; other data-* values can be content (a file name, a prompt, a
// code span), so those are recorded by name alone.
const ID_ATTRIBUTES = new Set([
  "data-slot",
  "data-workspace-area",
  "data-composer-shortcut",
  "data-ui-usage",
  "data-thread-details-panel",
  "data-timeline-row-kind",
]);
const ID_VALUE = /^[\w.:#-]{1,32}$/;

function describeElement(element: Element): string | null {
  const parts: string[] = [];
  for (const attribute of Array.from(element.attributes)) {
    if (!attribute.name.startsWith("data-") || IGNORED_DATA_ATTRIBUTES.has(attribute.name)) {
      continue;
    }
    parts.push(
      ID_ATTRIBUTES.has(attribute.name) && ID_VALUE.test(attribute.value)
        ? `${attribute.name}=${attribute.value}`
        : attribute.name,
    );
    if (parts.length >= MAX_ATTRIBUTES_PER_ELEMENT) break;
  }
  return parts.length > 0 ? `${element.tagName.toLowerCase()}[${parts.join(" ")}]` : null;
}

function collectComponentIds(start: Element | null): string[] {
  const ids: string[] = [];
  for (let element = start; element !== null && ids.length < MAX_COMPONENT_IDS;) {
    const description = describeElement(element);
    if (description !== null) ids.push(description);
    element = element.parentElement;
  }
  return ids;
}

function isShown(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  return !element.hidden && element.getClientRects().length > 0;
}

function texts(root: ParentNode, selector: string, prefix: string): string[] {
  const found: string[] = [];
  for (const element of Array.from(root.querySelectorAll(selector))) {
    if (!isShown(element)) continue;
    const text = element.textContent ? clip(element.textContent) : "";
    found.push(text.length > 0 ? `${prefix}: ${text}` : prefix);
  }
  return found;
}

function collectNotices(root: ParentNode): string[] {
  const notices = [
    ...texts(root, '[data-slot="toast-title"]', "toast"),
    ...texts(root, '[data-slot="alert-title"]', "alert"),
    ...texts(root, '[data-slot="dialog-title"]', "dialog"),
    ...Array.from(root.querySelectorAll("[data-composer-banner-surface]"))
      .filter(isShown)
      .map(() => "composer banner"),
  ];
  return [...new Set(notices)].slice(0, MAX_NOTICES);
}

function collectPanels(root: ParentNode): string[] {
  const panels = Array.from(root.querySelectorAll("[data-workspace-area]"))
    .filter(isShown)
    .map((element) => element.getAttribute("data-workspace-area") ?? "");
  return [...new Set(panels.filter((panel) => panel.length > 0))];
}

export function collectCaptureContext(input: {
  readonly document: Document;
  readonly route: string;
  readonly pointer: { readonly x: number; readonly y: number } | null;
}): UiCaptureContext {
  const { document, pointer } = input;
  const view = document.defaultView;
  const root = document.documentElement;
  const underPointer =
    pointer === null ? document.activeElement : document.elementFromPoint(pointer.x, pointer.y);
  const appearance = root.classList.contains("dark") ? "dark" : "light";
  const themeId = root.dataset.themeId;
  return {
    route: input.route,
    componentIds: collectComponentIds(underPointer),
    notices: collectNotices(document),
    panels: collectPanels(document),
    viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    theme: themeId ? `${appearance} (${themeId})` : appearance,
    density: root.dataset.interfaceDensity ?? "comfortable",
  };
}
