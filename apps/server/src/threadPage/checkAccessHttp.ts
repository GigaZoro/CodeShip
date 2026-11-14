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

const UpdateThreadBody = Schema.Struct({
  expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.NonEmptyString),
  operation_id: Schema.optional(Schema.String.check(Schema.isUUID())),
}).check(Schema.makeFilter((body) => body.description !== undefined || body.status !== undefined));
const decodeUpdateThreadBody = Schema.decodeUnknownEffect(UpdateThreadBody);
const isThreadId = Schema.is(Schema.String.check(Schema.isUUID()));

const respond = (status: number, body: object) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const invalidRequest = (message: string) => respond(400, { error: "invalid_request", message });

/** Parses a JSON body of at most 64 KiB, or answers null. */
const readJsonBody = Effect.fn("ThreadPageCheckRoutes.readJsonBody")(function* <A, E>(
  decode: (body: unknown) => Effect.Effect<A, E>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A declared length over the cap is refused before reading; chunked bodies hit the reader cap.
  if (Number(request.headers["content-length"] ?? "0") > MAX_BODY_BYTES) return null;
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.flatMap(decode),
    Effect.orElseSucceed(() => null),
  );
});

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
    const body = yield* readJsonBody(decodeAddNoteBody);
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

const updateThreadRoute = HttpRouter.add(
  "PATCH",
  `${THREADPAGE_CHECK_ROUTE_PREFIX}/threads/:threadId`,
  Effect.gen(function* () {
    if (!(yield* isCheckRequest)) return unauthorized;
    const { threadId } = yield* HttpRouter.params;
    const body = yield* readJsonBody(decodeUpdateThreadBody);
    if (threadId === undefined || !isThreadId(threadId) || body === null) {
      return invalidRequest(
        'Name the thread by its id in the path and send JSON of at most 64 KiB: {"expected_revision": <its revision>, "description": "…", "status": "…", "operation_id": "<optional UUID>"}, with a description, a status or both.',
      );
    }
    const access = yield* ThreadPageCheckAccess;
    return yield* access
      .updateThread({
        threadId,
        expectedRevision: body.expected_revision,
        description: body.description,
        status: body.status,
        operationId: body.operation_id,
      })
      .pipe(
        Effect.map((update) => respond(200, update)),
        Effect.catchTags({
          ThreadPageCheckAccessError: (error) => Effect.succeed(failureResponse(error)),
          ThreadPageStaleRevisionError: (error) =>
            Effect.succeed(
              respond(409, {
                error: "stale_revision",
                message: error.message,
                thread: error.thread,
              }),
            ),
        }),
      );
  }),
);

export const layer = Layer.mergeAll(listThreadsRoute, addNoteRoute, updateThreadRoute);
