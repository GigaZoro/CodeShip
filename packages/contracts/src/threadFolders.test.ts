import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  StoredSavedThreadFolders,
  renameSavedThreadFolder,
  saveThreadFolders,
} from "./threadFolders.ts";

const decodeStoredFolders = Schema.decodeUnknownSync(StoredSavedThreadFolders);

describe("saved folder edits", () => {
  it("renames in place, merges onto an existing folder, and removes with null", () => {
    expect(renameSavedThreadFolder(["A", "B", "C"], "b", "Bee")).toEqual(["A", "Bee", "C"]);
    expect(renameSavedThreadFolder(["A", "B", "C"], "C", "a")).toEqual(["a", "B"]);
    expect(renameSavedThreadFolder(["A", "B", "C"], "B", null)).toEqual(["A", "C"]);
  });

  it("saves the given folders first and keeps every saved one, matching ignoring case", () => {
    expect(saveThreadFolders(["A", "b", "C"], [" B ", "New", "new"])).toEqual([
      "B",
      "New",
      "A",
      "C",
    ]);
  });

  it("reads back stored folders without the entries a later rule would refuse", () => {
    expect(decodeStoredFolders(["A", 3, "  ", "B"])).toEqual(["A", "B"]);
  });
});
