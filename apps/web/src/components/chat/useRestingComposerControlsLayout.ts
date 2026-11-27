import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { observeResize } from "~/lib/observeResize";
import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { useLayoutEffect, useRef, useState } from "react";

export function useRestingComposerControlsLayout(host: HTMLDivElement | null) {
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const attachControls = (element: HTMLDivElement | null) => {
    controlsRef.current = element;
    setControls(element);
  };
  const [layout, setLayout] = useState({ visible: true });

  const measure = () => {
    if (host === null || !controls) return;

    const measurement = measureRestingComposerControls(controls);
    if (!measurement) return;
    const style = getComputedStyle(host);
    const hostWidth =
      host.clientWidth -
      (Number.parseFloat(style.paddingInlineStart) || 0) -
      (Number.parseFloat(style.paddingInlineEnd) || 0);

    setLayout((current) => {
      const next = resolveRestingComposerControlsLayout({
        ...measurement,
        hostWidth,
        previous: current,
      });
      return next.visible === current.visible ? current : next;
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes control resize, DOM mutations and font loading to measure which controls fit
  useLayoutEffect(() => {
    if (!host || !controls) return;
    let stopObserving = () => {};
    const observeControls = () => {
      stopObserving();
      stopObserving = observeResize(
        [
          host,
          controls,
          ...controls.querySelectorAll<HTMLElement>(
            "[data-composer-control-label], [data-chat-provider-model-picker-label]",
          ),
        ],
        measure,
      );
      measure();
    };
    observeControls();
    const mutations = new MutationObserver(observeControls);
    mutations.observe(controls, { childList: true, subtree: true, characterData: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopObserving();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [host, controls, measure]);

  return {
    controlsRef,
    attachControls,
    controlsVisible: layout.visible,
  };
}
