import {
  AuthDiagnosticsReadScope,
  EnvironmentId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  usageEnvironmentError,
  usageNotices,
  type EnvironmentUsageStatus,
} from "@t3tools/client-runtime/state/usage-progress";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useUsage } from "./usage";
import { serverEnvironment } from "./server";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { AtomRegistry } from "effect/reactivity";

const state = vi.hoisted(() => ({
  environments: [] as readonly EnvironmentUsageStatus[],
  query: null as ((atom: object) => readonly EnvironmentUsageStatus[]) | null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: object) => state.query?.(atom) ?? state.environments,
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
  const { shown } = useUsage(window);
  const environment = shown?.environments[0];
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
    needsCursorKeychainAccess: false,
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
    const coverage = usageNotices(
      usage.selectedEnvironments,
      usage.shown?.environments ?? [],
    ).coverage;
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

it("keeps mobile Limits connected without starting a cold transcript scan", async () => {
  const registry = AtomRegistry.make();
  using _cleanup = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = mountUsageProbe();
  state.query = (atom) =>
    registry.get(atom as Parameters<typeof registry.get>[0]) as readonly EnvironmentUsageStatus[];
  const summary = vi.mocked(serverEnvironment.usageSummary);
  summary.mockClear();
  function View({ limits }: { readonly limits: boolean }) {
    const usage = useUsage(window, null, { enabled: !limits });
    return (
      <p>
        {usage.environments.map(
          ({ label, canReadDiagnostics }) => `${label}: ${canReadDiagnostics}`,
        )}
      </p>
    );
  }
  await act(() => screen.root.render(<View limits />));
  expect(screen.container.textContent).toBe("Desk: true");
  expect(summary).not.toHaveBeenCalled();
  await act(() => screen.root.render(<View limits={false} />));
  expect(summary).toHaveBeenCalledOnce();
});
