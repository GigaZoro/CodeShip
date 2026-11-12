import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  UrlParams,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as Settings from "../serverSettings.ts";
import * as ThreadPageCheckAccessHttp from "./checkAccessHttp.ts";
import * as ThreadPageCheckAccess from "./ThreadPageCheckAccess.ts";

const OPERATION_ID = "5b0c1f8e-3f4a-4d55-9a7e-2f1d6c8b9a01";
const thread = (id: string, description?: string) => ({
  id,
  title: `Thread ${id}`,
  ...(description === undefined ? {} : { description }),
  status: "waiting",
  status_name: "Waiting",
  last_activity_at: "2026-11-12T08:00:00.000Z",
  url: `https://thread.page/app/threads/${id}`,
  archived: false,
});

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly params: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const fakeThreadPage = (answer: (request: SeenRequest) => Response) => {
  const requests: SeenRequest[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const seen: SeenRequest = {
        method: request.method,
        path: new URL(request.url).pathname.replace("/api/integrations/v1", ""),
        params: UrlParams.toString(request.urlParams),
        headers: request.headers,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null,
      };
      requests.push(seen);
      return HttpClientResponse.fromWeb(request, answer(seen));
    }),
  );
  return { http, requests };
};

const withAccess = <A, E>(
  http: HttpClient.HttpClient,
  use: (access: ThreadPageCheckAccess.ThreadPageCheckAccess["Service"]) => Effect.Effect<A, E>,
  apiToken = "tp_test",
) =>
  Effect.flatMap(ThreadPageCheckAccess.ThreadPageCheckAccess, use).pipe(
    Effect.provide(
      ThreadPageCheckAccess.layer.pipe(
        Layer.provide(Settings.ServerSettingsService.layerTest({ threadPage: { apiToken } })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.succeed(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.orDie,
      ),
    ),
  );

const unused = () => Response.json({}, { status: 500 });

describe("ThreadPageCheckAccess", () => {
  it.effect("gives a check a local URL and its own token that stops working when it ends", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage(unused);
      yield* withAccess(http, (access) =>
        Effect.gen(function* () {
          const env = yield* Effect.scoped(
            Effect.gen(function* () {
              const granted = yield* access.grant;
              assert.isTrue(yield* access.isGranted(granted.T3CODE_THREADPAGE_TOKEN ?? ""));
              return granted;
            }),
          );
          assert.equal(env.T3CODE_THREADPAGE_URL, "http://127.0.0.1:43123/api/threadpage");
          assert.notInclude(Object.values(env), "tp_test");
          assert.isFalse(yield* access.isGranted(env.T3CODE_THREADPAGE_TOKEN ?? ""));
          assert.isFalse(yield* access.isGranted(""));
        }),
      );
      assert.lengthOf(requests, 0);
    }),
  );

  it.effect("lists a folder's active threads across pages with ThreadPage's own fields", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage((request) =>
        Response.json(
          new URLSearchParams(request.params).get("cursor") === null
            ? { items: [thread("a", "Hands-on: sign in")], next_cursor: "page-2" }
            : { items: [thread("b")], next_cursor: null },
        ),
      );
      const threads = yield* withAccess(http, (access) => access.listThreads("folder-1"));
      expect(threads).toEqual([
        {
          id: "a",
          title: "Thread a",
          description: "Hands-on: sign in",
          status: "waiting",
          status_name: "Waiting",
          last_activity_at: "2026-11-12T08:00:00.000Z",
          url: "https://thread.page/app/threads/a",
        },
        {
          id: "b",
          title: "Thread b",
          description: "",
          status: "waiting",
          status_name: "Waiting",
          last_activity_at: "2026-11-12T08:00:00.000Z",
          url: "https://thread.page/app/threads/b",
        },
      ]);
      expect(requests.map(({ method, path, params }) => `${method} ${path}?${params}`)).toEqual([
        "GET /threads?folder_id=folder-1&state=active&limit=50",
        "GET /threads?folder_id=folder-1&state=active&limit=50&cursor=page-2",
      ]);
      assert.equal(requests[0]?.headers.authorization, "Bearer tp_test");
    }),
  );

  it.effect("refuses a folder too large to list whole instead of cutting it", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage((request) => {
        const page = Number(new URLSearchParams(request.params).get("cursor") ?? "0");
        return Response.json({
          items: Array.from({ length: 50 }, (_, index) => thread(`${page}-${index}`)),
          next_cursor: String(page + 1),
        });
      });
      const error = yield* withAccess(http, (access) =>
        access.listThreads("folder-1").pipe(Effect.flip),
      );
      assert.equal(error.reason, "threadpage_failed");
      assert.include(error.detail, "more than 500");
      assert.lengthOf(requests, 11);
    }),
  );

  it.effect("adds a note under the check's operation id, or a new one", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage((request) =>
        Response.json(
          {
            operation_id: request.headers["operation-id"],
            status: "accepted",
            note_id: "note-1",
            url: "https://thread.page/app/notes/note-1",
          },
          { status: 201 },
        ),
      );
      const [given, generated] = yield* withAccess(http, (access) =>
        Effect.all([
          access.addNote({ threadId: "t 1", markdown: "Healthy", operationId: OPERATION_ID }),
          access.addNote({ threadId: "t-2", markdown: "Healthy" }),
        ]),
      );
      expect(given).toEqual({
        note_id: "note-1",
        url: "https://thread.page/app/notes/note-1",
        operation_id: OPERATION_ID,
      });
      assert.match(generated.operation_id, /^[0-9a-f-]{36}$/u);
      assert.notEqual(generated.operation_id, OPERATION_ID);
      const [first, second] = requests;
      assert.equal(first?.method, "POST");
      assert.equal(first?.path, "/threads/t%201/notes");
      assert.equal(first?.headers["operation-id"], OPERATION_ID);
      expect(first?.body).toEqual({ content: { markdown: "Healthy" } });
      assert.equal(second?.headers["operation-id"], generated.operation_id);
    }),
  );

  it.effect("says why ThreadPage did not list or add, without passing on its text", () =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<
        readonly [Response, Partial<ThreadPageCheckAccess.ThreadPageCheckAccessError>]
      > = [
        [
          Response.json({ code: "write_not_allowed", message: "x" }, { status: 403 }),
          { status: 403, code: "write_not_allowed", retryAfterSeconds: null },
        ],
        [
          Response.json(
            { code: "rate_limited" },
            { status: 429, headers: { "retry-after": "30" } },
          ),
          { status: 429, code: "rate_limited", retryAfterSeconds: 30 },
        ],
        [
          Response.json({ code: "<b>Not a code</b>" }, { status: 500 }),
          { status: 500, code: null },
        ],
        [
          Response.json(
            { operation_id: OPERATION_ID, status: "conflict", code: "stale" },
            {
              status: 201,
            },
          ),
          { status: 201, code: "stale", detail: "ThreadPage did not add the note (conflict)." },
        ],
        [
          Response.json({ unexpected: true }, { status: 201 }),
          { status: null, detail: "ThreadPage answered in a form this version cannot read." },
        ],
      ];
      for (const [response, expected] of rows) {
        const { http } = fakeThreadPage(() => response.clone());
        const error = yield* withAccess(http, (access) =>
          access.addNote({ threadId: "t", markdown: "x" }).pipe(Effect.flip),
        );
        assert.equal(error.reason, "threadpage_failed");
        expect(error).toMatchObject(expected);
      }
    }),
  );

  it.effect("refuses a check on a machine with no ThreadPage token", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage(unused);
      const error = yield* withAccess(
        http,
        (access) => access.listThreads("folder-1").pipe(Effect.flip),
        "",
      );
      assert.equal(error.reason, "not_connected");
      assert.lengthOf(requests, 0);
    }),
  );
});

const CHECK_TOKEN = "check-token";

const serveRoutes = (service: Partial<ThreadPageCheckAccess.ThreadPageCheckAccess["Service"]>) =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const services = yield* Layer.build(
      HttpRouter.serve(ThreadPageCheckAccessHttp.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ThreadPageCheckAccess.ThreadPageCheckAccess)({
            isGranted: (token) => Effect.succeed(token === CHECK_TOKEN),
            listThreads: (folderId) =>
              Effect.sync(() => calls.push(folderId)).pipe(
                Effect.andThen(service.listThreads?.(folderId) ?? Effect.succeed([])),
              ),
            addNote: (input) =>
              Effect.sync(() => calls.push(input)).pipe(
                Effect.andThen(service.addNote?.(input) ?? Effect.die("unused")),
              ),
          }),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const send = (
      request: HttpClientRequest.HttpClientRequest,
      token: string | null = CHECK_TOKEN,
    ) =>
      client
        .execute(token === null ? request : HttpClientRequest.bearerToken(request, token))
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(response.json, (body) => ({ status: response.status, body })),
          ),
        );
    return { send, calls };
  });

const failure = (fields: Partial<ThreadPageCheckAccess.ThreadPageCheckAccessError>) =>
  new ThreadPageCheckAccess.ThreadPageCheckAccessError({
    reason: "threadpage_failed",
    detail: "ThreadPage answered with HTTP 429.",
    status: 429,
    code: "rate_limited",
    retryAfterSeconds: 30,
    ...fields,
  });

describe("ThreadPage check routes", () => {
  it.effect("open only for a running check's token", () =>
    Effect.gen(function* () {
      const { send, calls } = yield* serveRoutes({});
      const list = HttpClientRequest.get("/api/threadpage/threads?folder_id=f");
      const add = HttpClientRequest.post("/api/threadpage/notes").pipe(
        HttpClientRequest.bodyJsonUnsafe({ thread_id: "t", markdown: "x" }),
      );
      for (const token of [null, "session-token"]) {
        for (const request of [list, add]) {
          const response = yield* send(request, token);
          assert.equal(response.status, 401);
          expect(response.body).toMatchObject({ error: "unauthorized" });
        }
      }
      assert.lengthOf(calls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("list a folder's threads and report why ThreadPage did not answer", () =>
    Effect.gen(function* () {
      const listed = yield* serveRoutes({
        listThreads: () =>
          Effect.succeed([
            {
              id: "a",
              title: "Thread a",
              description: "",
              status: "waiting",
              status_name: "Waiting",
              last_activity_at: "2026-11-12T08:00:00.000Z",
              url: "https://thread.page/app/threads/a",
            },
          ]),
      });
      const missing = yield* listed.send(HttpClientRequest.get("/api/threadpage/threads"));
      assert.equal(missing.status, 400);
      expect(missing.body).toMatchObject({ error: "invalid_request" });
      const ok = yield* listed.send(
        HttpClientRequest.get("/api/threadpage/threads?folder_id=f%201"),
      );
      assert.equal(ok.status, 200);
      expect(ok.body).toMatchObject({ threads: [{ id: "a", status_name: "Waiting" }] });
      expect(listed.calls).toEqual(["f 1"]);

      const limited = yield* serveRoutes({ listThreads: () => Effect.fail(failure({})) });
      const refused = yield* limited.send(
        HttpClientRequest.get("/api/threadpage/threads?folder_id=f"),
      );
      assert.equal(refused.status, 502);
      expect(refused.body).toEqual({
        error: "threadpage_failed",
        message: "ThreadPage answered with HTTP 429.",
        status: 429,
        code: "rate_limited",
        retry_after: 30,
      });

      const offline = yield* serveRoutes({
        listThreads: () =>
          Effect.fail(failure({ reason: "not_connected", detail: "No token.", status: null })),
      });
      const notConnected = yield* offline.send(
        HttpClientRequest.get("/api/threadpage/threads?folder_id=f"),
      );
      assert.equal(notConnected.status, 503);
      expect(notConnected.body).toEqual({ error: "not_connected", message: "No token." });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("add a note from a valid body only", () =>
    Effect.gen(function* () {
      const { send, calls } = yield* serveRoutes({
        addNote: (input) =>
          Effect.succeed({
            note_id: "note-1",
            url: null,
            operation_id: input.operationId ?? OPERATION_ID,
          }),
      });
      const post = (body: unknown) =>
        send(
          HttpClientRequest.post("/api/threadpage/notes").pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        );
      for (const body of [
        { thread_id: "t", markdown: "" },
        { thread_id: "t" },
        { thread_id: "t", markdown: "x", operation_id: "not-a-uuid" },
        { thread_id: "t", markdown: "x".repeat(70 * 1024) },
        { thread_id: "..", markdown: "x" },
        { thread_id: ".", markdown: "x" },
      ]) {
        const response = yield* post(body);
        assert.equal(response.status, 400);
        expect(response.body).toMatchObject({ error: "invalid_request" });
      }
      assert.lengthOf(calls, 0);

      const added = yield* post({
        thread_id: "t",
        markdown: "Healthy",
        operation_id: OPERATION_ID,
      });
      assert.equal(added.status, 201);
      expect(added.body).toEqual({ note_id: "note-1", url: null, operation_id: OPERATION_ID });
      expect(calls).toEqual([{ threadId: "t", markdown: "Healthy", operationId: OPERATION_ID }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
