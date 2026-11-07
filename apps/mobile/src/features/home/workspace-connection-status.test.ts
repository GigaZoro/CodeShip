import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusPresentation } from "./workspace-connection-status";

function environment(
  label: string,
  connectionState: WorkspaceEnvironment["connectionState"],
): WorkspaceEnvironment {
  return {
    environmentId: label as never,
    environmentLabel: label,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState,
    connectionError: connectionState === "connected" ? null : "Could not reach sleeping laptop",
    connectionErrorTraceId: null,
    lastSeenAt: null,
  };
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    unreachableEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it.each([
    ["reconnecting", "Reconnecting to Sleeping laptop"],
    ["offline", "Sleeping laptop is offline"],
    ["error", "Can't connect to Sleeping laptop"],
  ] as const)(
    "names a secondary machine that is %s while another is connected",
    (connectionState, label) => {
      const unreachable = environment("Sleeping laptop", connectionState);
      const state = workspaceState({
        connectionError: unreachable.connectionError,
        unreachableEnvironments: [unreachable],
      });

      expect(workspaceConnectionStatusPresentation(state)).toEqual({
        label,
        showsProgress: false,
      });
    },
  );

  it("counts several unreachable machines", () => {
    const state = workspaceState({
      unreachableEnvironments: [
        environment("Sleeping laptop", "reconnecting"),
        environment("Zoro-PC", "offline"),
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)?.label).toBe("2 machines unreachable");
  });

  it("keeps the brand while every machine is connected", () => {
    expect(workspaceConnectionStatusPresentation(workspaceState())).toBeNull();
  });

  it("shows connected shell catch-up even while a secondary environment is unreachable", () => {
    const unreachable = environment("Sleeping laptop", "reconnecting");
    const state = workspaceState({
      hasSyncingConnectedEnvironment: true,
      hasPendingShellSnapshot: true,
      hasConnectingEnvironment: true,
      connectionError: unreachable.connectionError,
      connectingEnvironments: [unreachable],
      unreachableEnvironments: [unreachable],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      showsProgress: true,
    });
  });
});
