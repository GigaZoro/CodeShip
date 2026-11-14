import {
  ENVIRONMENT_DESCRIPTOR_PATH,
  EnvironmentStartingResponse,
  type EnvironmentStartup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

const decodeStartingResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(EnvironmentStartingResponse),
);

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, ENVIRONMENT_DESCRIPTOR_PATH),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  );
});

/** The migration a starting server reports in its descriptor path's 503; none once it serves. */
export const fetchEnvironmentStartup = Effect.fn(
  "clientRuntime.environment.fetchEnvironmentStartup",
)(function* (httpBaseUrl: string) {
  const client = yield* HttpClient.HttpClient;
  // A starting server cannot answer a CORS preflight, so a cross-origin probe sends no trace headers.
  const response = yield* client
    .get(environmentEndpointUrl(httpBaseUrl, ENVIRONMENT_DESCRIPTOR_PATH))
    .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
  if (response.status !== 503) return Option.none<EnvironmentStartup>();
  return Option.map(decodeStartingResponse(yield* response.text), (body) => body.startup);
});
