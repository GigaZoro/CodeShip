import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export class ApiCreditCheckError extends Schema.TaggedError<ApiCreditCheckError>()(
  "ApiCreditCheckError",
  { status: Schema.Int, detail: Schema.String, code: Schema.optionalKey(Schema.String) },
) {
  override get message() {
    return `API credit check failed (HTTP ${this.status}): ${this.detail}`;
  }
}

const ApiError = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) }),
});
const TokenCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const ClaudeUsage = Schema.Struct({
  model: Schema.String,
  usage: Schema.Struct({
    input_tokens: TokenCount,
    output_tokens: TokenCount,
    cache_read_input_tokens: Schema.optionalKey(TokenCount),
    cache_creation_input_tokens: Schema.optionalKey(TokenCount),
  }),
});
const decodeApiError = Schema.decodeUnknownEffect(ApiError);
const decodeClaudeUsage = Schema.decodeUnknownEffect(ClaudeUsage);

/** Only an explicit user credit check invokes this billable request. */
export const checkApiCredit = Effect.fn("ApiCreditCheck.check")(function* (input: {
  readonly apiKey: string;
}) {
  if (!input.apiKey.trim())
    return yield* new ApiCreditCheckError({ status: 0, detail: "No API key is configured." });
  const http = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
    HttpClientRequest.setHeader("x-api-key", input.apiKey),
    HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
    HttpClientRequest.bodyJson({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "OK" }],
    }),
  );
  const response = yield* http.execute(request);
  const body = yield* response.json;
  if (response.status < 200 || response.status >= 300) {
    const parsed = yield* decodeApiError(body);
    return yield* new ApiCreditCheckError({
      status: response.status,
      detail: parsed.error.message,
      ...(parsed.error.type ? { code: parsed.error.type } : {}),
    });
  }
  const result = yield* decodeClaudeUsage(body);
  if (
    result.usage.input_tokens +
      result.usage.output_tokens +
      (result.usage.cache_read_input_tokens ?? 0) +
      (result.usage.cache_creation_input_tokens ?? 0) ===
    0
  )
    return yield* new ApiCreditCheckError({
      status: response.status,
      detail: "The API did not report any token usage; credit availability could not be confirmed.",
    });
  return {
    model: result.model,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    cachedInputTokens: result.usage.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: result.usage.cache_creation_input_tokens ?? 0,
  };
}, Effect.timeout("30 seconds"));
