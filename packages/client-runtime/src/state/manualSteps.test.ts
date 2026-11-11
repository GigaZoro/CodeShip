import {
  CommandId,
  EnvironmentId,
  ManualStepReviewError,
  ThreadId,
  type DetectedManualStep,
  type ManualStep,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  beginManualStepStart,
  combineManualSteps,
  detectedManualStepText,
  manualStepChatHost,
  manualStepReviewState,
  manualStepsEnvironmentIdsKey,
  settleManualStepStart,
  type ManualStepStart,
} from "./manualSteps.ts";

const step = (
  threadId: string,
  machine: string,
  fields: Partial<Pick<ManualStep, "kind" | "updatedAt" | "title">> = {},
): ManualStep => ({
  threadId,
  title: fields.title ?? threadId,
  step: `Do ${threadId}`,
  kind: fields.kind ?? "hands-on",
  machine,
  updatedAt: fields.updatedAt ?? "2026-11-07T20:00:00.000Z",
  url: `https://thread.page/app/threads/${threadId}`,
});

describe("combineManualSteps", () => {
  it("merges every machine's list by thread, money first, then the newest", () => {
    const view = combineManualSteps([
      {
        status: "listed",
        steps: [
          step("xcode", "Mac", { updatedAt: "2026-11-07T21:00:00.000Z" }),
          step("minions", "Mac", { updatedAt: "2026-11-07T22:00:00.000Z" }),
          step("tray", "Zoro-PC"),
        ],
      },
      // A second machine reads the same ThreadPage lists, one step updated since.
      {
        status: "listed",
        steps: [
          step("tray", "Zoro-PC", { updatedAt: "2026-11-07T23:00:00.000Z" }),
          step("contabo", "Zoro-VPS", { kind: "needs-you" }),
          step("apt", "Zoro-VPS", { updatedAt: "2026-11-07T23:30:00.000Z" }),
        ],
      },
      { status: "failed", reason: "offline" },
    ]);
    expect(view.status === "listed" ? view.count : null).toBe(5);
    expect(
      view.status === "listed"
        ? view.groups.map((group) => [group.machine, group.steps.map((entry) => entry.threadId)])
        : view,
    ).toEqual([
      ["Zoro-VPS", ["contabo", "apt"]],
      ["Mac", ["minions", "xcode"]],
      ["Zoro-PC", ["tray"]],
    ]);
    expect(view.status === "listed" ? view.groups[2]?.steps[0]?.updatedAt : null).toBe(
      "2026-11-07T23:00:00.000Z",
    );
  });

  it.each([
    [[], { status: "not-connected" }],
    [[{ status: "not-connected" }, { status: "not-connected" }], { status: "not-connected" }],
    [[{ status: "not-connected" }, { status: "loading" }], { status: "loading" }],
    [
      [
        { status: "failed", reason: "offline" },
        { status: "failed", reason: "token-rejected" },
      ],
      { status: "failed", reason: "token-rejected" },
    ],
    [
      [
        { status: "failed", reason: "offline" },
        { status: "listed", steps: [] },
      ],
      { status: "listed", groups: [], count: 0, reviewEnvironmentId: null, chatHosts: [] },
    ],
    [
      // The lowest id reviews every step, whatever order the sources arrive in.
      [
        { status: "listed", steps: [] },
        { status: "listed", steps: [], reviewEnvironmentId: EnvironmentId.make("env-c") },
        { status: "listed", steps: [], reviewEnvironmentId: EnvironmentId.make("env-b") },
      ],
      {
        status: "listed",
        groups: [],
        count: 0,
        reviewEnvironmentId: EnvironmentId.make("env-b"),
        chatHosts: [],
      },
    ],
  ] as const)("shows %j as %j", (sources, view) => {
    expect(combineManualSteps(sources)).toEqual(view);
  });
});

const mac = "mac-env" as EnvironmentId;
const vps = "vps-env" as EnvironmentId;

describe("manualStepChatHost", () => {
  const hosts = [
    { environmentId: mac, machine: "MacBook Pro - Andrii" },
    { environmentId: vps, machine: "zoro-vps" },
  ];
  it.each([
    ["the step's own machine, however its folder spells it", hosts, vps, "MacBook-Pro-Andrii", mac],
    ["the reviewing machine when the step's machine is not connected", hosts, mac, "Zoro-PC", mac],
    ["no machine when the reviewer cannot start chats either", [hosts[1]!], mac, "Zoro-PC", null],
  ])("runs the chat on %s", (_case, chatHosts, reviewEnvironmentId, machine, expected) => {
    expect(
      manualStepChatHost({ chatHosts, reviewEnvironmentId }, machine)?.environmentId ?? null,
    ).toBe(expected);
  });

  it("offers only machines that serve the chat and have a No project folder", () => {
    const config = (label: string, manualStepChats: boolean, scratchWorkspaceRoot?: string) =>
      ({
        environment: { label, capabilities: { manualSteps: true, manualStepChats } },
        ...(scratchWorkspaceRoot === undefined ? {} : { scratchWorkspaceRoot }),
      }) as Parameters<typeof manualStepsEnvironmentIdsKey>[0] extends ReadonlyMap<unknown, infer C>
        ? C
        : never;
    const key = manualStepsEnvironmentIdsKey(
      new Map([
        [mac, config("Mac", true, "/home/scratch")],
        [vps, config("VPS", true)],
        ["old-env" as EnvironmentId, config("Old", false, "/home/scratch")],
      ]),
    );
    expect(JSON.parse(key ?? "{}").chats).toEqual([{ environmentId: mac, machine: "Mac" }]);
  });
});

describe("a manual step's start", () => {
  const keep = { _tag: "Other", text: "Keep the monthly term." } as const;
  const cancel = { _tag: "Other", text: "Cancel it." } as const;
  const first = CommandId.make("first");
  const begin = (
    state: ManualStepStart,
    target: Parameters<typeof beginManualStepStart>[1],
    attemptStarted = false,
  ) => beginManualStepStart(state, target, { attemptStarted, newId: () => "next" });
  const sent = beginManualStepStart(
    { attempt: null, chat: null },
    { environmentId: mac, decision: keep },
    { attemptStarted: false, newId: () => first },
  )!;
  const unanswered = settleManualStepStart(sent, first, null);

  it("sends nothing else while a start is on its way", () => {
    expect(begin(sent, { environmentId: mac, decision: cancel })).toBeNull();
  });

  it.each([
    ["replays the same decision for the same machine", mac, keep, "first"],
    ["starts another chat for a different decision", mac, cancel, "next"],
    ["starts another chat on a different machine", vps, keep, "next"],
  ])("after an unanswered start, %s", (_case, environmentId, decision, commandId) => {
    expect(begin(unanswered, { environmentId, decision })?.attempt).toMatchObject({
      commandId,
      inFlight: true,
    });
  });

  it("keeps a chat the thread list shows and starts another for the next choice", () => {
    expect(begin(unanswered, { environmentId: mac, decision: keep }, true)).toMatchObject({
      chat: { environmentId: mac, threadId: "first" },
      attempt: { commandId: "next" },
    });
  });

  it("ends with the chat of the start that succeeded, and ignores any other command", () => {
    const thread = ThreadId.make("first");
    expect(settleManualStepStart(sent, CommandId.make("other"), thread)).toBe(sent);
    expect(settleManualStepStart(sent, first, thread)).toEqual({
      attempt: null,
      chat: { environmentId: mac, threadId: thread },
    });
  });
});

const detected = (
  id: string,
  machine: string,
  fields: Partial<DetectedManualStep> = {},
): DetectedManualStep =>
  ({
    id,
    kind: "signed-out",
    machine,
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    ...fields,
  }) as DetectedManualStep;

describe("combineManualSteps with detected steps", () => {
  it("lists a machine's own findings with no ThreadPage token, most urgent first", () => {
    const view = combineManualSteps(
      [{ status: "not-connected" }],
      [
        {
          status: "listed",
          environmentId: mac,
          steps: [
            detected("mcp", "Mac", { kind: "mcp-needs-auth", serverName: "minions" }),
            detected("soon", "Mac", { kind: "login-expiring" }),
            detected("gone", "Mac", { kind: "login-expired" }),
          ],
        },
        { status: "failed" },
      ],
    );
    expect(view.status === "listed" ? view.count : null).toBe(3);
    expect(
      view.status === "listed"
        ? view.groups.map((group) => [group.machine, group.detected.map((entry) => entry.step.id)])
        : view,
    ).toEqual([["Mac", ["gone", "soon", "mcp"]]]);
  });

  it("keeps ThreadPage steps and groups findings by machine label, whatever its spelling", () => {
    const view = combineManualSteps(
      [
        {
          status: "listed",
          steps: [step("xcode", "MacBook-Pro-Andrii"), step("disk", "Zoro-VPS")],
        },
      ],
      [
        { status: "listed", environmentId: mac, steps: [detected("a", "MacBook Pro - Andrii")] },
        { status: "listed", environmentId: vps, steps: [detected("a", "zoro-vps")] },
      ],
    );
    expect(view.status === "listed" ? view.count : null).toBe(4);
    expect(
      view.status === "listed"
        ? view.groups.map((group) => [
            group.machine,
            group.steps.length,
            group.detected.map((entry) => entry.environmentId),
          ])
        : view,
    ).toEqual([
      ["MacBook-Pro-Andrii", 1, [mac]],
      ["Zoro-VPS", 1, [vps]],
    ]);
  });

  it("keeps the same step from two servers that share a label, and merges one server's repeats", () => {
    const dev = "mac-dev-env" as EnvironmentId;
    const view = combineManualSteps(
      [{ status: "not-connected" }],
      [
        { status: "listed", environmentId: mac, steps: [detected("a", "Mac")] },
        { status: "listed", environmentId: dev, steps: [detected("a", "Mac")] },
        { status: "listed", environmentId: mac, steps: [detected("a", "Mac")] },
      ],
    );
    expect(
      view.status === "listed"
        ? view.groups.map((group) => group.detected.map((entry) => entry.environmentId))
        : view,
    ).toEqual([[mac, dev]]);
    expect(view.status === "listed" ? view.count : null).toBe(2);
  });

  it("names a ThreadPage failure beside findings, and fails alone only with nothing else", () => {
    const failed = { status: "failed", reason: "token-rejected" } as const;
    const withFinding = combineManualSteps(
      [failed],
      [{ status: "listed", environmentId: mac, steps: [detected("a", "Mac")] }],
    );
    expect(withFinding.status === "listed" ? withFinding.threadPageIssue : null).toBe(
      "token-rejected",
    );
    expect(
      combineManualSteps([failed], [{ status: "listed", environmentId: mac, steps: [] }]),
    ).toEqual(failed);
    expect(combineManualSteps([{ status: "not-connected" }], [{ status: "loading" }])).toEqual({
      status: "loading",
    });
  });
});

describe("detectedManualStepText", () => {
  const helpers = { driverLabel: "Claude", formatDate: (iso: string) => iso.slice(0, 10) };
  it.each([
    [
      detected("a", "Mac", { accountName: "Vitalii" as never }),
      "Sign in to Claude · Vitalii",
      "Signed out",
    ],
    [
      detected("b", "Mac", {
        kind: "login-expiring",
        expiresAt: "2026-11-29T13:38:18.531Z" as never,
      }),
      "Sign in to Claude again",
      "Login ends 2026-11-29",
    ],
    [detected("c", "Mac", { kind: "login-expired" }), "Sign in to Claude again", "Login expired"],
    [
      detected("d", "Mac", {
        kind: "mcp-needs-auth",
        accountName: "claude" as never,
        serverName: "threadpage" as never,
      }),
      "Sign in to threadpage for Claude",
      "MCP server needs sign-in",
    ],
  ])("words %#", (input, stepText, detail) => {
    expect(detectedManualStepText(input, helpers)).toEqual({ step: stepText, detail });
  });
});

describe("manualStepReviewState", () => {
  it("reads a failed review's reason, and any other failure as offline", () => {
    const failure = (error: unknown) =>
      manualStepReviewState(AsyncResult.fromExit(Exit.fail(error)));
    expect(
      failure(new ManualStepReviewError({ reason: "generation-failed", detail: "bad" })),
    ).toEqual({ status: "failed", reason: "generation-failed" });
    expect(failure(new Error("socket closed"))).toEqual({ status: "failed", reason: "offline" });
  });
});
