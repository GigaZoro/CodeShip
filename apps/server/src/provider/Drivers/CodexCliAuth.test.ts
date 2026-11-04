import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeCodexCliAuth } from "./CodexCliAuth.ts";

const instanceId = ProviderInstanceId.make("codex-personal");
const authUrl =
  "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s7Ate";

const makeHarness = Effect.gen(function* () {
  const forwarded = yield* Ref.make<ReadonlyArray<string>>([]);
  const handlers = new Map<string, (event: unknown) => Effect.Effect<void>>();
  const client = {
    request: (method: string) =>
      Effect.succeed(
        method === "account/login/start" ? { type: "chatgpt", authUrl, loginId: "login-1" } : {},
      ),
    handleServerNotification: (method: string, handler: (event: unknown) => Effect.Effect<void>) =>
      Effect.sync(() => {
        handlers.set(method, handler);
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const http = HttpClient.make((request) =>
    Ref.update(forwarded, (urls) => [...urls, request.url]).pipe(
      Effect.as(HttpClientResponse.fromWeb(request, new Response("ok"))),
    ),
  );
  const auth = yield* makeCodexCliAuth({
    instanceId,
    credentialKey: "codex:home:/state/shadow",
    openClient: Effect.succeed(client),
    canLogout: true,
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const state = (predicate: (state: ProviderAuthState) => boolean) =>
    auth.controller
      .subscribe("owner")
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  return {
    auth,
    forwarded,
    state,
    complete: (event: unknown) => handlers.get("account/login/completed")!(event),
  };
});

it.effect("offers Codex's login page and finishes when Codex reports success", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.auth.controller.start("owner");
    const waiting = yield* h.state((value) => value.phase === "waiting");
    assert.deepEqual(waiting.interaction, {
      type: "browser",
      id: "browser",
      url: authUrl,
      requiresConsent: false,
      acceptsCallback: true,
    });
    yield* h.complete({ success: true, loginId: "other-login" });
    yield* h.complete({ success: true, loginId: "login-1" });
    yield* h.state((value) => value.phase === "succeeded");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a sign-in that Codex rejected", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.auth.controller.start("owner");
    yield* h.state((value) => value.phase === "waiting");
    yield* h.complete({ success: false, loginId: "login-1", error: "denied" });
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.equal(failed.message, "denied");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("forwards only this sign-in's pasted callback to Codex's loopback page", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const started = yield* h.auth.controller.start("owner");
    yield* h.state((value) => value.phase === "waiting");
    const complete = (callbackUrl: string) =>
      h.auth.controller.complete("owner", { flowId: started.flowId!, callbackUrl });
    const foreign = yield* complete(
      "http://localhost:1455/auth/callback?code=abc&state=forged",
    ).pipe(Effect.flip);
    assert.equal(foreign.detail, "This address does not belong to the current sign-in.");
    yield* complete("http://localhost:1455/auth/callback?code=abc&state=s7Ate");
    assert.deepEqual(yield* Ref.get(h.forwarded), [
      "http://localhost:1455/auth/callback?code=abc&state=s7Ate",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
