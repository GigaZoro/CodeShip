import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";

import {
  machineShowsLastKnownState,
  type MachineAvailability,
} from "../connection/presentation.ts";
import { threadKey } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { resolveThreadStatus, type ThreadStatusInput } from "./threadStatus.ts";

/**
 * Why a thread is stopped or frozen, when the reason is shared with other threads. Threads with
 * the same `key` wait on one thing, so the app reports them once.
 */
export type ThreadIncidentCause =
  | {
      readonly kind: "machine-offline";
      readonly key: string;
      readonly environmentId: EnvironmentId;
    }
  | {
      readonly kind: "usage-limit";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly providerInstanceId: ProviderInstanceId;
      /** When the limit window resets, to the minute; null when the provider did not say. */
      readonly resetAt: string | null;
    }
  | {
      readonly kind: "provider-outage";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly providerInstanceId: ProviderInstanceId;
    };

export type ThreadIncidentKind = ThreadIncidentCause["kind"];

export type ThreadIncidentInput = ThreadStatusInput &
  Pick<EnvironmentThreadShell, "environmentId" | "id" | "settledOverride"> &
  Partial<Pick<EnvironmentThreadShell, "limitRecovery">>;

export interface ThreadIncidentContext {
  /** Each machine's availability; a machine missing here counts as live. */
  readonly machineByEnvironment: ReadonlyMap<EnvironmentId, MachineAvailability>;
  /** `providerInstanceKey` of every provider that cannot answer now. */
  readonly downProviders: ReadonlySet<string>;
}

/** The fewest threads that make one cause an incident; a lone thread keeps its own notice. */
const THREAD_INCIDENT_MIN_THREADS = 2;

export function providerInstanceKey(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
): string {
  return `${environmentId}\u0000${providerInstanceId}`;
}

/** A provider is down while it is enabled but unavailable or in error, as provider status reads it. */
export function isProviderDown(provider: {
  readonly enabled: boolean;
  readonly status: string;
  readonly availability?: string | undefined;
}): boolean {
  return (
    provider.enabled &&
    provider.status !== "disabled" &&
    (provider.availability === "unavailable" || provider.status === "error")
  );
}

// Statuses that change while the machine runs; an unreachable machine leaves them frozen.
const LIVE_STATUSES = new Set(["working", "waiting", "input", "request", "approval"]);

function resetMinute(resetAt: string | null | undefined): string | null {
  if (resetAt == null) return null;
  const at = DateTime.make(resetAt);
  if (Option.isNone(at)) return null;
  return DateTime.formatIso(DateTime.startOf(at.value, "minute"));
}

/** The shared reason this thread is stopped or frozen, or null when it has none. */
function threadIncidentCause(
  thread: ThreadIncidentInput,
  context: ThreadIncidentContext,
): ThreadIncidentCause | null {
  // A settled thread is done with; its old failure is not part of what is happening now.
  if (thread.settledOverride === "settled") return null;
  const { environmentId } = thread;
  const status = resolveThreadStatus(thread);
  const machine = context.machineByEnvironment.get(environmentId) ?? "live";
  if (machineShowsLastKnownState(machine)) {
    return LIVE_STATUSES.has(status)
      ? { kind: "machine-offline", key: `machine-offline:${environmentId}`, environmentId }
      : null;
  }
  const providerInstanceId = thread.runtime?.providerInstanceId;
  if (providerInstanceId === undefined) return null;
  if (status === "limited") {
    const resetAt = resetMinute(
      thread.runtime?.usageLimitResetAt ?? thread.limitRecovery?.resetAt ?? null,
    );
    return {
      kind: "usage-limit",
      key: `usage-limit:${providerInstanceKey(environmentId, providerInstanceId)}\u0000${resetAt ?? ""}`,
      environmentId,
      providerInstanceId,
      resetAt,
    };
  }
  if (
    status === "failed" &&
    thread.runtime?.status === "failed" &&
    context.downProviders.has(providerInstanceKey(environmentId, providerInstanceId))
  ) {
    return {
      kind: "provider-outage",
      key: `provider-outage:${providerInstanceKey(environmentId, providerInstanceId)}`,
      environmentId,
      providerInstanceId,
    };
  }
  return null;
}

export interface ThreadIncident {
  readonly cause: ThreadIncidentCause;
  /** `threadKey` of every affected thread, in input order. */
  readonly threadKeys: ReadonlyArray<string>;
}

export interface ThreadIncidents {
  /** Most threads first, then by key, so the order holds while nothing changes. */
  readonly incidents: ReadonlyArray<ThreadIncident>;
  /** The incident each affected thread belongs to, by `threadKey`. */
  readonly byThreadKey: ReadonlyMap<string, ThreadIncident>;
  /** How many threads each cause holds, lone ones included, by cause key. */
  readonly threadCountByCause: ReadonlyMap<string, number>;
}

const EMPTY_THREAD_INCIDENTS: ThreadIncidents = {
  incidents: [],
  byThreadKey: new Map(),
  threadCountByCause: new Map(),
};

/** Groups threads by shared cause; a cause becomes an incident once it holds two threads. */
export function groupThreadIncidents(
  threads: ReadonlyArray<ThreadIncidentInput>,
  context: ThreadIncidentContext,
): ThreadIncidents {
  const groups = new Map<string, { cause: ThreadIncidentCause; threadKeys: string[] }>();
  for (const thread of threads) {
    const cause = threadIncidentCause(thread, context);
    if (cause === null) continue;
    const key = threadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const group = groups.get(cause.key);
    if (group) group.threadKeys.push(key);
    else groups.set(cause.key, { cause, threadKeys: [key] });
  }
  const incidents = [...groups.values()]
    .filter((group) => group.threadKeys.length >= THREAD_INCIDENT_MIN_THREADS)
    .sort(
      (a, b) => b.threadKeys.length - a.threadKeys.length || a.cause.key.localeCompare(b.cause.key),
    );
  if (groups.size === 0) return EMPTY_THREAD_INCIDENTS;
  const byThreadKey = new Map<string, ThreadIncident>();
  for (const incident of incidents) {
    for (const key of incident.threadKeys) byThreadKey.set(key, incident);
  }
  const threadCountByCause = new Map(
    [...groups].map(([key, group]) => [key, group.threadKeys.length] as const),
  );
  return { incidents, byThreadKey, threadCountByCause };
}

/** The incident a thread belongs to, or null when it waits on nothing shared. */
export function threadIncidentOf(
  incidents: ThreadIncidents,
  ref: ScopedThreadRef,
): ThreadIncident | null {
  return incidents.byThreadKey.get(threadKey(ref)) ?? null;
}

/** Equal when the same causes hold the same threads, so a reader can keep the previous value. */
export function sameThreadIncidents(previous: ThreadIncidents, next: ThreadIncidents): boolean {
  return (
    previous.threadCountByCause.size === next.threadCountByCause.size &&
    [...next.threadCountByCause].every(
      ([key, count]) => previous.threadCountByCause.get(key) === count,
    ) &&
    previous.incidents.length === next.incidents.length &&
    previous.incidents.every((incident, index) => {
      const other = next.incidents[index]!;
      return (
        incident.cause.key === other.cause.key &&
        incident.threadKeys.every((key, keyIndex) => key === other.threadKeys[keyIndex])
      );
    })
  );
}

export interface EndedThreadIncident {
  readonly incident: ThreadIncident;
  /** False when the threads were archived or settled away, or the machine was removed. */
  readonly recovered: boolean;
}

/**
 * Carries the incidents a reader has shown forward and reports the ones that ended. An incident
 * stays open while any thread still holds its cause, even one alone, and an offline machine's
 * incident stays open while that machine reconnects, so threads that resume one at a time and a
 * reconnect through "connecting" still end it once, as recovered.
 */
export function advanceOpenThreadIncidents(
  open: ReadonlyMap<string, ThreadIncident>,
  current: ThreadIncidents,
  threads: ReadonlyArray<ThreadIncidentInput>,
  context: ThreadIncidentContext,
): {
  readonly open: ReadonlyMap<string, ThreadIncident>;
  readonly ended: ReadonlyArray<EndedThreadIncident>;
} {
  const next = new Map<string, ThreadIncident>();
  for (const incident of current.incidents) next.set(incident.cause.key, incident);
  const ended: Array<EndedThreadIncident> = [];
  for (const [key, incident] of open) {
    if (next.has(key)) continue;
    const { cause } = incident;
    const stillHeld =
      (current.threadCountByCause.get(key) ?? 0) > 0 ||
      (cause.kind === "machine-offline" &&
        context.machineByEnvironment.get(cause.environmentId) === "connecting");
    if (stillHeld) next.set(key, incident);
    else ended.push({ incident, recovered: threadIncidentRecovered(incident, threads, context) });
  }
  return { open: next, ended };
}

function threadIncidentRecovered(
  incident: ThreadIncident,
  threads: ReadonlyArray<ThreadIncidentInput>,
  context: ThreadIncidentContext,
): boolean {
  const { cause } = incident;
  const machine = context.machineByEnvironment.get(cause.environmentId);
  // A machine that is gone or unreachable has not recovered anything it was blamed for.
  if (machine !== "live") return false;
  if (cause.kind === "machine-offline") return true;
  if (cause.kind === "provider-outage") {
    return !context.downProviders.has(
      providerInstanceKey(cause.environmentId, cause.providerInstanceId),
    );
  }
  const affected = new Set(incident.threadKeys);
  return threads.some((thread) => {
    if (!affected.has(threadKey({ environmentId: thread.environmentId, threadId: thread.id }))) {
      return false;
    }
    const status = resolveThreadStatus(thread);
    return status !== "failed" && status !== "limited";
  });
}
