import { usageClock } from "@t3tools/client-runtime/clock";
import { fakeTimers } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { subscribeDocumentReturn } from "./documentActivity";

describe("subscribeDocumentReturn", () => {
  // Focus can come back from the preview iframe, and a quick alt-tab can miss
  // the blur, so a return must not depend on the cached activity flipping.
  it("fires on every window focus and every return to a visible tab", () => {
    using _focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const wake = vi.fn();
    using subscription = new DisposableStack();
    subscription.defer(subscribeDocumentReturn(wake));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(wake).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(3);

    subscription.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(wake).toHaveBeenCalledTimes(3);
  });
});

it("wakes a remaining reset subscriber after another subscriber disconnects", () => {
  using _timers = fakeTimers();
  const noon = Date.parse("2026-11-21T12:00:00Z");
  vi.setSystemTime(noon);
  const clock = usageClock([noon + 60_000], false);
  const changed = vi.fn();
  using active = new DisposableStack();
  active.defer(clock.subscribe(changed));
  active.defer(subscribeDocumentReturn(clock.refresh));
  const removeOther = subscribeDocumentReturn(clock.refresh);
  removeOther();
  vi.setSystemTime(noon + 120_000);
  window.dispatchEvent(new Event("focus"));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(clock.getSnapshot()).toBe(noon + 120_000);
});
