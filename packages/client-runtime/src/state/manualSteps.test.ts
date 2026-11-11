import type { DetectedManualStep, EnvironmentId, ManualStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { combineManualSteps, detectedManualStepText } from "./manualSteps.ts";

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
      { status: "listed", groups: [], count: 0 },
    ],
  ] as const)("shows %j as %j", (sources, view) => {
    expect(combineManualSteps(sources)).toEqual(view);
  });
});

const mac = "mac-env" as EnvironmentId;
const vps = "vps-env" as EnvironmentId;
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

  it("shows a machine reached through two environments once and keeps ThreadPage steps", () => {
    const view = combineManualSteps(
      [{ status: "listed", steps: [step("xcode", "Mac"), step("disk", "Zoro-VPS")] }],
      [
        { status: "listed", environmentId: mac, steps: [detected("a", "Mac")] },
        {
          status: "listed",
          environmentId: vps,
          steps: [detected("a", "Mac"), detected("a", "zoro-vps")],
        },
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
      ["Mac", 1, [mac]],
      ["Zoro-VPS", 1, [vps]],
    ]);
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
