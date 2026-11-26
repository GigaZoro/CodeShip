import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { activateLanguage } from "@t3tools/shared/i18n";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type MonitoringThreadSummary,
} from "@t3tools/contracts";
import {
  fixChatRequest,
  mergeMonitoringChats,
  presentMonitoringChats,
  settleFixChat,
  type MonitoringChatsRequest,
  type MonitoringFixChatTarget,
  type MonitoringQueryRead,
} from "@t3tools/client-runtime/monitoring";
import type { MonitoringChatsResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import { useMonitoringFixChat, useMonitoringRefresh } from "../../state/monitoring";
import { serverEnvironment } from "../../state/server";
import { MissingEnvironmentNotes, MonitoringChatList, RetryButton } from "./MonitoringChatList";
import { MonitoringOverviewNotices, MonitoringRefreshButton } from "./MonitoringSection";

function pendingFixChatReply() {
  type Reply = { readonly threadId: ThreadId };
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((done) => {
    resolve = done;
  });
  return { effect: Effect.promise(() => promise), resolve };
}

function FixChatView({ target }: { readonly target: MonitoringFixChatTarget }) {
  const fixChat = useMonitoringFixChat(target, "reopened");
  return (
    <>
      <button onClick={fixChat.start} disabled={!fixChat.available || fixChat.pending}>
        Start fix
      </button>
      {fixChat.started && <output>{fixChat.started.threadId}</output>}
    </>
  );
}

it.each(["scope", "project", "route", "mount"] as const)(
  "ignores a delayed fix-chat reply after leaving the initiating %s",
  async (change) => {
    const target = {
      origin: `fix-chat-view-${change}`,
      environmentId: EnvironmentId.make("env-fix-chat"),
      projectId: ProjectId.make("project-fix-chat"),
      source: { threadIds: [ThreadId.make("example")] },
    } satisfies MonitoringFixChatTarget;
    using _available = vi
      .spyOn(serverEnvironment, "monitoringFixChatsAvailable")
      .mockReturnValue(Atom.make(true));
    await using screen = await render(<FixChatView target={target} />);
    using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue();
    const reply = pendingFixChatReply();
    using run = vi
      .spyOn(serverEnvironment.startMonitoringFixChat, "run")
      .mockReturnValue(reply.effect);
    const start = screen.getByRole("button", { name: "Start fix" });
    await start.click();
    await expect.element(start).toBeDisabled();
    const original = run.mock.calls[0]![1];

    if (change === "route") {
      await act(() => screen.router!.history.push("/#away"));
      await act(() => screen.router!.history.back());
    } else {
      await screen.rerender(
        <FixChatView
          key={change === "mount" ? "replacement" : undefined}
          target={{
            ...target,
            origin: change === "scope" ? "another-scope" : target.origin,
            projectId: change === "project" ? ProjectId.make("other-project") : target.projectId,
          }}
        />,
      );
      await screen.rerender(<FixChatView target={target} />);
    }

    await act(() => reply.resolve({ threadId: ThreadId.make("late-chat") }));
    await expect.element(start).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
    await expect.element(screen.getByText("late-chat")).not.toBeInTheDocument();
    const next = fixChatRequest(target, "reopened", "web", () => "new-command");
    settleFixChat(target, "reopened", next, null);
    expect(next.input.commandId).not.toBe(original.input.commandId);
  },
);

it("starts a separate fix chat for a new destination while the original reply is pending", async () => {
  const firstTarget = {
    origin: "same-overview-window-and-filters",
    environmentId: EnvironmentId.make("env-fix-chat"),
    projectId: ProjectId.make("project-a"),
    source: { view: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-29T00:00:00.000Z" } },
  } satisfies MonitoringFixChatTarget;
  const newTarget = { ...firstTarget, projectId: ProjectId.make("project-b") };
  const firstReply = pendingFixChatReply();
  const newReply = pendingFixChatReply();
  using _available = vi
    .spyOn(serverEnvironment, "monitoringFixChatsAvailable")
    .mockReturnValue(Atom.make(true));
  await using screen = await render(<FixChatView target={firstTarget} />);
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue();
  using run = vi
    .spyOn(serverEnvironment.startMonitoringFixChat, "run")
    .mockImplementation((_registry, { input }) =>
      input.projectId === firstTarget.projectId ? firstReply.effect : newReply.effect,
    );
  const start = screen.getByRole("button", { name: "Start fix" });
  await start.click();
  await expect.element(start).toBeDisabled();
  await screen.rerender(<FixChatView target={newTarget} />);
  await start.click();
  await expect.element(start).toBeDisabled();

  await act(() => firstReply.resolve({ threadId: ThreadId.make("chat-a") }));
  expect(navigate).not.toHaveBeenCalled();
  await expect.element(screen.getByText("chat-a")).not.toBeInTheDocument();
  await expect.element(start).toBeDisabled();

  const threadId = ThreadId.make("chat-b");
  await act(() => newReply.resolve({ threadId }));
  await expect.element(screen.getByText(threadId)).toBeVisible();
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ params: { environmentId: newTarget.environmentId, threadId } }),
  );
  const [firstRequest, newRequest] = run.mock.calls.map(([, request]) => request.input);
  expect(newRequest?.projectId).toBe(newTarget.projectId);
  expect(newRequest?.commandId).not.toBe(firstRequest?.commandId);
});

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
