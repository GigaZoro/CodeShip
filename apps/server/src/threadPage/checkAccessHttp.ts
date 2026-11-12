import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import {
  THREADPAGE_CHECK_ROUTE_PREFIX,
  ThreadPageCheckAccess,
  type ThreadPageCheckAccessError,
} from "./ThreadPageCheckAccess.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 64 * 1024;

const AddNoteBody = Schema.Struct({
  // "." and ".." would survive encodeURIComponent and change ThreadPage's request path.
  thread_id: Schema.NonEmptyString.check(Schema.isPattern(/^(?!\.\.?$)/u)),
  markdown: Schema.NonEmptyString,
  operation_id: Schema.optional(Schema.String.check(Schema.isUUID())),
});
const decodeAddNoteBody = Schema.decodeUnknownEffect(AddNoteBody);

const respond = (status: number, body: object) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const invalidRequest = (message: string) => respond(400, { error: "invalid_request", message });

const failureResponse = (error: ThreadPageCheckAccessError) =>
  error.reason === "not_connected"
    ? respond(503, { error: "not_connected", message: error.detail })
    : respond(502, {
        error: "threadpage_failed",
        message: error.detail,
        status: error.status,
        code: error.code,
        retry_after: error.retryAfterSeconds,
      });

/** Only the token a running check was given opens these routes; a session or pairing does not. */
const isCheckRequest = Effect.gen(function* () {
  const token = parseBearerToken(yield* HttpServerRequest.HttpServerRequest);
  if (token === null) return false;
  const access = yield* ThreadPageCheckAccess;
  return yield* access.isGranted(token);
});

const unauthorized = respond(401, {
  error: "unauthorized",
  message: "Only a running scheduled-task check can call this, with the token in its environment.",
});

const listThreadsRoute = HttpRouter.add(
  "GET",
  `${THREADPAGE_CHECK_ROUTE_PREFIX}/threads`,
  Effect.gen(function* () {
    if (!(yield* isCheckRequest)) return unauthorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const folderId = (
      new URLSearchParams(request.url.split("?", 2)[1] ?? "").get("folder_id") ?? ""
    ).trim();
    if (folderId === "") return invalidRequest("Name the folder: ?folder_id=<folder id>.");
    const access = yield* ThreadPageCheckAccess;
    return yield* access.listThreads(folderId).pipe(
      Effect.map((threads) => respond(200, { threads })),
      Effect.catchTags({
        ThreadPageCheckAccessError: (error) => Effect.succeed(failureResponse(error)),
      }),
    );
  }),
);

const addNoteRoute = HttpRouter.add(
  "POST",
  `${THREADPAGE_CHECK_ROUTE_PREFIX}/notes`,
  Effect.gen(function* () {
    if (!(yield* isCheckRequest)) return unauthorized;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A declared length over the cap is refused before reading; chunked bodies hit the reader cap.
    const body =
      Number(request.headers["content-length"] ?? "0") > MAX_BODY_BYTES
        ? null
        : yield* request.json.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
            Effect.flatMap(decodeAddNoteBody),
            Effect.orElseSucceed(() => null),
          );
    if (body === null) {
      return invalidRequest(
        'Send JSON of at most 64 KiB: {"thread_id": "…", "markdown": "…", "operation_id": "<optional UUID>"}.',
      );
    }
    const access = yield* ThreadPageCheckAccess;
    return yield* access
      .addNote({
        threadId: body.thread_id,
        markdown: body.markdown,
        operationId: body.operation_id,
      })
      .pipe(
        Effect.map((note) => respond(201, note)),
        Effect.catchTags({
          ThreadPageCheckAccessError: (error) => Effect.succeed(failureResponse(error)),
        }),
      );
  }),
);

export const layer = Layer.mergeAll(listThreadsRoute, addNoteRoute);
