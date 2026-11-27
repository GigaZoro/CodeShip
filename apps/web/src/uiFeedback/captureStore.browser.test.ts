import { assert, describe, it } from "vite-plus/test";

import {
  addUiCapture,
  deleteUiCapture,
  getUiCaptureScreenshot,
  loadUiCaptures,
  type UiCapture,
} from "./captureStore";

describe("UI capture store", () => {
  it("keeps the screenshot out of the capture list and deletes it with its capture", async () => {
    const capture: UiCapture = {
      id: "capture-1",
      createdAt: "2026-11-27T10:00:00.000Z",
      note: "sidebar jumps",
      route: "/threads/1",
      componentIds: [],
      notices: [],
      panels: [],
      viewport: { width: 1440, height: 900 },
      theme: "dark",
      density: "compact",
      hasScreenshot: true,
    };

    await addUiCapture(capture, "data:image/jpeg;base64,AAAA");

    assert.deepStrictEqual(await loadUiCaptures(), [capture]);
    assert.strictEqual(await getUiCaptureScreenshot("capture-1"), "data:image/jpeg;base64,AAAA");
    await deleteUiCapture("capture-1");
    assert.deepStrictEqual(await loadUiCaptures(), []);
    assert.strictEqual(await getUiCaptureScreenshot("capture-1"), null);
  });

  it("sees captures another tab saved after this one first loaded", async () => {
    assert.deepStrictEqual(await loadUiCaptures(), []);
    const other: UiCapture = {
      id: "from-other-tab",
      createdAt: "2026-11-27T11:00:00.000Z",
      note: "",
      route: "/",
      componentIds: [],
      notices: [],
      panels: [],
      viewport: { width: 800, height: 600 },
      theme: "light",
      density: "comfortable",
      hasScreenshot: false,
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("t3code:ui-feedback");
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => {
        const transaction = request.result.transaction("captures", "readwrite");
        transaction.objectStore("captures").put(other);
        transaction.addEventListener("complete", () => {
          request.result.close();
          resolve();
        });
        transaction.addEventListener("error", () => reject(transaction.error));
      });
    });

    assert.deepStrictEqual(await loadUiCaptures(), [other]);
    await deleteUiCapture("from-other-tab");
  });
});
