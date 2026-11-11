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

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 404, 200, 202, 200, 200];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            index >= 5
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
                }),
              recordOutcome: () => Effect.void,
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
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
    ]);
  }).pipe(Effect.scoped),
);
