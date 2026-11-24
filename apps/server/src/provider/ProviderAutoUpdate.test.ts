import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../serverSettings.ts";
import * as ProviderAutoUpdate from "./ProviderAutoUpdate.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const LAUNCHED_AT = "2026-05-01T00:00:00.000Z";
const BEFORE_LAUNCH = "2026-04-30T00:00:00.000Z";

function behindLatest(input: {
  readonly driver: string;
  readonly instanceId: string;
  readonly checkedAt: string;
  readonly updateCommand: string | null;
  readonly updateKey?: string;
  readonly latestVersion?: string;
  readonly latestVersionStatus?: ServerProviderCompatibilityAdvisory["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: input.checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: input.latestVersion ?? "1.1.0",
      updateCommand: input.updateCommand,
      ...(input.updateKey ? { updateKey: input.updateKey } : {}),
      canUpdate: true,
      checkedAt: input.checkedAt,
      message: null,
    },
    ...(input.latestVersionStatus
      ? {
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus: input.latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }
      : {}),
  };
}

it.effect(
  "updates shared installs once per release and skips stale and incompatible advisories",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(LAUNCHED_AT));
      const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const updated = yield* Queue.unbounded<string | undefined>();
      yield* Layer.build(
        ProviderAutoUpdate.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                // Cached from the previous run, so its advisory is not this launch's check.
                refresh: () =>
                  Effect.succeed([
                    behindLatest({
                      driver: "cursor",
                      instanceId: "cursor",
                      checkedAt: BEFORE_LAUNCH,
                      updateCommand: "cursor-agent update",
                    }),
                  ]),
                streamChanges: Stream.fromQueue(changes),
              }),
              Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({
                updateProvider: (target) =>
                  Queue.offer(
                    updated,
                    typeof target === "string" ? target : target.instanceId,
                  ).pipe(Effect.as({ providers: [] })),
              }),
              Settings.layerTest({ autoUpdateProviders: true }),
            ),
          ),
        ),
      );

      yield* Queue.offer(changes, [
        behindLatest({
          driver: "codex",
          instanceId: "codex",
          checkedAt: LAUNCHED_AT,
          updateCommand: null,
          updateKey: "managed-codex",
        }),
        behindLatest({
          driver: "codex",
          instanceId: "codex_work",
          checkedAt: LAUNCHED_AT,
          updateCommand: null,
          updateKey: "managed-codex",
        }),
        behindLatest({
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          checkedAt: LAUNCHED_AT,
          updateCommand: "claude update",
          latestVersionStatus: "broken",
        }),
      ]);
      const first = yield* Queue.take(updated);

      yield* Queue.offer(changes, [
        behindLatest({
          driver: "codex",
          instanceId: "codex",
          checkedAt: "2026-05-01T01:00:00.000Z",
          updateCommand: null,
          updateKey: "managed-codex",
          latestVersion: "1.2.0",
        }),
        behindLatest({
          driver: "opencode",
          instanceId: "opencode",
          checkedAt: "2026-05-01T01:00:00.000Z",
          updateCommand: "npm install -g opencode-ai@latest",
        }),
      ]);
      const second = yield* Queue.take(updated);
      assert.strictEqual(first, "codex");
      assert.strictEqual(second, "codex");
      assert.strictEqual(yield* Queue.take(updated), "opencode");

      const codex = (instanceId: string, latestVersion: string, checkedAt: string) =>
        behindLatest({
          driver: "codex",
          instanceId,
          updateCommand: null,
          updateKey: "managed-codex",
          latestVersion,
          checkedAt,
        });
      yield* Queue.offer(changes, [
        codex("stale", "1.1.0", LAUNCHED_AT),
        codex("replayed", "1.2.0", "2026-05-01T01:00:01.000Z"),
        codex("retry", "1.2.0", "2026-05-01T02:00:00.000Z"),
      ]);
      assert.strictEqual(yield* Queue.take(updated), "retry");
    }),
);

it.effect("checks immediately when automatic updates are enabled and hourly until disabled", () =>
  Effect.gen(function* () {
    const initial = { ...DEFAULT_SERVER_SETTINGS, autoUpdateProviders: false };
    const settings = yield* Ref.make(initial);
    const changes = yield* Queue.unbounded<typeof initial>();
    const refreshed = yield* Queue.unbounded<void>();
    const stopped = yield* Deferred.make<void>();
    yield* Layer.build(
      ProviderAutoUpdate.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              streamChanges: Stream.never.pipe(
                Stream.ensuring(Deferred.succeed(stopped, undefined)),
              ),
              refresh: () => Queue.offer(refreshed, undefined).pipe(Effect.as([])),
            }),
            Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Ref.get(settings),
              subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
            }),
          ),
        ),
      ),
    );
    const setAutomatic = (enabled: boolean) => {
      const next = { ...initial, autoUpdateProviders: enabled };
      return Ref.set(settings, next).pipe(Effect.andThen(Queue.offer(changes, next)));
    };
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* Queue.size(refreshed), 0);
    yield* setAutomatic(true);
    yield* Queue.take(refreshed);
    yield* TestClock.adjust("1 hour");
    yield* Queue.take(refreshed);
    yield* setAutomatic(false);
    yield* Deferred.await(stopped);
    yield* TestClock.adjust("2 hours");
    assert.strictEqual(yield* Queue.size(refreshed), 0);
  }),
);
