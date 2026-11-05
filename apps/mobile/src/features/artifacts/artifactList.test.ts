import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterArtifacts,
  sortArtifactsNewestFirst,
  type EnvironmentArtifact,
} from "./artifactList";

const artifact = (
  attachmentId: string,
  overrides: Partial<EnvironmentArtifact> = {},
): EnvironmentArtifact => ({
  environmentId: EnvironmentId.make("env-a"),
  attachmentId,
  title: attachmentId,
  height: 400,
  versions: 1,
  threadId: ThreadId.make("thread-a"),
  threadTitle: "Charts",
  archived: false,
  projectId: ProjectId.make("project-a"),
  projectTitle: "Alpha",
  providerInstanceId: null,
  publishedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("sortArtifactsNewestFirst", () => {
  it("orders by publish time across environments and breaks ties by key", () => {
    const sorted = sortArtifactsNewestFirst([
      artifact("old", { publishedAt: "2026-01-01T00:00:00.000Z" }),
      artifact("b", { publishedAt: "2026-01-02T00:00:00.000Z" }),
      artifact("a", { publishedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.attachmentId)).toEqual(["a", "b", "old"]);
  });
});

describe("filterArtifacts", () => {
  const artifacts = [
    artifact("revenue", { title: "Revenue chart" }),
    artifact("mock", { title: "Mockup", threadTitle: "Settings", projectTitle: null }),
  ];

  it("matches title, thread and project case-insensitively", () => {
    expect(filterArtifacts(artifacts, "REVENUE").map((item) => item.attachmentId)).toEqual([
      "revenue",
    ]);
    expect(filterArtifacts(artifacts, "settings").map((item) => item.attachmentId)).toEqual([
      "mock",
    ]);
    expect(filterArtifacts(artifacts, "alpha").map((item) => item.attachmentId)).toEqual([
      "revenue",
    ]);
  });

  it("returns every artifact for a blank query", () => {
    expect(filterArtifacts(artifacts, "  ")).toHaveLength(2);
  });
});
