// @effect-diagnostics nodeBuiltinImport:off - Runs the real package entries in an isolated Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { describe, expect, it } from "vite-plus/test";

import { parseReplayArguments as parseCodex } from "./record-codex-app-server-replay-fixture.ts";
import { cursorReplayFlags } from "./record-cursor-agent-sdk-replay-fixture.ts";
import { parseReplayArguments as parseFx } from "./record-fx-acp-replay-fixture.ts";
import { parseReplayArguments as parseGrok } from "./record-grok-acp-replay-fixture.ts";
import {
  parseClaudeReplayArguments,
  parseRecorderArguments,
  selectClaudeReplayPrompts,
} from "./replayRecorderArguments.ts";

const recorderNodeOptions = "--permission --allow-fs-read=* --allow-addons";
const syntheticEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/iu.test(key),
  ),
);

function runPackageRecorder(
  platform: NodeJS.Platform,
  cwd: string,
  entry: string,
  args: ReadonlyArray<string>,
  overrides: NodeJS.ProcessEnv = {},
) {
  const npmArgs = ["--offline", "--ignore-scripts", "run", "--silent", entry, "--", ...args];
  const windows = platform === "win32";
  return NodeChildProcess.spawnSync(
    windows ? "cmd.exe" : "npm",
    windows ? ["/d", "/c", "npm.cmd", ...npmArgs] : npmArgs,
    {
      cwd,
      env: { ...syntheticEnvironment, npm_config_node_options: recorderNodeOptions, ...overrides },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

describe("replay recorder arguments", () => {
  effectIt.effect(
    "preserves Bun dotenv expansion and process and CLI precedence through the Node package entry",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const sandbox = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "replay-recorder-package-"),
        );
        try {
          NodeFS.copyFileSync(
            new URL("../package.json", import.meta.url),
            NodePath.join(sandbox, "package.json"),
          );
          NodeFS.symlinkSync(
            NodeURL.fileURLToPath(new URL("./", import.meta.url)),
            NodePath.join(sandbox, "scripts"),
            "junction",
          );
          NodeFS.writeFileSync(
            NodePath.join(sandbox, ".env"),
            "OUTPUT_DIR=from-base\nT3_CODEX_REPLAY_OUT=$OUTPUT_DIR/base.ndjson\n",
          );
          NodeFS.writeFileSync(
            NodePath.join(sandbox, ".env.local"),
            "LOCAL_OUTPUT=from-local\nT3_CODEX_REPLAY_OUT=$LOCAL_OUTPUT/fixture.ndjson\nT3_CLAUDE_REPLAY_SCENARIO=multi_turn\n",
          );

          // Run the package shell with only the fixture's Node on PATH in both phases.
          const nodeBin = NodePath.join(sandbox, "node-bin");
          NodeFS.mkdirSync(nodeBin);
          NodeFS.copyFileSync(
            process.execPath,
            NodePath.join(nodeBin, platform === "win32" ? "node.exe" : "node"),
            NodeFS.constants.COPYFILE_FICLONE,
          );
          const nodeEnvironment = {
            ...Object.fromEntries(
              Object.entries(syntheticEnvironment).filter(([key]) => key.toUpperCase() !== "PATH"),
            ),
            PATH: nodeBin,
          };
          const dryRun = (entry: string) =>
            NodeChildProcess.spawnSync(process.execPath, ["--run", entry, "--", "--dry-run"], {
              cwd: sandbox,
              env: nodeEnvironment,
              encoding: "utf8",
              timeout: 30_000,
            });
          const entries = [
            ["record:codex-replay", "from-local/fixture.ndjson"],
            [
              "record:claude-replay",
              NodeURL.fileURLToPath(
                new URL(
                  "../src/orchestration-v2/testkit/fixtures/multi_turn/claude_transcript.ndjson",
                  import.meta.url,
                ),
              ),
            ],
          ] as const;
          for (const [entry] of entries) {
            const result = dryRun(entry);
            expect(result.error).toBeUndefined();
            expect(result.signal).toBeNull();
            expect(result.status).toBeGreaterThan(0);
            expect(result.stderr).toMatch(/\bbun\b/iu);
            expect(result.stdout.trim()).toBe("");
          }

          NodeFS.symlinkSync(
            NodeURL.fileURLToPath(new URL("../node_modules/", import.meta.url)),
            NodePath.join(sandbox, "node_modules"),
            "junction",
          );
          for (const [entry, expected] of entries) {
            const result = dryRun(entry);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            expect(NodePath.normalize(result.stdout.trim())).toBe(NodePath.normalize(expected));
          }

          const codex = (args: ReadonlyArray<string>, overrides?: NodeJS.ProcessEnv) =>
            runPackageRecorder(
              platform,
              sandbox,
              "record:codex-replay",
              ["--dry-run", ...args],
              overrides,
            );
          for (const [name, args, overrides] of [
            ["from-local/fixture.ndjson", [], {}],
            ["from-process.ndjson", [], { T3_CODEX_REPLAY_OUT: "from-process.ndjson" }],
            [
              "from-cli.ndjson",
              ["--out", "from-cli.ndjson"],
              { T3_CODEX_REPLAY_OUT: "from-process.ndjson" },
            ],
          ] as const) {
            const result = codex(args, overrides);
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout.trim()).toBe(name);
          }
          const claude = runPackageRecorder(platform, sandbox, "record:claude-replay", [
            "--dry-run",
          ]);
          expect(claude.error).toBeUndefined();
          expect(claude.status, claude.stderr).toBe(0);
          expect(claude.stdout.trim().replaceAll("\\", "/")).toMatch(
            /\/multi_turn\/claude_transcript\.ndjson$/u,
          );
          for (const recorder of ["record:codex-replay", "record:claude-replay"]) {
            const invalid = runPackageRecorder(platform, sandbox, recorder, [
              "--dry-run",
              "--no-such-argument",
            ]);
            expect(invalid.error).toBeUndefined();
            expect(invalid.status).toBe(1);
            expect(invalid.stderr).toContain("Unknown option '--no-such-argument'");
            expect(invalid.stdout).toBe("");
          }
          const blankPrompt = runPackageRecorder(
            platform,
            sandbox,
            "record:claude-replay",
            ["--dry-run"],
            { T3_CLAUDE_REPLAY_PROMPTS: "first\n---\n\n---\nsecond" },
          );
          expect(blankPrompt.error).toBeUndefined();
          expect(blankPrompt.status).toBe(1);
          expect(blankPrompt.stderr).toContain(
            "T3_CLAUDE_REPLAY_PROMPTS contains a blank prompt at position 2.",
          );
        } finally {
          NodeFS.rmSync(sandbox, { recursive: true, force: true });
        }
      }),
  );

  it("imports both Claude commands with no arguments without dispatching", () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'await import("./record-claude-agent-sdk-replay-fixture.ts"); await import("./probe-claude-fork-local-rollback-replay.ts");',
      ],
      {
        cwd: import.meta.dirname,
        env: { ...syntheticEnvironment, NODE_OPTIONS: recorderNodeOptions },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects every blank segment in configured Claude prompts", () => {
    for (const prompts of ["\n---\nsecond", "first\n---\n ", "first\n---\n \n---\nthird"]) {
      expect(() =>
        selectClaudeReplayPrompts(["default"], { T3_CLAUDE_REPLAY_PROMPTS: prompts }),
      ).toThrow("T3_CLAUDE_REPLAY_PROMPTS contains a blank prompt");
    }
    expect(
      selectClaudeReplayPrompts(["default"], {
        T3_CLAUDE_REPLAY_PROMPTS: " first \r\n---\r\nsecond ",
      }),
    ).toEqual([" first ", "second "]);
  });

  it.each([
    [parseFx, "T3_FX_BIN", "fx"],
    [parseGrok, "T3_GROK_BIN", "grok"],
  ] as const)("validates %s binary overrides in the argument phase", (parse, name, defaultPath) => {
    expect(() => parse(["--scenario", "simple"], { [name]: " " })).toThrow(
      name + " is set but empty",
    );
    expect(parse(["--scenario", "simple"], { [name]: "custom-bin" }).binaryPath).toBe("custom-bin");
    expect(parse(["--scenario", "simple"]).binaryPath).toBe(defaultPath);
  });

  it.each([
    ["record-fx-acp-replay-fixture.ts", "T3_FX_BIN"],
    ["record-grok-acp-replay-fixture.ts", "T3_GROK_BIN"],
  ])("rejects invalid binary overrides before workspace creation in %s", (script, name) => {
    const result = NodeChildProcess.spawnSync(process.execPath, [script, "--scenario", "simple"], {
      cwd: import.meta.dirname,
      env: { ...syntheticEnvironment, NODE_OPTIONS: recorderNodeOptions, [name]: " " },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name + " is set but empty");
  });
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
