import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestrationV2LinkedSender,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const Result = Schema.Struct({ modes: Schema.String });
const toolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Returns this request's mode limits.",
    success: Result,
    failure: OrchestratorMcpFailure,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
  Tool.make("hold", {
    description: "Holds a tool request open.",
    success: Result,
    failure: OrchestratorMcpFailure,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
  Tool.make("refuse", {
    description: "Refuses the call.",
    success: Result,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

/** One `probe` call to a linked peer at a remote address, answered by `http`. */
const probeThrough = Effect.fn(function* (http: HttpClient.HttpClient) {
  const box = descriptorOf("environment-box", "Box");
  const context = yield* Layer.build(
    PeerMcpClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () =>
              Effect.succeed({
                link: {
                  environmentId: box.environmentId,
                  label: box.label,
                  urls: ["https://peer.example"],
                  access: "auto",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1),
                  lastReachedAt: null,
                  lastError: null,
                },
                url: "https://peer.example",
                token: "fixture",
                serverVersion: "0.0.0-test",
              }),
            recordOutcome: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  return Context.get(context, PeerMcpClient.PeerMcpClient).call({
    environmentId: box.environmentId,
    tool: "probe",
    arguments: {},
    limits: { runtimeMode: "approval-required", interactionMode: "plan" },
    success: Result,
  });
});

const probeResult = JSON.stringify({
  result: { content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }] },
});

const refusal = new OrchestratorMcpFailure({
  code: "thread_not_found",
  message: "Thread thread-gone was not found.",
});

const senderToolkit = Toolkit.make(
  Tool.make("sender", {
    description: "Returns the thread this request is made for.",
    success: Schema.Struct({ senderThread: Schema.NullOr(OrchestrationV2LinkedSender) }),
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

it.effect("tells the peer which thread a call is made for", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(senderToolkit, {
        sender: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.map((scope) => ({ senderThread: scope.client?.senderThread ?? null })),
          ),
        ),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(senderToolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      // A thread id may hold any character; it arrives as sent.
      const sender = {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("import:claude/orc lead"),
        title: "orc lead / opus → fable",
      };
      const call = (input: { readonly sender?: typeof sender }) =>
        client.call({
          environmentId: box.environmentId,
          tool: "sender",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          ...input,
          success: Schema.Struct({ senderThread: Schema.NullOr(OrchestrationV2LinkedSender) }),
        });
      expect(yield* call({ sender })).toEqual({ senderThread: sender });
      expect(yield* call({})).toEqual({ senderThread: null });
      // A long title is cut to whole characters rather than breaking the call.
      const long = yield* call({ sender: { ...sender, title: "🧵".repeat(5000) } });
      expect(long.senderThread?.title).toBe("🧵".repeat(200));
      // A title holding an unpaired surrogate still lets the call through.
      const broken = yield* call({ sender: { ...sender, title: "Review \ud800" } });
      expect(broken.senderThread?.title).toBe("Review \ufffd");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("times out a peer that accepts a request and records the transport failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "probe" })),
        hold: McpToolAccess.reads(() =>
          Deferred.succeed(received, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      const held = yield* client
        .call({
          environmentId: box.environmentId,
          tool: "hold",
          arguments: {},
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: Result,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);
      yield* TestClock.adjust(74_999);
      expect(held.pollUnsafe()).toBeUndefined();

      const failure = yield* Fiber.join(held).pipe(Effect.timeoutOption(2), Effect.forkScoped);
      yield* TestClock.adjust(2);
      expect(yield* Fiber.join(failure)).toMatchObject(
        Option.some({
          code: "no_answer",
          message: "The linked environment stopped answering.",
        }),
      );
      expect(Option.getOrThrow(yield* links.get(box.environmentId)).lastError).toContain(
        "Peer MCP request deadline exceeded",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([false, true])(
  "reuses an initialized session before its first call finishes (cancelled: %s)",
  (cancelFirst) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const modes = McpInvocationContext.McpInvocationContext.pipe(
          Effect.map((scope) => {
            const ceiling = McpInvocationContext.clientModeCeiling(scope.client);
            return { modes: `${ceiling.runtimeMode}/${ceiling.interactionMode}` };
          }),
        );
        const handlers = McpToolAccess.toLayer(toolkit, {
          probe: McpToolAccess.reads(() => modes),
          refuse: McpToolAccess.reads(() => Effect.fail(refusal)),
          hold: McpToolAccess.reads(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(modes),
            ),
          ),
        });
        const box = descriptorOf("environment-box", "Box");
        const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
        const context = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-a", "A")),
        );
        const links = Context.get(context, PeerLinks.PeerLinks);
        const client = Context.get(context, PeerMcpClient.PeerMcpClient);
        yield* linkTo(links, b);
        const held = yield* client
          .call({
            environmentId: box.environmentId,
            tool: "hold",
            arguments: {},
            limits: { runtimeMode: "full-access", interactionMode: "default" },
            success: Result,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        if (cancelFirst) yield* Fiber.interrupt(held);
        const before = (yield* Ref.get(b.bearers)).length;
        expect(
          yield* client.call({
            environmentId: box.environmentId,
            tool: "probe",
            arguments: {},
            limits: { runtimeMode: "approval-required", interactionMode: "plan" },
            success: Result,
          }),
        ).toEqual({ modes: "approval-required/plan" });
        // One tool POST; no second initialize or initialized notification.
        expect((yield* Ref.get(b.bearers)).length - before).toBe(1);
        yield* Deferred.succeed(release, undefined);
        if (!cancelFirst) expect(yield* Fiber.join(held)).toEqual({ modes: "auto/default" });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("tells a peer without a tool, such as an older version, from a failed call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "probe" })),
        hold: McpToolAccess.reads(() => Effect.succeed({ modes: "hold" })),
        refuse: McpToolAccess.reads(() => Effect.die("unused")),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      const request = (tool: string) => ({
        environmentId: box.environmentId,
        tool,
        arguments: {},
        limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
        success: Result,
      });
      expect(yield* client.callIfAvailable(request("t3_from_a_newer_version"))).toEqual(
        Option.none(),
      );
      expect(yield* client.callIfAvailable(request("probe"))).toEqual(
        Option.some({ modes: "probe" }),
      );
      // The link still counts as answering.
      expect(
        (yield* links.list).find((link) => link.environmentId === box.environmentId)?.lastError,
      ).toBeNull();
      const missing = yield* Effect.flip(client.call(request("t3_from_a_newer_version")));
      expect(missing.code).toBe("invalid_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// The link keeps the message, so Settings → Linked environments shows which machine to update.
it.effect.each([
  {
    name: "an older peer",
    serverVersion: "0.0.1",
    message: `Box runs T3.CodeShip 0.0.1, older than ${packageJson.version} here, so this version cannot read its answer. Update T3.CodeShip on Box.`,
  },
  {
    name: "a newer peer",
    serverVersion: "999.0.0",
    message: `Box runs T3.CodeShip 999.0.0, newer than ${packageJson.version} here, so this version cannot read its answer. Update T3.CodeShip here.`,
  },
  {
    name: "a peer whose version does not compare",
    serverVersion: "dev",
    message:
      "The linked environment's answer did not match this version. Update both environments.",
  },
])(
  "an answer this version cannot read from $name names the side to update",
  ({ serverVersion, message }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = McpToolAccess.toLayer(toolkit, {
          probe: McpToolAccess.reads(() => Effect.succeed({ modes: "probe" })),
          hold: McpToolAccess.reads(() => Effect.succeed({ modes: "hold" })),
          refuse: McpToolAccess.reads(() => Effect.die("unused")),
        });
        const box = { ...descriptorOf("environment-box", "Box"), serverVersion };
        const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
        const context = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-a", "A")),
        );
        const links = Context.get(context, PeerLinks.PeerLinks);
        const client = Context.get(context, PeerMcpClient.PeerMcpClient);
        yield* linkTo(links, b);
        const failure = yield* Effect.flip(
          client.call({
            environmentId: box.environmentId,
            tool: "probe",
            arguments: {},
            limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
            success: Schema.Struct({ modes: Schema.Number }),
          }),
        );
        const listed = Effect.map(links.list, (all) => {
          const link = all.find((each) => each.environmentId === box.environmentId);
          return { lastError: link?.lastError, versionWarning: link?.versionWarning };
        });
        expect(failure).toMatchObject({ code: "version_mismatch", message });
        expect(yield* listed).toEqual({ lastError: message, versionWarning: message });
        // An answer it can read clears the last error, not the warning about that version.
        yield* client.call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: Result,
        });
        expect(yield* listed).toEqual({ lastError: null, versionWarning: message });
        // A caller that decodes part of an answer itself records the same message.
        expect(yield* client.recordUnreadable(box.environmentId)).toBe(message);
        expect(yield* listed).toEqual({ lastError: message, versionWarning: message });
        // Once it is seen on another version, by a call or by the list, an outage does not bring the warning back.
        const goesQuiet = Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
        yield* Ref.set(b.descriptor, { ...box, serverVersion: "0.0.3" });
        yield* client.call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: Result,
        });
        yield* goesQuiet;
        expect((yield* listed).versionWarning).toBeUndefined();
        yield* Ref.set(b.descriptor, { ...box, serverVersion: "0.0.3" });
        yield* client.recordUnreadable(box.environmentId);
        yield* Ref.set(b.descriptor, { ...box, serverVersion: "0.0.4" });
        expect((yield* listed).versionWarning).toBeUndefined();
        yield* goesQuiet;
        expect((yield* listed).versionWarning).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses arguments the peer's version does not take, listing its tools once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // As an older version has it: no `providerAccounts`, and a workspace without `startFromOrigin`.
      const older = Toolkit.make(
        Tool.make("configure", {
          description: "Returns the arguments it decoded.",
          parameters: Schema.Struct({
            snooze: Schema.optionalKey(Schema.Boolean),
            workspace: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
          }),
          success: Result,
          failure: OrchestratorMcpFailure,
          dependencies: [
            McpInvocationContext.McpInvocationContext,
            ThreadManagement.ThreadManagementService,
          ],
        }),
      );
      const handlers = McpToolAccess.toLayer(older, {
        configure: McpToolAccess.reads((input) => Effect.succeed({ modes: JSON.stringify(input) })),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(older, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      const configure = (
        args: Record<string, unknown>,
        ignorableArguments: ReadonlyArray<string> = [],
      ) =>
        client.call({
          environmentId: box.environmentId,
          tool: "configure",
          arguments: args,
          ignorableArguments,
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: Result,
        });
      expect(yield* configure({ snooze: true, workspace: { type: "root" } })).toEqual({
        modes: '{"snooze":true,"workspace":{"type":"root"}}',
      });
      // Its tools are listed once: a later call is the one tool request.
      const before = (yield* Ref.get(b.bearers)).length;
      yield* configure({ snooze: false });
      expect((yield* Ref.get(b.bearers)).length - before).toBe(1);
      const refused = yield* Effect.flip(
        configure({
          snooze: true,
          providerAccounts: { claude: { autoCompactWindow: "200000" } },
          workspace: { type: "worktree", startFromOrigin: false },
        }),
      );
      expect(refused).toMatchObject({
        code: "invalid_request",
        message:
          "Box runs T3.CodeShip 0.0.0-test, whose configure does not take providerAccounts, workspace.startFromOrigin. Update T3.CodeShip on Box to use them, or leave them out.",
      });
      expect(yield* configure({ snooze: true, includePrompt: true }, ["includePrompt"])).toEqual({
        modes: '{"snooze":true}',
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses an answer larger than the call takes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const large = "x".repeat(10_000);
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: large })),
        hold: McpToolAccess.reads(() => Effect.succeed({ modes: "hold" })),
        refuse: McpToolAccess.reads(() => Effect.die("unused")),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      const request = (maxResultBytes: number) => ({
        environmentId: box.environmentId,
        tool: "probe",
        arguments: {},
        limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
        success: Result,
        maxResultBytes,
      });
      expect(yield* client.callIfAvailable(request(20_000))).toEqual(Option.some({ modes: large }));
      // Over the result's limit, though the whole answer still fits the read.
      const overResult = yield* Effect.flip(client.callIfAvailable(request(9_000)));
      // So far over that the answer is not read whole.
      const overAnswer = yield* Effect.flip(client.callIfAvailable(request(1_000)));
      for (const [error, maxResultBytes] of [
        [overResult, 9_000],
        [overAnswer, 1_000],
      ] as const) {
        expect(error.message).toBe(
          `The linked environment's answer is larger than the ${maxResultBytes} bytes this call takes.`,
        );
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A tools/call answer held after its start; `signal` is its request's, to see it aborted. */
interface StalledCall {
  readonly received: Deferred.Deferred<void>;
  signal: AbortSignal | undefined;
}

/**
 * A peer whose `probe` takes `properties`. It keeps sessions in memory, as the real one does, so
 * `restart` forgets them.
 */
const fakePeerClient = Effect.fn("fakePeerClient")(function* (properties: Record<string, unknown>) {
  let schema: unknown = { type: "object", properties };
  let live = new Set<string>();
  let started = 0;
  let listError: string | undefined;
  let dropCall = false;
  let callStatus: number | undefined;
  let heldList:
    | { readonly received: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  let stalledCall: StalledCall | undefined;
  const requests: Array<string> = [];
  const ran: Array<unknown> = [];
  const http = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ) as { readonly method: string; readonly params?: { readonly arguments?: unknown } };
      const sessionId = request.headers["mcp-session-id"];
      requests.push(`${body.method} ${sessionId ?? "-"}`);
      const answer = (status: number, json?: unknown, headers: Record<string, string> = {}) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(json === undefined ? "" : JSON.stringify(json), { status, headers }),
        );
      if (body.method === "initialize") {
        started += 1;
        live.add(`session-${started}`);
        return answer(200, undefined, { "mcp-session-id": `session-${started}` });
      }
      if (sessionId === undefined || !live.has(sessionId)) return answer(404);
      if (body.method === "notifications/initialized") return answer(202);
      if (body.method === "tools/list") {
        if (listError !== undefined) {
          return answer(200, {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: listError },
          });
        }
        const tools = [{ name: "probe", inputSchema: schema }];
        const held = heldList;
        heldList = undefined;
        if (held !== undefined) {
          yield* Deferred.succeed(held.received, undefined);
          yield* Deferred.await(held.release);
        }
        return answer(200, { result: { tools } });
      }
      ran.push(body.params?.arguments);
      if (callStatus !== undefined) {
        const status = callStatus;
        callStatus = undefined;
        return answer(status);
      }
      if (dropCall) {
        dropCall = false;
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new TypeError("fetch failed"),
          }),
        });
      }
      const stall = stalledCall;
      stalledCall = undefined;
      if (stall !== undefined) {
        stall.signal = signal;
        yield* Deferred.succeed(stall.received, undefined);
        // The status and the start of the answer arrive, then nothing more.
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller) =>
                controller.enqueue(new TextEncoder().encode('{"result":{"content":[')),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return answer(200, { result: { content: [{ type: "text", text: '{"modes":"ran"}' }] } });
    }),
  );
  const box = descriptorOf("environment-box", "Box");
  const context = yield* Layer.build(
    PeerMcpClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () =>
              Effect.succeed({
                link: {
                  environmentId: box.environmentId,
                  label: box.label,
                  urls: ["https://peer.example"],
                  access: "auto",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1),
                  lastReachedAt: null,
                  lastError: null,
                },
                url: "https://peer.example",
                token: "fixture",
                serverVersion: "0.0.0-test",
              }),
            recordOutcome: () => Effect.void,
            recordUnreadable: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  const client = Context.get(context, PeerMcpClient.PeerMcpClient);
  return {
    requests,
    ran,
    call: (args: Record<string, unknown>) =>
      client.call({
        environmentId: box.environmentId,
        tool: "probe",
        arguments: args,
        limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
        success: Result,
      }),
    restart: (next: Record<string, unknown>) => {
      schema = { type: "object", properties: next };
      live = new Set();
    },
    failList: (message: string) => {
      listError = message;
    },
    /** The next call runs there, and its answer never arrives. */
    dropNextCall: () => {
      dropCall = true;
    },
    /** The next call runs there, and what answers it is only this HTTP status. */
    answerNextCallWith: (status: number) => {
      callStatus = status;
    },
    /** Holds the next tools/list answer, as listed when it arrived, until `release`. */
    holdNextList: Effect.gen(function* () {
      const held = {
        received: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      heldList = held;
      return held;
    }),
    /** Stalls the next tools/call answer after its status and part of its body. */
    stallNextCall: Effect.gen(function* () {
      const stall: StalledCall = { received: yield* Deferred.make<void>(), signal: undefined };
      stalledCall = stall;
      return stall;
    }),
  };
});

it.effect("times out a peer that stops partway through its answer and aborts the request", () =>
  Effect.gen(function* () {
    const peer = yield* fakePeerClient({});
    const stall = yield* peer.stallNextCall;
    const call = yield* peer.call({}).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(stall.received);
    yield* TestClock.adjust(74_999);
    expect(call.pollUnsafe()).toBeUndefined();

    const failure = yield* Fiber.join(call).pipe(Effect.timeoutOption(2), Effect.forkChild);
    yield* TestClock.adjust(2);
    expect(yield* Fiber.join(failure)).toMatchObject(
      Option.some({
        code: "no_answer",
        message: "The linked environment stopped answering.",
      }),
    );
    expect(stall.signal?.aborted).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("renews a session the peer lost once, checks the call again in it, and reuses it", () =>
  Effect.gen(function* () {
    const peer = yield* fakePeerClient({ newSetting: { type: "boolean" } });
    expect(yield* peer.call({ newSetting: true })).toEqual({ modes: "ran" });
    expect(yield* peer.call({})).toEqual({ modes: "ran" });
    peer.restart({});
    expect(yield* Effect.flip(peer.call({ newSetting: true }))).toMatchObject({
      code: "invalid_request",
      message:
        "Box runs T3.CodeShip 0.0.0-test, whose probe does not take newSetting. Update T3.CodeShip on Box to use it, or leave it out.",
    });
    expect(yield* peer.call({})).toEqual({ modes: "ran" });
    expect(peer.ran).toEqual([{ newSetting: true }, {}, {}]);
    expect(peer.requests).toEqual([
      "initialize -",
      "notifications/initialized session-1",
      "tools/list session-1",
      "tools/call session-1",
      "tools/call session-1",
      "tools/call session-1",
      "initialize -",
      "notifications/initialized session-2",
      "tools/list session-2",
      "tools/call session-2",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a call whose answer never arrives fails as no answer, not as a refusal", () =>
  Effect.gen(function* () {
    const peer = yield* fakePeerClient({});
    peer.dropNextCall();
    expect(yield* Effect.flip(peer.call({}))).toMatchObject({
      code: "no_answer",
      message: "The linked environment stopped answering.",
    });
    expect(peer.ran).toEqual([{}]);
  }).pipe(Effect.scoped),
);

it.effect(
  "a call a gateway answers with a server error fails as no answer, since it may have run",
  () =>
    Effect.gen(function* () {
      const peer = yield* fakePeerClient({});
      peer.answerNextCallWith(502);
      expect(yield* Effect.flip(peer.call({}))).toMatchObject({
        code: "no_answer",
        message:
          "The linked environment's address answered HTTP 502, so whether it acted is unknown.",
      });
      expect(peer.ran).toEqual([{}]);
      // A refusal by status alone is still the machine's answer.
      peer.answerNextCallWith(429);
      expect(yield* Effect.flip(peer.call({}))).toMatchObject({ code: "orchestration_error" });
    }).pipe(Effect.scoped),
);

it.effect("a call to a linked environment no address answers as fails as unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "probe" })),
        hold: McpToolAccess.reads(() => Effect.never),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      // Its address now answers as another environment, so the link's token is not sent there.
      yield* Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
      const failure = yield* client
        .call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: Result,
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("unreachable");
      expect(failure.message).toContain("Box did not answer");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a peer whose tool list errors fails the call with its error, not as unreadable", () =>
  Effect.gen(function* () {
    const peer = yield* fakePeerClient({});
    peer.failList("Internal error");
    expect(yield* Effect.flip(peer.call({ newSetting: true }))).toMatchObject({
      code: "orchestration_error",
      message: "Internal error",
    });
  }).pipe(Effect.scoped),
);

it.effect("refuses only on a list from the session still in use", () =>
  Effect.gen(function* () {
    const peer = yield* fakePeerClient({});
    const held = yield* peer.holdNextList;
    const first = yield* peer.call({ newSetting: true }).pipe(Effect.forkChild);
    yield* Deferred.await(held.received);
    peer.restart({ newSetting: { type: "boolean" } });
    expect(yield* peer.call({ newSetting: true })).toEqual({ modes: "ran" });
    yield* Deferred.succeed(held.release, undefined);
    expect(yield* Fiber.join(first)).toEqual({ modes: "ran" });
    expect(peer.ran).toEqual([{ newSetting: true }, { newSetting: true }]);
    expect(peer.requests).toEqual([
      "initialize -",
      "notifications/initialized session-1",
      "tools/list session-1",
      "tools/list session-1",
      "initialize -",
      "notifications/initialized session-2",
      "tools/list session-2",
      "tools/call session-2",
      "tools/call session-2",
    ]);
  }),
);

it.effect("bounds the session handshake, not a tool call that waits longer", () =>
  Effect.gen(function* () {
    const arrived = yield* Queue.unbounded<number>();
    const answer = yield* Deferred.make<void>();
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const index = requests++;
        yield* Queue.offer(arrived, index);
        // The first initialize, then the next initialized notification, never answer;
        // the third session's tool call answers late.
        if (index === 0 || index === 2) return yield* Effect.never;
        if (index === 5) yield* Deferred.await(answer);
        return HttpClientResponse.fromWeb(
          request,
          new Response(index === 5 ? probeResult : "", {
            status: index === 4 ? 202 : 200,
            headers: { "mcp-session-id": "session" },
          }),
        );
      }),
    );
    const probe = yield* probeThrough(http);

    for (const requestsBeforeStall of [1, 2]) {
      const stalled = yield* probe.pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.takeN(arrived, requestsBeforeStall);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(stalled)).toMatchObject({
        code: "orchestration_error",
        message: "The linked environment stopped answering.",
      });
    }

    const waiting = yield* Effect.forkScoped(probe);
    yield* Queue.takeN(arrived, 3);
    yield* TestClock.adjust(Duration.minutes(1));
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(waiting)).toEqual({ modes: "approval-required/plan" });
  }),
);

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 404, 200, 202, 200, 200, 200];
    const outcomes: Array<string | null> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            index === 7
              ? "{}"
              : index >= 5
                ? JSON.stringify({
                    result: {
                      content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }],
                    },
                  })
                : "",
            {
              status,
              headers:
                index === 0
                  ? { "mcp-session-id": "old" }
                  : index === 3
                    ? { "mcp-session-id": "renewed" }
                    : {},
            },
          ),
        );
      }),
    );
    const box = descriptorOf("environment-box", "Box");
    const context = yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.mock(PeerLinks.PeerLinks)({
              resolve: () =>
                Effect.succeed({
                  link: {
                    environmentId: box.environmentId,
                    label: box.label,
                    urls: ["https://peer.example"],
                    access: "auto",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(1),
                    lastReachedAt: null,
                    lastError: null,
                  },
                  url: "https://peer.example",
                  token: "fixture",
                  serverVersion: "0.0.0-test",
                }),
              recordOutcome: (_, outcome) => Effect.sync(() => outcomes.push(outcome.error)),
            }),
          ),
        ),
      ),
    );
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    for (let call = 0; call < 2; call++) {
      expect(
        yield* client.call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          limits: { runtimeMode: "approval-required", interactionMode: "plan" },
          success: Result,
        }),
      ).toEqual({ modes: "approval-required/plan" });
    }
    // An answer with neither a result nor an error is the link's problem, not the call's.
    const empty = yield* client
      .call({
        environmentId: box.environmentId,
        tool: "probe",
        arguments: {},
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        success: Result,
      })
      .pipe(Effect.flip);
    expect(outcomes).toEqual([null, null, empty.message]);
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
      "renewed",
    ]);
  }),
);

it.effect("keeps a link healthy when the peer refuses a call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        hold: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        refuse: McpToolAccess.reads(() => Effect.fail(refusal)),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      yield* links.recordOutcome(box.environmentId, { error: "earlier outage" });
      const refused = yield* client
        .call({
          environmentId: box.environmentId,
          tool: "refuse",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: Result,
        })
        .pipe(Effect.flip);
      // The agent hears the peer's own refusal; the link answered, so it is not failing.
      expect(refused).toMatchObject({ code: refusal.code, message: refusal.message });
      const link = yield* links.get(box.environmentId);
      expect(link._tag === "Some" ? link.value.lastError : "missing").toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
