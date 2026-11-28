import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { checkApiCredit } from "./ApiCreditCheck.ts";

it.effect("returns token usage for pricing a successful Claude credit check", () =>
  Effect.gen(function* () {
    const result = yield* checkApiCredit({ apiKey: "test-key" });
    assert.deepStrictEqual(result, {
      model: "claude-haiku-4-5-20251001",
      inputTokens: 3,
      outputTokens: 1,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 0,
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              model: "claude-haiku-4-5-20251001",
              usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 },
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect.each([
  { status: 429, code: "rate_limit_error", detail: "Too many requests" },
  {
    status: 400,
    code: "invalid_request_error",
    detail: "Your credit balance is too low to access the Anthropic API.",
  },
])("preserves upstream failure identity: $status / $code", ({ status, code, detail }) =>
  Effect.gen(function* () {
    const error = yield* checkApiCredit({ apiKey: "test-key" }).pipe(Effect.flip);
    assert.equal(error._tag, "ApiCreditCheckError");
    if (error._tag === "ApiCreditCheckError") {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.detail, detail);
    }
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: { type: code, message: detail } }, { status }),
          ),
        ),
      ),
    ),
  ),
);

it.effect.each([
  { input_tokens: 0, output_tokens: 0 },
  { input_tokens: -1, output_tokens: 1 },
  { input_tokens: 1.5, output_tokens: 1 },
])("rejects unmetered or invalid token evidence %j", (usage) =>
  Effect.gen(function* () {
    const error = yield* checkApiCredit({ apiKey: "test-key" }).pipe(Effect.flip);
    assert.isDefined(error);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ model: "claude-haiku-4-5-20251001", usage }),
          ),
        ),
      ),
    ),
  ),
);
