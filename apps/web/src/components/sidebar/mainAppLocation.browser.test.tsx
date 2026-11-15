import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { startMainAppLocationTracking, useNavigateToMainApp } from "./mainAppLocation";

const THREAD_PATH = "/environment-one/thread-one";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "quoted reply",
  start: 0,
  end: 12,
  prefix: "",
  suffix: "",
};

function ReturnControls() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <button type="button" onClick={() => void navigateToMainApp()}>
      Back to app
    </button>
  );
}

// The tracker records on onResolved, which the router emits only once React commits the page.
async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

describe("main app return location", () => {
  it.each(["/settings/general", "/usage", "/pull-requests"])(
    "returns from %s to the thread without re-opening the quote source it was opened at",
    async (section) => {
      await using screen = await render(<ReturnControls />, { router: THREAD_PATH });
      const router = screen.router!;
      using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };

      await settled(router, router.navigate(assistantCitationNavigation(citation, null)));
      expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
      await settled(router, router.navigate({ href: section }));
      await userEvent.click(screen.getByRole("button", { name: "Back to app" }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));

      expect(router.state.location.href).toBe(THREAD_PATH);
    },
  );
});
