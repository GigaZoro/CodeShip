import {
  CommandId,
  ManualStepReviewError,
  ManualStepsListError,
  ManualStepStartChatError,
  ThreadId,
  WS_METHODS,
  type DetectedManualStep,
  type DetectedManualStepsResult,
  type EnvironmentId,
  type ManualStep,
  type ManualStepDecision,
  type ManualStepReview,
  type ManualStepReviewFailure,
  type ManualStepSolution,
  type ManualStepStartChatInput,
  type ManualStepsListFailure,
  type ManualStepsListResult,
  type ManualStepStartChatFailure,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { msg, t, type Message } from "@t3tools/shared/i18n";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createWritableQueryAtomFamily,
} from "./runtime.ts";

/** One machine's answer. `offline` covers a server that could not be asked. */
export type ManualStepsSource =
  | { readonly status: "loading" }
  | { readonly status: "not-connected" }
  | {
      readonly status: "listed";
      readonly steps: ReadonlyArray<ManualStep>;
      /** Set when this machine serves `manualSteps.review` and this client may ask it. */
      readonly reviewEnvironmentId?: EnvironmentId;
    }
  | { readonly status: "failed"; readonly reason: ManualStepsListFailure | "offline" };

/** One machine's answer to `manualSteps.detected`. */
export type DetectedManualStepsSource =
  | { readonly status: "loading" }
  | {
      readonly status: "listed";
      readonly environmentId: EnvironmentId;
      readonly steps: ReadonlyArray<DetectedManualStep>;
    }
  | { readonly status: "failed" };

/** A step a machine found on its own, with the environment whose settings fix it. */
export interface DetectedManualStepEntry {
  readonly environmentId: EnvironmentId;
  readonly step: DetectedManualStep;
}

/** A machine this client may start a step's chat on, under the name its environment carries. */
export interface ManualStepChatHost {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
}

/**
 * A step's start that has not reported success. Its response can be lost after the chat started,
 * so the same decision is sent again under the same command id, which the server replays.
 */
export interface ManualStepStartAttempt {
  readonly environmentId: EnvironmentId;
  readonly decision: ManualStepDecision;
  readonly commandId: CommandId;
  /** On its way: nothing else is sent for the step until it settles. */
  readonly inFlight: boolean;
}

/** What this session knows about the chats it started for one step. */
export interface ManualStepStart {
  readonly attempt: ManualStepStartAttempt | null;
  /** The newest chat whose start reported success. */
  readonly chat: ScopedThreadRef | null;
}

const NO_START: ManualStepStart = { attempt: null, chat: null };

export const sameManualStepDecision = (left: ManualStepDecision, right: ManualStepDecision) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Choosing a suggested solution decides exactly what its card shows. */
export const manualStepSolutionDecision = (solution: ManualStepSolution): ManualStepDecision => ({
  _tag: "Solution",
  title: solution.title,
  detail: solution.detail,
  ...(solution.command === undefined ? {} : { command: solution.command }),
});

/** The request that starts a step's chat; `creationSource` is absent on web. */
export const manualStepStartChatInput = (
  step: ManualStep,
  decision: ManualStepDecision,
  commandId: CommandId,
  creationSource?: ManualStepStartChatInput["creationSource"],
): ManualStepStartChatInput => ({
  commandId,
  ...(creationSource === undefined ? {} : { creationSource }),
  step: {
    threadId: step.threadId,
    title: step.title,
    step: step.step,
    kind: step.kind,
    machine: step.machine,
    url: step.url,
  },
  decision,
});

/** The chat an attempt starts: its thread takes the command's id. */
export const manualStepAttemptChat = (attempt: ManualStepStartAttempt): ScopedThreadRef => ({
  environmentId: attempt.environmentId,
  threadId: ThreadId.make(attempt.commandId),
});

/**
 * The state after the user chooses `decision`, or null while a start is on its way, when nothing
 * may be sent. An unfinished attempt of the same decision for the same machine is sent again under
 * its own id. `attemptStarted` says the thread list shows that attempt's chat with its message:
 * it went through, so it becomes the step's chat and this choice starts another one.
 */
export function beginManualStepStart(
  state: ManualStepStart,
  target: { readonly environmentId: EnvironmentId; readonly decision: ManualStepDecision },
  options: { readonly attemptStarted: boolean; readonly newId: () => string },
): ManualStepStart | null {
  const { attempt } = state;
  if (attempt?.inFlight) return null;
  if (
    attempt !== null &&
    !options.attemptStarted &&
    attempt.environmentId === target.environmentId &&
    sameManualStepDecision(attempt.decision, target.decision)
  ) {
    return { ...state, attempt: { ...attempt, inFlight: true } };
  }
  return {
    chat: attempt !== null && options.attemptStarted ? manualStepAttemptChat(attempt) : state.chat,
    attempt: { ...target, commandId: CommandId.make(options.newId()), inFlight: true },
  };
}

/** The state after the start sent under `commandId` settled: with its chat, or null when it failed. */
export function settleManualStepStart(
  state: ManualStepStart,
  commandId: CommandId,
  threadId: ThreadId | null,
): ManualStepStart {
  const { attempt } = state;
  if (attempt?.commandId !== commandId) return state;
  return threadId === null
    ? { ...state, attempt: { ...attempt, inFlight: false } }
    : { attempt: null, chat: { environmentId: attempt.environmentId, threadId } };
}

export interface ManualStepGroup {
  readonly machine: string;
  /** The Waiting steps from ThreadPage. */
  readonly steps: ReadonlyArray<ManualStep>;
  /** Sign-ins this machine's server noticed itself, most urgent first. */
  readonly detected: ReadonlyArray<DetectedManualStepEntry>;
}

export type ManualStepsView =
  | { readonly status: "loading" }
  /** No machine has a ThreadPage token. */
  | { readonly status: "not-connected" }
  | { readonly status: "failed"; readonly reason: ManualStepsListFailure | "offline" }
  | {
      readonly status: "listed";
      readonly groups: ReadonlyArray<ManualStepGroup>;
      readonly count: number;
      /** Why no ThreadPage steps are shown while detected ones are; absent when ThreadPage listed. */
      readonly threadPageIssue?: ManualStepsListFailure | "offline";
      /**
       * The one machine that reviews every ThreadPage step for this user: the lowest environment id
       * among those that list, serve reviews and let this client ask. Null when there is none.
       */
      readonly reviewEnvironmentId: EnvironmentId | null;
      /** By environment id, so every client picks the same one of two that share a name. */
      readonly chatHosts: ReadonlyArray<ManualStepChatHost>;
    };

export interface ManualStepsState {
  readonly view: ManualStepsView;
  /** A machine is reading ThreadPage now, on open, on a timer or on Refresh. */
  readonly refreshing: boolean;
}

const FAILURE_MESSAGES: Record<ManualStepsListFailure | "offline", Message> = {
  "token-rejected": msg("ThreadPage refused the token. Save a new one in Settings."),
  "access-denied": msg(
    "The ThreadPage token cannot read threads. Give its connection Read access.",
  ),
  paused: msg(
    "The ThreadPage connection is paused. Resume it in ThreadPage Settings, Connections.",
  ),
  "rate-limited": msg("ThreadPage is busy. Try again in a minute."),
  "no-inbox": msg("The ThreadPage token sees no Machine inbox folder."),
  unreachable: msg("Could not reach ThreadPage."),
  offline: msg("Could not reach the machine that reads ThreadPage."),
};

export const manualStepsFailureMessage = (reason: ManualStepsListFailure | "offline") =>
  t(FAILURE_MESSAGES[reason]);

export type ManualStepReviewProblem = ManualStepReviewFailure | "offline";

const REVIEW_FAILURE_MESSAGES: Record<ManualStepReviewProblem, Message> = {
  ...FAILURE_MESSAGES,
  "not-connected": msg("ThreadPage is not connected on the machine that reviews steps."),
  "not-found": msg("This step is no longer waiting in ThreadPage."),
  "generation-failed": msg("The review could not be written. Try again."),
};

export const manualStepReviewFailureMessage = (reason: ManualStepReviewProblem) =>
  t(REVIEW_FAILURE_MESSAGES[reason]);

/**
 * One machine under the names its ThreadPage folder and its server carry, which differ in case,
 * spaces and separators ("MacBook-Pro-Andrii", "MacBook Pro - Andrii"; "Zoro-VPS", "zoro-vps").
 */
const machineKey = (machine: string) => machine.toLocaleLowerCase().replace(/[\s._-]+/g, "");

export type ManualStepStartChatProblem = ManualStepStartChatFailure | "offline";

const START_CHAT_FAILURE_MESSAGES: Record<ManualStepStartChatProblem, Message> = {
  "no-model": msg(
    "No provider account on that machine is signed in. Sign in to one, then choose again.",
  ),
  "launch-failed": msg("The chat could not be started. Try again."),
  offline: msg("Could not reach the machine that runs the chat."),
};

const isManualStepStartChatError = Schema.is(ManualStepStartChatError);

/** Why a step's chat did not start, from the failed command's cause. */
export function manualStepStartChatFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause);
  return t(
    START_CHAT_FAILURE_MESSAGES[
      Option.isSome(error) && isManualStepStartChatError(error.value)
        ? error.value.reason
        : "offline"
    ],
  );
}

/**
 * Where a step's chat runs: its own machine when this client may start chats there, because the
 * work often has to happen on that machine; otherwise the machine that reviews steps, which reads
 * ThreadPage and so is one of the user's own. Null when neither can run it.
 */
export function manualStepChatHost(
  view: {
    readonly chatHosts: ReadonlyArray<ManualStepChatHost>;
    readonly reviewEnvironmentId: EnvironmentId | null;
  },
  machine: string,
): ManualStepChatHost | null {
  const key = machineKey(machine);
  return (
    view.chatHosts.find((host) => machineKey(host.machine) === key) ??
    view.chatHosts.find((host) => host.environmentId === view.reviewEnvironmentId) ??
    null
  );
}

const byUrgency = (left: ManualStep, right: ManualStep) =>
  Number(right.kind === "needs-you") - Number(left.kind === "needs-you") ||
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.title.localeCompare(right.title);

const DETECTED_KIND_ORDER: Record<DetectedManualStep["kind"], number> = {
  "login-expired": 0,
  "signed-out": 1,
  "login-expiring": 2,
  "mcp-needs-auth": 3,
};

export const byDetectedUrgency = (left: DetectedManualStepEntry, right: DetectedManualStepEntry) =>
  DETECTED_KIND_ORDER[left.step.kind] - DETECTED_KIND_ORDER[right.step.kind] ||
  (left.step.accountName ?? left.step.driver).localeCompare(
    right.step.accountName ?? right.step.driver,
  ) ||
  left.step.instanceId.localeCompare(right.step.instanceId) ||
  (left.step.serverName ?? "").localeCompare(right.step.serverName ?? "");

/**
 * Every machine reads the same ThreadPage lists, so a step can arrive from several; it shows once.
 * Machines are grouped with money decisions first, then by name; inside a group money decisions
 * come first, then the most recently updated.
 */
function groupManualSteps(
  steps: ReadonlyArray<ManualStep>,
  detected: ReadonlyArray<DetectedManualStepEntry>,
): ReadonlyArray<ManualStepGroup> {
  const byThread = new Map<string, ManualStep>();
  for (const step of steps) {
    const known = byThread.get(step.threadId);
    if (known === undefined || step.updatedAt > known.updatedAt) byThread.set(step.threadId, step);
  }
  // A ThreadPage folder and a server label can spell one machine differently; see machineKey.
  // ThreadPage steps come first, so the folder's spelling names the group.
  const byMachine = new Map<
    string,
    { machine: string; steps: ManualStep[]; detected: DetectedManualStepEntry[] }
  >();
  const machineOf = (machine: string) => {
    const key = machineKey(machine);
    const known = byMachine.get(key);
    if (known !== undefined) return known;
    const created = { machine, steps: [], detected: [] };
    byMachine.set(key, created);
    return created;
  };
  for (const step of byThread.values()) machineOf(step.machine).steps.push(step);
  for (const entry of detected) machineOf(entry.step.machine).detected.push(entry);
  const groups = [...byMachine.values()].map(({ machine, ...found }) => ({
    machine,
    steps: found.steps.sort(byUrgency),
    detected: found.detected.sort(byDetectedUrgency),
  }));
  const hasMoney = (group: ManualStepGroup) =>
    group.steps.some((step) => step.kind === "needs-you");
  return groups.sort(
    (left, right) =>
      Number(hasMoney(right)) - Number(hasMoney(left)) || left.machine.localeCompare(right.machine),
  );
}

/**
 * Identifies a detected step: the server that found it plus its id. Two servers can share a
 * display label (a production and a development server on one machine), so the label is no identity.
 */
export const detectedManualStepKey = (entry: DetectedManualStepEntry) =>
  `${entry.environmentId}:${entry.step.id}`;

/** A server reached through several connections is one environment, so its steps show once. */
function detectedEntries(
  sources: ReadonlyArray<DetectedManualStepsSource>,
): ReadonlyArray<DetectedManualStepEntry> {
  const entries = new Map<string, DetectedManualStepEntry>();
  for (const source of sources) {
    if (source.status !== "listed") continue;
    for (const step of source.steps) {
      const entry = { environmentId: source.environmentId, step };
      const key = detectedManualStepKey(entry);
      if (!entries.has(key)) entries.set(key, entry);
    }
  }
  return [...entries.values()];
}

/**
 * Every client picks the same reviewer by comparing ids, not by catalog order, so a user's
 * clients never review one step on two machines.
 */
function lowestReviewEnvironmentId(sources: ReadonlyArray<ManualStepsSource>) {
  let lowest: EnvironmentId | null = null;
  for (const source of sources) {
    if (source.status !== "listed" || source.reviewEnvironmentId === undefined) continue;
    if (lowest === null || source.reviewEnvironmentId < lowest) lowest = source.reviewEnvironmentId;
  }
  return lowest;
}

/**
 * One machine's ThreadPage list is enough to show, and detected steps need no ThreadPage at all.
 * A ThreadPage failure shows alone only when nothing else is there to show.
 */
export function combineManualSteps(
  sources: ReadonlyArray<ManualStepsSource>,
  detectedSources: ReadonlyArray<DetectedManualStepsSource> = [],
  chatHosts: ReadonlyArray<ManualStepChatHost> = [],
): ManualStepsView {
  const listed = sources.flatMap((source) => (source.status === "listed" ? [source.steps] : []));
  const detected = detectedEntries(detectedSources);
  const failures = sources.flatMap((source) => (source.status === "failed" ? [source] : []));
  const failure = failures.find((source) => source.reason !== "offline") ?? failures[0];
  if (listed.length > 0 || detected.length > 0) {
    const groups = groupManualSteps(listed.flat(), detected);
    return {
      status: "listed",
      groups,
      count: groups.reduce((total, group) => total + group.steps.length + group.detected.length, 0),
      ...(listed.length === 0 && failure !== undefined ? { threadPageIssue: failure.reason } : {}),
      reviewEnvironmentId: lowestReviewEnvironmentId(sources),
      chatHosts: [...chatHosts].sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId),
      ),
    };
  }
  if (
    sources.some((source) => source.status === "loading") ||
    detectedSources.some((source) => source.status === "loading")
  ) {
    return { status: "loading" };
  }
  return failure === undefined ? { status: "not-connected" } : failure;
}

const isManualStepsListError = Schema.is(ManualStepsListError);
const isManualStepReviewError = Schema.is(ManualStepReviewError);

function manualStepsSource(
  result: AsyncResult.AsyncResult<ManualStepsListResult, unknown>,
  reviewEnvironmentId: EnvironmentId | undefined,
): ManualStepsSource {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    return value.value._tag === "NotConnected"
      ? { status: "not-connected" }
      : {
          status: "listed",
          steps: value.value.steps,
          ...(reviewEnvironmentId === undefined ? {} : { reviewEnvironmentId }),
        };
  }
  if (result._tag !== "Failure") return { status: "loading" };
  const error = Cause.findErrorOption(result.cause);
  return {
    status: "failed",
    reason:
      Option.isSome(error) && isManualStepsListError(error.value) ? error.value.reason : "offline",
  };
}

function detectedManualStepsSource(
  environmentId: EnvironmentId,
  result: AsyncResult.AsyncResult<DetectedManualStepsResult, unknown>,
): DetectedManualStepsSource {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    return { status: "listed", environmentId, steps: value.value.steps };
  }
  return result._tag === "Failure" ? { status: "failed" } : { status: "loading" };
}

/** One step's review as a client shows it. */
export type ManualStepReviewState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly reason: ManualStepReviewProblem }
  /** `refreshing` while a new review replaces this one. */
  | {
      readonly status: "ready";
      readonly review: ManualStepReview;
      readonly refreshing: boolean;
    };

export function manualStepReviewState(
  result: AsyncResult.AsyncResult<ManualStepReview, unknown>,
): ManualStepReviewState {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    return { status: "ready", review: value.value, refreshing: result.waiting };
  }
  if (result._tag !== "Failure") return { status: "loading" };
  const error = Cause.findErrorOption(result.cause);
  return {
    status: "failed",
    reason:
      Option.isSome(error) && isManualStepReviewError(error.value) ? error.value.reason : "offline",
  };
}

interface ManualStepsKey {
  /** Environments that serve `manualSteps.list`. */
  readonly list: ReadonlyArray<EnvironmentId>;
  /** Environments that serve `manualSteps.detected`; older servers do not. */
  readonly detected: ReadonlyArray<EnvironmentId>;
  /** Environments that serve `manualSteps.review`; older servers do not. */
  readonly reviews: ReadonlyArray<EnvironmentId>;
  /** Environments that serve `manualSteps.startChat`, with their labels; older servers do not. */
  readonly chats: ReadonlyArray<ManualStepChatHost>;
}

/** The key of `view` for the connected servers that serve either list, or null when none does. */
export function manualStepsEnvironmentIdsKey(
  serverConfigs: ReadonlyMap<
    EnvironmentId,
    Pick<ServerConfig, "environment" | "scratchWorkspaceRoot">
  >,
): string | null {
  const serving = (
    capability: "manualSteps" | "detectedManualSteps" | "manualStepReviews" | "manualStepChats",
  ) =>
    [...serverConfigs]
      .filter(([, config]) => config.environment.capabilities[capability] === true)
      .map(([environmentId]) => environmentId);
  const key: ManualStepsKey = {
    list: serving("manualSteps"),
    detected: serving("detectedManualSteps"),
    reviews: serving("manualStepReviews"),
    // The chat is a thread without a project, which a server whose data sits inside a checkout
    // cannot host.
    chats: serving("manualStepChats").flatMap((environmentId) => {
      const config = serverConfigs.get(environmentId);
      return config?.scratchWorkspaceRoot === undefined
        ? []
        : [{ environmentId, machine: config.environment.label }];
    }),
  };
  return key.list.length === 0 && key.detected.length === 0 ? null : JSON.stringify(key);
}

export function createManualStepsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:manual-steps:list",
    tag: WS_METHODS.manualStepsList,
    // Each read asks ThreadPage for every machine folder, so an open panel shares one briefly.
    staleTimeMs: 60_000,
    refreshIntervalMs: 5 * 60_000,
  });
  const detected = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:manual-steps:detected",
    tag: WS_METHODS.manualStepsDetected,
    // Served from provider status the server already holds, so a sign-in clears within a minute.
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
  });
  const reviewQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:manual-steps:review",
    tag: WS_METHODS.manualStepsReview,
    staleTimeMs: 24 * 60 * 60_000,
  });
  const writable = createWritableQueryAtomFamily<ManualStepReview, unknown>();
  /** A review of one step version never changes, so it is read once and kept. */
  const review = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: string; readonly updatedAt: string };
  }) => writable(reviewQuery(target));
  const reviewAgain = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:manual-steps:review-again",
    tag: WS_METHODS.manualStepsReviewAgain,
    // The card looks at the review of the input it showed, which the server may store under a
    // later updatedAt; a failed card must show the new review too.
    onSuccess: (target, registry, result) =>
      Effect.sync(() => {
        const atom = review(target);
        if (registry.get(atom).waiting) registry.refresh(atom);
        registry.set(atom, AsyncResult.success(result));
      }),
  });
  // One atom for every step, holding only the steps the user chose something for, and kept
  // through remounts so a retry from a reopened card still replays.
  const starts = Atom.make<ReadonlyMap<string, ManualStepStart>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel("environment-data:manual-steps:starts"),
  );
  const start = Atom.family((stepThreadId: string) =>
    Atom.readable((get) => get(starts).get(stepThreadId) ?? NO_START).pipe(
      Atom.withLabel(`environment-data:manual-steps:start:${stepThreadId}`),
    ),
  );
  const updateStart = (
    registry: AtomRegistry.AtomRegistry,
    stepThreadId: string,
    update: (state: ManualStepStart) => ManualStepStart,
  ) => {
    const all = registry.get(starts);
    const current = all.get(stepThreadId) ?? NO_START;
    const next = update(current);
    if (next !== current) registry.set(starts, new Map(all).set(stepThreadId, next));
  };
  /** Records the choice and returns the id to send it under; null while a start is on its way. */
  const beginStart = (
    registry: AtomRegistry.AtomRegistry,
    target: {
      readonly stepThreadId: string;
      readonly environmentId: EnvironmentId;
      readonly decision: ManualStepDecision;
    },
    options: { readonly attemptStarted: boolean; readonly newId: () => string },
  ): CommandId | null => {
    const next = beginManualStepStart(
      registry.get(starts).get(target.stepThreadId) ?? NO_START,
      target,
      options,
    );
    if (next === null) return null;
    updateStart(registry, target.stepThreadId, () => next);
    return next.attempt?.commandId ?? null;
  };
  const startChat = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:manual-steps:start-chat",
    tag: WS_METHODS.manualStepsStartChat,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.commandId },
    onSuccess: (target, registry, result) =>
      Effect.sync(() =>
        updateStart(registry, target.input.step.threadId, (state) =>
          settleManualStepStart(state, target.input.commandId, result.threadId),
        ),
      ),
  });
  /**
   * Ends a start that failed, keeping its attempt for a retry. The caller does this when the
   * command settles, because a command can fail before its request is ever built.
   */
  const failStart = (
    registry: AtomRegistry.AtomRegistry,
    stepThreadId: string,
    commandId: CommandId,
  ) =>
    updateStart(registry, stepThreadId, (state) => settleManualStepStart(state, commandId, null));
  /** Keyed by a JSON {@link ManualStepsKey}. */
  const view = Atom.family((environmentIdsKey: string) => {
    const key = JSON.parse(environmentIdsKey) as ManualStepsKey;
    const chatEntries = key.chats.map((host) => ({
      host,
      permission: startChat.permissionAtom(host.environmentId),
    }));
    const listEntries = key.list.map((environmentId) => ({
      environmentId,
      servesReviews: key.reviews.includes(environmentId),
      list: list({ environmentId, input: {} }),
      permission: reviewAgain.permissionAtom(environmentId),
    }));
    const detectedAtoms = key.detected.map((environmentId) =>
      detected({ environmentId, input: {} }),
    );
    return Atom.readable(
      (get): ManualStepsState => {
        const results = listEntries.map((entry) => get(entry.list));
        const detectedResults = detectedAtoms.map((atom) => get(atom));
        return {
          view: combineManualSteps(
            results.map((result, index) => {
              const entry = listEntries[index]!;
              // A reviewer serves reviews and lets this client run `reviewAgain`, the same scope.
              const reviews = entry.servesReviews && get(entry.permission);
              return manualStepsSource(result, reviews ? entry.environmentId : undefined);
            }),
            detectedResults.map((result, index) =>
              detectedManualStepsSource(key.detected[index]!, result),
            ),
            chatEntries.flatMap((entry) => (get(entry.permission) ? [entry.host] : [])),
          ),
          refreshing: [...results, ...detectedResults].some((result) => result.waiting),
        };
      },
      (refresh) => {
        for (const entry of listEntries) refresh(entry.list);
        for (const atom of detectedAtoms) refresh(atom);
      },
    ).pipe(Atom.withLabel(`environment-data:manual-steps:view:${environmentIdsKey}`));
  });
  return {
    list,
    detected,
    view,
    review,
    reviewAgain,
    startChat,
    start,
    beginStart,
    failStart,
  };
}

export interface DetectedManualStepText {
  /** What to do, for the row's first line. */
  readonly step: string;
  /** Why, for the row's second line. */
  readonly detail: string;
}

/** The account as the rows name it: the driver, plus the account's own name when it adds one. */
export function detectedManualStepAccountLabel(
  step: Pick<DetectedManualStep, "accountName">,
  driverLabel: string,
): string {
  const name = step.accountName?.trim();
  return name && name.toLowerCase() !== driverLabel.toLowerCase()
    ? `${driverLabel} · ${name}`
    : driverLabel;
}

/** The words for a detected step; the caller names the driver and formats dates in its locale. */
export function detectedManualStepText(
  step: DetectedManualStep,
  helpers: { readonly driverLabel: string; readonly formatDate: (iso: string) => string },
): DetectedManualStepText {
  const account = detectedManualStepAccountLabel(step, helpers.driverLabel);
  switch (step.kind) {
    case "signed-out":
      return { step: t("Sign in to {account}", { account }), detail: t("Signed out") };
    case "login-expiring":
      return {
        step: t("Sign in to {account} again", { account }),
        detail: step.expiresAt
          ? t("Login ends {date}", { date: helpers.formatDate(step.expiresAt) })
          : t("Login ends soon"),
      };
    case "login-expired":
      return { step: t("Sign in to {account} again", { account }), detail: t("Login expired") };
    case "mcp-needs-auth":
      return {
        step: t("Sign in to {server} for {account}", {
          server: step.serverDisplayName?.trim() || step.serverName || "MCP",
          account,
        }),
        detail: t("MCP server needs sign-in"),
      };
  }
}
