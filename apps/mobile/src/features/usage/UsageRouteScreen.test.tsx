import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@t3tools/contracts";
import {
  settleUsageSnapshot,
  settleUsageScanFailures,
  type EnvironmentUsageStatus,
  type UsageSnapshot,
  type UsageScanFailures,
} from "@t3tools/client-runtime/state/usage-progress";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { UsageRouteScreen } from "./UsageRouteScreen";

const { Contents, state } = vi.hoisted(() => ({
  Contents: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  state: {
    tab: "usage" as string | undefined,
    live: [] as readonly EnvironmentUsageStatus[],
    shown: null as UsageSnapshot | null,
    scanFailures: null as UsageScanFailures | null,
    simulateRequests: false,
    requestedWindow: null as UsageSummaryInput | null,
    readsEnabled: [] as (boolean | undefined)[],
    failedLimits: new Set<EnvironmentId>(),
    refreshingLimits: false,
    limitsRefreshingEnvironmentIds: new Set<EnvironmentId>(),
    refreshLimits: async () => {},
    refreshUsage: async () => {},
    usageRefreshingEnvironmentIds: new Set<EnvironmentId>(),
    revision: 0,
    listeners: new Set<() => void>(),
  },
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: "android" },
  Pressable: Contents,
  RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" onClick={onRefresh}>
      Pull to refresh
    </button>
  ),
  View: Contents,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native-reanimated", () => {
  const animation = {
    delay: () => animation,
    duration: () => animation,
    reduceMotion: () => animation,
  };
  return { default: { View: Contents }, FadeIn: animation, ReduceMotion: { System: "system" } };
});
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useRoute: () => ({ params: { tab: state.tab } }),
}));
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p role="status">{message}</p>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Contents }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({
    children,
    refreshControl,
  }: {
    children: ReactNode;
    refreshControl?: ReactNode;
  }) => (
    <div>
      {refreshControl}
      {children}
    </div>
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    onPressAction,
  }: {
    actions: readonly { id: string; title: string; subtitle?: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div role="menu">
      {actions.map(({ id, title, subtitle }) => (
        <button
          key={id}
          data-environment={id}
          type="button"
          onClick={() => onPressAction({ nativeEvent: { event: id } })}
        >
          {title}
          <span>{subtitle}</span>
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../layout/native-glass-header-items", () => ({ withNativeGlassHeaderItem: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children, trailing }: { children: ReactNode; trailing: ReactNode }) => (
    <main>
      {trailing}
      {children}
    </main>
  ),
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../state/usage", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  return {
    useUsage: (
      window: UsageSummaryInput,
      selected: ReadonlySet<EnvironmentId> | null,
      options?: { enabled?: boolean },
    ) => {
      useSyncExternalStore(subscribe, () => state.revision);
      state.readsEnabled.push(options?.enabled);
      const selectedEnvironments =
        selected === null
          ? state.live
          : state.live.filter(({ environmentId }) => selected.has(environmentId));
      const requestedWindow = state.requestedWindow ?? window;
      if (state.simulateRequests) {
        state.shown = settleUsageSnapshot(
          state.shown,
          requestedWindow,
          state.live,
          selectedEnvironments,
        );
        state.scanFailures = settleUsageScanFailures(
          state.scanFailures,
          requestedWindow,
          selectedEnvironments,
        );
      }
      return {
        requestedWindow,
        failures: state.scanFailures,
        shown: state.shown,
        showingKept: false,
        environments: state.live,
        selectedEnvironments,
        refreshingEnvironmentIds: state.usageRefreshingEnvironmentIds,
        refresh: state.refreshUsage,
      };
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../lib/appState", () => ({ useAppForeground: () => true }));
vi.mock("../../lib/i18n", () => ({
  t: (message: string) => message,
  msg: (message: string) => message,
}));
vi.mock("./ChatGptUsageSummary", () => ({ ChatGptUsageSummary: () => null }));
vi.mock("./UsageDailyChart", () => ({ UsageDailyChart: () => null }));
vi.mock("./UsageLimitsSection", () => ({
  useRefreshLimits: () => ({
    failedLabels: [],
    failedIds: state.failedLimits,
    refreshing: state.refreshingLimits,
    refreshingEnvironmentIds: state.limitsRefreshingEnvironmentIds,
    refresh: state.refreshLimits,
  }),
}));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsSection: () => <p>Limits overview</p> }));

function setup(tab: string | undefined = "usage") {
  const react = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = react.IS_REACT_ACT_ENVIRONMENT;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  state.tab = tab;
  state.live = [];
  state.shown = null;
  state.scanFailures = null;
  state.simulateRequests = false;
  state.requestedWindow = null;
  state.readsEnabled.length = 0;
  state.failedLimits.clear();
  state.refreshingLimits = false;
  state.limitsRefreshingEnvironmentIds.clear();
  state.refreshLimits = async () => {};
  state.refreshUsage = async () => {};
  state.usageRefreshingEnvironmentIds.clear();
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render: () =>
      act(() => {
        state.revision += 1;
        for (const listener of state.listeners) listener();
        root.render(<UsageRouteScreen />);
      }),
    async [Symbol.asyncDispose]() {
      await act(() => root.unmount());
      if (wasActEnvironment === undefined) delete react.IS_REACT_ACT_ENVIRONMENT;
      else react.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    },
  };
}

it("shows live mobile coverage before figures and uses the same message in the menu", async () => {
  await using screen = setup();
  const window = makeWindow(30, new Date("2026-11-21T18:56:00Z"));
  const desk: EnvironmentUsageStatus = {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    isPending: true,
    isConnected: true,
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    error: null,
    summary: null,
  };
  const laptop: EnvironmentUsageStatus = {
    ...desk,
    environmentId: EnvironmentId.make("laptop"),
    label: "Laptop",
    isPending: false,
    summary: {
      ...window,
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-11-21T18:56:00Z",
      buckets: [],
      sources: [],
      pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
      scanDurationMs: 0,
    },
  };
  const incompatible = { ...laptop, summary: { ...laptop.summary!, contractVersion: 0 } };
  state.live = [desk, incompatible];
  await screen.render();
  expect(screen.container.textContent).toContain("Scanning provider transcripts");
  expect(screen.container.querySelector('[role="status"]')?.textContent).toContain(
    "Totals leave out Laptop",
  );
  expect(screen.container.querySelector('[role="menu"]')?.textContent).toContain(
    "Laptop runs an older server version and is excluded from totals.",
  );

  state.shown = settleUsageSnapshot(null, window, [desk, laptop], [desk, laptop]);
  await screen.render();
  const message = "Laptop runs an older server version. Showing its last compatible values.";
  expect(screen.container.querySelector('[role="status"]')?.textContent).toContain(message);
  expect(screen.container.querySelector('[role="menu"]')?.textContent).toContain(message);
  expect(screen.container.querySelector('[role="menu"]')?.textContent).not.toContain(
    "excluded from totals",
  );
  expect(screen.container.querySelector('[aria-label="Cost"]')?.textContent).toContain(
    "By typeNo activity in this window.",
  );
});

it("opens the native Limits tab with transcript reads disabled", async () => {
  await using screen = setup("limits");
  state.live = [
    liveEnvironment("desk", "Desk"),
    liveEnvironment("laptop", "Laptop"),
    { ...liveEnvironment("remote", "Remote"), isConnected: false },
  ];
  state.failedLimits.add(EnvironmentId.make("laptop"));
  await screen.render();
  expect(screen.container.textContent).toContain("Limits overview");
  expect(state.readsEnabled).not.toHaveLength(0);
  expect(new Set(state.readsEnabled)).toEqual(new Set([false]));
  const menu = screen.container.querySelector('[role="menu"]');
  expect(menu?.querySelector('[data-environment="desk"] span')?.textContent).toBe("Connected");
  expect(menu?.querySelector('[data-environment="laptop"] span')?.textContent).toBe(
    "Could not refresh limits.",
  );
  expect(menu?.querySelector('[data-environment="remote"] span')?.textContent).toBe(
    "Waiting for connection…",
  );
  expect(menu?.textContent).not.toContain("Loading usage…");
});

function liveEnvironment(id: string, label: string): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    error: null,
    summary: null,
  };
}

it("keeps an unselected environment's own scan error in the mobile menu", async () => {
  await using screen = setup();
  state.live = [
    liveEnvironment("desk", "Desk"),
    { ...liveEnvironment("laptop", "Laptop"), error: "Laptop scan failed" },
  ];
  await screen.render();
  const laptop = screen.container.querySelector<HTMLButtonElement>('[data-environment="laptop"]')!;
  await act(() => laptop.click());
  expect(laptop.querySelector("span")?.textContent).toBe("Laptop scan failed");
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
});

it("keeps the mobile failure layout while the next clock tick retries a cold scan", async () => {
  await using screen = setup();
  state.simulateRequests = true;
  state.requestedWindow = makeWindow(1, new Date("2026-11-21T18:56:00Z"), "hour");
  const desk = liveEnvironment("desk", "Desk");
  state.live = [{ ...desk, error: "Read failed" }];
  await screen.render();
  expect(screen.container.textContent).toContain("Read failed");
  expect(screen.container.textContent).toContain("Retry");
  state.requestedWindow = makeWindow(1, new Date("2026-11-21T18:57:00Z"), "hour");
  state.live = [{ ...desk, isPending: true }];
  await screen.render();
  expect(screen.container.textContent).toContain("Read failed");
  expect(screen.container.textContent).not.toContain("Scanning provider transcripts…");
});

function observedSummary(contractVersion: number = USAGE_CONTRACT_VERSION) {
  return {
    ...makeWindow(30, new Date("2026-11-21T18:56:00Z")),
    contractVersion,
    readAt: "2026-11-21T18:56:00Z",
    buckets: [],
    sources: [],
    pricing: { status: "cached" as const, source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  };
}

function menuEnvironment(container: HTMLElement, id: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-environment="${id}"]`)!;
}

it("labels each mobile Limits refresh only until that environment settles", async () => {
  await using screen = setup("limits");
  const desk = liveEnvironment("desk", "Desk");
  const laptop = liveEnvironment("laptop", "Laptop");
  state.live = [desk, laptop];
  const deskRequest = Promise.withResolvers<void>();
  const laptopRequest = Promise.withResolvers<void>();
  state.refreshLimits = async () => {
    state.refreshingLimits = true;
    const refresh = async (id: EnvironmentId, request: Promise<void>) => {
      state.limitsRefreshingEnvironmentIds.add(id);
      await request;
      state.limitsRefreshingEnvironmentIds.delete(id);
    };
    await Promise.all([
      refresh(desk.environmentId, deskRequest.promise),
      refresh(laptop.environmentId, laptopRequest.promise),
    ]);
    state.refreshingLimits = false;
  };
  await screen.render();
  await act(() =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Pull to refresh")
      ?.click(),
  );
  await screen.render();
  try {
    expect(menuEnvironment(screen.container, "desk").textContent).toContain("Updating limits…");
    expect(menuEnvironment(screen.container, "laptop").textContent).toContain("Updating limits…");
    await act(() => deskRequest.resolve());
    await screen.render();
    expect(menuEnvironment(screen.container, "desk").querySelector("span")?.textContent).toBe(
      "Connected",
    );
    expect(menuEnvironment(screen.container, "laptop").textContent).toContain("Updating limits…");
  } finally {
    await act(() => laptopRequest.resolve());
  }
});

it("shows a mobile Usage refresh only for the selected environment", async () => {
  await using screen = setup();
  const desk = liveEnvironment("desk", "Desk");
  const laptop = liveEnvironment("laptop", "Laptop");
  state.live = [desk, laptop].map((environment) => ({
    ...environment,
    summary: observedSummary(),
  }));
  const request = Promise.withResolvers<void>();
  state.refreshUsage = async () => {
    state.usageRefreshingEnvironmentIds.add(laptop.environmentId);
    await request.promise;
    state.usageRefreshingEnvironmentIds.clear();
  };
  await screen.render();
  await act(() => menuEnvironment(screen.container, "desk").click());
  await act(() =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Pull to refresh")
      ?.click(),
  );
  try {
    expect(menuEnvironment(screen.container, "desk").querySelector("span")?.textContent).toBe(
      "Usage up to date",
    );
    expect(menuEnvironment(screen.container, "laptop").textContent).toContain("Updating usage…");
  } finally {
    await act(() => request.resolve());
  }
});

it("shows Update required for an unselected incompatible environment on mobile", async () => {
  await using screen = setup();
  state.live = [
    { ...liveEnvironment("desk", "Desk"), summary: observedSummary() },
    { ...liveEnvironment("laptop", "Laptop"), summary: observedSummary(0) },
  ];
  await screen.render();
  await act(() => menuEnvironment(screen.container, "laptop").click());
  expect(menuEnvironment(screen.container, "laptop").querySelector("span")?.textContent).toBe(
    "Update required.",
  );
});
