import { assert, describe, it } from "@effect/vitest";
import type { ScheduledTaskRunCheck } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadPageCheckAccess from "../threadPage/ThreadPageCheckAccess.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";

const NEEDS_RUN = "node ~/.agents/skills/polybot-pr-reviewer/ado-pr-review.mjs needs-run";

describe("resolveRunConditionCommand", () => {
  it("gives the same text a working argv on each system", () => {
    for (const [platform, home, script] of [
      [
        "win32",
        "C:\\Users\\me",
        "C:\\Users\\me\\.agents\\skills\\polybot-pr-reviewer\\ado-pr-review.mjs",
      ],
      ["darwin", "/Users/me", "/Users/me/.agents/skills/polybot-pr-reviewer/ado-pr-review.mjs"],
      ["linux", "/home/me", "/home/me/.agents/skills/polybot-pr-reviewer/ado-pr-review.mjs"],
    ] as const) {
      assert.deepEqual(
        RunConditionCheck.resolveRunConditionCommand(NEEDS_RUN, { home, platform }),
        {
          _tag: "command",
          command: "node",
          args: [script, "needs-run"],
        },
      );
    }
  });

  it("expands home in quoted words and refuses what needs a shell", () => {
    const host = { home: "/home/me", platform: "linux" } as const;
    const rows: ReadonlyArray<readonly [string, RunConditionCheck.ResolvedRunConditionCommand]> = [
      [
        `"~/My Scripts/check.sh" ~ $HOME '|' *.md`,
        {
          _tag: "command",
          command: "/home/me/My Scripts/check.sh",
          args: ["/home/me", "$HOME", "|", "*.md"],
        },
      ],
      [`check "open`, { _tag: "error", error: "unclosed_quote" }],
      [`check | grep x`, { _tag: "error", error: "shell_operator" }],
      [`check && next`, { _tag: "error", error: "shell_operator" }],
      [`check > out.txt`, { _tag: "error", error: "shell_operator" }],
      [`check 2>/dev/null`, { _tag: "error", error: "shell_operator" }],
      [`check a|b`, { _tag: "error", error: "shell_operator" }],
      [`check >out.txt`, { _tag: "error", error: "shell_operator" }],
      [`check next;`, { _tag: "error", error: "shell_operator" }],
      [`check "a"|b`, { _tag: "error", error: "shell_operator" }],
      [`check "x">y`, { _tag: "error", error: "shell_operator" }],
      [
        `check "a|b" 'x&y' x">"y`,
        { _tag: "command", command: "check", args: ["a|b", "x&y", "x>y"] },
      ],
      [
        `curl "https://example.com/?a=1&b=2"`,
        { _tag: "command", command: "curl", args: ["https://example.com/?a=1&b=2"] },
      ],
      ["   ", { _tag: "error", error: "empty" }],
    ];
    for (const [text, expected] of rows) {
      assert.deepEqual(RunConditionCheck.resolveRunConditionCommand(text, host), expected, text);
    }
  });
});

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const THREADPAGE_ENV = {
  T3CODE_THREADPAGE_URL: "http://127.0.0.1:43123/api/threadpage",
  T3CODE_THREADPAGE_TOKEN: "check-token",
};

const runCheck = (
  answer: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  options: {
    readonly policy?: Parameters<typeof ManagedPolicy.layerTest>[0];
    readonly timeoutSeconds?: number;
  } = {},
) => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const grant = { issued: 0, live: false, liveDuringRun: [] as boolean[] };
  const layer = RunConditionCheck.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(options.policy),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              grant.liveDuringRun.push(grant.live);
            }).pipe(Effect.andThen(answer)),
        }),
        Layer.mock(ThreadPageCheckAccess.ThreadPageCheckAccess)({
          grant: Effect.acquireRelease(
            Effect.sync(() => {
              grant.issued += 1;
              grant.live = true;
              return THREADPAGE_ENV;
            }),
            () =>
              Effect.sync(() => {
                grant.live = false;
              }),
          ),
        }),
      ),
    ),
  );
  return RunConditionCheck.RunConditionCheck.pipe(
    Effect.flatMap((check) =>
      check.run({
        command: NEEDS_RUN,
        timeoutSeconds: options.timeoutSeconds ?? 30,
        cwd: "/work/project",
      }),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.HomeDirectory, "/Users/me"),
    Effect.provideService(HostProcess.Environment, { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" }),
    Effect.provide(layer),
    Effect.map((result) => ({ result, calls, grant })),
  );
};

describe("RunConditionCheck", () => {
  it.effect("runs the program in the project folder with an agent shell's environment", () =>
    Effect.gen(function* () {
      const { calls } = yield* runCheck(Effect.succeed(output({})), { timeoutSeconds: 45 });
      assert.lengthOf(calls, 1);
      const call = calls[0]!;
      assert.equal(call.command, "node");
      assert.deepEqual(call.args, [
        "/Users/me/.agents/skills/polybot-pr-reviewer/ado-pr-review.mjs",
        "needs-run",
      ]);
      assert.equal(call.cwd, "/work/project");
      assert.deepEqual(call.env, {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: undefined,
        ...THREADPAGE_ENV,
      });
      assert.equal(call.timeoutBehavior, "timedOutResult");
      assert.equal(call.outputMode, "truncate");
      assert.isTrue(Duration.equals(Duration.fromInputUnsafe(call.timeout!), Duration.seconds(45)));
      assert.equal(call.stdin, "");
    }),
  );

  it.effect("maps each way a check ends", () =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<
        readonly [
          Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
          ScheduledTaskRunCheck,
        ]
      > = [
        [
          Effect.succeed(output({ stdout: '{"ok":true,"needsRun":true,"reason":"2 open PRs"}\n' })),
          { outcome: "run", failure: null, exitCode: 0, detail: "2 open PRs" },
        ],
        [
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(10),
              stdout: "checking\n  No open\tpull\u0007 requests  \n\n",
            }),
          ),
          { outcome: "skip", failure: null, exitCode: 10, detail: "No open pull requests" },
        ],
        [
          Effect.succeed(
            output({ code: ChildProcessSpawner.ExitCode(2), stderr: "boom\nauth failed\n" }),
          ),
          { outcome: "failed", failure: "exit_code", exitCode: 2, detail: "auth failed" },
        ],
        [
          Effect.succeed(
            output({
              stdout: `${JSON.stringify({ reason: "2 open PRs", ids: "x".repeat(400) })}\n`,
            }),
          ),
          { outcome: "run", failure: null, exitCode: 0, detail: "2 open PRs" },
        ],
        [
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(1),
              stdout: '{"ok":false,"error":"ADO token expired"}\n',
              stderr: "trace\n",
            }),
          ),
          { outcome: "failed", failure: "exit_code", exitCode: 1, detail: "ADO token expired" },
        ],
        [
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(2),
              stdout: "checking pull requests\n",
              stderr: "auth failed\n",
            }),
          ),
          { outcome: "failed", failure: "exit_code", exitCode: 2, detail: "auth failed" },
        ],
        [
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(10),
              stdout: "No open pull requests\n",
              stderr: "warning: slow API\n",
            }),
          ),
          { outcome: "skip", failure: null, exitCode: 10, detail: "No open pull requests" },
        ],
        [
          Effect.succeed(output({ stderr: "3 open PRs\n" })),
          { outcome: "run", failure: null, exitCode: 0, detail: "3 open PRs" },
        ],
        [
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(10),
              stdout: "a log line cut off at the cap",
              stdoutTruncated: true,
            }),
          ),
          { outcome: "skip", failure: null, exitCode: 10, detail: null },
        ],
        [
          Effect.succeed(output({ code: null, timedOut: true })),
          { outcome: "failed", failure: "timeout", exitCode: null, detail: null },
        ],
        [
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "node",
              argumentCount: 2,
              cause: new Error("spawn node ENOENT"),
            }),
          ),
          {
            outcome: "failed",
            failure: "not_started",
            exitCode: null,
            detail: "spawn node ENOENT",
          },
        ],
      ];
      for (const [answer, expected] of rows) {
        const { result, grant } = yield* runCheck(answer);
        assert.deepEqual(result, expected);
        // The check's ThreadPage token lives exactly as long as its program, however it ends.
        assert.deepEqual(grant.liveDuringRun, [true]);
        assert.isFalse(grant.live);
      }
      const long = yield* runCheck(Effect.succeed(output({ stdout: "x".repeat(400) })));
      assert.lengthOf(long.result.detail ?? "", 300);
    }),
  );

  it.effect("does not run when a policy forbids full access", () =>
    Effect.gen(function* () {
      const { result, calls, grant } = yield* runCheck(Effect.succeed(output({})), {
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      });
      assert.lengthOf(calls, 0);
      assert.equal(grant.issued, 0);
      assert.deepEqual(result, {
        outcome: "failed",
        failure: "policy",
        exitCode: null,
        detail: "Example Corp limits threads to Auto-accept edits.",
      });
    }),
  );
});
