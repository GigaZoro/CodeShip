import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageRetryButton } from "./UsageRetryButton";

function Notice({
  shown = true,
  pending = false,
  heading = true,
  onRetry = () => {},
}: {
  readonly shown?: boolean;
  readonly pending?: boolean;
  readonly heading?: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div data-workspace-area="usage" tabIndex={-1}>
      <section>
        {heading ? <h2 tabIndex={-1}>Scheduled task groups</h2> : null}
        {shown ? <UsageRetryButton pending={pending} onRetry={onRetry} /> : null}
      </section>
    </div>
  );
}

it("keeps focus and ignores presses while its retry is pending", async () => {
  const onRetry = vi.fn();
  await using screen = await render(<Notice pending onRetry={onRetry} />);
  const retry = screen.getByRole("button", { name: "Retry" });
  await expect.element(retry).toHaveAttribute("aria-disabled", "true");
  const button = retry.element() as HTMLButtonElement;
  button.focus();
  button.click();
  expect(onRetry).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);

  await screen.rerender(<Notice onRetry={onRetry} />);
  await retry.click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it.each([
  ["its section heading", true, "H2"],
  ["the Usage region without a heading", false, "DIV"],
] as const)("moves focus to %s when it is removed", async (_label, heading, tag) => {
  await using screen = await render(<Notice heading={heading} />);
  (screen.getByRole("button", { name: "Retry" }).element() as HTMLButtonElement).focus();
  await screen.rerender(<Notice heading={heading} shown={false} />);
  expect(document.activeElement?.tagName).toBe(tag);
});

it("leaves focus alone when another control has it", async () => {
  await using screen = await render(
    <>
      <Notice />
      <input aria-label="Search" />
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Search" }).element() as HTMLInputElement;
  search.focus();
  await screen.rerender(
    <>
      <Notice shown={false} />
      <input aria-label="Search" />
    </>,
  );
  expect(document.activeElement).toBe(search);
});
