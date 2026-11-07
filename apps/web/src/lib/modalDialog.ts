// Base UI sets neither aria-modal: Dialog renders role="dialog", AlertDialog role="alertdialog".
export const MODAL_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** A dialog's own keys belong to it; window shortcuts that act on the page behind must not fire. */
export function isInsideModalDialog(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(MODAL_DIALOG_SELECTOR)) return true;
  return document.activeElement?.closest(MODAL_DIALOG_SELECTOR) != null;
}
