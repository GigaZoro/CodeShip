// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function readBundle(bundle: string) {
  return NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
}

function bundleModule(source: string, path: string) {
  const start = source.indexOf(`// ${path}\n`);
  if (start < 0) throw new Error(`${path} is not in the bundle`);
  return source.slice(start, source.indexOf("\n// src/", start + 1));
}

function createBootstrapSession(bundle: string) {
  const source = readBundle(bundle);
  const frames: Array<() => void> = [];
  const dispatchInitialScroll = vi.fn();
  let endOffset = 0;
  const api = NodeVM.runInNewContext(
    `${bundleModule(source, "src/core/initialScrollSession.ts")}
${bundleModule(source, "src/core/bootstrapInitialScroll.ts")}
({ rearm: rearmBootstrapInitialScroll, evaluate: evaluateBootstrapInitialScroll })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      cancelAnimationFrame: vi.fn(),
      resolveInitialScrollOffset: () => endOffset,
      dispatchInitialScroll,
      Platform: { OS: "web" },
      IS_DEV: false,
    },
  ) as {
    rearm: (context: { state: unknown }, options: { scroll: number }) => void;
    evaluate: (context: { state: unknown }) => void;
  };
  const state = {
    initialScroll: { index: 14, viewOffset: -12, viewPosition: 1 },
    initialScrollSession: { kind: "bootstrap" },
    // The previous initial scroll is still in flight, which holds back every evaluation.
    scrollingTo: { isInitialScroll: true },
    refScroller: { current: {} },
    triggerCalculateItemsInView: () => api.evaluate(ctx),
  };
  const ctx = { state };
  return {
    dispatchInitialScroll,
    rearm: () => api.rearm(ctx, { scroll: endOffset }),
    layOut: (offset: number) => {
      endOffset = offset;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

describe.each([
  "react.js",
  "react.mjs",
  "react-native.js",
  "react-native.mjs",
  "react-native.web.js",
  "react-native.web.mjs",
])("bootstrap initial scroll watchdog (%s)", (bundle) => {
  it("scrolls to the end of the current layout, not the one saved before new rows were laid out", () => {
    const session = createBootstrapSession(bundle);
    session.rearm();
    session.layOut(2074);
    session.advance(8);
    expect(session.dispatchInitialScroll).toHaveBeenCalledTimes(1);
    expect(session.dispatchInitialScroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolvedOffset: 2074 }),
    );
  });
});
