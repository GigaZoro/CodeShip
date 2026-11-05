import { observeResize } from "./observeResize";

const CONTROLS_GAP_PX = 8;

/**
 * Pads `element` so its content ends before any title bar controls drawn over it. The controls
 * are fixed or absolutely positioned, so layout alone never makes room for them.
 */
export function reserveTitlebarControlsSpace(element: HTMLElement): () => void {
  let controls: Element[] = [];
  let stopObserving = () => {};
  const update = () => {
    const current = [...document.querySelectorAll("[data-workspace-titlebar-controls]")];
    if (current.length !== controls.length || current.some((item, i) => item !== controls[i])) {
      controls = current;
      stopObserving();
      stopObserving = observeResize([element, ...controls], update);
    }
    const box = element.getBoundingClientRect();
    let reserve = 0;
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const overlaps =
        rect.width > 0 &&
        rect.left < box.right &&
        rect.right > box.left &&
        rect.top < box.bottom &&
        rect.bottom > box.top;
      if (overlaps) reserve = Math.max(reserve, box.right - rect.left + CONTROLS_GAP_PX);
    }
    element.style.paddingRight = `${Math.ceil(reserve)}px`;
  };
  update();
  return () => stopObserving();
}
