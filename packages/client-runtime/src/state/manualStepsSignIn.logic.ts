import type { DetectedManualStep, ProviderAuthState, ServerProvider } from "@t3tools/contracts";

import {
  byDetectedUrgency,
  detectedManualStepKey,
  type DetectedManualStepEntry,
} from "./manualSteps.ts";

type StepKind = DetectedManualStep["kind"];

/** The kinds that are an account's own sign-in; the MCP servers of that account come after. */
const isAccountKind = (kind: StepKind) => kind !== "mcp-needs-auth";

/** An account in these states cannot sign an MCP server in, whatever it was asked to do. */
const accountCannotWork = (kind: StepKind) => kind === "signed-out" || kind === "login-expired";

export interface SignInStep {
  readonly key: string;
  readonly entry: DetectedManualStepEntry;
  /** For an MCP server: the step that signs in its provider account, when the walk has one. */
  readonly accountKey: string | null;
}

export type SignInSkipReason =
  | "user"
  /** This device cannot run the step at all. */
  | "unsupported"
  /** The step's provider account failed to sign in, so its MCP server cannot. */
  | "account-failed"
  /** The step's provider account is still signed out, so its MCP server cannot sign in. */
  | "account-skipped";

export type SignInOutcome =
  | { readonly status: "signed-in" }
  | { readonly status: "skipped"; readonly reason: SignInSkipReason }
  | {
      readonly status: "failed";
      readonly reason: "cancelled" | "failed";
      /** What the flow said, when it said anything. */
      readonly message: string | null;
    };

export interface SignInSession {
  readonly steps: ReadonlyArray<SignInStep>;
  readonly outcomes: Readonly<Record<string, SignInOutcome>>;
}

const sameAccount = (left: DetectedManualStepEntry, right: DetectedManualStepEntry) =>
  left.environmentId === right.environmentId && left.step.instanceId === right.step.instanceId;

/**
 * The order a guided walk takes: the list's own urgency order (expired login, signed out, ending
 * soon, then MCP). Every account step sorts before every MCP step, so an account always comes
 * before its own servers, whatever order the entries arrive in.
 */
export function planSignIns(
  entries: ReadonlyArray<DetectedManualStepEntry>,
): ReadonlyArray<SignInStep> {
  const unique = new Map(entries.map((entry) => [detectedManualStepKey(entry), entry] as const));
  const ordered = [...unique.values()].sort(byDetectedUrgency);
  return ordered.map((entry) => {
    const key = detectedManualStepKey(entry);
    const account =
      entry.step.kind === "mcp-needs-auth"
        ? ordered.find(
            (candidate) => isAccountKind(candidate.step.kind) && sameAccount(candidate, entry),
          )
        : undefined;
    return { key, entry, accountKey: account ? detectedManualStepKey(account) : null };
  });
}

/** Why an MCP step cannot be tried, from how its provider account step ended. */
function blockedReason(
  session: SignInSession,
  step: SignInStep,
): "account-failed" | "account-skipped" | null {
  if (step.accountKey === null) return null;
  const outcome = session.outcomes[step.accountKey];
  if (outcome?.status === "failed") return "account-failed";
  if (outcome?.status !== "skipped") return null;
  const account = session.steps.find((candidate) => candidate.key === step.accountKey);
  return account && accountCannotWork(account.entry.step.kind) ? "account-skipped" : null;
}

/** Records the skips an earlier outcome causes. Accounts come first, so one pass settles all. */
function settle(session: SignInSession): SignInSession {
  const outcomes: Record<string, SignInOutcome> = { ...session.outcomes };
  const settled = { steps: session.steps, outcomes };
  for (const step of session.steps) {
    if (outcomes[step.key] !== undefined) continue;
    const reason = blockedReason(settled, step);
    if (reason !== null) outcomes[step.key] = { status: "skipped", reason };
  }
  return settled;
}

export const startSignInSession = (
  entries: ReadonlyArray<DetectedManualStepEntry>,
): SignInSession => ({ steps: planSignIns(entries), outcomes: {} });

/** Records how a step ended. The first outcome stands; a step cannot end twice. */
export function recordSignInOutcome(
  session: SignInSession,
  key: string,
  outcome: SignInOutcome,
): SignInSession {
  if (session.outcomes[key] !== undefined || !session.steps.some((step) => step.key === key)) {
    return session;
  }
  return settle({ ...session, outcomes: { ...session.outcomes, [key]: outcome } });
}

export interface CurrentSignIn {
  readonly step: SignInStep;
  /** 1-based, counting steps the walk skipped for the user. */
  readonly position: number;
  readonly total: number;
  /** The last step still to do: its Next finishes the walk. */
  readonly last: boolean;
}

/** The first step with no outcome, or null when the walk is over. */
export function currentSignIn(session: SignInSession): CurrentSignIn | null {
  const index = session.steps.findIndex((step) => session.outcomes[step.key] === undefined);
  const step = session.steps[index];
  if (step === undefined) return null;
  return {
    step,
    position: index + 1,
    total: session.steps.length,
    last: session.steps
      .slice(index + 1)
      .every((later) => session.outcomes[later.key] !== undefined),
  };
}

export interface SignInResult {
  readonly step: SignInStep;
  readonly outcome: SignInOutcome;
}

/** What the walk did: what signed in, and everything that still needs a sign-in. */
export function summarizeSignIns(session: SignInSession): {
  readonly signedIn: ReadonlyArray<SignInStep>;
  readonly pending: ReadonlyArray<SignInResult>;
} {
  const signedIn: SignInStep[] = [];
  const pending: SignInResult[] = [];
  for (const step of session.steps) {
    const outcome = session.outcomes[step.key];
    if (outcome?.status === "signed-in") signedIn.push(step);
    // A step the walk never reached is as pending as one the user skipped.
    else pending.push({ step, outcome: outcome ?? { status: "skipped", reason: "user" } });
  }
  return { signedIn, pending };
}

export type SignInProgress =
  | { readonly state: "pending" }
  | { readonly state: "signed-in" }
  | {
      readonly state: "failed";
      readonly reason: "cancelled" | "failed";
      readonly message: string | null;
    };

export const outcomeOfProgress = (progress: SignInProgress): SignInOutcome | null =>
  progress.state === "pending"
    ? null
    : progress.state === "signed-in"
      ? { status: "signed-in" }
      : { status: "failed", reason: progress.reason, message: progress.message };

/**
 * Where one provider account's sign-in stands. A flow counts only when it started after the step
 * did (`baselineFlowId` is the flow the account had then), so a finished flow from earlier never
 * answers for this one. A signed-out account also counts as done once it reads as signed in, for
 * example when it was signed in from another window.
 */
export function providerSignInProgress(input: {
  readonly kind: StepKind;
  readonly baselineFlowId: string | null;
  /** The provider reads as signed in right now. */
  readonly signedIn: boolean;
  readonly flow: Pick<ProviderAuthState, "phase" | "flowId" | "message"> | undefined;
}): SignInProgress {
  const { flow } = input;
  if (flow?.flowId != null && flow.flowId !== input.baselineFlowId) {
    if (flow.phase === "succeeded") return { state: "signed-in" };
    if (flow.phase === "failed")
      return { state: "failed", reason: "failed", message: flow.message };
    if (flow.phase === "cancelled") {
      return { state: "failed", reason: "cancelled", message: flow.message };
    }
  }
  // A login that is only ending or has lapsed reads as signed in until it is renewed, so only a
  // signed-out account can be told apart by its status.
  if (input.signedIn && input.kind === "signed-out") return { state: "signed-in" };
  return { state: "pending" };
}

/** An MCP server's sign-in has one flow per step, so its phase and error say it all. */
export function mcpSignInProgress(input: {
  readonly phase: "waiting" | "succeeded" | undefined;
  readonly error: string | null;
}): SignInProgress {
  if (input.phase === "succeeded") return { state: "signed-in" };
  if (input.error !== null) return { state: "failed", reason: "failed", message: input.error };
  return { state: "pending" };
}

/** Whether the provider is signed in right now, as the Providers page decides it. */
export function providerReadsSignedIn(
  provider: Pick<ServerProvider, "auth" | "availability">,
  flowPhase: ProviderAuthState["phase"] | undefined,
): boolean {
  return (
    provider.availability !== "unavailable" &&
    (provider.auth.status === "authenticated" ||
      (provider.auth.status === "unknown" && flowPhase === "succeeded"))
  );
}

/**
 * A phone cannot sign in a provider that has no in-app sign-in: turned off, not installed, or
 * set up outside the app. The step says so and the walk goes on.
 */
export const providerSignInUnsupportedOnPhone = (
  provider: Pick<ServerProvider, "enabled" | "installed" | "setup">,
) => !provider.enabled || !provider.installed || provider.setup?.canAuthenticate === false;
