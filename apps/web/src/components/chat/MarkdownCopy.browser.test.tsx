import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownTable } from "./MarkdownTable";

const codeBlock = (code: string) => (
  <MarkdownCodeBlock code={code} language="sh" fenceTitle={null} theme="light" isStreaming={false}>
    <pre>
      <code>{code}</code>
    </pre>
  </MarkdownCodeBlock>
);

const table = (
  <MarkdownTable>
    <thead>
      <tr>
        <th>Name</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Ada</td>
      </tr>
    </tbody>
  </MarkdownTable>
);

// Insecure origins (a LAN or tailnet address over plain http) have no async clipboard.
function withoutAsyncClipboard() {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const execCommand = vi.spyOn(document, "execCommand").mockReturnValue(true);
  return {
    execCommand,
    [Symbol.dispose]() {
      execCommand.mockRestore();
      Reflect.deleteProperty(navigator, "clipboard");
      if (original) Object.defineProperty(Navigator.prototype, "clipboard", original);
    },
  };
}

describe("markdown copy without the async clipboard", () => {
  it("copies a code block through the execCommand fallback", async () => {
    // The block renders no links and reads no route.
    await using screen = await render(codeBlock("echo hi"), { router: false });
    using clipboard = withoutAsyncClipboard();

    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(clipboard.execCommand).toHaveBeenCalledWith("copy");
  });

  it("copies a table through the execCommand fallback", async () => {
    // The table renders no links and reads no route.
    await using screen = await render(table, { router: false });
    using clipboard = withoutAsyncClipboard();

    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Copy as Markdown" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(clipboard.execCommand).toHaveBeenCalledWith("copy");
  });
});

describe("markdown copy", () => {
  it("copies a fenced command without the newline that would run it on paste", async () => {
    await using screen = await render(codeBlock("echo hi\n\n"), { router: false });
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("echo hi\n");
  });

  it("reports a failed copy", async () => {
    await using screen = await render(
      <>
        {codeBlock("echo hi\n")}
        {table}
      </>,
      { router: false },
    );
    using _writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Denied"));
    using _error = vi.spyOn(console, "error").mockImplementation(() => {});
    using toast = vi.spyOn(toastManager, "add");

    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Copy as CSV" }));
    await vi.waitFor(() =>
      expect(toast.mock.calls.map(([options]) => [options.type, options.title])).toEqual([
        ["error", "Could not copy code"],
        ["error", "Could not copy table"],
      ]),
    );
  });
});
