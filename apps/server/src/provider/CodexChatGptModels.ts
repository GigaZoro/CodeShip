import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CODEX_ORIGINATOR } from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

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
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CodexCatalog)));
}, Effect.timeout("15 seconds"));

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
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
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map(
      (model) =>
        ({
          ...nativeModels.find((native) => native.slug === model.slug),
          capabilities:
            nativeModels.find((native) => native.slug === model.slug)?.capabilities ?? null,
          slug: model.slug,
          name: model.display_name,
          isCustom: false,
        }) satisfies ServerProviderModel,
    );
}, Effect.timeout("15 seconds"));
