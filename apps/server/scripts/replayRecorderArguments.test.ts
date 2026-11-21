import { describe, expect, it } from "vite-plus/test";

import { parseReplayArguments as parseCodex } from "./record-codex-app-server-replay-fixture.ts";
import { parseReplayArguments as parseFx } from "./record-fx-acp-replay-fixture.ts";
import { parseReplayArguments as parseGrok } from "./record-grok-acp-replay-fixture.ts";
import { parseClaudeReplayArguments, parseRecorderArguments } from "./replayRecorderArguments.ts";

describe("replay recorder arguments", () => {
  it.each([
    ["Fx", parseFx],
    ["Grok", parseGrok],
  ] as const)("%s validates the entire selection before recording", (_, parse) => {
    expect(parse(["--scenario", "simple"]).selected.map((entry) => entry.fixtureName)).toEqual([
      "simple",
    ]);
    expect(() => parse(["--scenario", "simple,typo"])).toThrow("replay fixture named 'typo'");
    expect(() => parse(["--scenario", "simple", "--scenario", "typo"])).toThrow(
      "replay fixture named 'typo'",
    );
    expect(() => parse(["--scenario", "simple,"])).toThrow("without empty names");
    expect(() => parse(["--scenario", "simple,simple", "--out", "one.ndjson"])).toThrow(
      "--out requires exactly one replay scenario.",
    );
  });

  it("validates Codex names even when all is in the selection", () => {
    expect(() => parseCodex(["--scenario", "all,typo"])).toThrow("Unknown scenario(s): typo");
    expect(() => parseCodex(["--scenario", "all"], { T3_CODEX_REPLAY_SCENARIOS: "typo" })).toThrow(
      "Unknown scenario(s): typo",
    );
    expect(
      parseCodex(["--", "--scenario", "simple", "--scenario", "tool_call"]).requestedScenarios,
    ).toEqual([
      "simple",
      "tool_call_read_only_on_request",
      "tool_call_workspace_never",
      "tool_call_restricted_granular",
    ]);
  });

  it("refuses conflicting Codex destinations and preserves a CLI override", () => {
    expect(() => parseCodex(["--out", "one.ndjson", "--out-dir", "directory"])).toThrow(
      "Pass either --out or --out-dir.",
    );
    expect(() => parseCodex(["--out", "one.ndjson", "--scenario", "all"])).toThrow(
      "--out requires exactly one replay scenario.",
    );
    expect(
      parseCodex(["--out-dir", "directory"], { T3_CODEX_REPLAY_OUT: "default.ndjson" }),
    ).toMatchObject({ out: undefined, outDir: "directory" });
  });

  it("accepts either Claude output form alone and rejects conflicting paths", () => {
    expect(parseClaudeReplayArguments(["one.ndjson"]).out).toBe("one.ndjson");
    expect(parseClaudeReplayArguments(["--out", "one.ndjson"]).out).toBe("one.ndjson");
    expect(() => parseClaudeReplayArguments(["--out", "one.ndjson", "stray.ndjson"])).toThrow(
      "Pass either --out or a positional output path.",
    );
  });

  it("refuses duplicate singleton options across recorders", () => {
    expect(() =>
      parseRecorderArguments({ options: { out: { type: "string", short: "o" } } }, [
        "--out",
        "first.ndjson",
        "-o",
        "second.ndjson",
      ]),
    ).toThrow("Pass --out at most once.");
  });
});
