import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import {
  AuthDiagnosticsReadScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type {
  EnvironmentUsageStatus,
  UsageSnapshot,
  UsageScanFailures,
} from "@t3tools/client-runtime/state/usage-progress";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import "../../index.css";
import { UsagePage } from "./UsagePage";
import { UsageProviderChart } from "./UsageProviderChart";
import { PROVIDER_ORDER } from "./usageProviders";

const state = vi.hoisted(() => ({
  cursorSetup: null as null | {
    readonly reader: "reading" | "unavailable";
    readonly canEnable: boolean;
  },
  usageCalls: new Set<string>(),
  startOnLimits: false,
  scheduledGrantProbe: false,
  now: 0,
  windowDays: 1 as 1 | 7,
  realClock: false,
  requests: new Set<string>(),
  response: "ready" as
    | "ready"
    | "waiting"
    | "provisional"
    | "empty"
    | "revoked"
    | "cursorPending"
    | "failed",
  secondEnvironment: null as
    | "waiting"
    | "ready"
    | "incompatible"
    | "sourceFailure"
    | "scanFailure"
    | "cursorPending"
    | "revoked"
    | null,
  costUsd: 0,
  totalTokens: 100,
  costSource: "unpriced" as "unpriced" | "modelPriced" | "providerReported",
  previous: null as UsageSnapshot | null,
  failures: null as UsageScanFailures | null,
  revision: 0,
  manualRefresh: null as Promise<void> | null,
  refreshingEnvironmentIds: new Set<EnvironmentId>(),
  listeners: new Set<() => void>(),
}));

vi.mock("../../hooks/useUsageNow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useUsageNow")>();
  return {
    ...actual,
    useUsageNow: (active: boolean) => {
      const now = actual.useUsageNow(active && state.realClock);
      return state.realClock ? now : state.now;
    },
    useUsageLimitNow: () => state.now,
  };
});
vi.mock("./usagePagePreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usagePagePreferences")>()),
  readUsagePagePreferences: () => ({
    metric: state.startOnLimits ? "limits" : "tokens",
    windowDays: state.windowDays,
  }),
}));
vi.mock("../../state/presentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make((get) =>
        state.cursorSetup === null
          ? get(actual.environmentPresentations.presentationsAtom)
          : cursorPresentations(),
      ),
    },
  };
});
vi.mock("../../state/environments", async (original) => {
  const actual = await original<typeof import("../../state/environments")>();
  return {
    ...actual,
    useEnvironments: () => {
      const result = actual.useEnvironments();
      return state.scheduledGrantProbe
        ? {
            ...result,
            environments: ["desk", "laptop"].map((environmentId) => ({
              environmentId,
              serverConfig: { environment: { capabilities: { scheduledTaskGroups: true } } },
            })),
          }
        : result;
    },
  };
});
vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentSessionStatesAtom: (ids: string) =>
      state.scheduledGrantProbe
        ? Atom.make(
            ids
              .split("\n")
              .filter(Boolean)
              .map(() => AsyncResult.fail(new Error("Grant lookup failed"))),
          )
        : actual.environmentSessionStatesAtom(ids),
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (id: EnvironmentId) =>
        state.cursorSetup === null
          ? actual.environmentSession.sessionStateAtom(id)
          : Atom.make(
              AsyncResult.success({
                authenticated: true,
                scopes: [
                  AuthDiagnosticsReadScope,
                  ...(state.cursorSetup.canEnable ? [AuthSettingsWriteScope] : []),
                ],
              }),
            ),
    },
  };
});
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { cursorUsageAccess } = await import("@t3tools/client-runtime/state/usage");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      cursorUsageAccessAtom: (id: EnvironmentId) => Atom.make(cursorUsageAccess(cursorConfig(id))),
      usageSummary: (request: { environmentId: EnvironmentId; input: UsageSummaryInput }) => {
        state.usageCalls.add(request.environmentId);
        return Atom.make(AsyncResult.success(reading(request.input, "ready").summary!));
      },
    },
  };
});
vi.mock("../../state/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/usage")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  const revision = () => state.revision;
  const {
    isKeptUsage,
    mergeAnsweredUsage,
    settleUsageScanFailures,
    settleUsageSnapshot,
    usageWindowKey,
  } = await import("@t3tools/client-runtime/state/usage-progress");
  return {
    mergeAnsweredUsage,
    useUsage: (
      window: UsageSummaryInput,
      selectedIds: ReadonlySet<EnvironmentId> | null = null,
      hidden?: Parameters<typeof actual.useUsage>[2],
      options?: Parameters<typeof actual.useUsage>[3],
    ) => {
      if (state.cursorSetup !== null) return actual.useUsage(window, selectedIds, hidden, options);
      useSyncExternalStore(subscribe, revision);
      state.requests.add(usageWindowKey(window));
      const other =
        state.secondEnvironment === null ? [] : [otherReading(window, state.secondEnvironment)];
      const environments = [reading(window), ...other];
      const selected =
        selectedIds === null
          ? environments
          : environments.filter(({ environmentId }) => selectedIds.has(environmentId));
      const shown = settleUsageSnapshot(state.previous, window, environments, selected);
      state.previous = shown;
      state.failures = settleUsageScanFailures(state.failures, window, selected);
      return {
        requestedWindow: window,
        failures: state.failures,
        environments,
        selectedEnvironments: selected,
        shown,
        showingKept: isKeptUsage(shown, window, selected),
        refreshingEnvironmentIds: state.refreshingEnvironmentIds,
        refresh: async () => {
          if (state.manualRefresh === null) return;
          for (const { environmentId } of selected)
            state.refreshingEnvironmentIds.add(environmentId);
          await state.manualRefresh;
          state.refreshingEnvironmentIds.clear();
        },
      };
    },
  };
});

function reading(window: UsageSummaryInput, response = state.response): EnvironmentUsageStatus {
  const summary: UsageSummary | null =
    response === "waiting" || response === "revoked" || response === "failed"
      ? null
      : {
          ...window,
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-11-21T23:59:00.000Z",
          buckets:
            response === "empty"
              ? []
              : [
                  {
                    day: window.sinceDay,
                    ...(window.sinceTime === undefined ? {} : { hourStart: window.sinceTime }),
                    provider: "codex",
                    model: response === "provisional" ? "other-model" : "usage-test-model",
                    totals: {
                      uncachedInputTokens: state.totalTokens,
                      cachedInputTokens: 0,
                      cacheCreationTokens: 0,
                      outputTokens: 0,
                      reasoningTokens: 0,
                    },
                    costUsd: state.costUsd,
                    cacheSavingsUsd: 0,
                    costSource: state.costSource,
                    records: 1,
                    unpricedRecords: state.costSource === "unpriced" ? 1 : 0,
                    sessions: 1,
                  },
                ],
          sources:
            response === "empty"
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
  const cursor: UsageSummary | null =
    response === "cursorPending" && summary !== null
      ? {
          ...summary,
          sources: [
            ...summary.sources,
            {
              ...summary.sources[0]!,
              fingerprint: { ...summary.sources[0]!.fingerprint, provider: "cursor" as const },
              scannedFiles: 0,
              distinctSessions: 0,
              refreshing: true,
            },
          ],
        }
      : summary;
  return {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    isConnected: true,
    canReadDiagnostics: response !== "revoked",
    needsCursorKeychainAccess: false,
    error:
      response === "revoked"
        ? "Diagnostics access was revoked."
        : response === "failed"
          ? "Read failed"
          : null,
    isPending: response === "waiting" || response === "provisional" || response === "cursorPending",
    summary: cursor,
  };
}

function otherReading(
  window: UsageSummaryInput,
  response: NonNullable<typeof state.secondEnvironment>,
): EnvironmentUsageStatus {
  if (response === "revoked" || response === "waiting") {
    return {
      ...reading(window, response),
      environmentId: EnvironmentId.make("laptop"),
      label: "Laptop",
    };
  }
  const other = reading(window, response === "cursorPending" ? response : "ready");
  const summary = other.summary!;
  return {
    ...other,
    environmentId: EnvironmentId.make("laptop"),
    label: "Laptop",
    error: response === "scanFailure" ? "Laptop scan failed" : null,
    summary:
      response === "scanFailure"
        ? null
        : {
            ...summary,
            contractVersion: response === "incompatible" ? 0 : summary.contractVersion,
            buckets: summary.buckets.map((bucket) => ({ ...bucket, model: "laptop-model" })),
            sources: summary.sources.map((source) => ({
              ...source,
              fingerprint: { ...source.fingerprint, hostId: "laptop" },
              ...(response === "sourceFailure"
                ? { status: "partial" as const, message: "Cursor fetch failed" }
                : {}),
            })),
          },
  };
}

function setup(windowDays: 1 | 7 = 1) {
  state.cursorSetup = null;
  state.usageCalls.clear();
  state.startOnLimits = false;
  state.scheduledGrantProbe = false;
  state.now = new Date(2026, 10, 21, 23, windowDays === 1 ? 56 : 59).getTime();
  state.windowDays = windowDays;
  state.realClock = false;
  state.requests.clear();
  state.response = "ready";
  state.secondEnvironment = null;
  state.costUsd = 0;
  state.totalTokens = 100;
  state.costSource = "unpriced";
  state.previous = null;
  state.failures = null;
  state.manualRefresh = null;
  state.refreshingEnvironmentIds.clear();
}

async function update() {
  await act(() => {
    state.revision++;
    for (const listener of state.listeners) listener();
  });
}

function cursorPresentations() {
  return new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        connection: { phase: "connected", error: null },
        serverConfig: null,
      },
    ],
    [
      EnvironmentId.make("laptop"),
      {
        entry: { target: { label: "Laptop" } },
        connection: { phase: "connected", error: null },
        serverConfig: null,
      },
    ],
  ]);
}

function cursorConfig(id: EnvironmentId) {
  const desk = id === "desk";
  const reader = state.cursorSetup?.reader ?? "unavailable";
  return {
    settings: DEFAULT_SERVER_SETTINGS,
    providers: [
      {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        enabled: true,
        installed: true,
        status: "ready" as const,
        version: null,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-11-21T23:59:00Z",
        models: [],
        slashCommands: [],
        skills: [],
        cursorAccountHistory: desk ? ("keychainOff" as const) : reader,
        ...(desk || !state.cursorSetup?.canEnable
          ? {}
          : {
              usageLimits: {
                checkedAt: "2026-11-21T23:59:00Z",
                windows:
                  reader === "reading"
                    ? []
                    : [
                        {
                          id: "totalPercentUsed",
                          kind: "monthly" as const,
                          label: "Total",
                          usedPercent: 25,
                        },
                      ],
                ...(reader === "reading"
                  ? { unavailable: { reason: "probeFailed" as const } }
                  : {}),
              },
            }),
      },
    ],
  };
}

it.each([
  ["keeps the action with token-only Linux quota", "unavailable", true, true],
  ["hides the action for a Linux history reader whose quota failed", "reading", true, false],
  ["hides the action on a read-only connection", "unavailable", false, false],
] as const)(
  "%s in the production web Usage and Limits views",
  async (_name, reader, canEnable, showAction) => {
    setup();
    state.startOnLimits = true;
    state.cursorSetup = { reader, canEnable };
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext value={registry}>
        <UsagePage />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Refresh limits" }).first())
      .toBeVisible();
    const action = screen.getByRole("button", { name: "Enable Cursor usage from Desk" });
    expect(state.usageCalls.size).toBe(0);
    expect(action.query() !== null).toBe(showAction);
    await act(() => {
      globalThis.window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", code: "KeyT", cancelable: true }),
      );
    });
    await expect
      .element(screen.getByRole("button", { name: "Refresh usage" }).first())
      .toBeVisible();
    expect(state.usageCalls).toEqual(new Set(["desk", "laptop"]));
    expect(action.query() !== null).toBe(showAction);
  },
);

function Screen() {
  return (
    <AppAtomRegistryProvider>
      <UsagePage />
    </AppAtomRegistryProvider>
  );
}

it.each([
  ["minute rolls over on Past 24h", 1],
  ["date rolls over on 7 days", 7],
] as const)("keeps model details interactive when the %s", async (_label, days) => {
  setup(days);
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: "usage-test-model" }).click();
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close" });
  const setPrice = dialog.getByRole("button", { name: "Set price" });
  await expect.element(dialog.getByRole("heading", { name: "usage-test-model" })).toBeVisible();
  await expect.element(setPrice).toBeEnabled();
  (close.element() as HTMLElement).focus();

  state.now += 60_000;
  state.response = "waiting";
  await update();

  await expect.element(dialog.getByRole("heading", { name: "usage-test-model" })).toBeVisible();
  await expect.element(close).toHaveFocus();
  await expect.element(setPrice).toBeEnabled();
  await expect.element(screen.getByText(/Showing previous usage/)).not.toBeInTheDocument();
  state.response = "provisional";
  await update();
  await expect.element(setPrice).toBeEnabled();
  await expect.element(close).toHaveFocus();
  await expect.element(screen.getByText("other-model", { exact: true })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

it("shows the failed environment's own error after it is unselected", async () => {
  setup();
  state.secondEnvironment = "scanFailure";
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: /All environments/ }).click();
  const laptop = page.getByRole("menuitemcheckbox", { name: /Laptop/ });
  await laptop.click();
  await expect.element(laptop).not.toBeChecked();
  await expect.element(laptop.getByText("Laptop scan failed")).toBeVisible();
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

async function selectWeekFromShortcut() {
  await act(() => {
    const mac = navigator.platform.startsWith("Mac");
    globalThis.window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "@",
        code: "Digit2",
        shiftKey: true,
        ctrlKey: !mac,
        metaKey: mac,
        cancelable: true,
      }),
    );
  });
}

it("keeps retained figures readable and disables price edits when the period changes", async () => {
  setup();
  const wasDark = document.documentElement.classList.contains("dark");
  using _theme = {
    [Symbol.dispose]: () => document.documentElement.classList.toggle("dark", wasDark),
  };
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: "usage-test-model" }).click();
  const dialog = page.getByRole("dialog");
  state.response = "waiting";
  await selectWeekFromShortcut();
  await expect.element(dialog.getByRole("button", { name: "Set price" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
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

it("keeps the model dialog on its authorized reading when the new period is empty and Laptop was already denied", async () => {
  setup();
  state.secondEnvironment = "revoked";
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: "usage-test-model" }).click();
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close" });
  (close.element() as HTMLElement).focus();
  state.response = "empty";
  await selectWeekFromShortcut();
  await expect.element(dialog.getByRole("heading", { name: "usage-test-model" })).toBeVisible();
  await expect.element(close).toHaveFocus();
  await expect.element(dialog.getByText(/Showing previous usage for Desk/)).toBeVisible();
});

it("keeps the web failure layout while the next clock tick retries a cold scan", async () => {
  setup();
  state.response = "failed";
  await using screen = await render(<Screen />);
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  state.response = "waiting";
  state.now += 60_000;
  await update();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect.element(screen.getByText("Loading usage…")).not.toBeInTheDocument();
});

it("shows manual Usage refresh progress only for the selected environment on web", async () => {
  setup();
  state.secondEnvironment = "ready";
  let finishRefresh!: () => void;
  state.manualRefresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: /All environments/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Desk/ }).click();
  await userEvent.keyboard("{Escape}");
  await screen.getByRole("button", { name: "Refresh usage" }).first().click();
  try {
    await screen.getByRole("button", { name: "Laptop" }).click();
    const menu = page.getByRole("menu");
    expect(menu.getByRole("menuitemcheckbox", { name: /Desk/ }).element().textContent).toContain(
      "Ready",
    );
    await expect
      .element(menu.getByRole("menuitemcheckbox", { name: /Laptop.*Refreshing/ }))
      .toBeVisible();
  } finally {
    await act(finishRefresh);
  }
});

it("reports live compatibility and source failures beside the saved total", async () => {
  setup();
  state.secondEnvironment = "ready";
  await using screen = await render(<Screen />);
  const figures = screen.getByText("200", { exact: true }).first();
  await expect.element(figures).toBeVisible();

  state.response = "waiting";
  state.secondEnvironment = "incompatible";
  await update();
  await expect
    .element(
      screen.getByText("Laptop runs an older server version. Showing its last compatible values."),
    )
    .toBeVisible();
  await expect.element(figures).toBeVisible();
  await screen.getByRole("button", { name: /All environments/ }).click();
  await expect
    .element(page.getByRole("menu").getByText(/Showing its last compatible values/))
    .toBeVisible();
  await expect
    .element(page.getByRole("menu").getByText(/is excluded from totals/))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  state.secondEnvironment = "sourceFailure";
  await update();
  await expect.element(screen.getByText("Cursor fetch failed")).toBeVisible();
  await expect.element(figures).toBeVisible();
});

it("closes the open model and removes its figures when diagnostics access is revoked", async () => {
  setup();
  state.secondEnvironment = "ready";
  await using screen = await render(<Screen />);
  await screen.getByRole("button", { name: "usage-test-model" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByRole("button", { name: "Set price" })).toBeEnabled();
  state.response = "revoked";
  await update();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "laptop-model" })).toBeVisible();
});

it("shows an incompatible environment notice while the first scan is pending", async () => {
  setup();
  state.response = "waiting";
  state.secondEnvironment = "incompatible";
  await using screen = await render(<Screen />);
  await expect.element(screen.getByText("Loading usage…")).toBeInTheDocument();
  await expect.element(screen.getByText("Totals leave out Laptop")).toBeVisible();
});

it("shows unknown values while Cursor has no first reading", async () => {
  setup();
  state.response = "cursorPending";
  await using screen = await render(<Screen />);
  const cursor = screen.getByRole("group", { name: "Cursor" });
  await expect.element(cursor.getByText("–", { exact: true }).first()).toBeVisible();
  await expect.element(cursor.getByText("0", { exact: true })).not.toBeInTheDocument();
  await expect.element(cursor.getByText(/0%/)).not.toBeInTheDocument();
});

it("pauses the rolling window in a hidden tab and catches up when it becomes visible", async () => {
  setup();
  state.realClock = true;
  using _clock = fakeTimers();
  vi.setSystemTime(state.now);
  using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await using screen = await render(<Screen />);
  await expect.element(screen.getByRole("button", { name: "usage-test-model" })).toBeVisible();
  const requests = state.requests.size;
  await act(() => {
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(() => vi.advanceTimersByTimeAsync(180_000));
  expect(state.requests.size).toBe(requests);
  await act(() => {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(state.requests.size).toBe(requests + 1);
});

it("keeps every provider's chart strokes and bars at 3:1 or higher in both themes", async () => {
  const wasDark = document.documentElement.classList.contains("dark");
  using _theme = {
    [Symbol.dispose]: () => document.documentElement.classList.toggle("dark", wasDark),
  };
  const day = "2026-11-21";
  const data = {
    chartType: "area" as const,
    providers: PROVIDER_ORDER,
    loadingProviders: new Set(["cursor"] as const),
    days: [day],
    daily: [
      {
        day,
        costUsd: 1,
        totalTokens: 100,
        byProvider: new Map(
          PROVIDER_ORDER.map((provider) => [provider, { costUsd: 1, totalTokens: 100 }]),
        ),
      },
    ],
    hours: [],
    hourly: [],
    metric: "cost" as const,
    referenceTime: undefined,
    resolution: "day" as const,
    timeZone: "UTC",
    hour12: true,
  };
  await using screen = await render(
    <main className="bg-background">
      <UsageProviderChart {...data} />
    </main>,
  );
  for (const chartType of ["area", "bar"] as const) {
    await screen.rerender(
      <main className="bg-background">
        <UsageProviderChart {...data} chartType={chartType} />
      </main>,
    );
    const series = [
      ...screen.container.querySelectorAll(
        chartType === "area" ? 'path[stroke-width="2"]' : "rect[fill]",
      ),
    ];
    expect(series).toHaveLength(PROVIDER_ORDER.length);
    if (chartType === "area")
      expect(series.filter((line) => line.hasAttribute("stroke-dasharray"))).toHaveLength(1);
    await expect.element(screen.getByText("Updating Cursor…")).toBeVisible();
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const canvas = colorLuminance(
        getComputedStyle(screen.getByRole("main").element()).backgroundColor,
      );
      for (const mark of series) {
        const style = getComputedStyle(mark);
        const color = chartType === "area" ? style.stroke : style.fill;
        const value = colorLuminance(color);
        expect(style.opacity).toBe("1");
        expect(
          (Math.max(canvas, value) + 0.05) / (Math.min(canvas, value) + 0.05),
          `${chartType} ${color} on the ${dark ? "dark" : "light"} canvas`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  }
});

it("stops advancing the requested period on Limits and catches up on Usage", async () => {
  setup();
  state.realClock = true;
  using _clock = fakeTimers();
  vi.setSystemTime(state.now);
  await using screen = await render(<Screen />);
  await expect.element(screen.getByRole("button", { name: "usage-test-model" })).toBeVisible();

  const selectMetric = (key: "t" | "l") =>
    act(() => {
      globalThis.window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: key === "t" ? "KeyT" : "KeyL",
          cancelable: true,
        }),
      );
    });
  await selectMetric("l");
  await expect.element(screen.getByRole("button", { name: "Refresh limits" })).toBeVisible();
  const initialRequests = state.requests.size;
  await act(() => vi.advanceTimersByTimeAsync(3 * 60_000));
  expect(state.requests.size).toBe(initialRequests);
  await selectMetric("t");
  await expect.element(screen.getByRole("button", { name: "usage-test-model" })).toBeVisible();
  expect(state.requests.size).toBe(initialRequests + 1);
});

it.each([
  ["modelPriced", 0, 100, "Priced usage costs $0"],
  ["providerReported", 1, 0, "No tokens recorded"],
  ["providerReported", 0.003, 100, "No cost breakdown available"],
] as const)(
  "describes the model's %s usage with cost %d and %d tokens",
  async (source, cost, tokens, label) => {
    setup();
    state.costSource = source;
    state.costUsd = cost;
    state.totalTokens = tokens;
    await using screen = await render(<Screen />);
    await screen.getByRole("button", { name: "usage-test-model" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
  },
);

it("keeps the model figures and Retry together after a rolling request fails", async () => {
  setup();
  await using screen = await render(<Screen />);
  const model = screen.getByRole("button", { name: "usage-test-model" });
  await expect.element(model).toBeVisible();
  state.now += 60_000;
  state.response = "waiting";
  await update();
  state.response = "failed";
  await update();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(model.query()).not.toBeNull();
});

it("announces a first pending read alongside a different environment's failure on web", async () => {
  setup();
  state.response = "waiting";
  state.secondEnvironment = "scanFailure";
  await using screen = await render(<Screen />);
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.getByText("Loading usage…").query()).not.toBeNull();
});

it("removes Laptop's reserved row from the web overview when its grant is revoked again", async () => {
  setup();
  state.secondEnvironment = "ready";
  await using screen = await render(<Screen />);
  state.response = "waiting";
  state.secondEnvironment = "revoked";
  await update();
  state.secondEnvironment = "cursorPending";
  await update();
  const cursor = screen.getByText("Cursor", { exact: true }).first();
  await expect.element(cursor).toBeVisible();
  state.secondEnvironment = "revoked";
  await update();
  expect(cursor.query()).toBeNull();
});

it("shows the live selected scheduled grant even without usage figures", async () => {
  setup();
  state.scheduledGrantProbe = true;
  state.response = "failed";
  await using screen = await render(<Screen />);
  expect(screen.container.textContent).toContain(
    "Could not check access to scheduled task runs on Desk.",
  );
  state.response = "ready";
  state.secondEnvironment = "waiting";
  await update();
  await screen.getByRole("button", { name: /All environments/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Desk/ }).click();
  await userEvent.keyboard("{Escape}");
  expect(screen.container.textContent).toContain(
    "Could not check access to scheduled task runs on Laptop.",
  );
  expect(screen.container.textContent).not.toContain(
    "Could not check access to scheduled task runs on Desk.",
  );
});
