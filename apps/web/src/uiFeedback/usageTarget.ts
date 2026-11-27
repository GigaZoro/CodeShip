/**
 * Which counted control a click landed on. Counts carry a key such as `nav:usage` or
 * `composer:composer.mode`, never the text a person typed or read.
 */

const USAGE_ID_ATTRIBUTE = "data-ui-usage";

const AREA_SELECTORS = {
  nav: '[data-ui-usage-area="nav-rail"]',
  details: "[data-thread-details-panel]",
  composer: '[data-slot="composer-shell"]',
} as const;
export type UsageArea = keyof typeof AREA_SELECTORS;
/** In the order the settings page and the export list them. */
export const USAGE_AREAS = Object.keys(AREA_SELECTORS) as ReadonlyArray<UsageArea>;

const INTERACTIVE_SELECTOR = [
  `[${USAGE_ID_ATTRIBUTE}]`,
  "button",
  "a[href]",
  "summary",
  "input",
  "select",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="checkbox"]',
].join(",");

/** Sections an unlabeled control is counted under, so it does not share one "unlabeled" bucket. */
const SECTION_ATTRIBUTES = [
  "data-thread-relationships-panel",
  "data-thread-side-chats-panel",
  "data-thread-details-pr-list",
  "data-thread-automations-panel",
  "data-composer-banner-surface",
] as const;
const SECTION_SELECTOR = SECTION_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(",");

const MAX_ID_LENGTH = 48;

function normalizeId(raw: string): string | null {
  // Digits mark counts, PR numbers and times; folding them keeps "3 queued" and "4 queued" one control.
  const id = raw.trim().replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, MAX_ID_LENGTH);
  return id.length > 0 ? id : null;
}

function sectionName(control: Element, container: Element): string | null {
  const section = control.closest(SECTION_SELECTOR);
  if (section === null || !container.contains(section)) return null;
  const attribute = SECTION_ATTRIBUTES.find((name) => section.hasAttribute(name));
  return attribute ? attribute.slice("data-".length) : null;
}

function controlId(control: Element, container: Element): string | null {
  const explicit = control.getAttribute(USAGE_ID_ATTRIBUTE);
  if (explicit) return normalizeId(explicit);
  const shortcut = control.getAttribute("data-composer-shortcut")?.split(/\s+/)[0];
  if (shortcut) return normalizeId(shortcut);
  // Never a label or the visible text: aria-label and title can hold a thread title, branch or path.
  const role = control.getAttribute("role") ?? control.tagName.toLowerCase();
  const section = sectionName(control, container);
  return section ? `${section} ${role}` : `unlabeled ${role}`;
}

/** The counter key for a click on `target`, or null when it is outside the counted areas. */
export function resolveUsageTarget(target: Element | null): string | null {
  if (target === null) return null;
  for (const area of USAGE_AREAS) {
    const container = target.closest(AREA_SELECTORS[area]);
    if (container === null) continue;
    const control = target.closest(INTERACTIVE_SELECTOR);
    if (control === null || !container.contains(control)) return null;
    if (control.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea')) {
      return null;
    }
    const id = controlId(control, container);
    return id === null ? null : `${area}:${id}`;
  }
  return null;
}
