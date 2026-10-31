import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

function oneClickUpdateCommand(provider: ServerProvider): string | null {
  const advisory = provider.versionAdvisory;
  const latestStatus = provider.compatibilityAdvisory?.latestVersionStatus;
  const updateStatus = provider.updateState?.status;
  return provider.enabled &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    latestStatus !== "broken" &&
    latestStatus !== "unsupported" &&
    updateStatus !== "queued" &&
    updateStatus !== "running"
    ? advisory.updateCommand
    : null;
}

/** Updates providers found behind latest by this launch's version check when the setting is on. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const serverSettings = yield* Settings.ServerSettingsService;
    const scope = yield* Effect.scope;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const checkedInstances = new Set<ProviderInstanceId>();
    // Instances that share an installer update once.
    const startedCommands = new Set<string>();

    const updateProvider = Effect.fn("ProviderAutoUpdate.updateProvider")(function* (
      provider: ServerProvider,
    ) {
      yield* Effect.logInfo("Updating provider at launch", {
        provider: provider.driver,
        instanceId: provider.instanceId,
      });
      // The runner records a failure in the provider's update state, which clients show.
      yield* runner
        .updateProvider({ provider: provider.driver, instanceId: provider.instanceId })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Provider update at launch failed", {
              provider: provider.driver,
              instanceId: provider.instanceId,
              reason: error.reason,
            }),
          ),
        );
    });

    const autoUpdateEnabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.autoUpdateProviders),
      Effect.catch((error) =>
        Effect.logWarning("Could not read provider auto-update setting", { error }).pipe(
          Effect.as(false),
        ),
      ),
    );

    yield* Stream.merge(
      Stream.fromEffect(providerRegistry.getProviders),
      providerRegistry.streamChanges,
    ).pipe(
      Stream.runForEach((providers) =>
        Effect.gen(function* () {
          // Cached snapshots carry the last run's advisory. Only each instance's first check
          // since launch counts, so later checks never update a CLI mid-session.
          const freshlyChecked = providers.filter(
            (provider) =>
              !checkedInstances.has(provider.instanceId) &&
              (provider.versionAdvisory?.checkedAt ?? "") >= startedAt,
          );
          if (freshlyChecked.length === 0) return;
          for (const provider of freshlyChecked) checkedInstances.add(provider.instanceId);
          if (!freshlyChecked.some((provider) => oneClickUpdateCommand(provider) !== null)) return;
          if (!(yield* autoUpdateEnabled)) return;
          for (const provider of freshlyChecked) {
            const command = oneClickUpdateCommand(provider);
            if (command === null || startedCommands.has(command)) continue;
            startedCommands.add(command);
            yield* updateProvider(provider).pipe(Effect.forkIn(scope));
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
