// @effect-diagnostics nodeBuiltinImport:off - runOnce is a synchronous script, tested on a real temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  nondeterministic,
  parseRenderMetricsArguments,
  renderComparison,
  runOnce,
} from "./render-metrics.ts";

const mountReport = { commits: 2, renders: 10, components: { Row: 10 } };

vi.mock("node:child_process", () => ({
  spawnSync: (
    _command: string,
    _args: string[],
    options: { env: { T3CODE_RENDER_REPORT_DIR: string } },
  ) => {
    NodeFS.writeFileSync(
      NodePath.join(options.env.T3CODE_RENDER_REPORT_DIR, "mount.json"),
      JSON.stringify(mountReport),
    );
    return { status: 0 };
  },
}));

describe("runOnce", () => {
  it("collects the scenario reports when HOME has no .cache, then removes its report dir", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-render-metrics-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("TMPDIR", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("TEMP", home);
    vi.stubEnv("TMP", home);
    try {
      expect(runOnce()).toEqual({ mount: mountReport });
      expect(NodeFS.readdirSync(home)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("nondeterministic", () => {
  it("names only the scenarios whose counts differ between runs", () => {
    const stable = { commits: 2, renders: 10, components: { Row: 10 } };
    expect(
      nondeterministic([
        { mount: stable, type: { commits: 1, renders: 4, components: { Editor: 4 } } },
        { mount: stable, type: { commits: 1, renders: 5, components: { Editor: 5 } } },
      ]),
    ).toEqual(["type"]);
  });
});

describe("renderComparison", () => {
  it("prints per-scenario deltas and the components that moved most", () => {
    const output = renderComparison(
      { stream: { commits: 40, renders: 400, components: { Row: 300, Header: 100 } } },
      { stream: { commits: 30, renders: 250, components: { Row: 150, Header: 100 } } },
    );
    expect(output).toContain("| stream | 40 → 30 (-10, -25%) | 400 → 250 (-150, -37%) |");
    expect(output).toContain("| `Row` | 300 → 150 (-150, -50%) |");
    expect(output).not.toContain("`Header`");
  });
});

describe("render metrics arguments", () => {
  it.each(["oops", "", "0", "-1", "1.5", "2.0", "0x10", "1e3", " 5", "05", "9007199254740992"])(
    "refuses --runs=%s",
    (runs) => {
      expect(() =>
        parseRenderMetricsArguments(["run", "--runs=" + runs, "--out=report.json"]),
      ).toThrow("--runs must be a positive safe integer.");
    },
  );

  it("accepts a positive run count and rejects a duplicate singleton", () => {
    expect(parseRenderMetricsArguments(["run", "--runs=2", "--out=report.json"])).toEqual({
      command: "run",
      runs: 2,
      out: "report.json",
    });
    expect(() => parseRenderMetricsArguments(["run", "--out=a", "--out=b"])).toThrow(
      "Pass --out at most once.",
    );
  });

  it.each(["--help", "-h"])("accepts %s only as a standalone argument", (flag) => {
    expect(parseRenderMetricsArguments([flag])).toEqual({ command: "help" });
    expect(() => parseRenderMetricsArguments([flag, "--no-such-argument"])).toThrow("Usage:");
  });
});
