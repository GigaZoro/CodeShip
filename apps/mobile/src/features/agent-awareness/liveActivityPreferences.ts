import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: {
    readonly enabled: boolean;
    readonly previousEnabled: boolean;
    readonly clerkToken: string | null;
    readonly connections: ReadonlyArray<SavedRemoteConnection>;
    readonly canConfigureEnvironment: (environmentId: EnvironmentId) => boolean;
  }) {
    const linkedConnections = input.connections.filter(
      (connection) => connection.bearerToken !== null,
    );

    const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
      connection: SavedRemoteConnection,
      enabled: boolean,
      clerkToken: string,
    ) {
      if (!input.canConfigureEnvironment(connection.environmentId)) return;

      yield* linkEnvironmentToCloudWithPreference({
        clerkToken,
        connection,
        liveActivitiesEnabled: enabled,
      });
    });

    const enableEveryPreference = Effect.fn("enableEveryPreference")(function* () {
      yield* updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: true });

      const clerkToken = input.clerkToken;
      if (!clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) => updateEnvironmentPreference(connection, true, clerkToken),
        { concurrency: "unbounded" },
      );
    });

    // Each step only warns, so one unreachable relay or environment does not stop the rest.
    const setEveryPreferenceBestEffort = Effect.fn("setEveryPreferenceBestEffort")(function* (
      enabled: boolean,
    ) {
      yield* updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: enabled }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not update the Live Activity device preference.", cause),
        ),
      );

      const clerkToken = input.clerkToken;
      if (!clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          updateEnvironmentPreference(connection, enabled, clerkToken).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Could not update the Live Activity preference for environment ${connection.environmentId}.`,
                cause,
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

    // Off is already saved on the device, so a relay or environment that cannot be reached must
    // not switch updates back on; the next registration sends the stored preference.
    if (!input.enabled) {
      yield* setEveryPreferenceBestEffort(false);
      return;
    }
    yield* enableEveryPreference().pipe(
      Effect.onError(() => setEveryPreferenceBestEffort(input.previousEnabled)),
    );
  },
);
