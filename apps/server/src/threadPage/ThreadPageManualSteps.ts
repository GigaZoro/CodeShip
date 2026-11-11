import {
  type ManualStep,
  ManualStepsListError,
  type ManualStepsListFailure,
  type ManualStepsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Settings from "../serverSettings.ts";
import {
  findMachineInbox,
  limitNotes,
  machineFolders,
  selectManualSteps,
  selectNotesToRead,
  type ThreadPageFolder,
  type ThreadPageNote,
  type ThreadPageNoteSummary,
  type ThreadPageThread,
} from "./manualSteps.ts";

const API = "https://thread.page/api/integrations/v1";
const PAGE_SIZE = "50";
// List cursors page 50 at a time; these caps bound a read to a few hundred requests at worst.
const MAX_FOLDER_PAGES = 20;
const MAX_THREAD_PAGES = 10;
const MAX_NOTE_PAGES = 10;
// 20+ rows ask for reviews at once; this keeps list and note reads under ThreadPage's rate limit.
const MAX_CONCURRENT_REQUESTS = 4;

const Folder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  trashed: Schema.Boolean,
});
const Thread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.String,
  archived: Schema.Boolean,
  trashed: Schema.Boolean,
  last_activity_at: Schema.String,
});
const NoteSummary = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  trashed: Schema.Boolean,
});
const Note = Schema.Struct({
  created_at: Schema.String,
  trashed: Schema.Boolean,
  markdown: Schema.String,
});
interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly next_cursor: string | null;
}
const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), next_cursor: Schema.NullOr(Schema.String) });
const decodeFolderPage = Schema.decodeUnknownEffect(page(Folder));
const decodeThreadPage = Schema.decodeUnknownEffect(page(Thread));
const decodeNotePage = Schema.decodeUnknownEffect(page(NoteSummary));
const decodeNote = Schema.decodeUnknownEffect(Note);

const isManualStepsListError = Schema.is(ManualStepsListError);

const failure = (reason: ManualStepsListFailure, detail: string) =>
  new ManualStepsListError({ reason, detail });

// ThreadPage error bodies echo request details; report only the status and the wait it asks for.
const describeFailure = (error: unknown): ManualStepsListError => {
  if (Cause.isTimeoutError(error)) {
    return failure("unreachable", "ThreadPage did not answer within 15 seconds.");
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const { status, headers } = error.reason.response;
    if (status === 401)
      return failure("token-rejected", "ThreadPage refused the token (HTTP 401).");
    if (status === 403) {
      return failure("access-denied", "The ThreadPage token cannot read threads (HTTP 403).");
    }
    if (status === 409) {
      return failure("paused", "The ThreadPage connection is paused or unavailable (HTTP 409).");
    }
    if (status === 429) {
      const wait = Number.parseInt(headers["retry-after"] ?? "", 10);
      return failure(
        "rate-limited",
        Number.isFinite(wait)
          ? `ThreadPage asked to wait ${wait} seconds (HTTP 429).`
          : "ThreadPage is rate limiting requests (HTTP 429).",
      );
    }
    return failure("unreachable", `ThreadPage answered with HTTP ${status}.`);
  }
  if (Schema.isSchemaError(error)) {
    return failure("unreachable", "ThreadPage answered in a form this version cannot read.");
  }
  return failure("unreachable", "Could not reach ThreadPage.");
};

export type ManualStepLookup =
  | { readonly _tag: "NotConnected" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Found"; readonly step: ManualStep };

interface ListedSteps {
  readonly steps: ReadonlyArray<ManualStep>;
  readonly readAtMillis: number;
}

export class ThreadPageManualSteps extends Context.Service<
  ThreadPageManualSteps,
  {
    /** Every Waiting thread in the machine folders of ThreadPage's Machine inbox. */
    readonly list: Effect.Effect<ManualStepsListResult, ManualStepsListError>;
    /**
     * The Waiting step of a thread, as of `updatedAt` or newer. Answers from the last list when
     * it has that version, or was read after it (then the thread is the hit or `Missing`);
     * otherwise reads the list again.
     */
    readonly findStep: (
      threadId: string,
      updatedAt: string,
    ) => Effect.Effect<ManualStepLookup, ManualStepsListError>;
    /** The first note of a thread and its newest few, in full and capped for a model prompt. */
    readonly notes: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<ThreadPageNote>, ManualStepsListError>;
  }
>()("t3/threadPage/ThreadPageManualSteps") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const requestSlots = yield* Semaphore.make(MAX_CONCURRENT_REQUESTS);

  const get = Effect.fn("ThreadPageManualSteps.get")(function* (
    token: string,
    path: string,
    params: Readonly<Record<string, string>>,
  ) {
    return yield* requestSlots.withPermits(1)(
      client
        .execute(
          HttpClientRequest.get(`${API}${path}`).pipe(
            HttpClientRequest.setUrlParams(params),
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              // ThreadPage's edge refuses requests without a named client.
              "User-Agent": "T3.CodeShip",
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout("15 seconds"),
        ),
    );
  });

  const readPages = Effect.fn("ThreadPageManualSteps.readPages")(function* <A, E>(
    maxPages: number,
    readPage: (cursor: string | null) => Effect.Effect<Page<A>, E>,
  ) {
    const items: A[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < maxPages; index += 1) {
      const result: Page<A> = yield* readPage(cursor);
      items.push(...result.items);
      cursor = result.next_cursor;
      if (cursor === null) break;
    }
    return items;
  });

  const read = Effect.fn("ThreadPageManualSteps.read")(function* (token: string) {
    const folders: ReadonlyArray<ThreadPageFolder> = yield* readPages(MAX_FOLDER_PAGES, (cursor) =>
      get(token, "/folders", { limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) }).pipe(
        Effect.flatMap(decodeFolderPage),
      ),
    );
    const inbox = findMachineInbox(folders);
    if (inbox === null) {
      return yield* failure("no-inbox", "The ThreadPage token sees no Machine inbox folder.");
    }
    const threadsByFolder = yield* Effect.forEach(
      [...machineFolders(folders, inbox.id)],
      ([folderId, machine]) =>
        readPages(MAX_THREAD_PAGES, (cursor) =>
          get(token, "/threads", {
            folder_id: folderId,
            state: "active",
            limit: PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
          }).pipe(Effect.flatMap(decodeThreadPage)),
        ).pipe(Effect.map((threads: ReadonlyArray<ThreadPageThread>) => ({ machine, threads }))),
      { concurrency: 4 },
    );
    return selectManualSteps(threadsByFolder);
  });

  const lastListed = yield* Ref.make<ListedSteps | null>(null);
  // One lookup at a time, so concurrent callers share a single read of the list.
  const lookupLock = yield* Semaphore.make(1);

  const readToken = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.threadPage.apiToken),
    Effect.mapError(() => failure("unreachable", "Could not read the ThreadPage token.")),
  );

  const mapReadError = (error: unknown) =>
    isManualStepsListError(error) ? error : describeFailure(error);

  const list = Effect.gen(function* () {
    const token = yield* readToken;
    if (token.length === 0) return { _tag: "NotConnected" } as const;
    const steps = yield* read(token).pipe(
      Effect.mapError(mapReadError),
      Effect.tapError((error) =>
        Effect.logWarning("ThreadPage manual steps read failed", {
          reason: error.reason,
          detail: error.detail,
        }),
      ),
    );
    yield* Ref.set(lastListed, { steps, readAtMillis: yield* Clock.currentTimeMillis });
    return {
      _tag: "Listed",
      steps,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    } as const;
  }).pipe(Effect.withSpan("ThreadPageManualSteps.list"));

  const findStep: ThreadPageManualSteps["Service"]["findStep"] = Effect.fn(
    "ThreadPageManualSteps.findStep",
  )(function* (threadId, updatedAt) {
    return yield* lookupLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(lastListed);
        const hit = cached?.steps.find((step) => step.threadId === threadId);
        if (hit !== undefined && hit.updatedAt >= updatedAt) {
          return { _tag: "Found", step: hit } as const;
        }
        // A list read after the requested version already shows whatever that version left.
        const requestedAtMillis = Date.parse(updatedAt);
        if (
          cached !== null &&
          cached.readAtMillis > (Number.isNaN(requestedAtMillis) ? 0 : requestedAtMillis)
        ) {
          return hit === undefined
            ? ({ _tag: "Missing" } as const)
            : ({ _tag: "Found", step: hit } as const);
        }
        const result = yield* list;
        if (result._tag === "NotConnected") return result;
        const step = result.steps.find((candidate) => candidate.threadId === threadId);
        return step === undefined
          ? ({ _tag: "Missing" } as const)
          : ({ _tag: "Found", step } as const);
      }),
    );
  });

  const notes: ThreadPageManualSteps["Service"]["notes"] = Effect.fn("ThreadPageManualSteps.notes")(
    function* (threadId) {
      const token = yield* readToken;
      if (token.length === 0) {
        return yield* failure("token-rejected", "No ThreadPage token is set.");
      }
      return yield* Effect.gen(function* () {
        const summaries: ReadonlyArray<ThreadPageNoteSummary> = yield* readPages(
          MAX_NOTE_PAGES,
          (cursor) =>
            get(token, `/threads/${encodeURIComponent(threadId)}/notes`, {
              limit: PAGE_SIZE,
              ...(cursor === null ? {} : { cursor }),
            }).pipe(Effect.flatMap(decodeNotePage)),
        );
        const bodies = yield* Effect.forEach(
          selectNotesToRead(summaries),
          (id) =>
            get(token, `/notes/${encodeURIComponent(id)}`, {}).pipe(Effect.flatMap(decodeNote)),
          { concurrency: 4 },
        );
        return limitNotes(
          bodies
            .filter((note) => !note.trashed)
            .map((note) => ({ createdAt: note.created_at, markdown: note.markdown })),
        );
      }).pipe(
        Effect.mapError(mapReadError),
        Effect.tapError((error) =>
          Effect.logWarning("ThreadPage notes read failed", {
            reason: error.reason,
            detail: error.detail,
          }),
        ),
      );
    },
  );

  return ThreadPageManualSteps.of({ list, findStep, notes });
});

export const layer = Layer.effect(ThreadPageManualSteps, make);
