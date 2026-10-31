import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
  readonly updateCommand: string;
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
      latestVersion: "1.1.0",
      updateCommand: input.updateCommand,
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

it.effect("updates each provider found behind latest by this launch's first check, once", () =>
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
              getProviders: Effect.succeed([
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
                Queue.offer(updated, typeof target === "string" ? target : target.instanceId).pipe(
                  Effect.as({ providers: [] }),
                ),
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
        updateCommand: "npm install -g @openai/codex@latest",
      }),
      behindLatest({
        driver: "codex",
        instanceId: "codex_work",
        checkedAt: LAUNCHED_AT,
        updateCommand: "npm install -g @openai/codex@latest",
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
        updateCommand: "npm install -g @openai/codex@latest",
      }),
      behindLatest({
        driver: "opencode",
        instanceId: "opencode",
        checkedAt: "2026-05-01T01:00:00.000Z",
        updateCommand: "npm install -g opencode-ai@latest",
      }),
    ]);
    const second = yield* Queue.take(updated);

    assert.deepStrictEqual([first, second], ["codex", "opencode"]);
  }),
);
