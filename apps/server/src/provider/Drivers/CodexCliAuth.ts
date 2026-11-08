import {
  boundedProviderMcpMessage,
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";

import { mcpCallbackUrl, mcpRedirect } from "@t3tools/shared/mcpAuthCallback";

const REQUEST_TIMEOUT = "20 seconds";
const CALLBACK_TIMEOUT = "15 seconds";

const CHATGPT_METHOD: ProviderAuthMethod = {
  id: "chatgpt",
  name: "ChatGPT account",
  description: "Signs in with Codex's own ChatGPT login.",
  type: "agent",
};

/** Signs a Codex home in and out through the app server's own ChatGPT login. */
export const makeCodexChatGptLogin = Effect.fn("makeCodexChatGptLogin")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  /** An initialized app server for the Codex home, closed with the scope. */
  readonly openClient: Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    CodexErrors.CodexAppServerError | ProviderSetupError,
    Scope.Scope
  >;
}) {
  const http = yield* HttpClient.HttpClient;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const openClient = (operation: string) =>
    options.openClient.pipe(
      Effect.mapError((cause) => failure(operation, "Could not start Codex. Try again.", cause)),
    );

  const authenticate = Effect.fn("CodexCliAuth.authenticate")(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    // The app server hosts Codex's localhost login page, so it stays open for the whole flow.
    const client = yield* openClient("start");
    const completed = yield* Deferred.make<void, ProviderSetupError>();
    let loginId: string | undefined;
    yield* client.handleServerNotification("account/login/completed", (event) =>
      event.loginId != null && loginId !== undefined && event.loginId !== loginId
        ? Effect.void
        : Deferred.done(
            completed,
            event.success
              ? Exit.void
              : Exit.fail(
                  failure(
                    "start",
                    boundedProviderMcpMessage(event.error) ?? "Codex sign-in did not finish.",
                  ),
                ),
          ).pipe(Effect.asVoid),
    );
    const started = yield* client.request("account/login/start", { type: "chatgpt" }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => failure("start", "Codex could not start sign-in.", cause)),
    );
    if (started.type !== "chatgpt")
      return yield* failure("start", "Codex did not offer a ChatGPT sign-in.");
    loginId = started.loginId;
    const redirect = mcpRedirect(started.authUrl);
    const forward = (pasted: string) => {
      const callbackUrl = redirect ? mcpCallbackUrl(pasted, redirect) : undefined;
      if (callbackUrl === undefined)
        return Effect.fail(
          failure("complete", "This address does not belong to the current sign-in."),
        );
      return http.get(callbackUrl).pipe(
        Effect.timeout(CALLBACK_TIMEOUT),
        Effect.mapError((cause) =>
          failure(
            "complete",
            "Codex is no longer waiting for this sign-in. Start it again.",
            cause,
          ),
        ),
        Effect.flatMap((response) =>
          response.status < 400
            ? Effect.void
            : Effect.fail(failure("complete", "Codex did not accept this address.")),
        ),
      );
    };
    yield* context.setInteraction(
      {
        type: "browser",
        id: "browser",
        url: started.authUrl,
        requiresConsent: false,
        acceptsCallback: redirect !== undefined,
      },
      undefined,
      redirect ? forward : undefined,
    );
    yield* Deferred.await(completed);
    yield* context.verifying;
  });

  const logout = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* openClient("logout");
      yield* client.request("account/logout", undefined).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          failure("logout", "Codex could not sign this account out. Try again.", cause),
        ),
      );
      return "Signed this Codex account out.";
    }),
  );
  return { authenticate, logout };
});

export const makeCodexCliAuth = Effect.fn("makeCodexCliAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialKey: string;
  /** An initialized app server for this instance's Codex home, closed with the scope. */
  readonly openClient: Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    CodexErrors.CodexAppServerError,
    Scope.Scope
  >;
  readonly canLogout: boolean;
}) {
  const login = yield* makeCodexChatGptLogin(options);
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed([CHATGPT_METHOD]),
    authenticate: (_methodId, context) => login.authenticate(context),
    logout: options.canLogout
      ? login.logout
      : Effect.fail(
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "logout",
            detail: "Sign out of this Codex login in a terminal with `codex logout`.",
          }),
        ),
  });
  return { controller };
});
