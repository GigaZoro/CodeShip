import { InfoIcon } from "lucide-react";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { ThreadNoticeSlot, ThreadNoticeStatus, useThreadNoticeSlot } from "./ThreadNoticeSlot";
import type { ThreadNotice } from "./threadNoticeSlot.logic";

function notice(
  producer: ThreadNotice["producer"],
  variant: ThreadNotice["variant"],
  title: string,
  extra: Partial<ThreadNotice> = {},
): ThreadNotice {
  return { id: title, producer, variant, icon: <InfoIcon />, title, ...extra };
}

function Thread({ notices }: { readonly notices: ReadonlyArray<ThreadNotice> }) {
  const slot = useThreadNoticeSlot(notices);
  return (
    <div style={{ width: "40rem" }}>
      <ComposerBanner.Column>
        <ThreadNoticeSlot
          slot={slot}
          detached
          onFocusLost={() => document.getElementById("composer")?.focus()}
        />
      </ComposerBanner.Column>
      <ThreadNoticeStatus slot={slot} />
      <textarea id="composer" data-testid="composer" aria-label="Composer" />
    </div>
  );
}

const sixNotices = (onRestore: () => void) => [
  notice("usageLimits", "info", "Usage limits"),
  notice("feedback", "error", "Feedback was not sent"),
  notice("usageLimitRecovery", "warning", "Usage limit reached"),
  notice("branchMismatch", "info", "Branch changed from main", {
    actions: (
      <Button size="xs" variant="ghost" onClick={onRestore}>
        Restore branch
      </Button>
    ),
  }),
  notice("environmentUnavailable", "error", "VPS is offline"),
  notice("queuedMessages", "info", "1 message waits for VPS to reconnect"),
];

it("shows six notices as one line with a counter that names the most urgent hidden one", async () => {
  const onRestore = vi.fn();
  await using screen = await render(<Thread notices={sixNotices(onRestore)} />);

  const banners = screen.container.querySelectorAll("[data-slot=composer-banner]");
  expect([...banners].map((banner) => banner.textContent)).toEqual(["VPS is offline+5·Needs you"]);
  const more = screen.getByRole("button", {
    name: "+5 more notices, most urgent: Needs you",
  });
  await expect.element(more).toHaveTextContent("+5·Needs you");
  await expect.element(screen.getByRole("status")).toHaveTextContent("VPS is offline");

  await userEvent.click(more);
  const list = page.getByRole("dialog", { name: "Other notices" });
  await expect.element(list).toBeVisible();
  expect(
    [...list.element().querySelectorAll("[data-slot=composer-banner]")].map(
      (banner) => banner.textContent,
    ),
  ).toEqual([
    "Branch changed from mainRestore branch",
    "Feedback was not sent",
    "Usage limit reached",
    // Both are information; the queued message arrived later.
    "1 message waits for VPS to reconnect",
    "Usage limits",
  ]);
  await userEvent.click(list.getByRole("button", { name: "Restore branch" }));
  expect(onRestore).toHaveBeenCalledOnce();
});

it("keeps the composer in place and the announcement unchanged as notices come and go behind the top one", async () => {
  await using screen = await render(<Thread notices={sixNotices(() => {})} />);
  const composerTop = () => screen.getByTestId("composer").element().getBoundingClientRect().top;
  const before = composerTop();

  await screen.rerender(<Thread notices={sixNotices(() => {}).slice(3)} />);

  await expect.element(screen.getByRole("button", { name: /\+2 more notices/ })).toBeVisible();
  expect(composerTop()).toBe(before);
  await expect.element(screen.getByRole("status")).toHaveTextContent("VPS is offline");
});

it("gives the slot to the newest of two equally urgent notices", async () => {
  await using screen = await render(
    <Thread notices={[notice("feedback", "error", "Feedback was not sent")]} />,
  );

  await screen.rerender(
    <Thread
      notices={[
        notice("feedback", "error", "Feedback was not sent"),
        notice("projectClone", "error", "Could not clone repo"),
      ]}
    />,
  );

  await expect.element(screen.getByRole("status")).toHaveTextContent("Could not clone repo");
  await expect
    .element(screen.getByRole("button", { name: "+1 more notice, most urgent: Failed" }))
    .toBeVisible();
});

it("drops colour from a notice that neither blocks, needs you nor failed", async () => {
  await using screen = await render(
    <Thread notices={[notice("usageLimitRecovery", "warning", "Usage limit reached")]} />,
  );

  expect(
    screen.container.querySelector("[data-composer-banner-surface]")?.getAttribute("data-variant"),
  ).toBe("default");
});

it("keeps the list of the rest open when a more urgent notice takes the slot", async () => {
  const feedback = notice("feedback", "error", "Feedback was not sent");
  const usage = notice("usageLimits", "info", "Usage limits");
  await using screen = await render(<Thread notices={[feedback, usage]} />);
  await userEvent.click(screen.getByRole("button", { name: /\+1 more notice/ }));
  const list = page.getByRole("dialog", { name: "Other notices" });
  await expect.element(list).toBeVisible();

  await screen.rerender(
    <Thread
      notices={[feedback, usage, notice("environmentUnavailable", "error", "VPS is offline")]}
    />,
  );

  await expect.element(screen.getByRole("status")).toHaveTextContent("VPS is offline");
  await expect.element(list).toBeVisible();
  await expect.element(list).toHaveTextContent("Feedback was not sentUsage limits");
});

it("moves focus back to the slot when the last hidden notice is dismissed from the list", async () => {
  function Dismissable() {
    const [hidden, setHidden] = useState(false);
    return (
      <Thread
        notices={[
          notice("feedback", "error", "Feedback was not sent", {
            dismissLabel: "Dismiss feedback",
            onDismiss: () => {},
          }),
          ...(hidden
            ? []
            : [
                notice("usageLimits", "info", "Usage limits", {
                  dismissLabel: "Dismiss usage limits",
                  onDismiss: () => setHidden(true),
                }),
              ]),
        ]}
      />
    );
  }
  await using screen = await render(<Dismissable />);
  await userEvent.click(screen.getByRole("button", { name: /\+1 more notice/ }));

  await userEvent.click(page.getByRole("button", { name: "Dismiss usage limits" }));

  await expect.element(screen.getByRole("button", { name: "Dismiss feedback" })).toHaveFocus();
});

it("moves focus to the composer when the list empties and the slot has no control", async () => {
  function Dismissable() {
    const [hidden, setHidden] = useState(false);
    return (
      <Thread
        notices={[
          notice("feedback", "error", "Feedback was not sent"),
          ...(hidden
            ? []
            : [
                notice("usageLimits", "info", "Usage limits", {
                  dismissLabel: "Dismiss usage limits",
                  onDismiss: () => setHidden(true),
                }),
              ]),
        ]}
      />
    );
  }
  await using screen = await render(<Dismissable />);
  await userEvent.click(screen.getByRole("button", { name: /\+1 more notice/ }));

  await userEvent.click(page.getByRole("button", { name: "Dismiss usage limits" }));

  await expect.element(screen.getByRole("textbox", { name: "Composer" })).toHaveFocus();
});

it("keeps focus in the list when one of several hidden notices is dismissed", async () => {
  function Dismissable() {
    const [hidden, setHidden] = useState(false);
    return (
      <Thread
        notices={[
          notice("feedback", "error", "Feedback was not sent"),
          notice("queuedMessages", "info", "1 message waits"),
          ...(hidden
            ? []
            : [
                notice("usageLimits", "info", "Usage limits", {
                  dismissLabel: "Dismiss usage limits",
                  onDismiss: () => setHidden(true),
                }),
              ]),
        ]}
      />
    );
  }
  await using screen = await render(<Dismissable />);
  await userEvent.click(screen.getByRole("button", { name: /\+2 more notices/ }));

  await userEvent.click(page.getByRole("button", { name: "Dismiss usage limits" }));

  await expect.element(page.getByRole("dialog", { name: "Other notices" })).toHaveFocus();
});
