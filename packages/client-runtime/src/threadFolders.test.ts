import { describe, expect, it } from "vite-plus/test";

import {
  addSavedThreadFolder,
  mergeSavedThreadFolders,
  moveThreadFolder,
  resolveThreadFolders,
} from "./threadFolders.ts";

describe("resolveThreadFolders", () => {
  it("keeps saved folders first in their order, then thread-named ones by name, matching ignoring case", () => {
    expect(
      resolveThreadFolders(
        ["Optimization", "  ", "autopilot", "OPTIMIZATION"],
        [null, "Reviews", "AUTOPILOT", "machine  care", "Archive", undefined, "reviews"],
      ),
    ).toEqual([
      { key: "optimization", name: "Optimization", saved: true },
      { key: "autopilot", name: "autopilot", saved: true },
      { key: "archive", name: "Archive", saved: false },
      { key: "machine care", name: "machine  care", saved: false },
      { key: "reviews", name: "Reviews", saved: false },
    ]);
  });
});

describe("saved folder edits", () => {
  it("adds a folder once, whatever its case", () => {
    const saved = addSavedThreadFolder(["Autopilot"], " Optimization ");
    expect(saved).toEqual(["Autopilot", "Optimization"]);
    expect(addSavedThreadFolder(saved, "autopilot")).toBe(saved);
  });

  it("merges machines' saved folders in the first machine's order, then what others add", () => {
    expect(mergeSavedThreadFolders([["A", "B"], ["b", "C", "a"], []])).toEqual(["A", "B", "C"]);
  });

  it("moves a folder and saves the whole order", () => {
    const folders = resolveThreadFolders(["A"], ["B"]);
    expect(moveThreadFolder(folders, "b", -1)).toEqual(["B", "A"]);
    expect(moveThreadFolder(folders, "a", -1)).toEqual(["A", "B"]);
  });
});
