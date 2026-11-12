import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as Settings from "../serverSettings.ts";
import { localUrlHostForAddress } from "../startupAccess.ts";
import {
  readThreadPagePages,
  THREADPAGE_API_URL,
  THREADPAGE_PAGE_SIZE,
  threadPageListPage,
  threadPageRequestHeaders,
} from "./threadPageApi.ts";

export const THREADPAGE_CHECK_ROUTE_PREFIX = "/api/threadpage";
const THREADPAGE_URL_ENV = "T3CODE_THREADPAGE_URL";
const THREADPAGE_TOKEN_ENV = "T3CODE_THREADPAGE_TOKEN";

const MAX_THREADS = 500;
// One page past the cap tells a folder of exactly MAX_THREADS from a larger one.
const MAX_THREAD_PAGES = MAX_THREADS / Number(THREADPAGE_PAGE_SIZE) + 1;
const ERROR_CODE = /^[a-z_]{1,64}$/u;

const Thread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.String,
  status_name: Schema.String,
  last_activity_at: Schema.String,
  url: Schema.String,
});
const NoteReceipt = Schema.Struct({
  operation_id: Schema.String,
  status: Schema.String,
  note_id: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeThreadPage = Schema.decodeUnknownEffect(threadPageListPage(Thread));
const decodeNoteReceipt = Schema.decodeUnknownEffect(NoteReceipt);

/** A thread as a check sees it: ThreadPage's own field names. */
export interface CheckThread {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly status_name: string;
  readonly last_activity_at: string;
  readonly url: string;
}

export interface CheckNote {
  readonly note_id: string;
  readonly url: string | null;
  readonly operation_id: string;
}

/** Why a check's ThreadPage call did not happen. Never carries the token or a ThreadPage body. */
export class ThreadPageCheckAccessError extends Schema.TaggedError<ThreadPageCheckAccessError>()(
  "ThreadPageCheckAccessError",
  {
    reason: Schema.Literals(["not_connected", "threadpage_failed"]),
    detail: Schema.String,
    /** ThreadPage's HTTP status, when it answered. */
    status: Schema.NullOr(Schema.Number),
    /** ThreadPage's error code, such as `write_not_allowed`. */
    code: Schema.NullOr(Schema.String),
    retryAfterSeconds: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const threadPageFailed = (
  detail: string,
  fields: { status?: number; code?: string | null; retryAfterSeconds?: number | null } = {},
) =>
  new ThreadPageCheckAccessError({
    reason: "threadpage_failed",
    detail,
    status: fields.status ?? null,
    code: fields.code ?? null,
    retryAfterSeconds: fields.retryAfterSeconds ?? null,
  });

const errorCode = (body: unknown): string | null =>
  typeof body === "object" &&
  body !== null &&
  "code" in body &&
  typeof body.code === "string" &&
  ERROR_CODE.test(body.code)
    ? body.code
    : null;

const describeFailure = (error: unknown): Effect.Effect<ThreadPageCheckAccessError> => {
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const { response } = error.reason;
    const wait = Number.parseInt(response.headers["retry-after"] ?? "", 10);
    return response.json.pipe(
      Effect.option,
      Effect.map((body) =>
        threadPageFailed(`ThreadPage answered with HTTP ${response.status}.`, {
          status: response.status,
          code: body._tag === "Some" ? errorCode(body.value) : null,
          retryAfterSeconds: response.status === 429 && Number.isFinite(wait) ? wait : null,
        }),
      ),
    );
  }
  if (Schema.isSchemaError(error)) {
    return Effect.succeed(
      threadPageFailed("ThreadPage answered in a form this version cannot read."),
    );
  }
  return Effect.succeed(threadPageFailed("Could not reach ThreadPage."));
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Lets a scheduled task's check command use the server's ThreadPage connection without seeing
 * its token: the check gets a local URL and a token of its own that stops working when it ends.
 */
export class ThreadPageCheckAccess extends Context.Service<
  ThreadPageCheckAccess,
  {
    /** Environment variables for one check run; its token is revoked when the scope closes. */
    readonly grant: Effect.Effect<Readonly<Record<string, string>>, never, Scope.Scope>;
    readonly isGranted: (token: string) => Effect.Effect<boolean>;
    /** The active threads of a folder, at most 500. */
    readonly listThreads: (
      folderId: string,
    ) => Effect.Effect<ReadonlyArray<CheckThread>, ThreadPageCheckAccessError>;
    readonly addNote: (input: {
      readonly threadId: string;
      readonly markdown: string;
      /** The same id on a retry returns the first receipt instead of adding a second note. */
      readonly operationId?: string | undefined;
    }) => Effect.Effect<CheckNote, ThreadPageCheckAccessError>;
  }
>()("t3/threadPage/ThreadPageCheckAccess") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const settingsService = yield* Settings.ServerSettingsService;
  const httpServer = yield* HttpServer.HttpServer;
  const grants = yield* Ref.make<ReadonlySet<string>>(new Set());
  const address = httpServer.address;
  const localUrl = NetAddress.isInetAddress(address)
    ? `http://${localUrlHostForAddress(address)}:${address.port}${THREADPAGE_CHECK_ROUTE_PREFIX}`
    : null;

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const grant = Effect.gen(function* () {
    if (localUrl === null) return {};
    const token = yield* crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orDie,
    );
    const tokenHash = yield* hashToken(token);
    yield* Effect.acquireRelease(
      Ref.update(grants, (current) => new Set(current).add(tokenHash)),
      () =>
        Ref.update(grants, (current) => {
          const next = new Set(current);
          next.delete(tokenHash);
          return next;
        }),
    );
    return { [THREADPAGE_URL_ENV]: localUrl, [THREADPAGE_TOKEN_ENV]: token };
  }).pipe(Effect.withSpan("ThreadPageCheckAccess.grant"));

  const isGranted: ThreadPageCheckAccess["Service"]["isGranted"] = Effect.fn(
    "ThreadPageCheckAccess.isGranted",
  )(function* (token) {
    if (token.length === 0) return false;
    const tokenHash = yield* hashToken(token);
    return (yield* Ref.get(grants)).has(tokenHash);
  });

  const connectionToken = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.threadPage.apiToken),
    Effect.orDie,
    Effect.filterOrFail(
      (token) => token.length > 0,
      () =>
        new ThreadPageCheckAccessError({
          reason: "not_connected",
          detail:
            "This machine has no ThreadPage token. Save one in Settings → Threads → ThreadPage.",
          status: null,
          code: null,
          retryAfterSeconds: null,
        }),
    ),
  );

  const send = <A, E, R>(
    token: string,
    request: HttpClientRequest.HttpClientRequest,
    decode: (body: unknown) => Effect.Effect<A, E, R>,
  ) =>
    client
      .execute(request.pipe(HttpClientRequest.setHeaders(threadPageRequestHeaders(token))))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(decode),
            Effect.map((value) => ({ status: response.status, value })),
          ),
        ),
        Effect.catch((error) => Effect.flatMap(describeFailure(error), Effect.fail)),
        // Bounds reading an error's body too, which describeFailure does.
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(threadPageFailed("ThreadPage did not answer within 15 seconds.")),
        }),
      );

  const listThreads: ThreadPageCheckAccess["Service"]["listThreads"] = Effect.fn(
    "ThreadPageCheckAccess.listThreads",
  )(function* (folderId) {
    const token = yield* connectionToken;
    const threads = yield* readThreadPagePages(MAX_THREAD_PAGES, (cursor) =>
      send(
        token,
        HttpClientRequest.get(`${THREADPAGE_API_URL}/threads`).pipe(
          HttpClientRequest.setUrlParams({
            folder_id: folderId,
            state: "active",
            limit: THREADPAGE_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
          }),
        ),
        decodeThreadPage,
      ).pipe(Effect.map((page) => page.value)),
    );
    // A cut list could make a check skip a run for work it never saw.
    if (threads.length > MAX_THREADS) {
      return yield* threadPageFailed(
        `The folder has more than ${MAX_THREADS} active threads, more than a check can list.`,
      );
    }
    return threads.map((thread): CheckThread => ({
      id: thread.id,
      title: thread.title,
      description: thread.description ?? "",
      status: thread.status,
      status_name: thread.status_name,
      last_activity_at: thread.last_activity_at,
      url: thread.url,
    }));
  });

  const addNote: ThreadPageCheckAccess["Service"]["addNote"] = Effect.fn(
    "ThreadPageCheckAccess.addNote",
  )(function* (input) {
    const token = yield* connectionToken;
    const operationId = input.operationId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const { status, value: receipt } = yield* send(
      token,
      HttpClientRequest.post(
        `${THREADPAGE_API_URL}/threads/${encodeURIComponent(input.threadId)}/notes`,
      ).pipe(
        HttpClientRequest.setHeader("Operation-Id", operationId),
        HttpClientRequest.bodyJsonUnsafe({ content: { markdown: input.markdown } }),
      ),
      decodeNoteReceipt,
    );
    // A 201 can still report that nothing was written.
    if (receipt.status !== "accepted" || receipt.note_id == null) {
      return yield* threadPageFailed(`ThreadPage did not add the note (${receipt.status}).`, {
        status,
        code: receipt.code != null && ERROR_CODE.test(receipt.code) ? receipt.code : null,
      });
    }
    return { note_id: receipt.note_id, url: receipt.url ?? null, operation_id: operationId };
  });

  return ThreadPageCheckAccess.of({ grant, isGranted, listThreads, addNote });
});

export const layer = Layer.effect(ThreadPageCheckAccess, make);
