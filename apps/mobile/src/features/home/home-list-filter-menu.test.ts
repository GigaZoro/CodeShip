import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  homeListFilterEnvironments,
  threadListRefinementMenuChange,
} from "./home-list-filter-menu";

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
    lastSeenAt: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});

describe("threadListRefinementMenuChange", () => {
  const refinement = { statusFilter: "all", sort: "default", selectedTags: ["bug"] } as const;

  it.each([
    ["status:working", { statusFilter: "working" }],
    ["sort:created", { sort: "created" }],
    ["tags:toggle:ui", { selectedTags: ["bug", "ui"] }],
    ["tags:toggle:bug", { selectedTags: [] }],
    ["tags:clear", { selectedTags: [] }],
    ["status:unknown", null],
    ["archived-threads", null],
  ] as const)("maps %s", (event, expected) => {
    expect(threadListRefinementMenuChange(event, refinement)).toEqual(expected);
  });
});
