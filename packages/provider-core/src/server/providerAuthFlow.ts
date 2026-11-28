import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthMethod,
  type ProviderAuthResponse,
  type ProviderAuthState,
} from "@t3tools/contracts/providerSetup";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type * as ProviderAuth from "./auth.ts";

export interface ProviderAuthFlowContext {
  readonly flowId: string;
  /** Owns staged credentials through publication or cancellation, independently of the login process. */
  readonly scope: Scope.Scope;
  readonly bindingInstances: ReadonlyArray<ProviderInstanceId>;
  readonly expiresAt: number;
  readonly returnUrl?: string;
  readonly callbackMode?: "server" | "client";
  readonly setInteraction: (
    interaction: ProviderAuthInteraction,
    respond?: (response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>,
    complete?: (callbackUrl: string) => Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<void>;
  readonly verifying: Effect.Effect<void>;
}

const isSetupError = Schema.is(ProviderSetupError);

const failureMessage = (cause: Cause.Cause<ProviderSetupError>) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && isSetupError(error.value)
    ? error.value.detail
    : "Sign-in failed. Start again.";
};

interface Flow {
  readonly id: string;
  readonly owner: string;
  readonly expiresAt: number;
  complete?: ((callbackUrl: string) => Effect.Effect<void, ProviderSetupError>) | undefined;
  fiber?: Fiber.Fiber<void>;
  responseFiber?: Fiber.Fiber<void, ProviderSetupError>;
  respond:
    | ((response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>)
    | undefined;
}

type Authenticate<A> = (
  methodId: string,
  context: ProviderAuthFlowContext,
) => Effect.Effect<A, ProviderSetupError, Scope.Scope>;

export const make = Effect.fn("ProviderAuthFlow.make")(function* (
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly credentialBinding: NonNullable<
      ProviderAuth.ProviderAuthController["credentialBinding"]
    >;
    readonly methods: Effect.Effect<ReadonlyArray<ProviderAuthMethod>, ProviderSetupError>;
    readonly defaultMethodId?: string;
    readonly refreshMethodsAfterAuth?: boolean;
    readonly logout: Effect.Effect<void | string, ProviderSetupError>;
    readonly timeoutMs?: number;
  } & (
    | { readonly authenticate: Authenticate<void>; readonly stage?: never }
    /** Existing sessions stay pinned to their old identity when the returned effect publishes the new one. */
    | {
        readonly stage: Authenticate<Effect.Effect<void, ProviderSetupError>>;
        /** Publication replaces the driver through settings; its old adapter must never admit another turn. */
        readonly replacesInstance?: true;
        readonly authenticate?: never;
      }
  ),
) {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const empty: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    interaction: null,
    credentialOwner: options.credentialBinding.owner,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: empty });
  let active: Flow | undefined;
  let operation: "idle" | "auth" | "cancelling" | "stopping" | "replaced" | "closed" = "idle";
  const isAccessBlocked = Effect.sync(
    () =>
      operation !== "idle" &&
      !(options.stage && (operation === "auth" || operation === "cancelling")),
  );
  const sessions = new Set<Scope.Closeable>();
  const opening = new Set<Scope.Closeable>();
  const stopOwnedSessions = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );
  const publish = (flow: Flow, patch: Partial<ProviderAuthState>) =>
    Effect.suspend(() =>
      active === flow
        ? SubscriptionRef.update(snapshot, (current) => ({
            owner: flow.owner,
            state: { ...current.state, ...patch },
          }))
        : Effect.void,
    );

  const requireFlow = Effect.fnUntraced(function* (owner: string, id: string) {
    if (
      operation !== "auth" ||
      !active ||
      active.owner !== owner ||
      active.id !== id ||
      (yield* Clock.currentTimeMillis) >= active.expiresAt
    ) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "respond",
        detail: "This sign-in is no longer active in this client.",
      });
    }
    return active;
  });

  const refreshMethods = options.methods.pipe(
    Effect.flatMap((methods) =>
      SubscriptionRef.update(snapshot, (current) => ({
        ...current,
        state: { ...current.state, methods },
      })),
    ),
    Effect.catch((error) =>
      SubscriptionRef.update(snapshot, (current) => ({
        ...current,
        state: { ...current.state, methods: current.state.methods ?? [], message: error.detail },
      })),
    ),
  );
  yield* refreshMethods.pipe(Effect.forkIn(scope));

  const controller: ProviderAuth.ProviderAuthController = {
    credentialBinding: options.credentialBinding,
    adoptCredentials: Effect.fn("providerAuthFlow.adoptCredentials")(function* (
      update,
      stopSessions,
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (operation !== "idle")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "import",
              detail: "Finish or cancel the existing sign-in first.",
            });
          operation = "stopping";
        }),
      );
      const result = yield* Effect.gen(function* () {
        yield* update.pipe(
          Effect.withSpan("providerAuthFlow.persistCredentials", {
            attributes: { instanceId: options.instanceId },
          }),
        );
        yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
        yield* refreshMethods;
      }).pipe(Effect.exit);
      const state: ProviderAuthState = {
        ...empty,
        methods: snapshot.value.state.methods ?? [],
        phase: Exit.isSuccess(result) ? "succeeded" : "failed",
        message: Exit.isSuccess(result) ? null : failureMessage(result.cause),
      };
      yield* lock.withPermit(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          operation = "idle";
        }),
      );
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return state;
    }, Effect.uninterruptible),
    refreshMethods,
    invalidate: lock.withPermit(
      Effect.gen(function* () {
        if (operation !== "idle") return;
        yield* stopOwnedSessions;
        yield* SubscriptionRef.set(snapshot, {
          owner: null,
          state: {
            ...empty,
            methods: snapshot.value.state.methods ?? [],
            message: "This provider's shared sign-in changed.",
          },
        });
      }),
    ),
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    isAccessBlocked,
    withAccess: (task) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parent = yield* Scope.Scope;
          const child = yield* lock.withPermit(
            Effect.gen(function* () {
              if (yield* isAccessBlocked)
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "session",
                  detail: "Provider sign-in is changing. Try again after it finishes.",
                });
              const child = yield* Scope.make();
              sessions.add(child);
              opening.add(child);
              yield* Scope.addFinalizer(
                child,
                Effect.sync(() => {
                  sessions.delete(child);
                  opening.delete(child);
                }),
              );
              yield* Scope.addFinalizer(parent, Scope.close(child, Exit.void));
              return child;
            }),
          );
          const fiber = yield* restore(task).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                opening.delete(child);
              }),
            ),
            Effect.provideService(Scope.Scope, child),
            Effect.forkIn(child),
          );
          return yield* restore(Fiber.await(fiber)).pipe(
            Effect.flatMap((result) => result),
            Effect.onExit((result) =>
              Exit.isFailure(result) ? Scope.close(child, Exit.void) : Effect.void,
            ),
          );
        }),
      ),
    start: (
      owner,
      stopSessions = Effect.void,
      selectedMethodId,
      returnUrl,
      callbackMode,
      bindingInstances = [options.instanceId],
      reserveIdleBinding,
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (operation === "auth" && active?.owner === owner) return snapshot.value.state;
          if (operation !== "idle")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "start",
              detail: "Provider setup is already in progress.",
            });
          const id = yield* crypto.randomUUIDv4().pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "start",
                  detail: "Could not start sign-in. Try again.",
                }),
            ),
          );
          const stagingScope = yield* Scope.make();
          if (!options.stage) {
            const idle =
              opening.size === 0 &&
              (reserveIdleBinding
                ? yield* reserveIdleBinding.pipe(
                    Scope.provide(stagingScope),
                    Effect.onError((cause) => Scope.close(stagingScope, Exit.failCause(cause))),
                  )
                : sessions.size === 0);
            if (!idle) {
              yield* Scope.close(stagingScope, Exit.void);
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail:
                  "This agent changes its live sign-in. Wait for turns and session starts using this account to finish, then try again.",
              });
            }
          }
          const flow: Flow = {
            id,
            owner,
            expiresAt: (yield* Clock.currentTimeMillis) + timeoutMs,
            respond: undefined,
          };
          active = flow;
          operation = "auth";
          const state: ProviderAuthState = {
            ...empty,
            methods: snapshot.value.state.methods ?? [],
            phase: "starting",
            flowId: id,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(flow.expiresAt)),
            message: "Starting sign-in.",
          };
          yield* SubscriptionRef.set(snapshot, { owner, state });
          flow.fiber = yield* Effect.gen(function* () {
            const methods = yield* options.methods;
            yield* publish(flow, { methods });
            const methodId = selectedMethodId ?? options.defaultMethodId ?? methods[0]?.id;
            if (!methodId || !methods.some((method) => method.id === methodId))
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "The provider did not advertise this sign-in method.",
              });
            if (!options.stage) yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
            const authenticate: Authenticate<void | Effect.Effect<void, ProviderSetupError>> =
              options.stage ?? options.authenticate;
            return yield* authenticate(methodId, {
              flowId: id,
              scope: stagingScope,
              bindingInstances,
              expiresAt: flow.expiresAt,
              ...(returnUrl ? { returnUrl } : {}),
              ...(callbackMode ? { callbackMode } : {}),
              // Terminal sign-in updates this for every output chunk within the auth operation.
              setInteraction: Effect.fnUntraced(function* (interaction, respond, complete) {
                if (active !== flow) return;
                flow.respond = respond;
                flow.complete = complete;
                yield* publish(flow, {
                  phase: "waiting",
                  interaction,
                  authorizationUrl:
                    interaction.type === "browser" || interaction.type === "deviceCode"
                      ? interaction.url
                      : null,
                  message: "Complete sign-in to continue.",
                });
              }),
              verifying: Effect.gen(function* () {
                flow.respond = undefined;
                flow.complete = undefined;
                yield* publish(flow, {
                  phase: "verifying",
                  interaction: null,
                  authorizationUrl: null,
                  message: "Checking provider sign-in.",
                });
              }),
            }).pipe(
              Effect.withSpan("providerAuthFlow.authenticate", {
                attributes: { instanceId: options.instanceId },
              }),
            );
          }).pipe(
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "start",
                    detail: "Sign-in expired. Start again.",
                  }),
                ),
            }),
            Effect.exit,
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                const finishing = yield* lock.withPermit(
                  Effect.sync(() => {
                    if (active !== flow) return false;
                    operation = Exit.isSuccess(result) ? "stopping" : "cancelling";
                    return true;
                  }),
                );
                if (!finishing)
                  return yield* Scope.close(
                    stagingScope,
                    Exit.isFailure(result) ? result : Exit.interrupt(),
                  );
                if (flow.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
                let replaced = false;
                const committed =
                  Exit.isSuccess(result) && result.value
                    ? yield* Effect.exit(
                        result.value.pipe(
                          Effect.withSpan("providerAuthFlow.persistCredentials", {
                            attributes: { instanceId: options.instanceId },
                          }),
                          Effect.tap(() =>
                            Effect.sync(() => {
                              replaced =
                                options.stage !== undefined && options.replacesInstance === true;
                            }),
                          ),
                          Effect.andThen(stopSessions.pipe(Effect.ensuring(stopOwnedSessions))),
                        ),
                      )
                    : result;
                yield* Scope.close(stagingScope, committed);
                yield* lock.withPermit(
                  Effect.gen(function* () {
                    if (active !== flow) return;
                    if (options.refreshMethodsAfterAuth) yield* refreshMethods;
                    yield* publish(flow, {
                      phase: Exit.isSuccess(committed) ? "succeeded" : "failed",
                      interaction: null,
                      authorizationUrl: null,
                      expiresAt: null,
                      message: Exit.isSuccess(committed)
                        ? "Sign-in complete."
                        : failureMessage(committed.cause),
                    });
                    active = undefined;
                    operation = replaced ? "replaced" : "idle";
                  }),
                );
              }).pipe(Effect.uninterruptible),
            ),
            Effect.onExit((exit) => Scope.close(stagingScope, exit)),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
          return state;
        }).pipe(Effect.uninterruptible),
      ),
    respond: (owner, input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { flow, fiber, ready } = yield* lock.withPermit(
            Effect.gen(function* () {
              const flow = yield* requireFlow(owner, input.flowId);
              const interaction = snapshot.value.state.interaction;
              if (
                !interaction ||
                interaction.id !== input.interactionId ||
                interaction.type !== input.response.type ||
                !flow.respond
              )
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "respond",
                  detail: "This sign-in interaction is no longer available.",
                });
              if (flow.responseFiber)
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "respond",
                  detail: "A sign-in response is already in progress.",
                });
              const ready = yield* Deferred.make<void>();
              const callback = flow.respond;
              const fiber = yield* Deferred.await(ready).pipe(
                Effect.andThen(Effect.suspend(() => callback(input.response))),
                Effect.interruptible,
                Effect.forkIn(scope),
              );
              flow.responseFiber = fiber;
              return { flow, fiber, ready };
            }),
          );
          yield* Deferred.succeed(ready, undefined);
          yield* restore(Fiber.join(fiber)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
            Effect.ensuring(
              lock.withPermit(
                Effect.sync(() => {
                  if (flow.responseFiber === fiber) delete flow.responseFiber;
                }),
              ),
            ),
          );
          return snapshot.value.state;
        }),
      ),
    complete: (owner, input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const flow = yield* requireFlow(owner, input.flowId);
          const interaction = snapshot.value.state.interaction;
          if (
            snapshot.value.state.phase !== "waiting" ||
            interaction?.type !== "browser" ||
            !interaction.acceptsCallback ||
            !flow.complete
          )
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "complete",
              detail: "This sign-in does not accept a redirect URL.",
            });
          yield* flow.complete(input.callbackUrl);
          return snapshot.value.state;
        }),
      ),
    cancel: Effect.fn("providerAuthFlow.cancel")(function* (owner, id) {
      const flow = yield* lock.withPermit(
        Effect.gen(function* () {
          const flow = yield* requireFlow(owner, id);
          yield* publish(flow, {
            phase: "cancelled",
            interaction: null,
            authorizationUrl: null,
            expiresAt: null,
            message: "Sign-in cancelled.",
          });
          active = undefined;
          operation = "cancelling";
          return flow;
        }),
      );
      if (flow.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
      if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
      operation = "idle";
      return snapshot.value.state;
    }, Effect.uninterruptible),
    logout: Effect.fn("providerAuthFlow.logout")(function* (stopSessions) {
      const flow = yield* lock.withPermit(
        Effect.gen(function* () {
          if (operation !== "idle" && operation !== "auth")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "logout",
              detail: "Provider setup is already stopping.",
            });
          operation = "stopping";
          const flow = active;
          active = undefined;
          return flow;
        }),
      );
      const result = yield* Effect.gen(function* () {
        if (flow?.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
        if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
        const message = yield* options.logout;
        if (options.refreshMethodsAfterAuth) yield* refreshMethods;
        return message;
      }).pipe(Effect.exit);
      const state: ProviderAuthState = {
        ...empty,
        methods: snapshot.value.state.methods ?? [],
        phase: Exit.isSuccess(result) ? "idle" : "failed",
        message: Exit.isSuccess(result)
          ? (result.value ?? "Signed out.")
          : "Could not sign out. Try again.",
      };
      yield* lock.withPermit(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          operation = "idle";
        }),
      );
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return state;
    }, Effect.uninterruptible),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) =>
          current.owner === null || current.owner === owner
            ? current.state
            : {
                ...current.state,
                flowId: null,
                authorizationUrl: null,
                interaction: null,
                expiresAt: null,
                message: active
                  ? "Sign-in is in progress in another client."
                  : current.state.message,
              },
        ),
      ),
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      // Settings rebuild instances; admitted sessions sharing this binding retain their own scopes.
    }),
  );
  return controller;
});
