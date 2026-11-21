import {
  AuthSettingsWriteScope,
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type ServerProvider,
  type UsageModelFilter,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import {
  cursorKeychainAccessEnvironments,
  cursorUsageAccess,
  resolveCursorUsageAccess,
  refreshUsage,
  refreshUsageLimits,
  usageRefreshingEnvironmentIdsAtom,
} from "./usage.ts";

const input = {
  sinceDay: UsageDay.make("2026-09-05"),
  untilDay: UsageDay.make("2026-09-05"),
  timeZone: "UTC",
};
const pricing = { status: "fresh" as const, source: "test", fetchedAt: null, knownModels: 1 };
const summary: UsageSummary = {
  ...input,
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-05T12:00:00Z",
  buckets: [],
  sources: [],
  pricing,
  scanDurationMs: 1,
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function harness(ids = ["a"], modelFilters: Record<string, UsageModelFilter> = {}) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const environments = ids.map((id) => {
    const environmentId = EnvironmentId.make(id);
    const rates = Promise.withResolvers<
      AsyncResult.Success<typeof pricing> | AsyncResult.Failure<never, unknown>
    >();
    const scan = Promise.withResolvers<UsageSummary>();
    const scanStarted = Promise.withResolvers<void>();
    const presentation = Atom.make({
      connection: { phase: "connected" },
    } as EnvironmentPresentation | null);
    const query = Atom.make(
      Effect.promise(() => {
        scanStarted.resolve();
        return scan.promise;
      }),
    );
    return { environmentId, rates, scan, scanStarted, presentation, query };
  });
  function get(environmentId: EnvironmentId) {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
    return environment;
  }
  const requested: { environmentId: EnvironmentId; input: UsageSummaryInput }[] = [];
  const options = {
    registry,
    environmentIds: environments.map((entry) => entry.environmentId),
    input,
    server: {
      usageSummary: (target: { environmentId: EnvironmentId; input: UsageSummaryInput }) => {
        requested.push(target);
        return get(target.environmentId).query;
      },
      usageModelFilterAtom: (environmentId: EnvironmentId) =>
        Atom.make<UsageModelFilter | undefined>(modelFilters[environmentId]),
      refreshUsageRates: {
        label: "test:rates",
        requiredScopes: () => [],
        permissionAtom: () => Atom.make(true),
        run: (
          _registry: AtomRegistry.AtomRegistry,
          { environmentId }: { environmentId: EnvironmentId },
        ) => get(environmentId).rates.promise,
      },
    },
    presentations: {
      presentationAtom: (environmentId: EnvironmentId) => get(environmentId).presentation,
    },
  } satisfies Parameters<typeof refreshUsage>[0];
  return { registry, environments, requested, options, refresh: () => refreshUsage(options) };
}

describe("manual usage refresh", () => {
  it.each(["success", "failure"])("waits for the rescan after a pricing %s", async (result) => {
    const {
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    let finished = false;
    const refreshing = refresh().then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    entry.rates.resolve(
      result === "success"
        ? AsyncResult.success(pricing)
        : AsyncResult.fail(new Error("Pricing offline")),
    );
    await entry.scanStarted.promise;
    expect(finished).toBe(false);
    entry.scan.resolve(summary);
    await refreshing;
    expect(finished).toBe(true);
  });

  it("rescans each environment with its own configured model filter", async () => {
    const modelFilter = { include: [{ provider: "claude" as const, model: "orbit-1" }] };
    const { environments, requested, refresh } = harness(["filtered", "plain"], {
      filtered: modelFilter,
    });
    const refreshing = refresh();
    for (const entry of environments) {
      entry.rates.resolve(AsyncResult.success(pricing));
      entry.scan.resolve(summary);
    }
    await refreshing;
    expect(requested).toEqual([
      { environmentId: "filtered", input: { ...input, modelFilter } },
      { environmentId: "plain", input },
    ]);
  });

  it("tracks each manual Usage refresh through its own rescan", async () => {
    const { registry, environments, refresh } = harness(["desk", "laptop"]);
    const [desk, laptop] = environments;
    const onlyLaptop = Promise.withResolvers<void>();
    const unmount = registry.mount(usageRefreshingEnvironmentIdsAtom);
    const unsubscribe = registry.subscribe(usageRefreshingEnvironmentIdsAtom, (ids) => {
      if (ids.size === 1 && ids.has(laptop!.environmentId)) onlyLaptop.resolve();
    });
    const refreshing = refresh();
    expect(registry.get(usageRefreshingEnvironmentIdsAtom)).toEqual(
      new Set(environments.map((env) => env.environmentId)),
    );
    for (const entry of environments) entry.rates.resolve(AsyncResult.success(pricing));
    await Promise.all(environments.map((env) => env.scanStarted.promise));
    desk!.scan.resolve(summary);
    await onlyLaptop.promise;
    expect(registry.get(usageRefreshingEnvironmentIdsAtom)).toEqual(
      new Set([laptop!.environmentId]),
    );
    laptop!.scan.resolve(summary);
    await refreshing;
    expect(registry.get(usageRefreshingEnvironmentIdsAtom).size).toBe(0);
    unsubscribe();
    unmount();
  });

  it("settles when an environment disconnects during the rescan", async () => {
    const {
      registry,
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    const refreshing = refresh();
    entry.rates.resolve(AsyncResult.success(pricing));
    await entry.scanStarted.promise;
    registry.set(entry.presentation, null);
    await refreshing;
  });

  it("waits for healthy environments without waiting for a recovering environment", async () => {
    const { registry, environments, refresh } = harness(["healthy", "recovering"]);
    const [healthy, recovering] = environments;
    registry.set(recovering!.presentation, null);
    let finished = false;
    const refreshing = refresh().then(() => {
      finished = true;
    });
    for (const entry of environments) entry.rates.resolve(AsyncResult.success(pricing));
    await healthy!.scanStarted.promise;
    expect(finished).toBe(false);
    healthy!.scan.resolve(summary);
    await refreshing;
    expect(finished).toBe(true);
  });

  it("replaces a scan that started before pricing was refreshed", async () => {
    const {
      registry,
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    let reads = 0;
    const rescanned = Promise.withResolvers<void>();
    const query = Atom.make(
      Effect.promise(() => {
        reads += 1;
        if (reads > 1) {
          rescanned.resolve();
          return Promise.resolve(summary);
        }
        return new Promise<UsageSummary>(() => {});
      }),
    );
    entry.query = query;
    const unmount = registry.mount(query);
    expect(reads).toBe(1);
    const refreshing = refresh();
    entry.rates.resolve(AsyncResult.success(pricing));
    await rescanned.promise;
    await refreshing;
    expect(reads).toBe(2);
    unmount();
  });
});

describe("limits refresh cooldown", () => {
  it("runs a fresh check after an in-flight check when settings change", async () => {
    const id = EnvironmentId.make("limits-after-enable");
    const oldCheck = Promise.withResolvers<string>();
    const first = refreshUsageLimits(id, () => oldCheck.promise, true);
    const newCheck = vi.fn(async () => "new limits");
    const afterEnable = refreshUsageLimits(id, newCheck, false, true);
    expect(newCheck).not.toHaveBeenCalled();
    oldCheck.resolve("old limits");
    expect(await first).toBe("old limits");
    expect(await afterEnable).toBe("new limits");
    expect(newCheck).toHaveBeenCalledTimes(1);
  });
});

describe("Cursor account usage access", () => {
  const cursorPrompt: UsageSummary = {
    ...summary,
    sources: [
      {
        fingerprint: {
          hostId: "host",
          provider: "cursor",
          resolvedHomePath: "/Users/me/.cursor/auth.json",
          volumeId: "volume",
        },
        status: "ok",
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 0,
        message: "Cursor account usage is off on this environment.",
        action: "enableCursorKeychain",
      },
    ],
  };
  const cursor = (status: ServerProvider["status"]): ServerProvider => ({
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: status !== "disabled",
    installed: status === "ready",
    version: null,
    status,
    auth: { status: "unknown" },
    checkedAt: "2026-09-05T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });

  const access = (provider: ServerProvider, summary: UsageSummary | null) =>
    resolveCursorUsageAccess({
      access: cursorUsageAccess({ settings: DEFAULT_SERVER_SETTINGS, providers: [provider] }),
      summary,
      isConnected: true,
      session: { authenticated: true, scopes: [AuthSettingsWriteScope] },
    });

  it("uses legacy summary hints only for a server without a history status", () => {
    const ready = cursor("ready");
    expect(access(ready, cursorPrompt).needsCursorKeychainAccess).toBe(true);
    expect(access(ready, null).needsCursorKeychainAccess).toBe(false);
    expect(
      access({ ...ready, cursorAccountHistory: "unavailable" }, cursorPrompt)
        .needsCursorKeychainAccess,
    ).toBe(false);
    const account: UsageSummary = {
      ...summary,
      sources: [
        {
          fingerprint: {
            hostId: "cursor.com",
            provider: "cursor",
            resolvedHomePath: "cursor-account:abc",
            volumeId: "abc",
          },
          status: "ok",
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 1,
          message: null,
        },
      ],
    };

    const off = access({ ...ready, cursorAccountHistory: "keychainOff" }, null);
    expect(cursorKeychainAccessEnvironments([off, access(ready, account)])).toEqual([]);
    expect(
      cursorKeychainAccessEnvironments([
        off,
        access({ ...ready, cursorAccountHistory: "unavailable" }, account),
      ]),
    ).toEqual([off]);
  });
});

it("keeps overlapping Usage refresh counts through unmount and remount", async () => {
  const tasks = new Set<() => void>();
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
  });
  registries.push(registry);
  const atom = usageRefreshingEnvironmentIdsAtom;
  const old = harness();
  const newer = harness();
  const stop = registry.mount(atom);
  const first = refreshUsage({ ...old.options, registry });
  stop();
  for (const task of tasks) {
    tasks.delete(task);
    task();
  }
  const unmount = registry.mount(atom);
  expect([...registry.get(atom)]).toEqual(["a"]);
  const second = refreshUsage({ ...newer.options, registry });
  old.environments[0]!.rates.resolve(AsyncResult.success(pricing));
  old.environments[0]!.scan.resolve(summary);
  await first;
  expect([...registry.get(atom)]).toEqual(["a"]);
  newer.environments[0]!.rates.resolve(AsyncResult.success(pricing));
  newer.environments[0]!.scan.resolve(summary);
  await second;
  expect(registry.get(atom).size).toBe(0);
  unmount();
});
