import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const Result = Schema.Struct({ modes: Schema.String });
const toolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Returns this request's mode limits.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("hold", {
    description: "Holds a tool request open.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
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
          dependencies: [McpInvocationContext.McpInvocationContext],
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

/**
 * A peer whose `probe` takes `properties`. It keeps sessions in memory, as the real one does, so
 * `restart` forgets them.
 */
const fakePeerClient = Effect.fn("fakePeerClient")(function* (properties: Record<string, unknown>) {
  let schema: unknown = { type: "object", properties };
  let live = new Set<string>();
  let started = 0;
  let heldList:
    | { readonly received: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  const requests: Array<string> = [];
  const ran: Array<unknown> = [];
  const http = HttpClient.make((request) =>
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
    /** Holds the next tools/list answer, as listed when it arrived, until `release`. */
    holdNextList: Effect.gen(function* () {
      const held = {
        received: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      heldList = held;
      return held;
    }),
  };
});

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
  }).pipe(Effect.scoped),
);
