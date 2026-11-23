import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  customThemeNames,
  getGeneratedUniwindThemeOutputs,
  renderUniwindThemesCSS,
} from "./generate-uniwind-themes.mts";
function withThemeSandbox(
  test: (
    mobile: string,
    run: (...args: string[]) => NodeChildProcess.SpawnSyncReturns<string>,
  ) => void,
) {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-theme-check-"));
  try {
    const script = "apps/mobile/scripts/generate-uniwind-themes.mts";
    for (const path of [
      script,
      "apps/mobile/package.json",
      "apps/mobile/src/lib/mobileTheme.ts",
      "scripts/lib/command-line.ts",
    ]) {
      const target = NodePath.join(sandbox, path);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(root, path), target);
    }
    NodeFS.symlinkSync(
      NodePath.join(root, "apps/mobile/node_modules"),
      NodePath.join(sandbox, "apps/mobile/node_modules"),
      "junction",
    );
    const mobile = NodePath.join(sandbox, "apps/mobile");
    const target = NodePath.join(sandbox, script);
    expect(NodePath.relative(NodeFS.realpathSync(sandbox), NodeFS.realpathSync(target))).toBe(
      NodePath.normalize(script),
    );
    test(mobile, (...args) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", target, ...args],
        { cwd: mobile, encoding: "utf8", timeout: 30_000 },
      ),
    );
  } finally {
    NodeFS.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("generate mobile Uniwind themes", () => {
  it.each([
    [["--chek"], "Unknown option '--chek'"],
    [["--check", "--check"], "Pass --check at most once."],
  ] as const)("refuses %j before writing outputs", (args, diagnostic) => {
    withThemeSandbox((mobile, run) => {
      const result = run(...args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
      for (const [file] of getGeneratedUniwindThemeOutputs()) {
        expect(NodeFS.existsSync(NodePath.join(mobile, NodePath.basename(file)))).toBe(false);
      }
    });
  });

  it("checks the committed output and leaves stale files untouched", () => {
    withThemeSandbox((mobile, run) => {
      const outputs = getGeneratedUniwindThemeOutputs();
      for (const [file, expected] of outputs) {
        expect(NodeFS.readFileSync(file, "utf8")).toBe(expected);
        NodeFS.copyFileSync(file, NodePath.join(mobile, NodePath.basename(file)));
      }
      const current = run("--check");
      expect(current.error).toBeUndefined();
      expect({ status: current.status, stderr: current.stderr }).toEqual({ status: 0, stderr: "" });

      const stalePath = NodePath.join(mobile, NodePath.basename(outputs[0]![0]));
      const sentinel = Buffer.from("stale output for the check-mode test\n");
      NodeFS.writeFileSync(stalePath, sentinel);
      const stale = run("--check");
      expect(stale.error).toBeUndefined();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("is stale");
      expect(NodeFS.readFileSync(stalePath)).toEqual(sentinel);
    });
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
