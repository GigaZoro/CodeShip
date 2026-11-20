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

function createList(bundle: string) {
  const source = readBundle(bundle);
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });
  },
);

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
