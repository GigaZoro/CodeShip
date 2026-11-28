import { describe, expect, it } from "@effect/vitest";

import { ProjectId, RunId, ThreadId } from "@t3tools/contracts/baseSchemas";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as DateTime from "effect/DateTime";

import {
  analyzeThread,
  commandPhase,
  normalizeCommand,
  type AnalysisItem,
  type AnalysisMessage,
  type AnalysisRequest,
  type AnalysisRun,
  type AnalysisSubagent,
  type AnalysisThread,
  type AnalysisTurn,
  type ThreadAnalysisInput,
} from "./ThreadAnalyzer.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(T0 + minutes * MINUTE));
const ms = (minutes: number) => minutes * MINUTE;

const thread = (overrides: Partial<AnalysisThread> = {}): AnalysisThread => ({
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Chat",
  providerInstanceId: ProviderInstanceId.make("claude_test"),
  model: "m-main",
  createdAt: at(0),
  settledAt: at(60),
  createdBy: "user",
  delegated: false,
  ...overrides,
});

const run = (
  ordinal: number,
  requestedMin: number,
  startedMin: number,
  completedMin: number,
  overrides: Partial<AnalysisRun> = {},
): AnalysisRun => ({
  runId: RunId.make(`run-${ordinal}`),
  ordinal,
  status: "completed",
  requestedAt: at(requestedMin),
  startedAt: at(startedMin),
  completedAt: at(completedMin),
  userMessageId: `msg-${ordinal}`,
  model: null,
  automaticContinuation: false,
  restartContinuation: false,
  ...overrides,
});

const message = (ordinal: number, overrides: Partial<AnalysisMessage> = {}): AnalysisMessage => ({
  messageId: `msg-${ordinal}`,
  createdBy: "user",
  scheduled: false,
  fromThread: false,
  delegatedTaskIds: null,
  text: `prompt ${ordinal}`,
  ...overrides,
});

const item = (overrides: Partial<AnalysisItem> & Pick<AnalysisItem, "type">): AnalysisItem => ({
  runId: "run-1",
  status: "completed",
  startedAt: null,
  completedAt: null,
  updatedAt: at(0),
  command: null,
  exitCode: null,
  outputIndicatesFailure: false,
  monitor: false,
  failureClass: null,
  fileName: null,
  toModel: null,
  ...overrides,
});

const command = (
  text: string,
  startMin: number,
  durationMin: number,
  exitCode: number,
  overrides: Partial<AnalysisItem> = {},
): AnalysisItem =>
  item({
    type: "command_execution",
    command: text,
    startedAt: at(startMin),
    completedAt: at(startMin + durationMin),
    exitCode,
    ...overrides,
  });

const request = (kind: string, createdMin: number, resolvedMin: number): AnalysisRequest => ({
  kind,
  createdAt: at(createdMin),
  resolvedAt: at(resolvedMin),
});

const subagent = (overrides: Partial<AnalysisSubagent> = {}): AnalysisSubagent => ({
  id: "sub-1",
  origin: "app_owned",
  childThreadId: null,
  remote: false,
  command: null,
  title: null,
  prompt: "do it",
  model: null,
  status: "completed",
  startedAt: at(25),
  completedAt: at(35),
  updatedAt: at(35),
  workflow: null,
  ...overrides,
});

const turn = (overrides: Partial<AnalysisTurn> = {}): AnalysisTurn => ({
  runId: "run-1",
  usage: null,
  contextUsedTokens: null,
  contextMaxTokens: null,
  costUsd: null,
  ...overrides,
});

const input = (overrides: Partial<ThreadAnalysisInput> = {}): ThreadAnalysisInput => ({
  thread: thread(),
  runs: [],
  attempts: [],
  messages: [],
  turns: [],
  items: [],
  requests: [],
  subagents: [],
  reopens: 0,
  ...overrides,
});

describe("analyzeThread", () => {
  it("partitions lifetime into time buckets, counts runs and orders findings", () => {
    const detail = analyzeThread(
      input({
        runs: [
          run(1, 0, 1, 11),
          run(2, 20, 22, 30, { status: "failed" }),
          run(3, 40, 40, 45, { automaticContinuation: true }),
        ],
        messages: [message(1), message(2), message(3, { createdBy: "system" })],
        items: [
          command("vp test run src/foo.test.ts", 2, 3, 0),
          item({ type: "dynamic_tool", startedAt: at(9), completedAt: at(10) }),
          item({
            type: "error",
            runId: "run-2",
            failureClass: "usage_limit",
            startedAt: at(30),
            completedAt: at(30),
          }),
        ],
        requests: [request("command", 6, 8)],
        subagents: [subagent({ childThreadId: ThreadId.make("child-1"), model: "gpt-x" })],
      }),
    );
    const { summary } = detail;

    expect(summary.time).toEqual({
      queuedMs: ms(3),
      agentMs: ms(17),
      commandMs: ms(3),
      approvalMs: ms(2),
      toolMs: ms(1),
      userResponseMs: ms(9),
      usageLimitMs: ms(10),
      settleTailMs: ms(15),
      delegateWaitMs: 0,
      idleMs: 0,
    });
    expect(Object.values(summary.time).reduce((sum, value) => sum + value, 0)).toBe(
      summary.lifetimeMs,
    );
    expect(summary.lifetimeMs).toBe(ms(60));
    // Every read of a period dates a chat by its settle stamp, also one before its creation.
    const stampedEarly = analyzeThread(input({ thread: thread({ settledAt: at(-5) }) })).summary;
    expect([stampedEarly.settledAt, stampedEarly.lifetimeMs]).toEqual([at(-5), 0]);
    expect(summary.activeMs).toBe(ms(23));
    expect(summary.runs).toMatchObject({
      total: 3,
      completed: 2,
      failed: 1,
      userPrompts: 2,
      automatic: 1,
      retries: 0,
    });
    expect(summary.errors).toEqual({ usage_limit: 1 });
    expect(summary.kind).toBe("interactive");
    expect(summary.helpers.delegates).toBe(1);
    expect(summary.helperModels).toEqual(["gpt-x"]);

    expect(detail.lanes[0]?.kind).toBe("chat");
    expect(detail.lanes[0]?.segments).toHaveLength(3);
    expect(detail.lanes[1]?.kind).toBe("delegate");

    expect(
      summary.findings.map(({ code, severity, wastedMs, count }) => ({
        code,
        severity,
        wastedMs,
        count,
      })),
    ).toEqual([
      { code: "usage_limit", severity: "medium", wastedMs: ms(10), count: 1 },
      { code: "run_failures", severity: "medium", wastedMs: ms(8), count: 1 },
      { code: "long_queue", severity: "low", wastedMs: ms(3), count: 2 },
      { code: "approval_wait", severity: "low", wastedMs: ms(2), count: 1 },
    ]);

    expect(detail.steps).toHaveLength(3);
    expect(detail.steps[1]).toMatchObject({
      source: "user",
      queuedMs: ms(2),
      durationMs: ms(8),
    });
    expect(detail.steps[2]?.source).toBe("automatic");
  });

  it("groups commands, excludes monitors and flags repeats, failures and slow commands", () => {
    const tests = Array.from({ length: 5 }, (_, index) =>
      command("vp test run x.test.ts", 1 + index * 3, 3, index < 3 ? 1 : 0),
    );
    const searches = Array.from({ length: 4 }, (_, index) =>
      command("rg foo src", 20 + index, 1, 1),
    );
    const detail = analyzeThread(
      input({
        thread: thread({ settledAt: at(120) }),
        runs: [run(1, 0, 0, 110)],
        messages: [message(1)],
        items: [
          ...tests,
          ...searches,
          command("vp run build", 30, 12, 0),
          command("tail -f log", 0, 110, 0, { monitor: true }),
        ],
      }),
    );
    const { summary } = detail;

    expect(summary.commands).toMatchObject({ count: 10, failed: 7 });
    const byCode = (code: string) => summary.findings.find((finding) => finding.code === code);
    expect(byCode("repeated_command")).toMatchObject({
      count: 5,
      wastedMs: ms(12),
      severity: "medium",
      detail: "vp test run x.test.ts",
    });
    expect(byCode("failing_commands")).toMatchObject({
      count: 3,
      wastedMs: ms(9),
      severity: "low",
    });
    expect(byCode("slow_command")).toMatchObject({
      count: 1,
      wastedMs: ms(12),
      severity: "medium",
      detail: "vp run build",
    });
    expect(summary.findings.some((finding) => finding.detail === "rg foo src")).toBe(false);

    expect(summary.phases).toContainEqual({
      phase: "test",
      count: 5,
      failed: 3,
      durationMs: ms(15),
    });
    expect(summary.phases).toContainEqual(
      expect.objectContaining({ phase: "inspect", count: 4, failed: 4 }),
    );
    expect(summary.phases).toContainEqual(expect.objectContaining({ phase: "build", count: 1 }));
    const durations = summary.phases.map((phase) => phase.durationMs);
    expect(durations).toEqual(durations.toSorted((left, right) => right - left));

    expect(detail.slowestCommands[0]?.command).toBe("vp run build");
    const repeated = detail.repeatedCommands.map((group) => group.command);
    expect(repeated).toContain("vp test run x.test.ts");
    expect(repeated).toContain("rg foo src");
  });

  it("counts t3_command_run commands like turn commands without changing the time partition", () => {
    const commandAgent = (
      id: string,
      startMin: number,
      durationMin: number,
      status = "completed",
    ) =>
      subagent({
        id,
        command: "cd /repo && vp test run a.test.ts",
        status,
        startedAt: at(startMin),
        completedAt: at(startMin + durationMin),
        updatedAt: at(startMin + durationMin),
      });
    const detail = analyzeThread(
      input({
        runs: [run(1, 0, 0, 1), run(2, 32, 32, 33)],
        messages: [
          message(1),
          // The wake leads with task ids for the agent; the step names the commands instead.
          message(2, {
            createdBy: "agent",
            delegatedTaskIds: ["c3", "c4"],
            text: "Command c3 [failed]: ...",
          }),
        ],
        subagents: [
          commandAgent("c1", 1, 12, "failed"),
          commandAgent("c2", 20, 2, "failed"),
          commandAgent("c3", 25, 2, "failed"),
          commandAgent("c4", 30, 2),
        ],
      }),
    );
    const { summary } = detail;

    expect(summary.helpers.commands).toBe(4);
    expect(detail.steps[1]).toMatchObject({
      source: "helpers",
      prompt: "vp test run a.test.ts",
    });
    expect(detail.lanes.filter((lane) => lane.kind === "command")).toHaveLength(4);
    expect(summary.commands).toEqual({ count: 4, failed: 3, durationMs: ms(18) });
    expect(summary.phases).toEqual([{ phase: "test", count: 4, failed: 3, durationMs: ms(18) }]);
    expect(detail.slowestCommands[0]).toMatchObject({
      command: "vp test run a.test.ts",
      durationMs: ms(12),
      exitCode: null,
      failed: true,
    });
    expect(detail.repeatedCommands).toEqual([
      { command: "vp test run a.test.ts", phase: "test", count: 4, failed: 3, durationMs: ms(18) },
    ]);
    expect(
      summary.findings.map(({ code, count, wastedMs }) => ({ code, count, wastedMs })),
    ).toEqual(
      expect.arrayContaining([
        { code: "slow_command", count: 1, wastedMs: ms(12) },
        { code: "repeated_command", count: 4, wastedMs: ms(6) },
        { code: "failing_commands", count: 3, wastedMs: ms(16) },
      ]),
    );
    expect(summary.time.commandMs).toBe(0);
    expect(Object.values(summary.time).reduce((sum, value) => sum + value, 0)).toBe(
      summary.lifetimeMs,
    );
  });

  it("wastes the time of every execution after the first and groups by the full command", () => {
    const test = "vp test run y.test.ts";
    const repeats = analyzeThread(
      input({
        items: [
          command(test, 20, 1, 0),
          command(test, 0, 10, 0),
          command(test, 30, 1, 0),
          command(test, 40, 1, 0),
        ],
      }),
    );
    expect(repeats.summary.findings).toContainEqual(
      expect.objectContaining({ code: "repeated_command", count: 4, wastedMs: ms(3) }),
    );

    const long = (suffix: string) => `vp test run ${"a".repeat(250)} ${suffix}`;
    const groups = analyzeThread(
      input({
        items: [
          command(long("one"), 0, 1, 0),
          command(long("two"), 5, 1, 0),
          command(long("one"), 10, 1, 0),
          command(long("two"), 15, 1, 0),
        ],
      }),
    );
    expect(groups.repeatedCommands.map((group) => group.count)).toEqual([2, 2]);
    expect(groups.repeatedCommands[0]?.command).toHaveLength(200);
  });

  it("caps lanes, segments, markers, steps and command lists and counts what it left out", () => {
    const runCount = 700;
    const helperCount = 350;
    const longRun = (index: number) => index % 2 === 1;
    const detail = analyzeThread(
      input({
        thread: thread({ settledAt: at(2200) }),
        runs: Array.from({ length: runCount }, (_, index) =>
          run(index + 1, index * 3, index * 3, index * 3 + (longRun(index) ? 2 : 1)),
        ),
        messages: Array.from({ length: runCount }, (_, index) => message(index + 1)),
        items: [
          ...Array.from({ length: 10 }, (_, index) =>
            item({
              type: "error",
              runId: "run-1",
              failureClass: "boom",
              startedAt: at(index * 100),
              completedAt: at(index * 100),
            }),
          ),
          ...Array.from({ length: 20 }, (_, index) => [
            command(`vp test run f${index}.test.ts`, index * 4, 1, 0),
            command(`vp test run f${index}.test.ts`, index * 4 + 2, 1, 0),
          ]).flat(),
        ],
        subagents: Array.from({ length: helperCount }, (_, index) =>
          subagent({
            id: `sub-${String(index).padStart(3, "0")}`,
            startedAt: at(index),
            completedAt: at(index + (longRun(index) ? 2 : 1)),
          }),
        ),
      }),
    );

    expect(detail.steps).toHaveLength(500);
    expect(detail.omitted).toEqual({ lanes: 50, markers: 210, steps: 200 });
    expect(detail.steps.filter((step) => step.durationMs === ms(2))).toHaveLength(350);
    expect(detail.steps.map((step) => step.requestedAt)).toEqual(
      detail.steps.map((step) => step.requestedAt).toSorted(),
    );
    expect(detail.markers).toHaveLength(500);
    expect(detail.markers.filter((marker) => marker.kind === "failure")).toHaveLength(10);
    expect(detail.markers.map((marker) => marker.at)).toEqual(
      detail.markers.map((marker) => marker.at).toSorted(),
    );
    expect(detail.lanes).toHaveLength(301);
    expect(detail.lanes[0]).toMatchObject({ id: "chat", omittedSegments: 300 });
    expect(detail.lanes[0]?.segments).toHaveLength(400);
    expect(detail.lanes[0]?.segments.map((segment) => segment.startedAt)).toEqual(
      detail.lanes[0]?.segments.map((segment) => segment.startedAt).toSorted(),
    );
    const helperIds = detail.lanes.slice(1).map((lane) => lane.id);
    expect(helperIds).toEqual(helperIds.toSorted());
    expect(detail.lanes.slice(1).every((lane) => lane.omittedSegments === 0)).toBe(true);
    expect(detail.slowestCommands).toHaveLength(15);
    expect(detail.repeatedCommands).toHaveLength(15);
  });

  it("sums tokens and cost, skips local commands and reports cache and context findings", () => {
    const detail = analyzeThread(
      input({
        runs: [run(1, 0, 1, 11)],
        messages: [message(1)],
        turns: [
          turn({
            usage: {
              usageStatus: "complete",
              inputTokens: 1_000_000,
              cachedInputTokens: 200_000,
              outputTokens: 1_000,
            },
            costUsd: 2,
            contextUsedTokens: 190_000,
            contextMaxTokens: 200_000,
          }),
          turn(),
          turn({
            usage: {
              usageStatus: "complete",
              inputTokens: 50,
              outputTokens: 5,
              localCommand: true,
            },
          }),
        ],
      }),
    );
    const { summary } = detail;

    expect(summary.tokens).toMatchObject({
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 1_000,
    });
    expect(summary.costUsd).toBe(2);
    expect(summary.unpricedTurns).toBe(1);
    expect(summary.peakContextRatio).toBe(0.95);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({ code: "low_cache_reuse", severity: "high", detail: "20" }),
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        code: "context_pressure",
        severity: "low",
        detail: "95",
        count: 0,
      }),
    );
    expect(detail.steps[0]).toMatchObject({ outputTokens: 1_000, costUsd: 2 });

    // A turn reports its context after compacting, so the low peak must not stand for the chat.
    const compacted = analyzeThread(
      input({
        runs: [run(1, 0, 1, 11)],
        messages: [message(1)],
        items: [
          item({ type: "compaction", updatedAt: at(3) }),
          item({ type: "compaction", updatedAt: at(6) }),
        ],
        turns: [turn({ contextUsedTokens: 20_000, contextMaxTokens: 200_000 })],
      }),
    );
    expect(
      compacted.summary.findings.filter((finding) => finding.code.startsWith("context_")),
    ).toEqual([
      expect.objectContaining({
        code: "context_compacted",
        severity: "medium",
        count: 2,
        detail: null,
      }),
    ]);
  });

  it("classifies thread kind, shortens prompts, marks reopening and builds workflow lanes", () => {
    const kindOf = (
      threadOverrides: Partial<AnalysisThread>,
      messageOverrides: Partial<AnalysisMessage> = {},
    ) =>
      analyzeThread(
        input({
          thread: thread(threadOverrides),
          runs: [run(1, 0, 1, 11)],
          messages: [message(1, messageOverrides)],
        }),
      ).summary.kind;

    expect(kindOf({}, { scheduled: true })).toBe("scheduled");
    expect(kindOf({ delegated: true }, { scheduled: true })).toBe("delegated");
    expect(kindOf({ createdBy: "agent" })).toBe("agent");

    const long = analyzeThread(
      input({
        runs: [run(1, 0, 1, 11), run(2, 20, 21, 30)],
        messages: [
          message(1, { text: "alpha   beta\n".repeat(30) }),
          message(2, { text: "a   b\n c" }),
        ],
      }),
    );
    expect(long.steps[0]?.prompt).toBe("alpha beta ".repeat(30).trim().slice(0, 159) + "…");
    expect(long.steps[0]?.prompt).toHaveLength(160);
    expect(long.steps[1]?.prompt).toBe("a b c");

    const reopened = analyzeThread(
      input({ reopens: 2, runs: [run(1, 0, 1, 11)], messages: [message(1)] }),
    );
    expect(reopened.summary.reopens).toBe(2);
    expect(reopened.summary.findings).toContainEqual(
      expect.objectContaining({ code: "reopened", count: 2 }),
    );

    const agentAt = (startMin: number, endMin: number) => ({
      startedAt: T0 + startMin * MINUTE,
      completedAt: T0 + endMin * MINUTE,
    });
    const workflow = analyzeThread(
      input({
        runs: [run(1, 0, 1, 11)],
        messages: [message(1)],
        subagents: [
          subagent({
            origin: "provider_native",
            workflow: {
              totalTokens: 500,
              agents: [
                {
                  label: "a",
                  model: "haiku",
                  state: "completed",
                  totalTokens: 200,
                  ...agentAt(26, 30),
                },
                {
                  label: "b",
                  model: "opus",
                  state: "failed",
                  totalTokens: 100,
                  ...agentAt(27, 31),
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(workflow.summary.helpers.workflows).toBe(1);
    expect(workflow.summary.helperModels).toEqual(expect.arrayContaining(["haiku", "opus"]));
    expect(workflow.lanes.map((lane) => lane.kind)).toEqual([
      "chat",
      "workflow",
      "subagent",
      "subagent",
    ]);
    expect(workflow.lanes[1]?.tokens).toBe(500);
    expect(workflow.lanes[2]).toMatchObject({ label: "a", model: "haiku" });
    expect(workflow.lanes[2]?.segments[0]?.status).toBe("completed");
    expect(workflow.lanes[3]?.segments[0]?.status).toBe("failed");
  });
});

describe("commandPhase and normalizeCommand", () => {
  it.each([
    [`/bin/zsh -lc "cd /repo && FOO=1 vp test run a.test.ts"`, "vp test run a.test.ts"],
    [`H="/a b/x.mjs"; S=/tmp/s; node "$H" toolchain`, `node "$H" toolchain`],
    [`export PATH="/a b/bin:$PATH"\nnpm run validate:docs`, "npm run validate:docs"],
    ["cd /repo\nvp test run a.test.ts", "vp test run a.test.ts"],
    [`"/a b/bin/node" script.mjs`, "node script.mjs"],
    [`node "/a b/v1/x.mjs" verify --log /tmp/s/out.log`, "node x.mjs verify --log out.log"],
    ["/private/tmp/scratch/probe.sh --fast", "probe.sh --fast"],
    // Commands are stored capped in length, so the wrapper's closing quote may be gone.
    ["/bin/zsh -lc 'git status && vp run bu", "git status && vp run bu"],
    [
      `/bin/zsh -lc "git -c safe.directory=\\"/a b\\" status"`,
      `git -c safe.directory="/a b" status`,
    ],
    [`/bin/zsh -lc 'echo '\\''hi'\\'' && vp fmt'`, `echo 'hi' && vp fmt`],
  ] as const)("normalizes %j to %j", (text, normalized) => {
    expect(normalizeCommand(text)).toBe(normalized);
  });

  it.each([
    ["git push origin HEAD", "ship"],
    ["node .github/scripts/landing-turn.cjs land", "ship"],
    ["vp i", "install"],
    ["npm ci", "install"],
    ["vp run check:changed", "test"],
    ["vp run typecheck", "typecheck"],
    ["vp lint src", "lint"],
    ["vp fmt", "format"],
    ["vp run build", "build"],
    ["git status", "git"],
    ["gh pr view 12", "git"],
    ["rg foo src", "inspect"],
    ["cat package.json | grep build", "inspect"],
    ["cat a && vp run build", "build"],
    ["node scripts/x.ts", "run"],
    ["git diff -- build.ts", "git"],
    ['echo "git push"', "other"],
    ["yarn build", "build"],
    ["yarn test", "test"],
    ["yarn lint", "lint"],
    ["yarn install", "install"],
    ["pnpm run test:unit", "test"],
    ["pnpm exec tsc --noEmit", "typecheck"],
    ["FOO=1 npx vitest run a.test.ts", "test"],
    ["cd app && git push origin main", "ship"],
    ["gh pr merge 12 --squash", "ship"],
    ["go test ./...", "test"],
    ["biome format .", "format"],
    ["sed -n 1,5p a.ts", "inspect"],
    ["git status && yarn build", "build"],
    ["git -C ../repo push origin HEAD:main", "ship"],
    ["cd /repo\nvp test run a.test.ts", "test"],
    ["pnpm \\\n  build", "build"],
    ["cat > a.sh <<'EOF'\ngit push\nEOF", "inspect"],
    ["make", "build"],
    ["./do-thing", "other"],
    ["/bin/zsh -lc 'git status", "git"],
    ["python3 - <<'PY'\nimport os\ngit push", "run"],
    ["node -e 'require(1); git push", "run"],
    [`S=/tmp/s; "/a b/bin/node" "/a b/x.mjs" verify > $S/o.json; cat $S/o.json`, "run"],
    [`/bin/zsh -lc "git -c safe.directory=\\"/a b\\" push origin HEAD"`, "ship"],
  ] as const)("classifies %s as %s", (text, phase) => {
    expect(commandPhase(text)).toBe(phase);
  });
});
