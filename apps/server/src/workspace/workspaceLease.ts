import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

// Commands and terminals can start in an arbitrary subdirectory without a thread's checkout key.
// Keep starts concurrent; a handoff defers if any admission is in flight at its final check.
const admissionPermits = Number.MAX_SAFE_INTEGER;
const admissions = Semaphore.makeUnsafe(admissionPermits);
let completedAdmissions = 0;
export const workspaceAdmissionGeneration = Effect.sync(() => completedAdmissions);
export const withWorkspaceProcessStart = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  admissions.withPermit(
    effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          completedAdmissions++;
        }),
      ),
    ),
  );
export const tryWithWorkspaceStartsPaused = admissions.withPermitsIfAvailable(admissionPermits);
