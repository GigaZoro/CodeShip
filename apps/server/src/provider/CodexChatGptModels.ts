import {
  ProviderSetupError,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import {
  CHATGPT_SIGNED_OUT,
  traceableErrorCode,
  type CodexChatGptCredentials,
} from "./CodexChatGptAuth.ts";
import { CODEX_ORIGINATOR, mapCodexModelCapabilities } from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int, code: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return `ChatGPT answered the model list with HTTP ${this.status}${this.code ? ` (${this.code})` : ""}.`;
  }
}

const ApiError = Schema.Struct({
  error: Schema.Struct({ code: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
});
const decodeApiError = Schema.decodeUnknownEffect(ApiError);

const catalogFailure = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const code = traceableErrorCode(
    yield* response.json.pipe(
      Effect.flatMap(decodeApiError),
      Effect.map((body) => body.error.code),
      Effect.orElseSucceed(() => undefined),
    ),
  );
  yield* Effect.annotateCurrentSpan({
    "http.response.status_code": response.status,
    ...(code ? { "openai.error.code": code } : {}),
  });
  return yield* new ChatGptCatalogError({ status: response.status, ...(code ? { code } : {}) });
});

const isCatalogError = Schema.is(ChatGptCatalogError);
const isRefusedToken = (error: unknown) =>
  isCatalogError(error) && (error.status === 401 || error.status === 403);

/**
 * Runs `load` with the connection's token. ChatGPT can revoke a session before its token
 * expires, so a refused token gets one forced renewal and one retry before it means sign in again.
 */
export const withChatGptToken = Effect.fn("withChatGptToken")(function* <A, E, R>(
  auth: {
    readonly renew: (
      rejected: CodexChatGptCredentials,
    ) => Effect.Effect<CodexChatGptCredentials, ProviderSetupError>;
  },
  instanceId: ProviderInstanceId,
  credentials: CodexChatGptCredentials,
  load: (accessToken: string) => Effect.Effect<A, E, R>,
) {
  const first = yield* Effect.result(load(credentials.accessToken));
  if (first._tag === "Success") return { credentials, value: first.success };
  if (!isRefusedToken(first.failure)) return yield* Effect.fail(first.failure);
  const revoked = new ProviderSetupError({
    instanceId,
    operation: "models",
    detail: "Your ChatGPT connection was revoked. Sign in again.",
  });
  const renewed = yield* auth
    .renew(credentials)
    .pipe(Effect.mapError((error) => (error.operation === CHATGPT_SIGNED_OUT ? revoked : error)));
  const second = yield* Effect.result(load(renewed.accessToken));
  if (second._tag === "Success") return { credentials: renewed, value: second.success };
  return yield* Effect.fail(isRefusedToken(second.failure) ? revoked : second.failure);
});

const CodexCatalog = Schema.Struct({
  models: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
});

/** Requests the catalog exactly as Codex does, so the backend tailors it the same way. */
export const chatGptCodexCatalog = Effect.fn("chatGptCodexCatalog")(function* (
  accessToken: string,
  clientVersion: string,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.setUrlParam("client_version", clientVersion),
      HttpClientRequest.setHeader("originator", CODEX_ORIGINATOR),
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* catalogFailure(response);
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CodexCatalog)));
}, Effect.timeout("15 seconds"));

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              effort: Schema.NonEmptyString,
              description: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
    }),
  ),
});

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* catalogFailure(response);
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model): ServerProviderModel => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
      // A pinned Codex CLI can predate a model the account already has; the catalog still lists its efforts.
      const catalogCapabilities =
        model.default_reasoning_level && model.supported_reasoning_levels
          ? mapCodexModelCapabilities({
              id: model.slug,
              model: model.slug,
              displayName: model.display_name,
              description: "",
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: model.default_reasoning_level,
              supportedReasoningEfforts: model.supported_reasoning_levels.map((level) => ({
                reasoningEffort: level.effort,
                description: level.description ?? "",
              })),
            })
          : null;
      return {
        ...native,
        capabilities: native?.capabilities ?? catalogCapabilities,
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      };
    });
}, Effect.timeout("15 seconds"));
