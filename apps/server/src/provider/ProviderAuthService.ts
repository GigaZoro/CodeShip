import type { ProviderSessionId } from "@t3tools/contracts/baseSchemas";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import {
  ProviderSetupError,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderAuthPurpose,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  type ProviderAuthState,
} from "@t3tools/contracts/providerSetup";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderInstanceRegistrySync from "./ProviderInstanceRegistrySync.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

export type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

function credentialBindingInstances(
  instances: ReadonlyArray<ProviderInstance>,
  instanceId: ProviderInstanceId,
  binding: ProviderAuthController["credentialBinding"],
) {
  if (!binding) return [instanceId];
  return [
    instanceId,
    ...instances
      .filter(
        (instance) =>
          instance.instanceId !== instanceId &&
          instance.auth?.credentialBinding?.key === binding.key &&
          instance.auth.credentialBinding.owner === binding.owner,
      )
      .map((instance) => instance.instanceId),
  ];
}

interface ProviderAuthTarget {
  readonly instanceId: ProviderInstanceId;
  readonly purpose?: ProviderAuthPurpose;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  {
    readonly reconnectProfile: (
      input: ProviderAuthTarget & { methodId: string },
    ) => Effect.Effect<ChatGptReconnectProfile | null, ProviderSetupError>;
    readonly importProfile: (
      input: ProviderAuthTarget & { profile: ChatGptTransferredProfile },
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly start: (
      input: ProviderAuthStartInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly complete: (
      input: ProviderAuthTarget & { readonly flowId: string; readonly callbackUrl: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly respond: (
      input: ProviderAuthRespondInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderAuthTarget & { readonly flowId: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly logout: (
      input: ProviderAuthTarget,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderAuthTarget,
      ownerSessionId: string,
    ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
    readonly tryHandlePromptCommand: (
      input: ProviderAuthTarget & { readonly text: string; readonly hasAttachments: boolean },
    ) => Effect.Effect<boolean, ProviderSetupError>;
  }
>()("t3/provider/ProviderAuthService") {}

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const registrySync = yield* ProviderInstanceRegistrySync.ProviderInstanceRegistrySync;
  const credentialChanges = yield* Semaphore.make(1);

  // A sign-in or sign-out can save the account's credentials, which the registry runs in the
  // background. Its caller hears of it once the registry runs them, so a turn it starts at once
  // does not use the account's old instance.
  const credentialsRunning = (instanceId: ProviderInstanceId) =>
    registrySync.catchUp.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId,
            operation: "reload",
            detail: "The server could not reload this account after its sign-in changed.",
            cause,
          }),
      ),
    );
  const afterCredentialsSaved = (state: ProviderAuthState) =>
    Effect.as(credentialsRunning(state.instanceId), state);
  const whenSignedIn = (state: ProviderAuthState) =>
    state.phase === "succeeded" ? afterCredentialsSaved(state) : Effect.succeed(state);

  const getController = Effect.fn("ProviderAuthService.getController")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    purpose?: ProviderAuthPurpose,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (purpose === "limits") {
      if (instance?.limitsAuth) return instance.limitsAuth;
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This account reads its limits without a separate sign-in."
          : "This provider instance is no longer available.",
      });
    }
    if (!instance?.auth) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This provider does not support sign-in in T3.CodeShip."
          : "This provider instance is no longer available.",
      });
    }
    return instance.auth;
  });

  const bindingInstances = Effect.fn("ProviderAuthService.bindingInstances")(function* (
    instanceId: ProviderInstanceId,
    binding: ProviderAuthController["credentialBinding"],
  ) {
    if (!binding) return [instanceId];
    return credentialBindingInstances(yield* registry.listInstances, instanceId, binding);
  });

  // Invalidate credentials using session bindings; model selection may already point to another provider.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
    binding: ProviderAuthController["credentialBinding"],
    previousInstances?: ReadonlyArray<ProviderInstanceId>,
  ) {
    yield* Effect.annotateCurrentSpan("instanceId", instanceId);
    const failure = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "stopSessions", detail });
    const affectedIds = new Set(
      previousInstances ?? (yield* bindingInstances(instanceId, binding)),
    );
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(() => failure("Could not read the provider's active sessions. Try again.")),
      );
    const released = new Set<ProviderSessionId>();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
          Effect.flatMap((projection) =>
            Effect.forEach(
              projection.providerSessions.filter(
                (session) =>
                  affectedIds.has(session.providerInstanceId) &&
                  session.status !== "stopped" &&
                  session.status !== "error" &&
                  !released.has(session.id),
              ),
              (session) =>
                Effect.gen(function* () {
                  if (session.providerInstanceId !== instanceId) {
                    const current = yield* registry.getInstance(session.providerInstanceId);
                    // Settings reconciliation removes the captured aliases while retiring their old drivers.
                    if (
                      current === undefined
                        ? !previousInstances
                        : !binding ||
                          current.auth?.credentialBinding?.key !== binding.key ||
                          current.auth.credentialBinding.owner !== binding.owner
                    )
                      return;
                  }
                  yield* providerSessions
                    .release({
                      providerSessionId: session.id,
                      reason: "manual_shutdown",
                      detail: "Provider sign-in changed.",
                    })
                    .pipe(Effect.tap(() => Effect.sync(() => released.add(session.id))));
                }),
              { discard: true },
            ),
          ),
          Effect.mapError(() =>
            failure("Could not stop all sessions for this provider. Try again."),
          ),
        ),
      { discard: true },
    ).pipe(
      Effect.ensuring(
        Effect.suspend(() => Effect.annotateCurrentSpan("releasedSessions", released.size)),
      ),
    );
    if (binding) {
      yield* Effect.forEach(
        (yield* registry.listInstances).filter(
          (instance) =>
            instance.instanceId !== instanceId &&
            affectedIds.has(instance.instanceId) &&
            instance.auth?.credentialBinding?.key === binding.key &&
            instance.auth.credentialBinding.owner === binding.owner,
        ),
        (instance) => instance.auth?.invalidate ?? Effect.void,
        { discard: true },
      );
    }
  });

  const checkSharedBinding = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    operation: "start" | "logout",
    auth: ProviderAuthController,
  ) {
    const binding = auth.credentialBinding;
    if (!binding) return;
    const instances = yield* registry.listInstances;
    for (const instance of instances) {
      if (
        instance.instanceId !== instanceId &&
        instance.auth?.credentialBinding?.key === binding.key &&
        instance.auth.credentialBinding.owner === binding.owner &&
        instance.auth.isChangingCredentials &&
        (yield* instance.auth.isChangingCredentials)
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation,
          detail:
            "Another provider instance is changing this shared sign-in. Finish or cancel it first.",
        });
      }
    }
  });

  return ProviderAuthService.of({
    reconnectProfile: Effect.fnUntraced(function* (input) {
      const auth = yield* getController(input.instanceId, "export");
      if (!auth.reconnectProfile)
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "export",
          detail: "This provider does not support ChatGPT profile transfer.",
        });
      return yield* auth.reconnectProfile(input.methodId);
    }),
    importProfile: Effect.fn("ProviderAuthService.importProfile")(function (input) {
      return credentialChanges.withPermit(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("instanceId", input.instanceId);
          const auth = yield* getController(input.instanceId, "import");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          if (!auth.importProfile)
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "import",
              detail: "This provider does not support ChatGPT profile transfer.",
            });
          return yield* auth.importProfile(
            input.profile,
            stopSessions(input.instanceId, auth.credentialBinding),
          );
        }),
      );
    }, Effect.flatMap(whenSignedIn)),
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      yield* Effect.annotateCurrentSpan({
        instanceId: input.instanceId,
        purpose: input.purpose ?? "account",
      });
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "start", input.purpose);
          // A limits login sits beside the account's own sign-in, so its sessions keep running.
          const limitsLogin = input.purpose === "limits";
          if (!limitsLogin) yield* checkSharedBinding(input.instanceId, "start", auth);
          const peers = limitsLogin
            ? [input.instanceId]
            : yield* bindingInstances(input.instanceId, auth.credentialBinding);
          return yield* auth.start(
            ownerSessionId,
            limitsLogin
              ? Effect.void
              : stopSessions(input.instanceId, auth.credentialBinding, peers),
            input.methodId,
            input.returnUrl,
            input.callbackMode,
            peers,
            limitsLogin
              ? undefined
              : Effect.suspend(() => providerSessions.reserveIdleCredentialBinding(peers)),
          );
        }),
      );
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "respond", input.purpose);
      if (!auth.respond) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "respond",
          detail: "This provider does not accept this sign-in interaction.",
        });
      }
      return yield* auth.respond(ownerSessionId, input);
    }, Effect.flatMap(whenSignedIn)),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "complete", input.purpose);
      return yield* auth.complete(ownerSessionId, input);
    }, Effect.flatMap(whenSignedIn)),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input, ownerSessionId) {
      yield* Effect.annotateCurrentSpan({
        instanceId: input.instanceId,
        purpose: input.purpose ?? "account",
      });
      const auth = yield* getController(input.instanceId, "cancel", input.purpose);
      return yield* auth.cancel(ownerSessionId, input.flowId);
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        instanceId: input.instanceId,
        purpose: input.purpose ?? "account",
      });
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "logout", input.purpose);
          if (input.purpose === "limits") return yield* auth.logout(Effect.void);
          yield* checkSharedBinding(input.instanceId, "logout", auth);
          return yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
        }),
      );
    }, Effect.flatMap(afterCredentialsSaved)),
    subscribe: Function.flow(
      Effect.fn("ProviderAuthService.subscribe")(function* (input, ownerSessionId) {
        const changes = yield* registry.subscribeChanges;
        const initial = yield* getController(input.instanceId, "subscribe", input.purpose);
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, "subscribe", input.purpose)),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId)),
          Stream.mapEffect(whenSignedIn),
        );
      }),
      Stream.unwrap,
    ),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(
      function* (input) {
        const instance = yield* registry.getInstance(input.instanceId);
        if (!instance?.auth?.isLogoutPrompt?.(input.text, input.hasAttachments)) {
          return false;
        }
        return yield* credentialChanges.withPermit(
          Effect.gen(function* () {
            const auth = yield* getController(input.instanceId, "logout");
            if (!auth.isLogoutPrompt?.(input.text, input.hasAttachments)) return false;
            yield* checkSharedBinding(input.instanceId, "logout", auth);
            yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
            return true;
          }),
        );
      },
      (effect, input) =>
        Effect.flatMap(effect, (loggedOut) =>
          loggedOut ? Effect.as(credentialsRunning(input.instanceId), true) : Effect.succeed(false),
        ),
    ),
  });
});

export const layer = Layer.effect(ProviderAuthService, makeProviderAuthService);

export const layerUnattendedSecretRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    const refresh = mutator.refreshUnattendedSecrets((instanceId) =>
      Effect.gen(function* () {
        const instances = yield* registry.listInstances;
        const auth = instances.find((instance) => instance.instanceId === instanceId)?.auth;
        const isChanging = auth?.isAccessBlocked ?? auth?.isChangingCredentials;
        if (isChanging !== undefined && (yield* isChanging)) return false;
        const peers = credentialBindingInstances(instances, instanceId, auth?.credentialBinding);
        const onSameHome = ProviderInstanceRegistry.instancesSharingHome(instances, instanceId);
        return yield* providerSessions.reserveIdleCredentialBinding(
          [...new Set([...peers, ...onSameHome])],
          { requireDisconnected: true },
        );
      }),
    );
    yield* refresh.pipe(
      Effect.repeat(Schedule.spaced("5 minutes")),
      Effect.delay("5 minutes"),
      Effect.forkScoped,
    );
  }),
);
