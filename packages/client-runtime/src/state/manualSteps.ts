import {
  ManualStepsListError,
  WS_METHODS,
  type DetectedManualStep,
  type DetectedManualStepsResult,
  type EnvironmentId,
  type ManualStep,
  type ManualStepsListFailure,
  type ManualStepsListResult,
  type ServerConfig,
} from "@t3tools/contracts";
import { msg, t, type Message } from "@t3tools/shared/i18n";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** One machine's answer. `offline` covers a server that could not be asked. */
export type ManualStepsSource =
  | { readonly status: "loading" }
  | { readonly status: "not-connected" }
  | { readonly status: "listed"; readonly steps: ReadonlyArray<ManualStep> }
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
  // A ThreadPage folder and a server label can spell one machine differently ("Zoro-VPS", "zoro-vps").
  // ThreadPage steps come first, so the folder's spelling names the group.
  const byMachine = new Map<
    string,
    { machine: string; steps: ManualStep[]; detected: DetectedManualStepEntry[] }
  >();
  const machineOf = (machine: string) => {
    const key = machine.toLocaleLowerCase();
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
 * One machine's ThreadPage list is enough to show, and detected steps need no ThreadPage at all.
 * A ThreadPage failure shows alone only when nothing else is there to show.
 */
export function combineManualSteps(
  sources: ReadonlyArray<ManualStepsSource>,
  detectedSources: ReadonlyArray<DetectedManualStepsSource> = [],
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

function manualStepsSource(
  result: AsyncResult.AsyncResult<ManualStepsListResult, unknown>,
): ManualStepsSource {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    return value.value._tag === "NotConnected"
      ? { status: "not-connected" }
      : { status: "listed", steps: value.value.steps };
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

interface ManualStepsKey {
  /** Environments that serve `manualSteps.list`. */
  readonly list: ReadonlyArray<EnvironmentId>;
  /** Environments that serve `manualSteps.detected`; older servers do not. */
  readonly detected: ReadonlyArray<EnvironmentId>;
}

/** The key of `view` for the connected servers that serve either list, or null when none does. */
export function manualStepsEnvironmentIdsKey(
  serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "environment">>,
): string | null {
  const serving = (capability: "manualSteps" | "detectedManualSteps") =>
    [...serverConfigs]
      .filter(([, config]) => config.environment.capabilities[capability] === true)
      .map(([environmentId]) => environmentId);
  const key: ManualStepsKey = {
    list: serving("manualSteps"),
    detected: serving("detectedManualSteps"),
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
  /** Keyed by a JSON {@link ManualStepsKey}. */
  const view = Atom.family((environmentIdsKey: string) => {
    const key = JSON.parse(environmentIdsKey) as ManualStepsKey;
    const listAtoms = key.list.map((environmentId) => list({ environmentId, input: {} }));
    const detectedAtoms = key.detected.map((environmentId) =>
      detected({ environmentId, input: {} }),
    );
    return Atom.readable(
      (get): ManualStepsState => {
        const results = listAtoms.map((atom) => get(atom));
        const detectedResults = detectedAtoms.map((atom) => get(atom));
        return {
          view: combineManualSteps(
            results.map(manualStepsSource),
            detectedResults.map((result, index) =>
              detectedManualStepsSource(key.detected[index]!, result),
            ),
          ),
          refreshing: [...results, ...detectedResults].some((result) => result.waiting),
        };
      },
      (refresh) => {
        for (const atom of listAtoms) refresh(atom);
        for (const atom of detectedAtoms) refresh(atom);
      },
    ).pipe(Atom.withLabel(`environment-data:manual-steps:view:${environmentIdsKey}`));
  });
  return { list, detected, view };
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
