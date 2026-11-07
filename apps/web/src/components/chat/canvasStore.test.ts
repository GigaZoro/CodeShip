import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  resolveChatCanvasModel,
  type ChatCanvasMeasurements,
} from "./canvasStore";
import type { ChatCanvasPreview } from "./chatCanvasLayout";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const measurements = (width: number, height = 900, needsYouHeight = 0): ChatCanvasMeasurements => ({
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
  needsYouHeight,
});
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};

describe("chat canvas model", () => {
  it("shows the details card inline only where the canvas fits it beside the chat", () => {
    const resolve = (width: number) =>
      resolveChatCanvasModel({
        measurements: measurements(width),
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      }).detailsCardMode;
    expect(resolve(1400)).toBe("inline");
    expect(resolve(900)).toBe("popover");
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number) =>
      resolveChatCanvasModel({
        measurements: measurements(1100, 300),
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
  });

  it("keeps the chat and the details card clear of Needs you at the foot of the column", () => {
    const resolve = (needsYouHeight: number) => {
      const model = resolveChatCanvasModel({
        measurements: measurements(1400, 900, needsYouHeight),
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
      return {
        chatRight: model.layout.chat.left + model.layout.chat.width,
        detailsHeight: model.detailsCardPlacement?.height,
      };
    };
    expect(resolve(0)).toEqual({ chatRight: 1084, detailsHeight: 876 });
    expect(resolve(200)).toEqual({ chatRight: 1076, detailsHeight: 664 });
  });

  it("ignores a details card measured for another thread", () => {
    const model = resolveChatCanvasModel({
      measurements: measurements(1100, 300),
      detailsCardMeasurement: { threadRef: otherThreadRef, width: 280, fullContentHeight: 400 },
      threadRef,
      preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.layout.overlapsDetailsCard).toBe(false);
    expect(model.detailsCardMode).toBe("inline");
  });

  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
  });
});
