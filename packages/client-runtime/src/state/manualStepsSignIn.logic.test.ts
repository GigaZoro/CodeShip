import type { DetectedManualStep, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { detectedManualStepKey, type DetectedManualStepEntry } from "./manualSteps.ts";
import {
  currentSignIn,
  mcpSignInProgress,
  outcomeOfProgress,
  planSignIns,
  providerSignInProgress,
  providerSignInUnsupportedOnPhone,
  recordSignInOutcome,
  startSignInSession,
  summarizeSignIns,
  type SignInSession,
} from "./manualStepsSignIn.logic.ts";

const environmentId = "environment-mac" as EnvironmentId;

const entry = (
  kind: DetectedManualStep["kind"],
  instanceId: string,
  serverName?: string,
  inEnvironment: EnvironmentId = environmentId,
): DetectedManualStepEntry =>
  ({
    environmentId: inEnvironment,
    step: {
      id: [kind, instanceId, serverName ?? ""].join(":"),
      kind,
      machine: "Mac",
      instanceId,
      driver: "claudeAgent",
      ...(serverName ? { serverName } : {}),
    },
  }) as DetectedManualStepEntry;

const keys = (session: SignInSession) => session.steps.map((step) => step.key);
const keyOf = detectedManualStepKey;

// Three Claude accounts, two with ThreadPage and minions; one account signed out, one lapsed.
const sixSteps = [
  entry("mcp-needs-auth", "claude_b", "minions"),
  entry("mcp-needs-auth", "claude_a", "threadpage"),
  entry("login-expiring", "claude_c"),
  entry("mcp-needs-auth", "claude_a", "minions"),
  entry("signed-out", "claude_b"),
  entry("login-expired", "claude_a"),
];

describe("planSignIns", () => {
  it("walks expired login, signed out, ending soon, then MCP", () => {
    const kinds = planSignIns(sixSteps).map((step) => step.entry.step.kind);
    expect(kinds).toEqual([
      "login-expired",
      "signed-out",
      "login-expiring",
      "mcp-needs-auth",
      "mcp-needs-auth",
      "mcp-needs-auth",
    ]);
  });

  it("puts an account before its own MCP servers whatever order they arrive in", () => {
    const plan = planSignIns(sixSteps);
    for (const step of plan.filter((candidate) => candidate.accountKey !== null)) {
      const account = plan.findIndex((candidate) => candidate.key === step.accountKey);
      expect(account).toBeGreaterThanOrEqual(0);
      expect(account).toBeLessThan(plan.indexOf(step));
    }
  });

  it("links an MCP server to its own account only", () => {
    const plan = planSignIns(sixSteps);
    const minionsOfB = plan.find((step) => step.entry.step.serverName === "minions");
    expect(plan.find((step) => step.key === minionsOfB?.accountKey)?.entry.step.instanceId).toBe(
      minionsOfB?.entry.step.instanceId,
    );
  });

  it("does not link an MCP server to a same-named account on another machine", () => {
    const plan = planSignIns([
      entry("signed-out", "claude", undefined, "environment-vps" as EnvironmentId),
      entry("mcp-needs-auth", "claude", "threadpage"),
    ]);
    expect(plan.find((step) => step.entry.step.kind === "mcp-needs-auth")?.accountKey).toBeNull();
  });

  it("leaves an MCP server without a step for its account unblocked", () => {
    expect(planSignIns([entry("mcp-needs-auth", "claude", "minions")])[0]?.accountKey).toBeNull();
  });

  it("lists a step once", () => {
    expect(planSignIns([sixSteps[0]!, sixSteps[0]!])).toHaveLength(1);
  });
});

describe("a guided walk", () => {
  const signedIn = { status: "signed-in" } as const;
  const failed = { status: "failed", reason: "failed", message: "Denied" } as const;

  it("advances through the steps in order and reports its position", () => {
    let session = startSignInSession(sixSteps);
    const seen: Array<[number, number]> = [];
    for (let current = currentSignIn(session); current; current = currentSignIn(session)) {
      seen.push([current.position, current.total]);
      session = recordSignInOutcome(session, current.step.key, signedIn);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6].map((position) => [position, 6]));
  });

  it("marks the final step as last", () => {
    const session = startSignInSession([sixSteps[2]!, sixSteps[4]!]);
    expect(currentSignIn(session)?.last).toBe(false);
    const next = recordSignInOutcome(session, keys(session)[0]!, signedIn);
    expect(currentSignIn(next)?.last).toBe(true);
  });

  it("skips an account's MCP servers when its account sign-in failed, and says why", () => {
    let session = startSignInSession(sixSteps);
    session = recordSignInOutcome(session, keyOf(entry("login-expired", "claude_a")), failed);
    expect(session.outcomes[keyOf(entry("mcp-needs-auth", "claude_a", "threadpage"))]).toEqual({
      status: "skipped",
      reason: "account-failed",
    });
    expect(session.outcomes[keyOf(entry("mcp-needs-auth", "claude_a", "minions"))]).toEqual({
      status: "skipped",
      reason: "account-failed",
    });
  });

  it("still asks for the MCP servers of an account that signed in", () => {
    let session = startSignInSession(sixSteps);
    session = recordSignInOutcome(session, keyOf(entry("login-expired", "claude_a")), failed);
    session = recordSignInOutcome(session, keyOf(entry("signed-out", "claude_b")), signedIn);
    const remaining = keys(session).filter((key) => session.outcomes[key] === undefined);
    expect(remaining).toEqual([
      keyOf(entry("login-expiring", "claude_c")),
      keyOf(entry("mcp-needs-auth", "claude_b", "minions")),
    ]);
  });

  it("skips only the MCP servers of the account that failed", () => {
    const session = recordSignInOutcome(
      startSignInSession(sixSteps),
      keyOf(entry("signed-out", "claude_b")),
      failed,
    );
    expect(session.outcomes[keyOf(entry("mcp-needs-auth", "claude_a", "minions"))]).toBeUndefined();
    expect(session.outcomes[keyOf(entry("mcp-needs-auth", "claude_b", "minions"))]).toEqual({
      status: "skipped",
      reason: "account-failed",
    });
  });

  it("skips MCP servers of an account the user left signed out", () => {
    const session = recordSignInOutcome(
      startSignInSession(sixSteps),
      keyOf(entry("signed-out", "claude_b")),
      { status: "skipped", reason: "user" },
    );
    expect(session.outcomes[keyOf(entry("mcp-needs-auth", "claude_b", "minions"))]).toEqual({
      status: "skipped",
      reason: "account-skipped",
    });
  });

  it("keeps asking for the MCP servers of an account whose login merely ends soon", () => {
    const steps = [entry("login-expiring", "claude_c"), entry("mcp-needs-auth", "claude_c", "x")];
    const session = recordSignInOutcome(startSignInSession(steps), keyOf(steps[0]!), {
      status: "skipped",
      reason: "user",
    });
    expect(currentSignIn(session)?.step.entry.step.serverName).toBe("x");
  });

  it("keeps the first outcome of a step and ignores unknown steps", () => {
    const first = recordSignInOutcome(
      startSignInSession(sixSteps),
      keys(startSignInSession(sixSteps))[0]!,
      signedIn,
    );
    const key = keys(first)[0]!;
    expect(recordSignInOutcome(first, key, failed)).toBe(first);
    expect(recordSignInOutcome(first, "nowhere:else", failed)).toBe(first);
  });

  it("ends when every step has an outcome", () => {
    let session = startSignInSession([sixSteps[2]!]);
    session = recordSignInOutcome(session, keys(session)[0]!, signedIn);
    expect(currentSignIn(session)).toBeNull();
  });
});

describe("summarizeSignIns", () => {
  it("lists what signed in apart from everything still pending", () => {
    let session = startSignInSession(sixSteps);
    session = recordSignInOutcome(session, keyOf(entry("login-expired", "claude_a")), {
      status: "failed",
      reason: "failed",
      message: null,
    });
    session = recordSignInOutcome(session, keyOf(entry("signed-out", "claude_b")), {
      status: "signed-in",
    });
    session = recordSignInOutcome(session, keyOf(entry("login-expiring", "claude_c")), {
      status: "skipped",
      reason: "user",
    });
    const summary = summarizeSignIns(session);
    expect(summary.signedIn.map((step) => step.key)).toEqual([
      keyOf(entry("signed-out", "claude_b")),
    ]);
    expect(summary.pending.map(({ step, outcome }) => [step.key, outcome.status])).toEqual([
      [keyOf(entry("login-expired", "claude_a")), "failed"],
      [keyOf(entry("login-expiring", "claude_c")), "skipped"],
      [keyOf(entry("mcp-needs-auth", "claude_a", "minions")), "skipped"],
      [keyOf(entry("mcp-needs-auth", "claude_a", "threadpage")), "skipped"],
      [keyOf(entry("mcp-needs-auth", "claude_b", "minions")), "skipped"],
    ]);
  });

  it("counts a step the walk never reached as pending", () => {
    const summary = summarizeSignIns(startSignInSession([sixSteps[2]!]));
    expect(summary.pending).toHaveLength(1);
  });
});

describe("providerSignInProgress", () => {
  const flow = (phase: "starting" | "succeeded" | "failed" | "cancelled", flowId = "flow-2") => ({
    phase,
    flowId,
    message: phase === "failed" ? "Token rejected" : null,
  });

  it("is pending while a new flow runs", () => {
    expect(
      providerSignInProgress({
        kind: "signed-out",
        baselineFlowId: null,
        signedIn: false,
        flow: flow("starting"),
      }),
    ).toEqual({ state: "pending" });
  });

  it("is signed in when a new flow succeeded", () => {
    expect(
      providerSignInProgress({
        kind: "login-expired",
        baselineFlowId: "flow-1",
        signedIn: true,
        flow: flow("succeeded"),
      }),
    ).toEqual({ state: "signed-in" });
  });

  it("does not take a finished flow from before the step for this step's answer", () => {
    expect(
      providerSignInProgress({
        kind: "login-expiring",
        baselineFlowId: "flow-2",
        signedIn: true,
        flow: flow("succeeded", "flow-2"),
      }),
    ).toEqual({ state: "pending" });
  });

  it("does not read a lapsed login as done only because it still looks signed in", () => {
    expect(
      providerSignInProgress({
        kind: "login-expired",
        baselineFlowId: null,
        signedIn: true,
        flow: undefined,
      }),
    ).toEqual({ state: "pending" });
  });

  it("reads a signed-out account as done once it is signed in", () => {
    expect(
      providerSignInProgress({
        kind: "signed-out",
        baselineFlowId: null,
        signedIn: true,
        flow: undefined,
      }),
    ).toEqual({ state: "signed-in" });
  });

  it.each([
    ["failed", "failed", "Token rejected"],
    ["cancelled", "cancelled", null],
  ] as const)("fails with the reason when the flow %s", (phase, reason, message) => {
    expect(
      providerSignInProgress({
        kind: "signed-out",
        baselineFlowId: null,
        signedIn: false,
        flow: flow(phase),
      }),
    ).toEqual({ state: "failed", reason, message });
  });
});

describe("mcpSignInProgress and outcomes", () => {
  it("maps the flow's phase and error", () => {
    expect(mcpSignInProgress({ phase: "waiting", error: null })).toEqual({ state: "pending" });
    expect(mcpSignInProgress({ phase: "succeeded", error: null })).toEqual({ state: "signed-in" });
    expect(mcpSignInProgress({ phase: undefined, error: "No route" })).toEqual({
      state: "failed",
      reason: "failed",
      message: "No route",
    });
  });

  it("has no outcome until the step settles", () => {
    expect(outcomeOfProgress({ state: "pending" })).toBeNull();
    expect(outcomeOfProgress({ state: "signed-in" })).toEqual({ status: "signed-in" });
  });
});

describe("providerSignInUnsupportedOnPhone", () => {
  it.each([
    [
      { enabled: true, installed: true, setup: { canInstall: false, canAuthenticate: true } },
      false,
    ],
    [
      { enabled: true, installed: true, setup: { canInstall: false, canAuthenticate: false } },
      true,
    ],
    [{ enabled: true, installed: false }, true],
    [{ enabled: false, installed: true }, true],
  ] as const)("%j is unsupported: %s", (provider, unsupported) => {
    expect(providerSignInUnsupportedOnPhone(provider)).toBe(unsupported);
  });
});
