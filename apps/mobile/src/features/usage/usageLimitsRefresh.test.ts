import { EnvironmentId } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type RefreshResult = AsyncResult.AsyncResult<void, string>;

const state = vi.hoisted(() => ({
  refresh: (_environmentId: string): Promise<RefreshResult> => {
    throw new Error("refresh not set up");
  },
}));
vi.mock("../../state/server", async () => {
  const Effect = await import("effect/Effect");
  return {
    serverEnvironment: {
      refreshProviders: {
        label: "refresh providers",
        run: (_registry: unknown, input: { readonly environmentId: string }) =>
          Effect.promise(() => state.refresh(input.environmentId)).pipe(
            Effect.flatMap((result) =>
              result._tag === "Failure" ? Effect.failCause(result.cause) : Effect.void,
            ),
          ),
      },
    },
  };
});

import {
  environmentIdsKey,
  limitsRefreshFailuresAtom,
  limitsRefreshingEnvironmentIdsAtom,
  refreshEnvironmentLimits,
} from "./usageLimitsRefresh";

const success: RefreshResult = AsyncResult.success(undefined);
const failure: RefreshResult = AsyncResult.failure(Cause.fail("offline"));

function setup(refresh: (environmentId: string) => Promise<RefreshResult>) {
  state.refresh = refresh;
  const registry = AtomRegistry.make();
  return {
    registry,
    failures: (ids: readonly EnvironmentId[]) => {
      const atom = limitsRefreshFailuresAtom(environmentIdsKey(ids));
      registry.mount(atom);
      return registry.get(atom);
    },
  };
}

it("keeps a newer environment failure when an older refresh finishes", async () => {
  const a = EnvironmentId.make("mobile-limits-a");
  const b = EnvironmentId.make("mobile-limits-b");
  const pending = Promise.withResolvers<RefreshResult>();
  const { registry, failures } = setup((environmentId) =>
    environmentId === a ? pending.promise : Promise.resolve(failure),
  );
  failures([a, b]);
  const first = refreshEnvironmentLimits(registry, a);
  await refreshEnvironmentLimits(registry, b, { automatic: true });
  expect(failures([a, b])).toEqual([b]);
  pending.resolve(success);
  await first;
  expect(failures([a, b])).toEqual([b]);
});

it("does not let an older refresh clear a newer failure for the same environment", async () => {
  const a = EnvironmentId.make("mobile-limits-race-a");
  const b = EnvironmentId.make("mobile-limits-race-b");
  const aFirst = Promise.withResolvers<RefreshResult>();
  const bFirst = Promise.withResolvers<RefreshResult>();
  let aCalls = 0;
  const { registry, failures } = setup((environmentId) =>
    environmentId === b
      ? bFirst.promise
      : ++aCalls === 1
        ? aFirst.promise
        : Promise.resolve(failure),
  );
  failures([a, b]);
  const older = Promise.all([
    refreshEnvironmentLimits(registry, a, { automatic: true }),
    refreshEnvironmentLimits(registry, b, { automatic: true }),
  ]);
  aFirst.resolve(success);
  await refreshUsageLimits(a, () => aFirst.promise);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([a]);
  bFirst.resolve(success);
  await older;
  expect(failures([a, b])).toEqual([a]);
});

it("skips an automatic refresh inside the throttle window without touching the outcome", async () => {
  const a = EnvironmentId.make("mobile-limits-throttle");
  const { registry, failures } = setup(() => Promise.resolve(failure));
  failures([a]);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([a]);
  state.refresh = () => Promise.resolve(success);
  await refreshEnvironmentLimits(registry, a, { automatic: true });
  expect(failures([a])).toEqual([a]);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([]);
});

it("clears a Limits environment's pending state as soon as its own request settles", async () => {
  const desk = EnvironmentId.make("mobile-limits-pending-desk");
  const laptop = EnvironmentId.make("mobile-limits-pending-laptop");
  const deskRequest = Promise.withResolvers<RefreshResult>();
  const laptopRequest = Promise.withResolvers<RefreshResult>();
  const bothStarted = Promise.withResolvers<void>();
  const started = new Set<string>();
  const { registry } = setup((id) => {
    started.add(id);
    if (started.size === 2) bothStarted.resolve();
    return id === desk ? deskRequest.promise : laptopRequest.promise;
  });
  const atom = limitsRefreshingEnvironmentIdsAtom(environmentIdsKey([desk, laptop]));
  const unmount = registry.mount(atom);
  const first = refreshEnvironmentLimits(registry, desk);
  const second = refreshEnvironmentLimits(registry, laptop);
  await bothStarted.promise;
  expect(registry.get(atom)).toEqual(new Set([desk, laptop]));
  deskRequest.resolve(success);
  await first;
  expect(registry.get(atom)).toEqual(new Set([laptop]));
  laptopRequest.resolve(success);
  await second;
  expect(registry.get(atom).size).toBe(0);
  unmount();
});

it("keeps the Limits request pending when the view unmounts and remounts", async () => {
  const id = EnvironmentId.make("remount");
  const request = Promise.withResolvers<RefreshResult>();
  const started = Promise.withResolvers<void>();
  state.refresh = () => {
    started.resolve();
    return request.promise;
  };
  const tasks = new Set<() => void>();
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
  });
  const atom = limitsRefreshingEnvironmentIdsAtom(environmentIdsKey([id]));
  const stop = registry.mount(atom);
  const refresh = refreshEnvironmentLimits(registry, id);
  await started.promise;
  stop();
  for (const task of tasks) {
    tasks.delete(task);
    task();
  }
  const unmount = registry.mount(atom);
  expect(registry.get(atom).has(id)).toBe(true);
  request.resolve(success);
  await refresh;
  expect(registry.get(atom).has(id)).toBe(false);
  unmount();
  registry.dispose();
});
