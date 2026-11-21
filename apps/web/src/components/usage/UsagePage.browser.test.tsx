import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type {
  EnvironmentUsageStatus,
  UsageSnapshot,
} from "@t3tools/client-runtime/state/usage-progress";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import "../../index.css";
import { UsagePage } from "./UsagePage";

const state = vi.hoisted(() => ({
  now: 0,
  response: "ready" as "ready" | "waiting" | "empty",
  previous: null as UsageSnapshot | null,
  revision: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("../../hooks/useUsageNow", () => ({
  useUsageNow: () => state.now,
  useUsageLimitNow: () => state.now,
}));
vi.mock("./usagePagePreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usagePagePreferences")>()),
  readUsagePagePreferences: () => ({ metric: "tokens", windowDays: 1 }),
}));
vi.mock("../../state/usage", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  const revision = () => state.revision;
  const { isKeptUsage, mergeAnsweredUsage, settleUsageSnapshot } =
    await import("@t3tools/client-runtime/state/usage-progress");
  return {
    mergeAnsweredUsage,
    useUsage: (window: UsageSummaryInput) => {
      useSyncExternalStore(subscribe, revision);
      const environments = [reading(window)];
      const shown = settleUsageSnapshot(state.previous, window, environments, environments);
      state.previous = shown;
      return {
        environments,
        selectedEnvironments: environments,
        shown,
        showingKept: isKeptUsage(shown, window, environments),
        refresh: async () => {},
      };
    },
  };
});

function reading(window: UsageSummaryInput): EnvironmentUsageStatus {
  const summary: UsageSummary | null =
    state.response === "waiting"
      ? null
      : {
          ...window,
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-11-21T23:59:00.000Z",
          buckets:
            state.response === "empty"
              ? []
              : [
                  {
                    day: window.sinceDay,
                    provider: "codex",
                    model: "usage-test-model",
                    totals: {
                      uncachedInputTokens: 100,
                      cachedInputTokens: 0,
                      cacheCreationTokens: 0,
                      outputTokens: 0,
                      reasoningTokens: 0,
                    },
                    costUsd: 0,
                    cacheSavingsUsd: 0,
                    costSource: "unpriced",
                    records: 1,
                    unpricedRecords: 1,
                    sessions: 1,
                  },
                ],
          sources:
            state.response === "empty"
              ? []
              : [
                  {
                    fingerprint: {
                      hostId: "desk",
                      provider: "codex",
                      resolvedHomePath: "/transcripts",
                      volumeId: "1",
                    },
                    status: "ok",
                    scannedFiles: 1,
                    skippedFiles: 0,
                    malformedRecords: 0,
                    distinctSessions: 1,
                    message: null,
                  },
                ],
          pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 1,
        };
  return {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    isConnected: true,
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    error: null,
    isPending: state.response === "waiting",
    summary,
  };
}

function setup() {
  state.now = Date.parse("2026-11-21T23:59:00.000Z");
  state.response = "ready";
  state.previous = null;
}

async function update() {
  await act(() => {
    state.revision++;
    for (const listener of state.listeners) listener();
  });
}

function Screen() {
  return (
    <AppAtomRegistryProvider>
      <UsagePage />
    </AppAtomRegistryProvider>
  );
}

it("keeps model details and their focus when the clock advances into an uncached window", async () => {
  setup();
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: "usage-test-model" }).click();
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close" });
  await expect.element(dialog.getByRole("heading", { name: "usage-test-model" })).toBeVisible();
  (close.element() as HTMLElement).focus();

  state.now += 60_000;
  state.response = "waiting";
  await update();

  await expect.element(dialog.getByRole("heading", { name: "usage-test-model" })).toBeVisible();
  await expect.element(close).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

it("clears provider placeholders after a compatible empty window settles", async () => {
  setup();
  await using screen = await render(<Screen />);
  await expect.element(screen.getByRole("button", { name: "usage-test-model" })).toBeVisible();

  state.previous = null;
  state.response = "waiting";
  await update();
  await expect.element(screen.getByText("Loading usage…")).toBeInTheDocument();
  const activeFootprint = screen.container.querySelectorAll('[data-slot="skeleton"]').length;

  state.response = "empty";
  await update();
  await expect.element(screen.getByText("No activity in this window.").first()).toBeVisible();

  state.previous = null;
  state.response = "waiting";
  await update();
  await expect.element(screen.getByText("Loading usage…")).toBeInTheDocument();
  expect(screen.container.querySelectorAll('[data-slot="skeleton"]').length).toBeLessThan(
    activeFootprint,
  );
});

function colorLuminance(color: string): number {
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const rgb = context.getImageData(0, 0, 1, 1).data.slice(0, 3);
  return Array.from(rgb, (value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}

it("keeps retained usage figures readable in the light and dark themes", async () => {
  setup();
  const wasDark = document.documentElement.classList.contains("dark");
  using _theme = {
    [Symbol.dispose]: () => document.documentElement.classList.toggle("dark", wasDark),
  };
  await using screen = await render(<Screen />);
  state.now += 60_000;
  state.response = "waiting";
  await update();
  await expect.element(screen.getByText(/Showing previous usage for Desk/)).toBeVisible();
  const figure = screen.getByText("100", { exact: true }).first();
  await expect.element(figure).toBeVisible();
  for (const dark of [false, true]) {
    document.documentElement.classList.toggle("dark", dark);
    const style = getComputedStyle(figure.element());
    const background = getComputedStyle(screen.getByRole("main").element()).backgroundColor;
    const lighter = Math.max(colorLuminance(style.color), colorLuminance(background));
    const darker = Math.min(colorLuminance(style.color), colorLuminance(background));
    expect(style.opacity).toBe("1");
    expect(
      (lighter + 0.05) / (darker + 0.05),
      JSON.stringify({ dark, foreground: style.color, background }),
    ).toBeGreaterThanOrEqual(4.5);
  }
});
