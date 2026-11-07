import { describe, expect, it } from "vite-plus/test";

import { formatAppWindowTitle, resolveAppWindowTitle } from "./windowTitle.ts";

describe("window titles", () => {
  it.each([
    [["Fix login", "Web app"], "Fix login - Web app - T3.CodeShip (Beta)"],
    [["Fix login", null], "Fix login - T3.CodeShip (Beta)"],
    [["  ", undefined], "T3.CodeShip (Beta)"],
    [[], "T3.CodeShip (Beta)"],
  ] as const)("formats %j", (context, expected) => {
    expect(formatAppWindowTitle(context, "T3.CodeShip (Beta)")).toBe(expected);
  });

  it.each([
    ["Fix login - Web app - T3.CodeShip (Dev)", "Fix login - Web app - T3.CodeShip (Dev)"],
    ["T3.CodeShip (Dev)", "T3.CodeShip (Dev)"],
    // The static HTML title names another stage; a dev server error page names nothing.
    ["T3.CodeShip (Beta)", "T3.CodeShip (Dev)"],
    ["localhost:5733", "T3.CodeShip (Dev)"],
    ["Fix login - T3.CodeShip (Beta)", "T3.CodeShip (Dev)"],
  ])("keeps %j only when it names this app", (pageTitle, expected) => {
    expect(resolveAppWindowTitle(pageTitle, "T3.CodeShip (Dev)")).toBe(expected);
  });
});
