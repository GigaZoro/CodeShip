import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { activateLanguage } from "@t3tools/shared/i18n";
import * as Cause from "effect/Cause";
import { formatEnvironmentQueryError } from "../../state/query";
import { EnvironmentId, ThreadId, type MonitoringThreadSummary } from "@t3tools/contracts";
import {
  mergeMonitoringChats,
  presentMonitoringChats,
  type MonitoringChatsRequest,
  type MonitoringQueryRead,
} from "@t3tools/client-runtime/monitoring";
import type { MonitoringChatsResult } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import { useMonitoringRefresh } from "../../state/monitoring";
import { MissingEnvironmentNotes, MonitoringChatList, RetryButton } from "./MonitoringChatList";
import { MonitoringOverviewNotices, MonitoringRefreshButton } from "./MonitoringSection";

it("announces overview environment notices politely while leaving analysis counts outside live regions", async () => {
  const screenWith = (pending: number, failed: number, unreadable = "") => (
    <MonitoringOverviewNotices stale={false} pending={pending} failed={failed}>
      <MissingEnvironmentNotes
        missing={{ waiting: unreadable ? "Workstation" : "", unreadable }}
        retry="available"
        onRetry={() => {}}
      />
    </MonitoringOverviewNotices>
  );
  // These notices and the refresh control need no routes.
  await using screen = await render(screenWith(1, 0), { router: false });
  const pending = screen.getByText("1 settled chat is still being analyzed.");
  await expect.element(pending).toBeVisible();
  expect(pending.element().closest("[aria-live], [role=status], [role=alert]")).toBeNull();

  await expect.element(screen.getByRole("status")).toBeEmptyDOMElement();
  await screen.rerender(screenWith(2, 1, "Laptop: offline"));
  for (const message of [
    "2 settled chats are still being analyzed.",
    "1 chat could not be analyzed.",
  ]) {
    const count = screen.getByText(message);
    await expect.element(count).toBeVisible();
    expect(count.element().closest("[aria-live], [role=status], [role=alert]")).toBeNull();
  }
  for (const text of [
    "Could not refresh these environments: Laptop: offline",
    "Waiting for these environments: Workstation",
  ]) {
    const notice = screen.getByText(text);
    await expect.element(notice).toBeVisible();
    expect(notice.element().closest("[role=status]")).toBe(screen.getByRole("status").element());
  }
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("keeps keyboard focus on Refresh and ignores presses while it is busy", async () => {
  let presses = 0;
  const screenWith = (refreshing: boolean) => (
    <MonitoringRefreshButton
      refreshing={refreshing}
      onRefresh={() => {
        presses++;
      }}
    />
  );
  // The header control needs no routing.
  await using screen = await render(screenWith(false), { router: false });
  const button = screen.getByRole("button", { name: "Refresh monitoring" });
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  expect(presses).toBe(1);
  await screen.rerender(screenWith(true));
  await expect.element(button).toHaveFocus();
  await expect.element(button).toHaveAttribute("aria-busy", "true");
  await expect.element(button).toHaveAttribute("aria-disabled", "true");
  await expect.element(screen.getByRole("status")).toHaveTextContent("Refreshing…");
  await userEvent.keyboard("{Enter}");
  expect(presses).toBe(1);
  await screen.rerender(screenWith(false));
  await expect.element(button).toHaveFocus();
});

it("releases Retry after a Refresh timeout and clears the message after a successful Retry", async () => {
  const completions: Array<(timedOut: boolean) => void> = [];
  const refresh = () =>
    new Promise<boolean>((resolve) => {
      completions.push(resolve);
    });
  function View() {
    const { refreshing, timedOut, run } = useMonitoringRefresh();
    const onRefresh = () => run(refresh);
    return (
      <>
        <MonitoringRefreshButton
          refreshing={refreshing}
          timedOut={timedOut}
          onRefresh={onRefresh}
        />
        <RetryButton retry={refreshing ? "busy" : "available"} onRetry={onRefresh} />
      </>
    );
  }
  // The controls share state without a route.
  await using screen = await render(<View />, { router: false });
  await screen.getByRole("button", { name: "Refresh monitoring" }).click();
  const retry = screen.getByRole("button", { name: "Retry", exact: true });
  await expect.element(retry).toHaveAttribute("aria-busy", "true");
  await act(() => completions[0]!(true));
  await expect.element(retry).toHaveAttribute("aria-busy", "false");
  await expect.element(screen.getByText("The request timed out.")).toBeVisible();
  await retry.click();
  await expect.element(retry).toHaveAttribute("aria-busy", "true");
  await act(() => completions[1]!(false));
  await expect.element(retry).toHaveAttribute("aria-busy", "false");
  await expect.element(screen.getByText("The request timed out.")).not.toBeInTheDocument();
});

it("keeps the stale label and keyboard focus on Retry until the failed chat read settles", async () => {
  const request: MonitoringChatsRequest = {
    window: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" },
    filters: {},
    order: { sort: "settledAt", direction: "desc", limit: 50 },
    pageSize: 50,
  };
  const summary = {
    threadId: ThreadId.make("chat-1"),
    title: "Cached chat",
    kind: "interactive",
    models: [],
    settledAt: "2026-11-10T00:00:00.000Z",
    lifetimeMs: 1_000,
    activeMs: 200,
    costUsd: 0,
    findings: [],
  } as unknown as MonitoringThreadSummary;
  const answer = { chats: [{ summary, sortValue: 1 }], total: 1 };
  const view = (
    read: MonitoringQueryRead<MonitoringChatsResult>,
    previous?: ReturnType<typeof mergeMonitoringChats>,
    unready: { readonly error: string | null; readonly reconnects: boolean } | null = null,
  ) =>
    mergeMonitoringChats(
      [
        {
          environment: {
            environmentId: EnvironmentId.make("env-a"),
            label: "Laptop",
            unready,
          },
          readPage: () => read,
        },
      ],
      request,
      previous,
    );
  const ready = view({ isPending: false, error: null, result: answer });
  const failed = view({ isPending: false, error: "offline", result: null }, ready);
  const retrying = view({ isPending: true, error: null, result: null }, failed);
  const offline = view({ isPending: false, error: null, result: null }, ready, {
    error: "offline",
    reconnects: true,
  });
  const reconnecting = view({ isPending: false, error: null, result: null }, offline, {
    error: null,
    reconnects: false,
  });
  const replacing = view({ isPending: true, error: null, result: null }, reconnecting);
  const recovered = view({ isPending: false, error: null, result: answer }, replacing);
  let presses = 0;
  const screenWith = (next: typeof ready) => (
    <MonitoringChatList
      {...presentMonitoringChats({ request, view: ready }, { request, view: next })}
      order={request.order}
      onOrderChange={() => {}}
      onRetry={() => {
        presses++;
      }}
      projectTitleOf={() => "Project"}
    />
  );

  await using screen = await render(screenWith(ready));
  await screen.rerender(screenWith(failed));
  const retry = screen.getByRole("button", { name: "Retry", exact: true });
  await expect.element(screen.getByText("Showing previous monitoring results.")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Cached chat" })).toBeVisible();
  await userEvent.tab();
  await expect.element(retry).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(presses).toBe(1);

  await screen.rerender(screenWith(retrying));
  await expect.element(retry).toHaveFocus();
  await expect.element(retry).toHaveAttribute("aria-busy", "true");
  await expect.element(screen.getByText("Showing previous monitoring results.")).toBeVisible();

  for (const next of [offline, reconnecting, replacing]) {
    await screen.rerender(screenWith(next));
    await expect.element(retry).toHaveFocus();
    const notice = screen.getByText("Could not refresh these environments: Laptop: offline");
    await expect.element(notice).toBeVisible();
    expect(notice.element().closest("[role=status]")).toBe(screen.getByRole("status").element());
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Showing previous monitoring results.")).toBeVisible();
  }
  await screen.rerender(screenWith(recovered));
  await expect.element(retry).not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Showing previous monitoring results."))
    .not.toBeInTheDocument();
});

it("translates the typed request timeout instead of showing its English message", () => {
  activateLanguage({
    language: "uk",
    formattingLocale: "uk",
    catalog: {
      "The request timed out.": "Час очікування відповіді минув.",
    },
  });
  try {
    const error = new EnvironmentRpcUnavailableError({
      environmentId: "env-a",
      reason: "timeout",
      message: "The request timed out.",
    });
    expect(formatEnvironmentQueryError(Cause.fail(error))).toBe("Час очікування відповіді минув.");
  } finally {
    activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
  }
});
