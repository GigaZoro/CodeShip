import {
  type DelegatedTaskRole,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  repositoryKeysOf,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as MachinePlacement from "./MachinePlacement.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO = 4;
export const REPO_IMPLEMENTATION_CAP_ENV = "T3CODE_REPO_IMPLEMENTATION_CAP";
const DEFAULT_REPO_CONCURRENCY_PEER_PROBE_TIMEOUT = Duration.millis(1500);

export type NonImplementationDelegatedRole = "review" | "research" | "design";
const NON_IMPLEMENTATION_ROLES: ReadonlySet<string> = new Set<NonImplementationDelegatedRole>([
  "review",
  "research",
  "design",
]);

const decodePeerCapacity = Schema.decodeUnknownOption(
  Schema.Struct({
    capacity: Schema.optional(
      Schema.Struct({
        activeImplementationThreadsByRepo: Schema.optional(
          Schema.Record(Schema.String, Schema.Number),
        ),
      }),
    ),
  }),
);

export interface RepoConcurrencyMachineCount {
  readonly environmentId: EnvironmentId | "local";
  readonly label: string;
  readonly count: number;
}

export interface RepoConcurrencyDecision {
  readonly allowed: boolean;
  readonly activeCount: number;
  readonly requestedCount: number;
  readonly limit: number;
  readonly repoKey: string | null;
  readonly breakdown: ReadonlyArray<RepoConcurrencyMachineCount>;
}

export type RepoConcurrencyReservationResult<A> =
  | { readonly admitted: true; readonly decision: RepoConcurrencyDecision; readonly value: A }
  | { readonly admitted: false; readonly decision: RepoConcurrencyDecision };

export interface RepoConcurrencyCheckInput {
  readonly projectId: ProjectId;
  /** Number of new implementation threads being admitted in this request (defaults to 1). */
  readonly requestedCount?: number;
}

export interface RepoConcurrencyAdmissionOptions {
  readonly limit?: number;
  readonly probeTimeout?: Duration.Input;
}

export function isNonImplementationRole(
  role: DelegatedTaskRole | undefined,
): role is NonImplementationDelegatedRole {
  return role !== undefined && NON_IMPLEMENTATION_ROLES.has(role);
}

/**
 * Parses `T3CODE_REPO_IMPLEMENTATION_CAP` as a strict positive integer,
 * falling back to {@link DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO}.
 */
export function parseRepoImplementationCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO;
}

/**
 * Computes a single machine's active implementation thread count for a repository
 * without double-counting alias keys (e.g. canonical remote URL and repo slug)
 * that `readLocalCapacity` increments for each active thread.
 */
export function maxRepoCountForKeys(
  countsByRepo: Readonly<Record<string, number>> | undefined,
  targetKeys: ReadonlyArray<string>,
): number {
  if (countsByRepo === undefined || targetKeys.length === 0) return 0;
  let max = 0;
  for (const key of targetKeys) {
    const value = countsByRepo[key];
    if (typeof value === "number" && Number.isFinite(value) && value > max) {
      max = Math.floor(value);
    }
  }
  return max;
}

export function formatRepoConcurrencyFailure(
  decision: RepoConcurrencyDecision,
): OrchestratorMcpFailure {
  const details = decision.breakdown
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.label}: ${entry.count}`)
    .join(", ");
  const repoLabel = decision.repoKey ?? "this repository";
  const where = details.length > 0 ? ` (${details})` : "";
  const requesting =
    decision.requestedCount > 1 ? ` while requesting ${decision.requestedCount} more` : "";
  return new OrchestratorMcpFailure({
    code: "repo_capacity_full",
    message:
      `Repository concurrency limit reached for ${repoLabel}: ${decision.activeCount}/${decision.limit} active or landing implementation threads${where}${requesting}. ` +
      `Wait for an active implementation or landing thread to finish before starting another, or pass capExemption: "broken_main" or "incident" only for broken-main fixes or money/production incidents.`,
  });
}

const fallbackOnNonInterrupt = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: () => A,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.orElseSucceed(fallback),
    Effect.catchDefect(() => Effect.sync(fallback)),
  );

/**
 * Enforces the fleet-wide per-repository concurrent implementation thread cap
 * across the local environment and all reachable linked environments.
 */
export class RepoConcurrencyAdmission extends Context.Service<
  RepoConcurrencyAdmission,
  {
    readonly limit: number;
    readonly check: (input: RepoConcurrencyCheckInput) => Effect.Effect<RepoConcurrencyDecision>;
    /**
     * Atomically checks capacity and reserves `requestedCount` local in-flight slots for the
     * target repository across `use`, serializing only the check-and-reserve phase per repo key
     * and releasing the reservation once `use` completes, fails, or is interrupted.
     */
    readonly withReservation: <A, E, R>(
      input: RepoConcurrencyCheckInput,
      use: (decision: RepoConcurrencyDecision) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<RepoConcurrencyReservationResult<A>, E, R>;
  }
>()("t3/peer/RepoConcurrencyAdmission") {}

export const withRepoConcurrencySlot = <A, E, R>(input: {
  readonly admission: Option.Option<RepoConcurrencyAdmission["Service"]>;
  readonly projectId: ProjectId;
  readonly requestedCount?: number;
  readonly use: () => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | OrchestratorMcpFailure, R> => {
  if (Option.isNone(input.admission)) return input.use();
  return input.admission.value
    .withReservation(
      {
        projectId: input.projectId,
        ...(input.requestedCount === undefined ? {} : { requestedCount: input.requestedCount }),
      },
      () => input.use(),
    )
    .pipe(
      Effect.flatMap((result) =>
        result.admitted
          ? Effect.succeed(result.value)
          : Effect.fail(formatRepoConcurrencyFailure(result.decision)),
      ),
    );
};

const make = Effect.fn("RepoConcurrencyAdmission.make")(function* (
  options: RepoConcurrencyAdmissionOptions = {},
) {
  const platform = yield* HostProcess.Platform;
  const projects = yield* ProjectService.ProjectService;
  const memoryAdmission = yield* MemoryAdmission.MemoryAdmission;
  const hostResources = yield* Effect.serviceOption(HostResources.HostResources);
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcpClient = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

  const envCap = Option.getOrUndefined(
    yield* Config.String(REPO_IMPLEMENTATION_CAP_ENV).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
  );
  const limit =
    options.limit !== undefined && Number.isSafeInteger(options.limit) && options.limit > 0
      ? options.limit
      : parseRepoImplementationCap(envCap);
  const probeTimeout = options.probeTimeout ?? DEFAULT_REPO_CONCURRENCY_PEER_PROBE_TIMEOUT;
  const hereEnvironmentId = Option.isSome(serverEnvironment)
    ? Option.some(yield* serverEnvironment.value.getEnvironmentId)
    : Option.none<EnvironmentId>();

  // Per-key check locks and local in-flight slot reservations. Kept strictly local to this
  // admission service (never surfaced in `MachinePlacement.readLocalCapacity`) so a remote peer
  // probing this host during a delegated launch never double-counts the parent's own reservation.
  const repoLocks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const inFlightByRepoKey = new Map<string, number>();

  const maxInFlightForKeys = (targetKeys: ReadonlyArray<string>): number => {
    let max = 0;
    for (const key of targetKeys) {
      const value = inFlightByRepoKey.get(key) ?? 0;
      if (value > max) max = value;
    }
    return max;
  };

  const reserveKeys = (targetKeys: ReadonlyArray<string>, count: number): void => {
    for (const key of targetKeys) {
      inFlightByRepoKey.set(key, (inFlightByRepoKey.get(key) ?? 0) + count);
    }
  };

  const releaseKeys = (targetKeys: ReadonlyArray<string>, count: number): void => {
    for (const key of targetKeys) {
      const next = (inFlightByRepoKey.get(key) ?? 0) - count;
      if (next <= 0) {
        inFlightByRepoKey.delete(key);
      } else {
        inFlightByRepoKey.set(key, next);
      }
    }
  };

  const withRepoCheckLocks = <A, E, R>(
    targetKeys: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    // Canonical ascending key order prevents deadlocks when two repos share an alias key.
    const sortedKeys = [...new Set(targetKeys)].toSorted();
    const acquireAll = (index: number): Effect.Effect<A, E, R> => {
      if (index >= sortedKeys.length) return effect;
      const key = sortedKeys[index]!;
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = repoLocks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users += 1;
          repoLocks.set(key, entry);
          return entry;
        }),
        (entry) => entry.semaphore.withPermits(1)(acquireAll(index + 1)),
        (entry) =>
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users <= 0) {
              repoLocks.delete(key);
            }
          }),
      );
    };
    return acquireAll(0);
  };

  const resolveTargetKeys = (projectId: ProjectId): Effect.Effect<ReadonlyArray<string>> =>
    fallbackOnNonInterrupt(projects.getWithRepositoryIdentity(projectId), () => Option.none()).pipe(
      Effect.map((project) =>
        Option.isNone(project) || project.value.repositoryIdentity == null
          ? []
          : repositoryKeysOf(project.value.repositoryIdentity),
      ),
    );

  const evaluateForKeys = Effect.fn("RepoConcurrencyAdmission.evaluateForKeys")(function* (
    targetKeys: ReadonlyArray<string>,
    requestedCount: number,
  ) {
    const inFlight = maxInFlightForKeys(targetKeys);
    const readLocalCount = MachinePlacement.readLocalCapacity({
      hostResources,
      memoryAdmission,
      projections,
      projects,
    }).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.map((capacity): RepoConcurrencyMachineCount => ({
        environmentId: "local",
        label: "local",
        count:
          maxRepoCountForKeys(capacity.activeImplementationThreadsByRepo, targetKeys) + inFlight,
      })),
      Effect.catchDefect(() =>
        Effect.succeed<RepoConcurrencyMachineCount>({
          environmentId: "local",
          label: "local",
          count: inFlight,
        }),
      ),
    );

    const readPeerCounts = Effect.gen(function* () {
      if (Option.isNone(peerLinks) || Option.isNone(peerMcpClient)) {
        return [] as ReadonlyArray<RepoConcurrencyMachineCount>;
      }
      const enabled = yield* fallbackOnNonInterrupt(peerLinks.value.enabled, () => false);
      if (!enabled) {
        return [] as ReadonlyArray<RepoConcurrencyMachineCount>;
      }
      const listed = yield* fallbackOnNonInterrupt(peerLinks.value.list, () => []);
      const reachablePeers = listed.filter(
        (link) =>
          link.status === "reachable" &&
          (Option.isNone(hereEnvironmentId) || link.environmentId !== hereEnvironmentId.value),
      );
      if (reachablePeers.length === 0) {
        return [] as ReadonlyArray<RepoConcurrencyMachineCount>;
      }
      return yield* Effect.forEach(
        reachablePeers,
        (link) =>
          fallbackOnNonInterrupt(
            peerMcpClient.value
              .callIfAvailable({
                environmentId: link.environmentId,
                tool: "orchestrator_capabilities",
                arguments: {},
                limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
                success: Schema.Unknown,
              })
              .pipe(Effect.timeoutOption(probeTimeout), Effect.map(Option.flatten)),
            () => Option.none(),
          ).pipe(
            Effect.map((response): RepoConcurrencyMachineCount => {
              if (Option.isNone(response)) {
                return { environmentId: link.environmentId, label: link.label, count: 0 };
              }
              const decoded = decodePeerCapacity(response.value);
              const count = Option.isSome(decoded)
                ? maxRepoCountForKeys(
                    decoded.value.capacity?.activeImplementationThreadsByRepo,
                    targetKeys,
                  )
                : 0;
              return { environmentId: link.environmentId, label: link.label, count };
            }),
          ),
        { concurrency: "unbounded" },
      );
    });

    const [localCount, peerCounts] = yield* Effect.all([readLocalCount, readPeerCounts], {
      concurrency: "unbounded",
    });
    const breakdown = [localCount, ...peerCounts];
    const activeCount = breakdown.reduce((sum, entry) => sum + entry.count, 0);
    return {
      allowed: activeCount + requestedCount <= limit,
      activeCount,
      requestedCount,
      limit,
      repoKey: targetKeys[0] ?? null,
      breakdown,
    } satisfies RepoConcurrencyDecision;
  });

  const check: RepoConcurrencyAdmission["Service"]["check"] = Effect.fn(
    "RepoConcurrencyAdmission.check",
  )(function* (input) {
    const requestedCount = Math.max(1, Math.floor(input.requestedCount ?? 1));
    const targetKeys = yield* resolveTargetKeys(input.projectId);
    if (targetKeys.length === 0) {
      return {
        allowed: true,
        activeCount: 0,
        requestedCount,
        limit,
        repoKey: null,
        breakdown: [],
      } satisfies RepoConcurrencyDecision;
    }
    return yield* evaluateForKeys(targetKeys, requestedCount);
  });

  const withReservation: RepoConcurrencyAdmission["Service"]["withReservation"] = Effect.fn(
    "RepoConcurrencyAdmission.withReservation",
  )(function* <A, E, R>(
    input: RepoConcurrencyCheckInput,
    use: (decision: RepoConcurrencyDecision) => Effect.Effect<A, E, R>,
  ) {
    const requestedCount = Math.max(1, Math.floor(input.requestedCount ?? 1));
    const targetKeys = yield* resolveTargetKeys(input.projectId);
    if (targetKeys.length === 0) {
      const decision: RepoConcurrencyDecision = {
        allowed: true,
        activeCount: 0,
        requestedCount,
        limit,
        repoKey: null,
        breakdown: [],
      };
      const value = yield* use(decision);
      return { admitted: true, decision, value } satisfies RepoConcurrencyReservationResult<A>;
    }

    return yield* Effect.uninterruptibleMask((restore) => {
      let reserved = false;
      return Effect.gen(function* () {
        const decision = yield* restore(
          withRepoCheckLocks(
            targetKeys,
            Effect.uninterruptibleMask((restoreInLock) =>
              Effect.gen(function* () {
                const evaluated = yield* restoreInLock(evaluateForKeys(targetKeys, requestedCount));
                if (evaluated.allowed) {
                  reserveKeys(targetKeys, requestedCount);
                  reserved = true;
                }
                return evaluated;
              }),
            ),
          ),
        );
        if (!decision.allowed) {
          return { admitted: false, decision } satisfies RepoConcurrencyReservationResult<A>;
        }
        const value = yield* restore(use(decision));
        return { admitted: true, decision, value } satisfies RepoConcurrencyReservationResult<A>;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (reserved) {
              reserved = false;
              releaseKeys(targetKeys, requestedCount);
            }
          }),
        ),
      );
    });
  });

  return RepoConcurrencyAdmission.of({ limit, check, withReservation });
});

export const layerLive = (options?: RepoConcurrencyAdmissionOptions) =>
  Layer.effect(RepoConcurrencyAdmission, make(options));

export const layer = layerLive();

export const layerTest = (
  impl?:
    | Partial<RepoConcurrencyAdmission["Service"]>
    | ((input: RepoConcurrencyCheckInput) => Effect.Effect<RepoConcurrencyDecision>),
): Layer.Layer<RepoConcurrencyAdmission> => {
  const defaultWithReservation = (
    checkFn: RepoConcurrencyAdmission["Service"]["check"],
  ): RepoConcurrencyAdmission["Service"]["withReservation"] =>
    Effect.fn("RepoConcurrencyAdmission.withReservation")(function* <A, E, R>(
      input: RepoConcurrencyCheckInput,
      use: (decision: RepoConcurrencyDecision) => Effect.Effect<A, E, R>,
    ) {
      const decision = yield* checkFn(input);
      if (!decision.allowed) {
        return { admitted: false, decision } satisfies RepoConcurrencyReservationResult<A>;
      }
      const value = yield* use(decision);
      return { admitted: true, decision, value } satisfies RepoConcurrencyReservationResult<A>;
    });

  if (typeof impl === "function") {
    return Layer.succeed(RepoConcurrencyAdmission, {
      limit: DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO,
      check: impl,
      withReservation: defaultWithReservation(impl),
    });
  }
  const limit = impl?.limit ?? DEFAULT_MAX_ACTIVE_IMPLEMENTATION_THREADS_PER_REPO;
  const check =
    impl?.check ??
    ((input) =>
      Effect.succeed({
        allowed: true,
        activeCount: 0,
        requestedCount: Math.max(1, Math.floor(input.requestedCount ?? 1)),
        limit,
        repoKey: null,
        breakdown: [],
      }));
  return Layer.succeed(RepoConcurrencyAdmission, {
    limit,
    check,
    withReservation: impl?.withReservation ?? defaultWithReservation(check),
  });
};
