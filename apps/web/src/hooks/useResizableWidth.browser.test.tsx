import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "test:responsive-panel-width";

function Panel({ defaultWidth }: { defaultWidth: number }) {
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return (
    <>
      <button onClick={() => setWidth(350)}>{width}</button>
      <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />
    </>
  );
}

function ResettablePanel({
  storageKey = "reset-panel-a",
  defaultWidth = 400,
  maxWidth = 800,
}: {
  storageKey?: string;
  defaultWidth?: number;
  maxWidth?: number;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth,
    minWidth: 200,
    maxWidth,
    edge: "left",
  });
  return (
    <aside
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
        } as CSSProperties
      }
    >
      <output>{width}</output>
      <div role="separator" style={{ width: 8, height: 100 }} {...handlers} />
    </aside>
  );
}

describe("useResizableWidth", () => {
  it("follows a responsive default until the user saves a width", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Panel defaultWidth={320} />, { router: false });
      expect(screen.container.textContent).toBe("320");
      await screen.rerender(<Panel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("200");

      await act(() => screen.container.querySelector("button")!.click());
      await screen.rerender(<Panel defaultWidth={180} />);
      expect(screen.container.textContent).toBe("350");

      await screen.unmount();
      await using restored = await render(<Panel defaultWidth={200} />, { router: false });
      expect(restored.container.textContent).toBe("350");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });

  it("keeps the default responsive after a stationary click and persists an actual drag", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Panel defaultWidth={240} />, { router: false });
      await screen.getByRole("separator").click();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      await screen.rerender(<Panel defaultWidth={256} />);
      expect(screen.container.textContent).toBe("256");

      const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0 };
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
      });
      await screen.rerender(<Panel defaultWidth={280} />);
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 500 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(screen.container.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("280px");

      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 450 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBe("330");
      await screen.rerender(<Panel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("330");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });

  it("resets only the current panel to its current clamped default and leaves remounts adaptive", async () => {
    localStorage.setItem("reset-panel-a", "450");
    localStorage.setItem("reset-panel-b", "300");
    await using screen = await render(<ResettablePanel />);
    await screen.rerender(
      <ResettablePanel storageKey="reset-panel-b" defaultWidth={600} maxWidth={500} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("300");

    await userEvent.dblClick(screen.getByRole("separator"));
    await expect.element(screen.getByRole("status")).toHaveTextContent("500");
    expect(localStorage.getItem("reset-panel-b")).toBeNull();
    expect(localStorage.getItem("reset-panel-a")).toBe("450");

    await screen.rerender(
      <ResettablePanel key="remount" storageKey="reset-panel-b" defaultWidth={700} />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("700");
  });

  it("resets the visible width even when removing the saved width fails", async () => {
    localStorage.setItem("reset-panel-a", "500");
    await using screen = await render(<ResettablePanel />);
    using _error = vi.spyOn(console, "error").mockImplementation(() => {});
    using _remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    await userEvent.dblClick(screen.getByRole("separator"));
    await expect.element(screen.getByRole("status")).toHaveTextContent("400");
    expect(localStorage.getItem("reset-panel-a")).toBe("500");
  });
});
