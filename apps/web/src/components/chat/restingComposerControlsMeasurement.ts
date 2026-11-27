import type { RestingComposerControlsMeasurement } from "../composerFooterLayout";

function elementOuterWidth(element: HTMLElement): number {
  const width = element.getBoundingClientRect().width;
  if (width === 0) return 0;
  return width + elementInlineMarginWidth(element);
}

function elementInlineMarginWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

export function measureRestingComposerControls(
  controls: HTMLElement,
): RestingComposerControlsMeasurement | null {
  const gap = Number.parseFloat(getComputedStyle(controls).columnGap) || 0;
  const picker = controls.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  if (!picker) return null;
  const providerUnavailable = controls.querySelector<HTMLElement>(
    '[data-chat-provider-unavailable="true"]',
  );
  // Labels truncate to nothing; the icon, effort and run chip marks never shrink.
  const shrinkableWidth = Array.from(
    picker.querySelectorAll<HTMLElement>(
      "[data-chat-provider-model-picker-label], [data-run-chip-label]",
    ),
    (label) => label.clientWidth,
  ).reduce((sum, width) => sum + width, 0);
  const pickerMinimumWidth =
    Math.max(
      Number.parseFloat(getComputedStyle(picker).minWidth) || 0,
      picker.scrollWidth - shrinkableWidth,
    ) + elementInlineMarginWidth(picker);
  return {
    minimumWidth:
      pickerMinimumWidth + (providerUnavailable ? elementOuterWidth(providerUnavailable) + gap : 0),
  };
}
