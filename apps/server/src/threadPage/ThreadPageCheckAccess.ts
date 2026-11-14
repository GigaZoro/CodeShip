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

/** A thread as a check sees it: ThreadPage's own field names. */
const CheckThreadSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: Schema.String,
  status_name: Schema.String,
  /** Moves on with every change to the thread; a check's update names the one it read. */
  revision: Schema.Int,
  last_activity_at: Schema.String,
  url: Schema.String,
});
export type CheckThread = typeof CheckThreadSchema.Type;

// ThreadPage leaves out the description for a connection that only adds notes.
const Thread = Schema.Struct({
  ...CheckThreadSchema.fields,
  description: Schema.optional(Schema.String),
});
const NoteReceipt = Schema.Struct({
  operation_id: Schema.String,
  status: Schema.String,
  note_id: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
});
const ChangeReceipt = Schema.Struct({
  status: Schema.String,
  kind: Schema.optional(Schema.String),
  target: Schema.optional(Schema.Struct({ id: Schema.String })),
  revision: Schema.optional(Schema.NullOr(Schema.Int)),
  thread_status: Schema.optional(Schema.String),
  code: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeThreadPage = Schema.decodeUnknownEffect(threadPageListPage(Thread));
const decodeThread = Schema.decodeUnknownEffect(Thread);
const decodeNoteReceipt = Schema.decodeUnknownEffect(NoteReceipt);
const decodeChangeReceipt = Schema.decodeUnknownEffect(ChangeReceipt);

const toCheckThread = (thread: typeof Thread.Type): CheckThread => ({
  ...thread,
  description: thread.description ?? "",
});

export interface CheckNote {
  readonly note_id: string;
  readonly url: string | null;
  readonly operation_id: string;
}

export interface CheckThreadUpdate {
  /** The thread's revision after the change, when ThreadPage reports it. */
  readonly revision: number | null;
  /** The thread's status after the change: a deleted status lands on its replacement. */
  readonly status: string;
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

/** The thread changed since the check read it, so the check's update was not sent. */
export class ThreadPageStaleRevisionError extends Schema.TaggedError<ThreadPageStaleRevisionError>()(
  "ThreadPageStaleRevisionError",
  { thread: CheckThreadSchema },
) {
  override get message(): string {
    return `The thread is at revision ${this.thread.revision} now; read it again before changing it.`;
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
    /** Sets a thread's description or status, only while it is still at `expectedRevision`. */
    readonly updateThread: (input: {
      readonly threadId: string;
      readonly expectedRevision: number;
      readonly description?: string | undefined;
      readonly status?: string | undefined;
      /** The same id on a retry returns the first change instead of refusing it as stale. */
      readonly operationId?: string | undefined;
    }) => Effect.Effect<
      CheckThreadUpdate,
      ThreadPageCheckAccessError | ThreadPageStaleRevisionError
    >;
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
    return threads.map(toCheckThread);
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

  const updateThread: ThreadPageCheckAccess["Service"]["updateThread"] = Effect.fn(
    "ThreadPageCheckAccess.updateThread",
  )(function* (input) {
    const token = yield* connectionToken;
    const threadUrl = `${THREADPAGE_API_URL}/threads/${encodeURIComponent(input.threadId)}`;
    const operationId = input.operationId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    // ThreadPage's thread update takes no revision, so it is compared here just before the update;
    // only a change landing between these two calls goes unseen.
    const { value: current } = yield* send(token, HttpClientRequest.get(threadUrl), decodeThread);
    if (current.revision !== input.expectedRevision) {
      // A retry after a lost answer finds the thread moved on by its own first attempt.
      const earlier =
        input.operationId === undefined
          ? null
          : yield* send(
              token,
              HttpClientRequest.get(
                `${THREADPAGE_API_URL}/operations/${encodeURIComponent(operationId)}`,
              ),
              decodeChangeReceipt,
            ).pipe(
              Effect.map(({ value }) => value),
              Effect.catchIf(
                (error) => error.status === 404,
                () => Effect.succeed(null),
              ),
            );
      const landed =
        earlier?.kind === "thread.update" &&
        earlier.target?.id === current.id &&
        earlier.status === "accepted";
      if (!landed) {
        return yield* new ThreadPageStaleRevisionError({ thread: toCheckThread(current) });
      }
      // Sent again under the same id, ThreadPage answers the first change, or refuses a different body.
    }

    const { status, value: receipt } = yield* send(
      token,
      HttpClientRequest.patch(threadUrl).pipe(
        HttpClientRequest.setHeader("Operation-Id", operationId),
        HttpClientRequest.bodyJsonUnsafe({
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
        }),
      ),
      decodeChangeReceipt,
    );
    if (receipt.status !== "accepted") {
      return yield* threadPageFailed(`ThreadPage did not change the thread (${receipt.status}).`, {
        status,
        code: receipt.code != null && ERROR_CODE.test(receipt.code) ? receipt.code : null,
      });
    }
    return {
      revision: receipt.revision ?? null,
      status: receipt.thread_status ?? input.status ?? current.status,
      operation_id: operationId,
    };
  });

  return ThreadPageCheckAccess.of({ grant, isGranted, listThreads, addNote, updateThread });
});

export const layer = Layer.effect(ThreadPageCheckAccess, make);
