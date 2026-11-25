import { describe, expect, it } from "vite-plus/test";

import { threadListRefinementMenuChange } from "./home-list-filter-menu";

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
