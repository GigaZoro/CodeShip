import { describe, expect, it } from "vite-plus/test";

import { resolveWindowTitle } from "./branding.logic";

describe("resolveWindowTitle needs-you count", () => {
  const base = { appDisplayName: "T3.CodeShip", projectTitle: "api", threadTitle: "Fix login" };

  it.each([
    [{ desktop: false }, "(2) api / Fix login - T3.CodeShip"],
    [{ desktop: true }, "(2) api / Fix login"],
    [{ desktop: false, threadTitle: null }, "(2) T3.CodeShip"],
  ])("leads the whole title with the count for %j", (override, expected) => {
    expect(resolveWindowTitle({ ...base, needsYouCount: 2, ...override })).toBe(expected);
  });

  it("adds nothing when no thread needs the user", () => {
    expect(resolveWindowTitle({ ...base, needsYouCount: 0, desktop: false })).toBe(
      "api / Fix login - T3.CodeShip",
    );
  });
});
