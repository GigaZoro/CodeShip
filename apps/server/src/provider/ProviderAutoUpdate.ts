import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const checkInterval = Duration.hours(1);

function automaticUpdatesEnabled(settings: ServerSettings): boolean {
  return settings.enableProviderUpdateChecks && settings.autoUpdateProviders;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const serverSettings = yield* Settings.ServerSettingsService;
    const scope = yield* Effect.scope;
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const attempted = new Map<string, { version: string; checkedAt: number }>();

    const updateProvider = Effect.fn("ProviderAutoUpdate.updateProvider")(function* (
      provider: ServerProvider,
    ) {
      yield* Effect.logInfo("Updating provider automatically", {
        provider: provider.driver,
        instanceId: provider.instanceId,
      });
      yield* runner
        .updateProvider({ provider: provider.driver, instanceId: provider.instanceId })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Automatic provider update failed", {
              provider: provider.driver,
              instanceId: provider.instanceId,
              reason: error.reason,
            }),
          ),
        );
    });

    const changes = yield* serverSettings.subscribeChanges;
    const enabled = Stream.concat(
      Stream.fromEffect(
        serverSettings.getSettings.pipe(
          Effect.map(automaticUpdatesEnabled),
          Effect.catch((error) =>
            Effect.logWarning("Could not read provider auto-update setting", { error }).pipe(
              Effect.as(false),
            ),
          ),
        ),
      ),
      Stream.map(changes, automaticUpdatesEnabled),
    ).pipe(Stream.changes);
    yield* enabled.pipe(
      Stream.switchMap((on) =>
        on
          ? Stream.merge(
              providerRegistry.streamChanges,
              Stream.fromEffectSchedule(providerRegistry.refresh(), Schedule.spaced(checkInterval)),
            )
          : Stream.empty,
      ),
      Stream.runForEach((providers) =>
        Effect.gen(function* () {
          for (const provider of providers) {
            const advisory = provider.versionAdvisory;
            const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
            if (
              !provider.enabled ||
              advisory?.status !== "behind_latest" ||
              !advisory.canUpdate ||
              !advisory.latestVersion ||
              !advisory.checkedAt ||
              compatibility === "broken" ||
              compatibility === "unsupported" ||
              provider.updateState?.status === "queued" ||
              provider.updateState?.status === "running"
            )
              continue;
            const key = advisory.updateKey ?? advisory.updateCommand;
            if (!key) continue;
            const checkedAt = Date.parse(advisory.checkedAt);
            const last = attempted.get(key);
            // Replayed snapshots and sibling accounts share one attempt. A fresh hourly check can retry.
            if (
              checkedAt < (last?.checkedAt ?? startedAt) ||
              (last?.version === advisory.latestVersion &&
                checkedAt < last.checkedAt + Duration.toMillis(checkInterval))
            )
              continue;
            attempted.set(key, { version: advisory.latestVersion, checkedAt });
            yield* updateProvider(provider).pipe(Effect.forkIn(scope));
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
