import { EnvironmentId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import {
  usageEnvironmentError,
  type EnvironmentUsageStatus,
} from "@t3tools/client-runtime/state/usage-progress";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useUsage } from "./usage";

const state = vi.hoisted(() => ({ environments: [] as readonly EnvironmentUsageStatus[] }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({ environmentPresentations: {} }));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {}, readEnvironmentScope: vi.fn() }));
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

it("renders mobile Usage with a single failed or offline environment", async () => {
  const react = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = react.IS_REACT_ACT_ENVIRONMENT;
  react.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const failed: EnvironmentUsageStatus = {
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    summary: null,
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    error: "Usage scan failed.",
    needsCursorKeychainAccess: false,
  };
  try {
    state.environments = [failed];
    await act(() => root.render(<UsageProbe key="failed" />));
    expect(container.textContent).toBe("Usage scan failed.");

    state.environments = [
      { ...failed, isConnected: false, canReadDiagnostics: false, error: null },
    ];
    await act(() => root.render(<UsageProbe key="offline" />));
    expect(container.textContent).toBe("This environment is not connected.");
  } finally {
    await act(() => root.unmount());
    if (wasActEnvironment === undefined) delete react.IS_REACT_ACT_ENVIRONMENT;
    else react.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
});
