import type { SdkCredentialStore, SdkLoginOptions, SdkLoginResult } from "@cursor/sdk";
import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { isCursorSdkError, loadCursorSdk } from "./sdk.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

const AUTH_TIMEOUT_MS = 300_000;

// The SDK has no code distinguishing these failures, so classify by its fixed message prefixes.
const loginFailureDetail = (cause: unknown) => {
  if (isCursorSdkError(cause, "CursorSdkError")) {
    if (cause.message.startsWith("Login succeeded, but creating an SDK API key failed")) {
      return "Cursor signed you in but could not create an API key. Your team's settings may restrict API keys: ask a team admin, or add CURSOR_API_KEY in provider settings.";
    }
    if (cause.message.startsWith("Login failed or timed out")) {
      return "Cursor sign-in failed or timed out. Check that this machine can reach Cursor, then start sign-in again.";
    }
  }
  return "Cursor sign-in failed. Start sign-in again.";
};

const AdmittedKey = Context.Reference<
  { readonly binding: string; readonly apiKey: string | undefined } | undefined
>("CursorAuth/AdmittedKey", { defaultValue: () => undefined });

interface AuthFlow {
  readonly id: string;
  readonly owner: string;
  fiber?: Fiber.Fiber<void>;
}

export interface CursorAuth {
  readonly controller: ProviderAuthController;
  readonly readApiKey: Effect.Effect<string | undefined, ProviderSetupError>;
  readonly requireApiKey: Effect.Effect<string, ProviderSetupError>;
  readonly usesApiKey: boolean;
  readonly withAccess: <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

export interface CursorAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly store: SdkCredentialStore;
  readonly credentialBinding?: NonNullable<ProviderAuthController["credentialBinding"]>;
  readonly verify: (apiKey: string) => Effect.Effect<void, ProviderSetupError>;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
  readonly login?: (options: SdkLoginOptions) => Promise<SdkLoginResult>;
}

export const makeCursorAuth = Effect.fn("makeCursorAuth")(function* (options: CursorAuthOptions) {
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const configuredKey = options.apiKey?.trim() || undefined;
  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: emptyState });
  let active: AuthFlow | undefined;
  let operation: "idle" | "login" | "cancelling" | "publishing" | "stopping" | "closed" = "idle";
  const binding = options.credentialBinding ?? {
    owner: "t3" as const,
    key: `cursor:${options.instanceId}`,
  };
  const accessBlocked = () =>
    operation !== "idle" && operation !== "login" && operation !== "cancelling";
  const sessions = new Set<Scope.Closeable>();

  const publish = (flow: AuthFlow, patch: Partial<ProviderAuthState>) =>
    SubscriptionRef.update(snapshot, (current) => ({
      owner: flow.owner,
      state: { ...current.state, ...patch },
    }));

  const readApiKey = Effect.gen(function* () {
    if (configuredKey) return configuredKey;
    const credentials = yield* Effect.tryPromise({
      try: () => options.store.load(),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "credentials",
          detail: "Could not read the Cursor sign-in. Try signing in again.",
          cause,
        }),
    });
    const now = yield* Clock.currentTimeMillis;
    return credentials &&
      (credentials.apiKeyExpiresAtMs === undefined || credentials.apiKeyExpiresAtMs > now)
      ? credentials.apiKey
      : undefined;
  });

  const requireApiKey = Effect.gen(function* () {
    const admitted = yield* AdmittedKey;
    if (accessBlocked() && !(operation === "publishing" && admitted?.binding === binding.key)) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "Cursor sign-in or sign-out is in progress. Try again after it finishes.",
      });
    }
    const apiKey = admitted?.binding === binding.key ? admitted.apiKey : yield* readApiKey;
    if (!apiKey) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
      });
    }
    return apiKey;
  });

  // Closing admission before draining these scopes prevents cached credentials surviving sign-out.
  const withAccess: CursorAuth["withAccess"] = (task) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* Scope.Scope;
        const { child, credentials } = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (accessBlocked())
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "session",
                detail: "Cursor sign-in or sign-out is in progress. Try again after it finishes.",
              });
            const admitted = yield* AdmittedKey;
            const credentials =
              admitted?.binding === binding.key
                ? admitted
                : { binding: binding.key, apiKey: yield* readApiKey };
            const child = yield* Scope.make();
            sessions.add(child);
            yield* Scope.addFinalizer(
              child,
              Effect.sync(() => {
                sessions.delete(child);
              }),
            );
            yield* Scope.addFinalizer(parent, Scope.close(child, Exit.void));
            return { child, credentials };
          }),
        );
        const fiber = yield* restore(task).pipe(
          Effect.provideService(Scope.Scope, child),
          Effect.provideService(AdmittedKey, credentials),
          Effect.forkIn(child),
        );
        return yield* restore(Fiber.await(fiber)).pipe(
          Effect.flatten,
          Effect.onExit((result) =>
            Exit.isFailure(result) ? Scope.close(child, Exit.void) : Effect.void,
          ),
        );
      }),
    );
  const stopSessionsWithCredentials = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );

  const authenticate = Effect.fn("providerAuthFlow.authenticate")(function* (flow: AuthFlow) {
    yield* Effect.annotateCurrentSpan({ instanceId: options.instanceId });
    // The SDK first writes into memory. Cancellation must not save a late login result.
    const { Cursor, InMemoryCredentialStore } = yield* Effect.try({
      try: loadCursorSdk,
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "start",
          detail: "Could not load the Cursor SDK. Try signing in again.",
          cause,
        }),
    });
    const pendingStore = new InMemoryCredentialStore();
    const urls = yield* Queue.unbounded<string>();
    yield* Queue.take(urls).pipe(
      Effect.flatMap((authorizationUrl) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (
              active !== flow ||
              operation !== "login" ||
              snapshot.value.state.phase === "verifying"
            )
              return;
            yield* publish(flow, {
              phase: "waiting",
              authorizationUrl,
              message:
                "Open the Cursor sign-in page and finish signing in. This page updates automatically.",
            });
          }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.tryPromise({
      try: (signal) =>
        (options.login ?? Cursor.auth.login)({
          openBrowser: false,
          store: pendingStore,
          signal,
          apiKeyName: `T3.CodeShip - ${options.displayName}`,
          onLoginUrl: (authorizationUrl) => {
            if (active === flow) Queue.offerUnsafe(urls, authorizationUrl);
          },
        }),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "start",
          detail: loginFailureDetail(cause),
          cause,
        }),
    });
    const credentials = yield* Effect.promise(() => pendingStore.load());
    if (!credentials)
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "start",
        detail: "Cursor login did not return credentials.",
      });
    yield* lock.withPermit(
      Effect.suspend(() =>
        active === flow && operation === "login"
          ? publish(flow, {
              phase: "verifying",
              authorizationUrl: null,
              message: "Checking Cursor sign-in.",
            })
          : Effect.interrupt,
      ),
    );
    yield* options.verify(credentials.apiKey);
    return credentials;
  });

  const runLogin = Effect.fn("CursorAuth.runLogin")(
    function* (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) {
      const credentials = yield* authenticate(flow).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: AUTH_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Cursor sign-in expired. Start sign-in again.",
              }),
            ),
        }),
      );
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* lock.withPermit(
            Effect.sync(() => {
              if (active !== flow) return false;
              operation = "publishing";
              return true;
            }),
          );
          if (!current) return;
          yield* Effect.tryPromise({
            try: () => options.store.save(credentials),
            catch: (cause) =>
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Could not save the Cursor sign-in. Try again.",
                cause,
              }),
          }).pipe(
            Effect.withSpan("providerAuthFlow.persistCredentials", {
              attributes: { instanceId: options.instanceId },
            }),
          );
          yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
          yield* options.onChanged(true);
        }),
      );
    },
    (effect, flow) =>
      effect.pipe(
        Effect.tapCause((cause) => Effect.logWarning("Cursor sign-in failed", cause)),
        Effect.exit,
        Effect.flatMap((result) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== flow) return;
              active = undefined;
              operation = "idle";
              yield* publish(flow, {
                phase: Exit.isSuccess(result) ? "succeeded" : "failed",
                authorizationUrl: null,
                expiresAt: null,
                message: Exit.isSuccess(result)
                  ? "Signed in with Cursor."
                  : Option.match(Cause.findErrorOption(result.cause), {
                      onNone: () => "Cursor sign-in failed or expired. Start sign-in again.",
                      onSome: (error) => error.detail,
                    }),
              });
            }),
          ),
        ),
      ),
  );

  const requireFlow = Effect.fn("CursorAuth.requireFlow")(function* (
    owner: string,
    id: string,
    name: string,
  ) {
    if (operation !== "login" || !active || active.owner !== owner || active.id !== id) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: name,
        detail: "This sign-in is no longer active in this client.",
      });
    }
    return active;
  });

  const controller: ProviderAuthController = {
    credentialBinding: binding,
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    isAccessBlocked: Effect.sync(accessBlocked),
    withAccess,
    invalidate: stopSessionsWithCredentials,
    start: (owner, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!options.enabled)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Enable Cursor before signing in.",
              });
            if (configuredKey)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail:
                  "Remove CURSOR_API_KEY from this provider's environment before using browser sign-in.",
              });
            if (active?.owner === owner && operation === "login") return snapshot.value.state;
            if (operation !== "idle")
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Cursor setup is already in progress.",
              });
            const id = yield* random.uuidV4().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "start",
                    detail: "Could not start Cursor sign-in. Try again.",
                    cause,
                  }),
              ),
            );
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS),
            );
            const flow: AuthFlow = { id, owner };
            active = flow;
            operation = "login";
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId: id,
              expiresAt,
              message: "Starting Cursor sign-in.",
            };
            yield* SubscriptionRef.set(snapshot, { owner, state });
            flow.fiber = yield* runLogin(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            return state;
          }),
        ),
      ),
    complete: () =>
      Effect.fail(
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "complete",
          detail: "Finish signing in on the Cursor website. No redirect URL is needed.",
        }),
      ),
    cancel: (owner, id) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const flow = yield* requireFlow(owner, id, "cancel");
              active = undefined;
              operation = "cancelling";
              yield* publish(flow, {
                phase: "cancelled",
                authorizationUrl: null,
                expiresAt: null,
                message: "Cursor sign-in was cancelled.",
              });
              return flow;
            }),
          );
          if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
          operation = "idle";
          return snapshot.value.state;
        }),
      ),
    logout: (stopSessions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (configuredKey)
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail:
                    "Remove CURSOR_API_KEY from this provider's environment to disconnect it.",
                });
              if (operation !== "idle" && operation !== "login")
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "Cursor setup is already stopping.",
                });
              operation = "stopping";
              const flow = active;
              active = undefined;
              return flow;
            }),
          );
          const result = yield* Effect.gen(function* () {
            if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
            yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
            yield* Effect.tryPromise({
              try: () => options.store.clear(),
              catch: (cause) =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "Could not clear the Cursor sign-in. Try again.",
                  cause,
                }),
            });
            yield* options.onChanged(false);
          }).pipe(Effect.exit);
          operation = "idle";
          const state: ProviderAuthState = {
            ...emptyState,
            phase: Exit.isSuccess(result) ? "idle" : "failed",
            message: Exit.isSuccess(result)
              ? "Signed out of Cursor."
              : "Cursor sign-out failed. Try again.",
          };
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return state;
        }),
      ),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) => {
          const state = {
            ...current.state,
            credentialOwner: "t3" as const,
            methods: [
              {
                id: "browser",
                name: "Sign in with Cursor",
                description: null,
                type: "agent" as const,
              },
            ],
            interaction:
              current.state.phase === "waiting" &&
              current.state.authorizationUrl &&
              current.state.flowId
                ? {
                    type: "browser" as const,
                    id: current.state.flowId,
                    url: current.state.authorizationUrl,
                    requiresConsent: false,
                  }
                : null,
          };
          if (current.owner === null || current.owner === owner) return state;
          return {
            ...state,
            interaction: null,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: active ? "Sign-in is in progress in another client." : current.state.message,
          };
        }),
      ),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* stopSessionsWithCredentials;
    }),
  );

  return {
    controller,
    readApiKey,
    requireApiKey,
    withAccess,
    usesApiKey: configuredKey !== undefined,
  } satisfies CursorAuth;
});
