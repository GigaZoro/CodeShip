import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderConsumeResetCreditOutcome,
  type ServerProvider,
  type ServerProviderResetKind,
  type ServerProviderUsageWindow,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import type { ProviderConsumeResetCreditRequest } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ResetCreditRedemption from "../orchestration-v2/ResetCreditRedemption.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageResetRedeemer from "./UsageResetRedeemer.ts";

const HOUR = 3_600_000;
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-15T12:00:00.000Z"));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (hours: number) => iso(NOW + hours * HOUR);

const account = (
  driver: "claudeAgent" | "codex",
  planResetInHours: number,
  overrides: Partial<ServerProvider> = {},
  grant: { kind: ServerProviderResetKind; usableNow?: boolean } = { kind: "weekly" },
): ServerProvider => {
  const window: ServerProviderUsageWindow = {
    id: "weekly",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 100,
    resetsAt: at(planResetInHours),
    windowDurationMins: 10_080,
  };
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(NOW),
    models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(NOW),
      accountKey: "account-key",
      windows: [window],
      resetCredits: {
        availableCount: 1,
        credits: [
          {
            program: driver === "codex" ? "codexRateLimits" : "granted",
            kind: grant.kind,
            usableNow: grant.usableNow ?? true,
            expiresAt: at(400),
          },
        ],
      },
    },
    ...overrides,
  };
};

interface Claimed {
  readonly instanceId: ProviderInstanceId;
  readonly request: ProviderConsumeResetCreditRequest | undefined;
}

/**
 * A redeemer over fake providers. A fresh reading shows `refreshed`, else the listed provider, and
 * `freshSettings` are the settings from that reading on. Only a sweep's own settings read signals.
 */
const harness = Effect.fn("harness")(function* (input: {
  readonly provider: ServerProvider;
  readonly peers?: ReadonlyArray<ServerProvider>;
  readonly freshPeers?: ReadonlyArray<ServerProvider>;
  readonly redeem?: boolean;
  readonly refreshed?: ServerProvider;
  readonly freshSettings?: Partial<ServerSettingsValue>;
  readonly outcome?: ProviderConsumeResetCreditOutcome | "error";
}) {
  yield* TestClock.setTime(NOW);
  const claims = yield* Queue.unbounded<Claimed>();
  const sweeps = yield* Queue.unbounded<void>();
  const refreshes = yield* Ref.make(0);
  const deciding = yield* Ref.make(false);
  const warnings: string[] = [];
  const settings = yield* Ref.make<ServerSettingsValue>({
    ...DEFAULT_SERVER_SETTINGS,
    redeemUsageResets: input.redeem ?? true,
    maxPlanResetWaitHours: 48,
  });
  const layer = UsageResetRedeemer.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Logger.layer(
          [
            Logger.make(({ logLevel, message }) => {
              if (logLevel === "Warn") warnings.push(JSON.stringify(message));
            }),
          ],
          { mergeWithExisting: false },
        ),
        Scheduler.layer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.gen(function* () {
            if (!(yield* Ref.get(deciding))) yield* Queue.offer(sweeps, undefined);
            return yield* Ref.get(settings);
          }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.gen(function* () {
            const peers = (yield* Ref.get(deciding))
              ? (input.freshPeers ?? input.peers)
              : input.peers;
            return [input.provider, ...(peers ?? [])];
          }),
        }),
        Layer.mock(ResetCreditRedemption.ResetCreditRedemption)({
          redeemOnFreshRead: (instanceId, decide) =>
            Effect.gen(function* () {
              yield* Ref.update(refreshes, (count) => count + 1);
              yield* Ref.update(settings, (current) => ({ ...current, ...input.freshSettings }));
              yield* Ref.set(deciding, true);
              const request = yield* decide(input.refreshed ?? input.provider);
              yield* Ref.set(deciding, false);
              if (request === null) return Option.none();
              yield* Queue.offer(claims, { instanceId, request });
              if (input.outcome === "error") {
                return yield* new ProviderSetupError({
                  instanceId,
                  operation: "consume-reset-credit",
                  detail: "Account acct-private refused.",
                });
              }
              return Option.some({ outcome: input.outcome ?? ("reset" as const) });
            }),
        }),
      ),
    ),
  );
  return { claims, sweeps, refreshes, warnings, layer };
});

/** Waits for the sweep after the next tick, so a claim that was going to happen has happened. */
const afterNextSweep = (
  sweeps: Queue.Queue<void>,
  duration: `${number} ${"seconds" | "minutes"}`,
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(duration);
    yield* Queue.take(sweeps);
  });

describe("UsageResetRedeemer", () => {
  it.effect("claims the reset when the plan reset is further away than the wait", () =>
    Effect.gen(function* () {
      const { claims, layer } = yield* harness({ provider: account("claudeAgent", 49) });
      yield* Effect.gen(function* () {
        const claimed = yield* Queue.take(claims);
        assert.deepEqual(claimed.request, {
          kind: "weekly",
          attemptKey: `banked-reset:account-key:claude:${Math.floor((NOW + 49 * HOUR) / 1000)}`,
          accountKey: "account-key",
        });
        const redeemer = yield* UsageResetRedeemer.UsageResetRedeemer;
        assert.deepEqual((yield* redeemer.lastRedemptions).get("account-key"), {
          at: iso(NOW),
          outcome: "reset",
          kind: "weekly",
          reason: "reset-too-far",
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    { billingKind: "plan", balanceState: "available", usedPercent: 20, expected: 0 },
    { billingKind: "plan", balanceState: "available", usedPercent: 100, expected: 1 },
    { billingKind: "payPerUse", balanceState: "available", usedPercent: 100, expected: 0 },
    { billingKind: "payPerUse", balanceState: "exhausted", usedPercent: 20, expected: 1 },
  ] as const)(
    "preserves resets ahead of $billingKind with $balanceState balance and $usedPercent% plan use",
    ({ billingKind, balanceState, usedPercent, expected }) =>
      Effect.gen(function* () {
        const provider = account("claudeAgent", 100);
        const peer = account("claudeAgent", 100, {
          instanceId: ProviderInstanceId.make("peer"),
          billingKind,
          payPerUse: {
            linkedPlanInstanceId: ProviderInstanceId.make("claude_plan"),
            grantUsd: 50,
            meteringStartedAt: "2026-09-01T00:00:00.000Z",
            unpricedUsage: false,
            cycleStart: "2026-09-01T00:00:00.000Z",
            cycleEnd: "2026-12-01T00:00:00.000Z",
            estimatedRemainingUsd: 48,
            balanceState,
            checkedAt: iso(NOW),
            spendUsd: null,
            spendSource: "metered",
          },
          usageLimits: {
            checkedAt: iso(NOW),
            windows: [
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent, resetsAt: at(100) },
            ],
          },
        });
        const { claims, sweeps, layer } = yield* harness({ provider, peers: [peer] });
        yield* Effect.gen(function* () {
          yield* Queue.take(sweeps);
          yield* afterNextSweep(sweeps, "5 seconds");
          assert.equal(yield* Queue.size(claims), expected);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each([
    { model: "claude-opus-5-5", enabled: true, expected: 0 },
    { model: "claude-sonnet-4-5", enabled: true, expected: 1 },
    { model: "claude-opus-5-5", enabled: false, expected: 1 },
  ])(
    "checks model scope and readiness before preserving a reset ($model, $enabled)",
    ({ model, enabled, expected }) =>
      Effect.gen(function* () {
        const provider = account("claudeAgent", 100, {}, { kind: "full" });
        const scoped = {
          ...provider,
          usageLimits: {
            ...provider.usageLimits!,
            windows: provider.usageLimits!.windows.map((window) => ({
              ...window,
              id: "seven_day_opus",
              model: "opus",
            })),
          },
        };
        const peer = account("claudeAgent", 100, {
          instanceId: ProviderInstanceId.make("api"),
          enabled,
          billingKind: "payPerUse",
          payPerUse: {
            linkedPlanInstanceId: ProviderInstanceId.make("claude_plan"),
            grantUsd: 50,
            meteringStartedAt: "2026-09-01T00:00:00.000Z",
            unpricedUsage: false,
            cycleStart: "2026-09-01T00:00:00.000Z",
            cycleEnd: "2026-12-01T00:00:00.000Z",
            estimatedRemainingUsd: 48,
            balanceState: "available",
            checkedAt: iso(NOW),
            spendUsd: null,
            spendSource: "metered",
          },
          models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
          usageLimits: undefined,
        });
        const { claims, sweeps, layer } = yield* harness({ provider: scoped, peers: [peer] });
        yield* Effect.gen(function* () {
          yield* Queue.take(sweeps);
          yield* afterNextSweep(sweeps, "5 seconds");
          assert.equal(yield* Queue.size(claims), expected);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("rechecks other accounts before spending a reset", () =>
    Effect.gen(function* () {
      const peer = account("claudeAgent", 100, {
        instanceId: ProviderInstanceId.make("api"),
        billingKind: "payPerUse",
        payPerUse: {
          linkedPlanInstanceId: ProviderInstanceId.make("claude_plan"),
          grantUsd: 50,
          meteringStartedAt: "2026-09-01T00:00:00.000Z",
          unpricedUsage: false,
          cycleStart: "2026-09-01T00:00:00.000Z",
          cycleEnd: "2026-12-01T00:00:00.000Z",
          estimatedRemainingUsd: 48,
          balanceState: "available",
          checkedAt: iso(NOW),
          spendUsd: null,
          spendSource: "metered",
        },
      });
      const { claims, sweeps, layer } = yield* harness({
        provider: account("claudeAgent", 100),
        freshPeers: [peer],
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* afterNextSweep(sweeps, "5 seconds");
        assert.equal(yield* Queue.size(claims), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("claims through Codex with the key the provider repeats safely", () =>
    Effect.gen(function* () {
      const { claims, layer } = yield* harness({
        provider: account("codex", 60, {}, { kind: "full" }),
      });
      yield* Effect.gen(function* () {
        const claimed = yield* Queue.take(claims);
        assert.deepEqual(claimed.request, {
          kind: "full",
          attemptKey: `banked-reset:account-key:codex:${Math.floor((NOW + 60 * HOUR) / 1000)}`,
          accountKey: "account-key",
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("waits while the plan reset is within the wait", () =>
    Effect.gen(function* () {
      const { claims, sweeps, layer } = yield* harness({ provider: account("claudeAgent", 47) });
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* afterNextSweep(sweeps, "5 seconds");
        assert.equal(yield* Queue.size(claims), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("claims nothing while the setting is off", () =>
    Effect.gen(function* () {
      const { claims, sweeps, layer } = yield* harness({
        provider: account("claudeAgent", 100),
        redeem: false,
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* afterNextSweep(sweeps, "5 seconds");
        assert.equal(yield* Queue.size(claims), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("never claims a grant held back for something other than a limit", () =>
    Effect.gen(function* () {
      const { claims, sweeps, layer } = yield* harness({
        provider: account("claudeAgent", 100, {}, { kind: "weekly", usableNow: false }),
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* afterNextSweep(sweeps, "5 seconds");
        assert.equal(yield* Queue.size(claims), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([{ availability: "unavailable" }, { billingKind: "payPerUse" }] satisfies Array<
    Partial<ServerProvider>
  >)("skips accounts unavailable for plan reset redemption", (overrides) =>
    Effect.gen(function* () {
      const { claims, sweeps, layer } = yield* harness({
        provider: account("claudeAgent", 100, overrides),
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* afterNextSweep(sweeps, "5 seconds");
        assert.equal(yield* Queue.size(claims), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "reads the account again before claiming and claims nothing the fresh reading drops",
    () =>
      Effect.gen(function* () {
        const used = account("claudeAgent", 100);
        // The limit lifted meanwhile, the login switched to another account that is also out, or
        // the person turned claiming off or raised the wait while the account was read.
        for (const fresh of [
          { refreshed: { ...used, usageLimits: { ...used.usageLimits!, usageAllowed: true } } },
          {
            refreshed: {
              ...used,
              usageLimits: { ...used.usageLimits!, accountKey: "other-account-key" },
            },
          },
          { freshSettings: { redeemUsageResets: false } },
          { freshSettings: { maxPlanResetWaitHours: 168 } },
        ]) {
          const { claims, sweeps, refreshes, layer } = yield* harness({ provider: used, ...fresh });
          yield* Effect.gen(function* () {
            yield* Queue.take(sweeps);
            yield* afterNextSweep(sweeps, "5 seconds");
            assert.equal(yield* Ref.get(refreshes), 1);
            assert.equal(yield* Queue.size(claims), 0);
          }).pipe(Effect.provide(layer));
        }
      }),
  );

  it.effect("does not repeat a claim that got an answer", () =>
    Effect.gen(function* () {
      const { claims, sweeps, layer } = yield* harness({
        provider: account("claudeAgent", 100),
        outcome: "alreadyRedeemed",
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(claims);
        yield* afterNextSweep(sweeps, "20 minutes");
        assert.equal(yield* Queue.size(claims), 0);
        const redeemer = yield* UsageResetRedeemer.UsageResetRedeemer;
        assert.equal((yield* redeemer.lastRedemptions).get("account-key")?.outcome, "already_used");
      }).pipe(Effect.provide(layer));
    }),
  );

  // A refused claim spent nothing, so a reset that becomes available later can still be claimed.
  it.effect.each([
    { outcome: "error", recorded: "failed" },
    { outcome: "noCredit", recorded: "no_reset" },
    { outcome: "nothingToReset", recorded: "not_limited" },
  ] as const)("tries a $outcome claim again only after 15 minutes", ({ outcome, recorded }) =>
    Effect.gen(function* () {
      const { claims, sweeps, warnings, layer } = yield* harness({
        provider: account("claudeAgent", 100),
        outcome,
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(claims);
        yield* afterNextSweep(sweeps, "10 minutes");
        // A provider's error text can name the account, so the warning carries only its tag.
        assert.deepEqual(
          warnings,
          outcome === "error"
            ? [
                JSON.stringify([
                  "usage-reset-redeemer.claim-failed",
                  { instanceId: "claudeAgent", errorTag: "ProviderSetupError" },
                ]),
              ]
            : [],
        );
        assert.equal(yield* Queue.size(claims), 0);
        yield* TestClock.adjust("5 minutes");
        yield* Queue.take(claims);
        const redeemer = yield* UsageResetRedeemer.UsageResetRedeemer;
        assert.equal((yield* redeemer.lastRedemptions).get("account-key")?.outcome, recorded);
      }).pipe(Effect.provide(layer));
    }),
  );
});
