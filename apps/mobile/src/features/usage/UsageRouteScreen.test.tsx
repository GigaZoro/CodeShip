import { minuteTick } from "@t3tools/client-runtime/clock";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type { EnvironmentUsageStatus } from "@t3tools/client-runtime/state/usage-progress";
import {
  initialUsageViewState,
  settleUsageView,
  type UsageViewState,
} from "@t3tools/client-runtime/state/usage-view";
import { makeWindow, usageWindowLabel } from "@t3tools/shared/usageFormat";
import { collectLimitAccounts, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { UsageRouteScreen } from "./UsageRouteScreen";

const { Contents, state } = vi.hoisted(() => ({
  Contents: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  state: {
    productionUsage: false,
    usageCalls: new Set<EnvironmentId>(),
    limitPresentations: null as LimitPresentations | null,
    tab: "usage" as string | undefined,
    live: [] as readonly EnvironmentUsageStatus[],
    view: null as UsageViewState | null,
    grantProbe: null as ReturnType<typeof mobileGrantProbe> | null,
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
  Button: ({
    label,
    accessibilityLabel,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {label}
    </button>
  ),
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
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({
    children,
    menus,
  }: {
    children: ReactNode;
    menus?: readonly {
      readonly title: string;
      readonly items: readonly {
        readonly id: string;
        readonly title: string;
        readonly subtitle?: string;
        readonly onPress: () => void;
      }[];
    }[];
  }) => (
    <main>
      {menus?.map((menu) => (
        <div key={menu.title} role="menu">
          {menu.items.map(({ id, title, subtitle, onPress }) => (
            <button key={id} data-environment={id} type="button" onClick={onPress}>
              {title}
              <span>{subtitle}</span>
            </button>
          ))}
        </div>
      ))}
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
vi.mock("../../state/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/usage")>();
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
      options?: Parameters<typeof actual.useUsage>[2],
    ) => {
      if (state.productionUsage) return actual.useUsage(window, selected, options);
      useSyncExternalStore(subscribe, () => state.revision);
      state.readsEnabled.push(options?.enabled);
      const selectedEnvironments =
        selected === null
          ? state.live
          : state.live.filter(({ environmentId }) => selected.has(environmentId));
      const requestedWindow = state.requestedWindow ?? window;
      state.view = settleUsageView(state.view ?? initialUsageViewState, {
        window: requestedWindow,
        environments: state.live,
        selectedIds: selected,
        hidden: [],
        enabled: options?.enabled ?? true,
      });
      return {
        requestedWindow,
        usage: state.view,
        environments: state.live,
        selectedEnvironments,
        refreshingEnvironmentIds: state.usageRefreshingEnvironmentIds,
        refresh: state.refreshUsage,
      };
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      usageModelFilterAtom: () => Atom.make(undefined),
      usageScanSettingsKeyAtom: () => Atom.make("settings"),
      usageSummary: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: UsageSummaryInput;
      }) => {
        state.usageCalls.add(environmentId);
        return Atom.make(AsyncResult.success({ ...observedSummary(), ...input }));
      },
    },
  };
});
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsWithProvidersAtom: Atom.make(
        () =>
          state.limitPresentations ??
          new Map([
            [
              EnvironmentId.make("desk"),
              {
                entry: { target: { label: "Desk" } },
                serverConfig: null,
                connection: { phase: "connected", error: null },
              },
            ],
          ]),
      ),
      presentationsAtom: Atom.make(
        new Map([
          [
            EnvironmentId.make("desk"),
            {
              entry: { target: { label: "Desk" } },
              connection: { phase: "connected", error: null },
            },
          ],
          [
            EnvironmentId.make("laptop"),
            {
              entry: { target: { label: "Laptop" } },
              connection: { phase: "connected", error: null },
            },
          ],
        ]),
      ),
    },
  };
});
vi.mock("../../state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: (id: EnvironmentId) =>
        state.grantProbe?.(id) ??
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            scopes: [AuthDiagnosticsReadScope, AuthOrchestrationReadScope],
          }),
        ),
    },
    readEnvironmentScope: () => false,
    useEnvironmentScope: () => false,
  };
});
vi.mock("../../lib/appState", () => ({
  useAppForeground: () => true,
  subscribeAppActive: () => () => {},
}));
vi.mock("react-native-svg", () => ({
  Defs: Contents,
  Path: Contents,
  Pattern: Contents,
  Rect: Contents,
  Svg: Contents,
}));
vi.mock("./CodexLimitsSignIn", () => ({ CodexLimitsSignIn: () => null }));
vi.mock("./ProviderHolds", () => ({ ProviderHolds: () => null }));
vi.mock("../../lib/i18n", () => ({
  t: (message: string, values?: Record<string, string>) =>
    message.replace(/\{([^}]+)\}/g, (key, name: string) => values?.[name] ?? key),
  tn: (count: number, one: string, other: string) =>
    (count === 1 ? one : other).replace("{count}", String(count)),
  msg: (message: string) => message,
  getFormattingLocale: () => "en-US",
}));
vi.mock("./ChatGptUsageSummary", () => ({ ChatGptUsageSummary: () => null }));
vi.mock("./UsageDailyChart", () => ({ UsageDailyChart: () => null }));
vi.mock("./UsageLimitsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./UsageLimitsSection")>()),
  useRefreshLimits: () => ({
    failedLabels: [],
    failedIds: state.failedLimits,
    refreshing: state.refreshingLimits,
    refreshingEnvironmentIds: state.limitsRefreshingEnvironmentIds,
    refresh: state.refreshLimits,
  }),
}));
vi.mock("./UsageLimitsPooled", () => ({
  UsageLimitsSection: () => <p>Limits overview</p>,
}));

function setup(tab: string | undefined = "usage") {
  const react = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = react.IS_REACT_ACT_ENVIRONMENT;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  state.tab = tab;
  state.productionUsage = false;
  state.usageCalls.clear();
  state.limitPresentations = null;
  state.live = [];
  state.view = null;
  state.grantProbe = null;
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
  const registry = AtomRegistry.make();
  return {
    container,
    render: (child: ReactNode = <UsageRouteScreen />) =>
      act(() => {
        state.revision += 1;
        for (const listener of state.listeners) listener();
        root.render(<RegistryContext value={registry}>{child}</RegistryContext>);
      }),
    async [Symbol.asyncDispose]() {
      await act(() => root.unmount());
      registry.dispose();
      if (wasActEnvironment === undefined) delete react.IS_REACT_ACT_ENVIRONMENT;
      else react.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    },
  };
}

it("keeps the mobile compatibility explanation in coverage and the short status in the menu", async () => {
  await using screen = setup();
  const window = makeWindow(30, new Date("2026-11-21T18:56:00Z"));
  const desk: EnvironmentUsageStatus = {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    isPending: true,
    isConnected: true,
    canReadDiagnostics: true,
    usageSettingsKey: "settings",
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
  expect(menuEnvironment(screen.container, "laptop").querySelector("span")?.textContent).toBe(
    "Update required.",
  );

  state.view = settleUsageView(initialUsageViewState, {
    window,
    environments: [desk, laptop],
    selectedIds: null,
    hidden: [],
    enabled: true,
  });
  await screen.render();
  const message = "Laptop runs an older server version. Showing its last compatible values.";
  expect(screen.container.querySelector('[role="status"]')?.textContent).toContain(message);
  expect(menuEnvironment(screen.container, "laptop").querySelector("span")?.textContent).toBe(
    "Update required.",
  );
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
    usageSettingsKey: "settings",
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

it("labels kept mobile figures with their exact window after the next scan fails", async () => {
  await using screen = setup();
  const tick = makeWindow(1, new Date("2026-11-21T18:56:00Z"), "hour");
  const next = makeWindow(1, new Date("2026-11-21T18:57:00Z"), "hour");
  const desk = { ...liveEnvironment("desk", "Desk"), summary: { ...observedSummary(), ...tick } };
  state.requestedWindow = tick;
  state.live = [desk];
  await screen.render();
  const label = `Showing previous usage for Desk · ${usageWindowLabel(tick)}`;
  expect(screen.container.textContent).not.toContain(label);

  state.requestedWindow = next;
  state.live = [{ ...desk, summary: null, isPending: true }];
  await screen.render();
  state.live = [{ ...desk, summary: null, error: "Read failed" }];
  await screen.render();
  expect(screen.container.textContent).toContain(label);
  expect(screen.container.textContent).toContain("Read failed");
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

it("announces a first pending read alongside a different environment's failure on mobile", async () => {
  await using screen = setup();
  state.live = [
    { ...liveEnvironment("desk", "Desk"), error: "Desk failed" },
    { ...liveEnvironment("laptop", "Laptop"), isPending: true },
  ];
  await screen.render();
  expect(screen.container.textContent).toContain("Retry");
  expect(screen.container.textContent).toContain("Scanning provider transcripts…");
  state.live = [{ ...liveEnvironment("desk", "Desk"), isPending: true }, state.live[1]!];
  await screen.render();
  await act(() => menuEnvironment(screen.container, "laptop").click());
  expect(screen.container.textContent).toContain("Desk failed");
  expect(screen.container.textContent).toContain("Retry");
  expect(screen.container.textContent).not.toContain("Scanning provider transcripts…");
});

it("removes Laptop's reserved row from mobile Providers when its grant is revoked again", async () => {
  await using screen = setup();
  const desk = { ...liveEnvironment("desk", "Desk"), summary: observedSummary() };
  const laptop = { ...liveEnvironment("laptop", "Laptop"), summary: observedSummary() };
  const denied = { ...laptop, canReadDiagnostics: false, summary: null, error: "Access revoked" };
  const pending = { ...desk, isPending: true, summary: null };
  state.live = [desk, laptop];
  await screen.render();
  state.live = [pending, denied];
  await screen.render();
  state.live = [
    pending,
    {
      ...laptop,
      isPending: true,
      summary: {
        ...laptop.summary,
        sources: [
          {
            fingerprint: {
              provider: "cursor",
              hostId: "Laptop",
              resolvedHomePath: "/test",
              volumeId: "1",
            },
            status: "ok",
            refreshing: true,
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: null,
          },
        ],
      },
    },
  ];
  await screen.render();
  const providers = () =>
    screen.container.querySelector('[aria-label="Providers"]')?.textContent ?? "";
  expect(providers()).toContain("Cursor");
  state.live = [pending, denied];
  await screen.render();
  expect(providers()).not.toContain("Cursor");
});

function mobileGrantProbe() {
  return Atom.family((id: EnvironmentId) => {
    let reads = 0;
    return Atom.make(() => {
      if (id === "desk") return AsyncResult.initial();
      if (id === "other") return AsyncResult.success({ authenticated: true, scopes: [] });
      return ++reads === 1
        ? AsyncResult.fail(new Error("Unavailable"))
        : AsyncResult.success({ authenticated: true, scopes: [AuthOrchestrationReadScope] });
    });
  });
}

// Mobile Usage has no scheduled-task section, so grant states for scheduled task runs are not its to report.
it("shows no scheduled-task access notices on mobile Usage", async () => {
  await using screen = setup();
  state.grantProbe = mobileGrantProbe();
  state.live = [
    liveEnvironment("desk", "Desk"),
    liveEnvironment("laptop", "Laptop"),
    liveEnvironment("other", "Other"),
  ];
  await screen.render();
  expect(screen.container.textContent).not.toContain("scheduled task runs");
});

it("reads no transcripts on mobile Limits, even after deselecting Laptop", async () => {
  await using screen = setup("usage");
  state.productionUsage = true;
  await screen.render();
  expect(state.usageCalls).toEqual(new Set(["desk", "laptop"]));
  state.usageCalls.clear();
  state.tab = "limits";
  await screen.render();
  expect(screen.container.textContent).toContain("Limits overview");
  await act(() => menuEnvironment(screen.container, "laptop").click());
  expect(state.usageCalls.size).toBe(0);
});

it("an empty mobile Limits section displays its message without a minute subscription", async () => {
  const { UsageLimitsSection } =
    await vi.importActual<typeof import("./UsageLimitsPooled")>("./UsageLimitsPooled");
  await using screen = setup("limits");
  using minute = vi.spyOn(minuteTick, "subscribe");
  await screen.render(<UsageLimitsSection selectedEnvironmentIds={null} failedLabels={[]} />);
  expect(screen.container.textContent).toContain("No provider on the selected environments");
  expect(minute).not.toHaveBeenCalled();
});

it("counts a reset credit's expiry down on the mobile account screen with no reset ahead", async () => {
  const { UsageLimitAccountScreen } =
    await vi.importActual<typeof import("./UsageLimitsPooled")>("./UsageLimitsPooled");
  await using screen = setup("limits");
  const now = Date.parse("2026-11-22T12:00:00Z");
  vi.useFakeTimers({ now });
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  state.limitPresentations = new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              installed: true,
              status: "ready",
              version: null,
              auth: { status: "authenticated" },
              checkedAt: "2026-11-22T11:59:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-11-22T11:59:00Z",
                windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }],
                resetCredits: {
                  availableCount: 1,
                  nextExpiresAt: new Date(now + 10 * 60_000).toISOString(),
                },
              },
            },
          ],
        },
      },
    ],
  ]);
  const [account] = collectLimitAccounts(state.limitPresentations);
  await screen.render(
    <UsageLimitAccountScreen
      route={{
        params: {
          accountKey: account!.key,
          windowId: "session",
          windowKind: "session",
          environmentIds: null,
        },
      }}
    />,
  );
  expect(screen.container.textContent).toContain("next expires in 10m");
  await act(() => vi.advanceTimersByTime(60_000));
  expect(screen.container.textContent).toContain("next expires in 9m");
});
