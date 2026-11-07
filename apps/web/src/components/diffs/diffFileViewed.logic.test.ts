import { describe, expect, it } from "vite-plus/test";

import {
  diffFileViewedStatus,
  getFileViewedRange,
  setDiffFilesViewed,
} from "./diffFileViewed.logic";

describe("getFileViewedRange", () => {
  const files = ["c.ts", "a.ts", "b.ts", "d.ts"].map((fileKey) => ({ fileKey }));

  it("includes both endpoints in displayed order in either direction", () => {
    expect(getFileViewedRange(files, "b.ts", "c.ts")).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, "c.ts", "b.ts")).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, "a.ts", "a.ts")).toEqual([files[1]]);
  });

  it("changes only the clicked file without a current anchor", () => {
    expect(getFileViewedRange(files, "a.ts", null)).toEqual([files[1]]);
    expect(getFileViewedRange(files, "a.ts", "removed.ts")).toEqual([files[1]]);
    expect(getFileViewedRange(files, "removed.ts", "a.ts")).toEqual([]);
  });
});

describe("diffFileViewedStatus", () => {
  const marks = setDiffFilesViewed(new Map(), [{ path: "a.ts", version: 1 }], true);

  it("reads a file whose content changed since it was marked as changed, not viewed", () => {
    expect(diffFileViewedStatus(marks, "a.ts", 1)).toBe("viewed");
    expect(diffFileViewedStatus(marks, "a.ts", 2)).toBe("changed");
    expect(diffFileViewedStatus(marks, "b.ts", 1)).toBeNull();
  });

  it("keeps the mark while the file's content is still loading", () => {
    expect(diffFileViewedStatus(marks, "a.ts", null)).toBe("viewed");
  });

  it("re-marking a changed file records its new content, and unmarking forgets it", () => {
    const remarked = setDiffFilesViewed(marks, [{ path: "a.ts", version: 2 }], true);
    expect(diffFileViewedStatus(remarked, "a.ts", 2)).toBe("viewed");
    expect(
      diffFileViewedStatus(
        setDiffFilesViewed(remarked, [{ path: "a.ts", version: 2 }], false),
        "a.ts",
        2,
      ),
    ).toBeNull();
  });
});
