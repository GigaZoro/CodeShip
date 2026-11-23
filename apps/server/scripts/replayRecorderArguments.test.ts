import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { describe, expect, it } from "vite-plus/test";

import { parseReplayArguments as parseCodex } from "./record-codex-app-server-replay-fixture.ts";
import { cursorReplayFlags } from "./record-cursor-agent-sdk-replay-fixture.ts";
import { parseReplayArguments as parseFx } from "./record-fx-acp-replay-fixture.ts";
import { parseReplayArguments as parseGrok } from "./record-grok-acp-replay-fixture.ts";
import { parseClaudeReplayArguments, parseRecorderArguments } from "./replayRecorderArguments.ts";

describe("replay recorder arguments", () => {
  it("refuses a blank Cursor output before dispatch", async () => {
    let dispatched = false;
    const command = Command.make("cursor-fixture", cursorReplayFlags, () =>
      Effect.sync(() => {
        dispatched = true;
      }),
    );
    const run = (out: string) =>
      Command.runWith(command, { version: "0.0.0", renderErrors: false })([
        "--scenario",
        "simple",
        "--out",
        out,
      ]).pipe(Effect.provide(NodeServices.layer), Effect.result, Effect.runPromise);
    expect(await run(" ")).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ShowHelp",
        errors: [
          {
            _tag: "InvalidValue",
            kind: "flag",
            option: "out",
            value: " ",
            expected: "--out needs a value.",
          },
        ],
      },
    });
    expect(dispatched).toBe(false);
    expect((await run("example.ndjson"))._tag).toBe("Success");
    expect(dispatched).toBe(true);
  });

  it.each([
    ["Fx", parseFx],
    ["Grok", parseGrok],
  ] as const)("%s validates the entire selection before recording", (_, parse) => {
    expect(parse(["--scenario", "simple"]).selected.map((entry) => entry.fixtureName)).toEqual([
      "simple",
    ]);
    expect(parse(["--scenario", "simple,simple", "--scenario", "simple"]).selected).toHaveLength(1);
    expect(() => parse(["--scenario", "simple,typo"])).toThrow("replay fixture named 'typo'");
    expect(() => parse(["--scenario", "simple", "--scenario", "typo"])).toThrow(
      "replay fixture named 'typo'",
    );
    expect(() => parse(["--scenario", "simple,"])).toThrow("without empty names");
    expect(
      parse(["--scenario", "simple,simple", "--scenario", "simple", "--out", "one.ndjson"]),
    ).toMatchObject({ selected: [{ fixtureName: "simple" }], out: "one.ndjson" });
    expect(() => parse(["--scenario", "simple", "--out="])).toThrow("--out needs a value.");
  });

  it.each([
    [["--out-dir="], {}, "--out-dir needs a value."],
    [["--out", " "], {}, "--out needs a value."],
    [["--model="], {}, "--model needs a value."],
    [[], { T3_CODEX_REPLAY_OUT_DIR: "" }, "T3_CODEX_REPLAY_OUT_DIR is set but empty"],
    [[], { T3_CODEX_REPLAY_OUT: "" }, "T3_CODEX_REPLAY_OUT is set but empty"],
    [["--scenario", ""], {}, "--scenario needs a value."],
    [[], { T3_CODEX_REPLAY_MODEL: " " }, "T3_CODEX_REPLAY_MODEL is set but empty"],
  ] as const)("Codex refuses an empty value before recording: %j %j", (args, env, message) => {
    expect(() => parseCodex(args, env)).toThrow(message);
  });

  it("treats the empty optional Codex environment selection as unset", () => {
    expect(parseCodex([], { T3_CODEX_REPLAY_SCENARIOS: "" }).requestedScenarios).toEqual([
      "simple",
    ]);
    expect(() => parseCodex([], { T3_CODEX_REPLAY_SCENARIOS: " " })).toThrow("without empty names");
  });

  it("lets a Codex CLI destination override an empty environment destination", () => {
    expect(parseCodex(["--out-dir", "directory"], { T3_CODEX_REPLAY_OUT_DIR: "" })).toMatchObject({
      outDir: "directory",
    });
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
    expect(parseClaudeReplayArguments(["one.ndjson"], {}).out).toBe("one.ndjson");
    expect(parseClaudeReplayArguments(["--out", "one.ndjson"], {}).out).toBe("one.ndjson");
    expect(() => parseClaudeReplayArguments(["--out", "one.ndjson", "stray.ndjson"], {})).toThrow(
      "Pass either --out or a positional output path.",
    );
  });

  it("reads the Claude selection from the command line, then the environment", () => {
    expect(parseClaudeReplayArguments([], {})).toMatchObject({ scenario: "simple" });
    expect(
      parseClaudeReplayArguments([], {
        T3_CLAUDE_REPLAY_SCENARIO: "fork_session",
        T3_CLAUDE_REPLAY_QUERY_MODE: "restart",
      }),
    ).toMatchObject({ scenario: "fork_session", queryMode: "restart" });
    expect(
      parseClaudeReplayArguments(["--scenario", "simple"], { T3_CLAUDE_REPLAY_SCENARIO: "" }),
    ).toMatchObject({ scenario: "simple" });
  });

  it.each([
    [[""], {}, "A positional argument needs a value."],
    [["--out="], {}, "--out needs a value."],
    [["--scenario", ""], {}, "--scenario needs a value."],
    [[], { T3_CLAUDE_REPLAY_SCENARIO: "" }, "T3_CLAUDE_REPLAY_SCENARIO is set but empty"],
    [[], { T3_CLAUDE_REPLAY_QUERY_MODE: "" }, "T3_CLAUDE_REPLAY_QUERY_MODE is set but empty"],
  ] as const)("Claude refuses an empty value before recording: %j %j", (args, env, message) => {
    expect(() => parseClaudeReplayArguments(args, env)).toThrow(message);
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
