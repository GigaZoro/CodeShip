import {
  AuthDiagnosticsReadScope,
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type { EnvironmentUsageStatus } from "@t3tools/client-runtime/state/usage-progress";
import { usageEnvironmentError, usageNotices } from "@t3tools/client-runtime/state/usage-view";
import { usageRefreshingEnvironmentIdsAtom } from "@t3tools/client-runtime/state/usage";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useUsage } from "./usage";
import { makeWindow } from "@t3tools/shared/usageFormat";

const state = vi.hoisted(() => ({
  environments: [] as readonly EnvironmentUsageStatus[],
  query: null as ((atom: object) => readonly EnvironmentUsageStatus[]) | null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: object) =>
    atom === usageRefreshingEnvironmentIdsAtom
      ? new Set()
      : (state.query?.(atom) ?? state.environments),
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map([
          [
            "desk",
            {
              connection: { phase: "connected", error: null },
              entry: { target: { label: "Desk" } },
            },
          ],
        ]),
      ),
    },
  };
});
vi.mock("./server", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      usageSummary: vi.fn(() => Atom.make(AsyncResult.initial())),
      usageModelFilterAtom: () => Atom.make(undefined),
      usageScanSettingsKeyAtom: () => Atom.make("settings"),
    },
  };
});
vi.mock("./session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: () =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            scopes: [AuthDiagnosticsReadScope],
          }),
        ),
    },
    readEnvironmentScope: vi.fn(),
  };
});
vi.mock("../lib/i18n", () => ({ t: (message: string) => message }));

const window: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-10-16"),
  untilDay: UsageDay.make("2026-10-23"),
  timeZone: "UTC",
  resolution: "day",
};

function UsageProbe() {
  const environment = useUsage(window).selectedEnvironments[0];
  return <output>{environment ? usageEnvironmentError(environment) : "Loading usage"}</output>;
}

function mountUsageProbe() {
  const react = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = react.IS_REACT_ACT_ENVIRONMENT;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  state.query = null;
  return {
    container,
    root,
    async [Symbol.asyncDispose]() {
      await act(() => root.unmount());
      if (wasActEnvironment === undefined) delete react.IS_REACT_ACT_ENVIRONMENT;
      else react.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    },
  };
}

function failedScan(error: string): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    summary: null,
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    error,
    usageSettingsKey: "settings",
  };
}

it("renders mobile Usage with a single failed or offline environment", async () => {
  await using screen = mountUsageProbe();
  const { root, container } = screen;
  const failed = failedScan("Usage scan failed.");
  state.environments = [failed];
  await act(() => root.render(<UsageProbe key="failed" />));
  expect(container.textContent).toBe("Usage scan failed.");

  state.environments = [{ ...failed, isConnected: false, canReadDiagnostics: false, error: null }];
  await act(() => root.render(<UsageProbe key="offline" />));
  expect(container.textContent).toBe("This environment is not connected.");
});

it("keeps two slow mobile scan errors and Retry visible across later ticks", async () => {
  await using screen = mountUsageProbe();
  const requests = new Map<object, readonly EnvironmentUsageStatus[]>();
  const pending = [{ ...failedScan(""), isPending: true, error: null }];
  state.query = (atom) => {
    if (!requests.has(atom)) requests.set(atom, pending);
    return requests.get(atom)!;
  };
  function Scan({ elapsed }: { readonly elapsed: number }) {
    const request = makeWindow(
      1,
      new Date(Date.parse("2026-11-21T18:56:00Z") + elapsed * 1000),
      "hour",
    );
    const usage = useUsage(request);
    const { coverage } = usageNotices(
      usage.usage,
      usage.selectedEnvironments,
      usage.requestedWindow,
    );
    return (
      <>
        {coverage?.gaps.map(({ message, environment }) => (
          <p key={environment.environmentId}>{message}</p>
        ))}
        {coverage?.gaps.some(({ retryable }) => retryable) ? (
          <button type="button" onClick={() => void usage.refresh()}>
            Retry
          </button>
        ) : null}
      </>
    );
  }
  await act(() => screen.root.render(<Scan elapsed={0} />));
  for (const [index, started] of [0, 120].entries()) {
    await act(() => screen.root.render(<Scan elapsed={started + 60} />));
    expect(requests.size).toBe(index + 1);
    const error = `Scan ${index + 1} failed`;
    requests.set([...requests.keys()][index]!, [failedScan(error)]);
    await act(() => screen.root.render(<Scan elapsed={started + 65} />));
    expect(requests.size).toBe(index + 1);
    expect(screen.container.textContent).toContain(error);
    expect(screen.container.querySelector("button")?.textContent).toBe("Retry");
    await act(() => screen.root.render(<Scan elapsed={started + 120} />));
    expect(requests.size).toBe(index + 2);
    expect(screen.container.textContent).toContain(error);
  }
});

function statusWithTokens(label: string, tokens: number): EnvironmentUsageStatus {
  return {
    ...failedScan(""),
    label,
    environmentId: EnvironmentId.make(label.toLowerCase()),
    error: null,
    summary: {
      ...window,
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-10-23T12:00:00Z",
      buckets: [
        {
          day: window.sinceDay,
          provider: "codex",
          model: "test",
          totals: {
            uncachedInputTokens: tokens,
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
      sources: [
        {
          fingerprint: {
            hostId: label,
            provider: "codex",
            resolvedHomePath: "/test",
            volumeId: "test",
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
      scanDurationMs: 0,
    },
  };
}

function ScopedUsage({ period }: { readonly period: UsageSummaryInput }) {
  const usage = useUsage(period);
  const { coverage } = usageNotices(usage.usage, usage.selectedEnvironments, usage.requestedWindow);
  return (
    <>
      {usage.usage.view.kind === "figures" ? (
        <output>{usage.usage.view.merged.totalTokens} tokens</output>
      ) : null}
      {coverage?.gaps.map(({ environment, message }) => (
        <p key={environment.environmentId}>{message}</p>
      ))}
      {coverage?.gaps.some(({ retryable }) => retryable) ? (
        <button type="button">Retry</button>
      ) : null}
    </>
  );
}

it("shows Laptop's 200 on mobile until it answers after Desk loses access during a rolling refresh", async () => {
  await using screen = mountUsageProbe();
  const tick = makeWindow(1, new Date("2026-10-23T12:00:00Z"), "hour");
  const next = makeWindow(1, new Date("2026-10-23T12:01:00Z"), "hour");
  const desk = statusWithTokens("Desk", 100);
  const laptop = statusWithTokens("Laptop", 200);
  const tokens = () => screen.container.querySelector("output")?.textContent;
  state.environments = [desk, laptop];
  await act(() => screen.root.render(<ScopedUsage period={tick} />));
  expect(tokens()).toBe("300 tokens");

  state.environments = [
    { ...desk, summary: null, isPending: true },
    { ...laptop, summary: null, isPending: true },
  ];
  await act(() => screen.root.render(<ScopedUsage period={next} />));
  expect(tokens()).toBe("300 tokens");
  const revoked = { ...desk, canReadDiagnostics: false, summary: null, error: "Access revoked" };
  state.environments = [revoked, { ...laptop, summary: null, isPending: true }];
  await act(() => screen.root.render(<ScopedUsage period={next} />));
  expect(tokens()).toBe("200 tokens");

  state.environments = [revoked, statusWithTokens("Laptop", 250)];
  await act(() => screen.root.render(<ScopedUsage period={next} />));
  expect(tokens()).toBe("250 tokens");
});

it("returns the same mobile usage state when rerendered with unchanged statuses", async () => {
  await using screen = mountUsageProbe();
  const seen: ReturnType<typeof useUsage>["usage"][] = [];
  function Capture() {
    const usage = useUsage(window);
    seen.push(usage.usage);
    return <output>{usage.usage.view.kind}</output>;
  }
  state.environments = [statusWithTokens("Desk", 100)];
  await act(() => screen.root.render(<Capture />));
  expect(screen.container.textContent).toBe("figures");
  state.environments = [{ ...state.environments[0]! }];
  await act(() => screen.root.render(<Capture />));
  await act(() => screen.root.render(<Capture />));
  expect(seen.length).toBeLessThan(10);
  expect(seen.at(-1)).toBe(seen.at(-2));
  expect(seen.at(-1)).toBe(seen.at(-3));
});

it("reports only the new period's failures on mobile while retaining the previous figures", async () => {
  await using screen = mountUsageProbe();
  const date = new Date("2026-10-23T12:00:00Z");
  const week = makeWindow(7, date);
  const month = makeWindow(30, date);
  const desk = failedScan("Weekly scan failed");
  const laptop = statusWithTokens("Laptop", 200);
  state.environments = [desk, laptop];
  await act(() => screen.root.render(<ScopedUsage period={week} />));
  expect(screen.container.textContent).toContain("Weekly scan failed");
  const pending = [desk, laptop].map((env) => ({
    ...env,
    summary: null,
    error: null,
    isPending: true,
  }));
  state.environments = pending;
  await act(() => screen.root.render(<ScopedUsage period={month} />));
  expect(screen.container.textContent).toContain("200 tokens");
  expect(screen.container.textContent).not.toContain("Weekly scan failed");
  state.environments = [
    { ...pending[0]!, isPending: false, error: "Monthly scan failed" },
    pending[1]!,
  ];
  await act(() => screen.root.render(<ScopedUsage period={month} />));
  expect(screen.container.textContent).toContain("Monthly scan failed");
  state.environments = pending;
  await act(() => screen.root.render(<ScopedUsage period={month} />));
  expect(screen.container.textContent).toContain("Monthly scan failed");
  expect(screen.container.querySelector("button")?.textContent).toBe("Retry");
});

it("keeps 100 mobile tokens after the following minute's scan fails", async () => {
  await using screen = mountUsageProbe();
  const before = makeWindow(1, new Date("2026-10-23T12:00:00Z"), "hour");
  const after = makeWindow(1, new Date("2026-10-23T12:01:00Z"), "hour");
  const ready = statusWithTokens("Desk", 100);
  state.environments = [ready];
  await act(() => screen.root.render(<ScopedUsage period={before} />));
  expect(screen.container.textContent).toContain("100 tokens");
  state.environments = [{ ...ready, isPending: true, summary: null }];
  await act(() => screen.root.render(<ScopedUsage period={after} />));
  state.environments = [failedScan("Read failed")];
  await act(() => screen.root.render(<ScopedUsage period={after} />));
  expect(screen.container.textContent).toContain("100 tokens");
  expect(screen.container.textContent).toContain("Showing its last values");
});

it("drops mobile figures and failures read under other usage settings while the new ones load", async () => {
  await using screen = mountUsageProbe();
  const period = makeWindow(7, new Date("2026-10-23T12:00:00Z"));
  const laptop = {
    ...failedScan("Laptop scan failed"),
    label: "Laptop",
    environmentId: EnvironmentId.make("laptop"),
  };
  const saved = [statusWithTokens("Desk", 100), laptop];
  state.environments = saved;
  await act(() => screen.root.render(<ScopedUsage period={period} />));
  expect(screen.container.textContent).toBe("100 tokensLaptop: Laptop scan failedRetry");

  state.environments = saved.map((environment) => ({
    ...environment,
    summary: null,
    error: null,
    isPending: true,
    usageSettingsKey: "repriced",
  }));
  await act(() => screen.root.render(<ScopedUsage period={period} />));
  expect(screen.container.textContent).toBe("");
});
