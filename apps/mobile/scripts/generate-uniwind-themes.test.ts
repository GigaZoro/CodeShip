import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { customThemeNames, renderUniwindThemesCSS } from "./generate-uniwind-themes.mts";

describe("generate mobile Uniwind themes", () => {
  it("starts in Node the way the package's generate script runs it, and the committed files are current", () => {
    // Vitest resolves imports Node cannot, such as a .tsx file or a path without its extension, so run the real command.
    const run = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "scripts/generate-uniwind-themes.mts",
        "--check",
      ],
      { cwd: NodePath.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 },
    );
    expect(run.error).toBeUndefined();
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("gives every theme the same variables and a fixed Clerk palette for its appearance", () => {
    const css =
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../global.css"), "utf8") +
      renderUniwindThemesCSS();
    const themes = new Map<string, Map<string, string>>(
      ["light", "dark", ...customThemeNames].map((name) => [name, new Map()]),
    );
    for (const [, name, body] of css.matchAll(/@variant ([\w-]+) \{([^}]+)\}/gu)) {
      const variables = themes.get(name!);
      for (const [, variable, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
        variables?.set(variable!, value!.trim().toLowerCase());
      }
    }

    const lightVariables = themes.get("light")!;
    for (const [name, variables] of themes) {
      expect([...variables.keys()].sort(), name).toEqual([...lightVariables.keys()].sort());
      const isDark = name === "dark" || name.endsWith("-dark");
      expect(
        Object.fromEntries(
          [...variables].filter(([variable]) => variable.startsWith("--color-clerk-")),
        ),
        name,
      ).toEqual({
        "--color-clerk-page": isDark ? "#0a0a0a" : "#fcfcfc",
        "--color-clerk-foreground": isDark ? "#f5f5f5" : "#27272a",
        "--color-clerk-foreground-muted": isDark ? "#818181" : "#71717b",
        "--color-clerk-border": isDark ? "#191919" : "#e4e4e7",
        "--color-clerk-danger": isDark ? "#ff6467" : "#c10007",
      });
    }
  });
});
