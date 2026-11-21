import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@t3tools/contracts";
import {
  settleUsageSnapshot,
  type EnvironmentUsageStatus,
  type UsageSnapshot,
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
    readsEnabled: [] as (boolean | undefined)[],
    revision: 0,
    listeners: new Set<() => void>(),
  },
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: "android" },
  Pressable: Contents,
  RefreshControl: () => null,
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
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Contents }));
vi.mock("../../components/ui/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ actions }: { actions: readonly { title: string; subtitle?: string }[] }) => (
    <div role="menu">
      {actions.map(({ title, subtitle }) => (
        <p key={title}>{subtitle}</p>
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
    useUsage: (window: UsageSummaryInput, _selected: unknown, options?: { enabled?: boolean }) => {
      useSyncExternalStore(subscribe, () => state.revision);
      state.readsEnabled.push(options?.enabled);
      return {
        requestedWindow: window,
        shown: state.shown,
        showingKept: false,
        environments: state.live,
        selectedEnvironments: state.live,
        refresh: vi.fn(),
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
vi.mock("./UsageLimitsSection", () => ({ useRefreshLimits: () => ({ failedLabels: [] }) }));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsSection: () => <p>Limits overview</p> }));

function setup(tab: string | undefined = "usage") {
  const react = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = react.IS_REACT_ACT_ENVIRONMENT;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  state.tab = tab;
  state.live = [];
  state.shown = null;
  state.readsEnabled.length = 0;
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
  await screen.render();
  expect(screen.container.textContent).toContain("Limits overview");
  expect(state.readsEnabled).not.toHaveLength(0);
  expect(new Set(state.readsEnabled)).toEqual(new Set([false]));
});
