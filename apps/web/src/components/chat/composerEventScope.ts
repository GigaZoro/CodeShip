import { useComposerHandleContext } from "../../composerHandleContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps() {
  const composerRef = useComposerHandleContext();
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });

  return {
    ...composerFloatingLayerProps,
    // Focusing the editor on a touch device opens the on-screen keyboard, so the menu keeps its own focus return.
    finalFocus:
      composerRef && !isCoarsePointer
        ? () => {
            const activeElement = document.activeElement;
            if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
              return false;
            }
            composerRef.current?.focusAtEnd();
            return false;
          }
        : undefined,
  };
}

function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}

/**
 * composer.mode marks the run chip it opens; the popover's onOpenChangeComplete then moves focus
 * to the checked permission in its own popup, after the popover placed its own focus.
 */
export function markOpenToPermissions(trigger: HTMLElement): void {
  delete trigger.dataset.openToEffort;
  trigger.dataset.openToPermissions = "true";
}

/** Reads and clears the mark; true when composer.mode had asked for the permissions. */
export function focusRequestedPermission(open: boolean, trigger: HTMLElement | null): boolean {
  if (!trigger?.dataset.openToPermissions) return false;
  delete trigger.dataset.openToPermissions;
  if (open) focusCheckedPermission(trigger);
  return true;
}

/** Focuses the checked permission in the popup this trigger opened. */
function focusCheckedPermission(trigger: HTMLElement | null): void {
  const popupId = trigger?.getAttribute("aria-controls");
  const popup = popupId ? document.getElementById(popupId) : null;
  popup
    ?.querySelector<HTMLElement>("[data-composer-permissions] [aria-checked='true']")
    ?.focus({ preventScroll: true });
}

/**
 * composer.effort marks the model picker trigger it opens; the picker then moves focus to the
 * selected effort level once its popup is open.
 */
export function markOpenToEffort(trigger: HTMLElement): void {
  delete trigger.dataset.openToPermissions;
  trigger.dataset.openToEffort = "true";
}

/** Reads and clears the mark composer.effort left on the model picker trigger. */
export function takeOpenToEffort(trigger: HTMLElement | null): boolean {
  if (!trigger?.dataset.openToEffort) return false;
  delete trigger.dataset.openToEffort;
  return true;
}
