import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { unknownArguments } from "../mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** The only MCP protocol version a T3.CodeShip `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** For the server's own background reads of a link: a supervised plan-mode caller. */
export const READ_ONLY_PEER_LIMITS: PeerCallLimits = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/** How long a background read waits for a linked machine before treating it as unreachable. */
export const PEER_READ_TIMEOUT = Duration.seconds(20);

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
interface PeerCallInput<S extends Schema.Decoder<unknown>> {
  readonly environmentId: EnvironmentId;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly limits: PeerCallLimits;
  readonly success: S;
  /** The most the tool's result may take as JSON; a larger answer is refused, never read whole. */
  readonly maxResultBytes?: number;
  /**
   * Top-level arguments a peer may lack because its version already does what they ask. Any other
   * argument its tool's schema lacks refuses the call, since the peer would drop it unheard.
   */
  readonly ignorableArguments?: ReadonlyArray<string>;
}

export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(
      input: PeerCallInput<S>,
    ) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
    /**
     * `call` for the server's own background work, which skips a peer that does not have `tool`,
     * such as one running an older version: none then, and the link counts as answering.
     */
    readonly callIfAvailable: <S extends Schema.Decoder<unknown>>(
      input: PeerCallInput<S>,
    ) => Effect.Effect<Option.Option<S["Type"]>, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

/** JSON-RPC's invalid params, which an MCP server answers for a tool it does not have. */
const INVALID_PARAMS = -32602;

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeToolsListResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
      }),
    }),
  ),
);
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

/** Not final, so a task already running there resumes once the beta is on there again. */
const linkedEnvironmentsOffThere = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message:
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Machines & access → Linked environments.",
});

const unexpectedShape = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The linked environment answered in an unexpected shape.",
});

/** One linked environment at the address it answered on, for one call. */
interface Peer {
  readonly key: string;
  readonly label: string;
  readonly url: string;
  readonly token: string;
  readonly serverVersion: string;
  readonly limitHeader: Record<string, string>;
}

/**
 * An MCP answer carries its result twice, as escaped text and as structured content, so its body
 * takes up to about three times the result's size.
 */
const ANSWER_BYTES_PER_RESULT_BYTE = 4;

const answerTooLarge = (maxResultBytes: number) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `The linked environment's answer is larger than the ${maxResultBytes} bytes this call takes.`,
  });

/** The body as text, read no further than `maxResultBytes` allows when it is set. */
const readBody = (response: HttpClientResponse.HttpClientResponse, maxResultBytes?: number) => {
  if (maxResultBytes === undefined) return response.text;
  const maxBodyBytes = maxResultBytes * ANSWER_BYTES_PER_RESULT_BYTE;
  return Stream.runFoldEffect(
    response.stream,
    (): { readonly chunks: Array<Uint8Array>; size: number } => ({ chunks: [], size: 0 }),
    (read, chunk) => {
      read.size += chunk.byteLength;
      if (read.size > maxBodyBytes) return Effect.fail(answerTooLarge(maxResultBytes));
      read.chunks.push(chunk);
      return Effect.succeed(read);
    },
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")));
};

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  // Each peer's tool input schemas, as listed in one session of one version.
  const inputSchemas = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly sessionId: string;
        readonly serverVersion: string;
        readonly schemas: ReadonlyMap<string, unknown>;
      }
    >
  >(new Map());

  const post = (url: string, token: string, body: unknown, headers: Record<string, string>) =>
    httpClient.execute(
      HttpClientRequest.post(`${url}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        }),
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
      ),
    );

  const openSession = Effect.fn("PeerMcpClient.openSession")(function* (
    url: string,
    token: string,
    limitHeader: Record<string, string>,
  ) {
    const initialized = yield* post(
      url,
      token,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3code-peer", version: "1" },
        },
      },
      limitHeader,
    );
    const sessionId = initialized.headers["mcp-session-id"];
    if (initialized.status === 403) return yield* linkedEnvironmentsOffThere;
    if (initialized.status !== 200 || sessionId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
        message:
          initialized.status === 401
            ? "The linked environment no longer accepts this link. It may have been revoked there; link it again."
            : `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
      });
    }
    yield* post(
      url,
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
    );
    return sessionId;
  });

  const startSession = Effect.fnUntraced(function* (peer: Peer) {
    const sessionId = yield* openSession(peer.url, peer.token, peer.limitHeader);
    // The initialized session outlives a request, including a long wait or cancellation.
    yield* Ref.update(sessions, (current) => new Map(current).set(peer.key, sessionId));
    return sessionId;
  });

  const currentSession = (peer: Peer) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((current) => {
        const sessionId = current.get(peer.key);
        return sessionId === undefined ? startSession(peer) : Effect.succeed(sessionId);
      }),
    );

  /**
   * Posts `body` in the session `session` gives, and once more after starting a new one when the
   * peer lost it. The peer may run other code then, so `session` runs again for the new one.
   */
  const send = Effect.fnUntraced(function* (
    peer: Peer,
    body: unknown,
    session: Effect.Effect<string, OrchestratorMcpFailure | HttpClientError.HttpClientError>,
  ) {
    const attempt = Effect.flatMap(session, (sessionId) =>
      post(peer.url, peer.token, body, {
        ...peer.limitHeader,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": PROTOCOL_VERSION,
      }).pipe(Effect.map((response) => ({ sessionId, response }))),
    );
    let sent = yield* attempt;
    if (sent.response.status === 404) {
      yield* startSession(peer);
      sent = yield* attempt;
    }
    const { response } = sent;
    if (response.status === 401) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
      });
    }
    if (response.status === 403) return yield* linkedEnvironmentsOffThere;
    if (response.status !== 200) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The linked environment answered HTTP ${response.status}.`,
      });
    }
    return sent;
  });

  const listInputSchemas = Effect.fnUntraced(function* (peer: Peer) {
    const { sessionId, response } = yield* send(
      peer,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      currentSession(peer),
    );
    const listed = yield* decodeToolsListResponse(
      responseJson(response.headers["content-type"], yield* response.text),
    ).pipe(Effect.mapError(() => unexpectedShape));
    const schemas = new Map(listed.result.tools.map((tool) => [tool.name, tool.inputSchema]));
    const stillCurrent = (yield* Ref.get(sessions)).get(peer.key) === sessionId;
    if (stillCurrent) {
      yield* Ref.update(inputSchemas, (current) =>
        new Map(current).set(peer.key, { sessionId, serverVersion: peer.serverVersion, schemas }),
      );
    }
    return { sessionId, schemas, stillCurrent };
  });

  /**
   * The session to call in, once it refused arguments the peer's tool does not take there: its
   * server drops them while decoding, so the call would succeed without them. A peer without the
   * tool is left to say so.
   */
  const sessionCheckedFor = Effect.fnUntraced(function* (
    peer: Peer,
    input: PeerCallInput<Schema.Decoder<unknown>>,
  ) {
    const ignorable = new Set(input.ignorableArguments);
    const checked = Object.fromEntries(
      Object.entries(input.arguments).filter(([key]) => !ignorable.has(key)),
    );
    if (Object.values(checked).every((value) => value === undefined)) {
      return yield* currentSession(peer);
    }
    const unknownIn = (schemas: ReadonlyMap<string, unknown>) =>
      schemas.has(input.tool) ? unknownArguments(schemas.get(input.tool), checked) : [];
    // A pass ends without an answer only when another call started a new session while it listed.
    while (true) {
      const sessionId = (yield* Ref.get(sessions)).get(peer.key);
      const cached = (yield* Ref.get(inputSchemas)).get(peer.key);
      if (
        cached !== undefined &&
        cached.sessionId === sessionId &&
        cached.serverVersion === peer.serverVersion &&
        unknownIn(cached.schemas).length === 0
      ) {
        return cached.sessionId;
      }
      // Listed again before a refusal, since the peer may have restarted since.
      const listed = yield* listInputSchemas(peer);
      const unknown = unknownIn(listed.schemas);
      if (unknown.length === 0) return listed.sessionId;
      if (!listed.stillCurrent) continue;
      const them = unknown.length === 1 ? "it" : "them";
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `${peer.label} runs T3.CodeShip ${peer.serverVersion}, whose ${input.tool} does not take ${unknown.join(", ")}. Update T3.CodeShip on ${peer.label} to use ${them}, or leave ${them} out.`,
      });
    }
  });

  /**
   * The text of the peer's result, or none when the peer has no such tool. Its callers own the span
   * and record the outcome on the link.
   */
  const request = Effect.fnUntraced(function* (input: PeerCallInput<Schema.Decoder<unknown>>) {
    const resolved = yield* links.resolve(input.environmentId).pipe(Effect.mapError(fromLinkError));
    const peer: Peer = {
      key: `${input.environmentId} ${resolved.url}`,
      label: resolved.link.label,
      url: resolved.url,
      token: resolved.token,
      serverVersion: resolved.serverVersion,
      limitHeader: {
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      },
    };
    const { response } = yield* send(
      peer,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: input.tool, arguments: input.arguments },
      },
      sessionCheckedFor(peer, input),
    );
    const body = yield* decodeToolCallResponse(
      responseJson(
        response.headers["content-type"],
        yield* readBody(response, input.maxResultBytes),
      ),
    ).pipe(Effect.mapError(() => unexpectedShape));
    if (
      body.error?.code === INVALID_PARAMS &&
      body.error.message === `Tool '${input.tool}' not found`
    ) {
      return Option.none<string>();
    }
    if (body.error !== undefined || body.result === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: body.error?.message ?? "The linked environment returned no result.",
      });
    }
    const text = body.result.content.map((part) => part.text ?? "").join("");
    if (
      input.maxResultBytes !== undefined &&
      Buffer.byteLength(text, "utf8") > input.maxResultBytes
    ) {
      return yield* answerTooLarge(input.maxResultBytes);
    }
    if (body.result.isError === true) {
      // A refusal keeps the peer's own code, so the agent sees why it was refused.
      const refused = decodeFailure(text);
      return yield* refused._tag === "Some"
        ? new OrchestratorMcpFailure({ code: refused.value.code, message: refused.value.message })
        : new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: text || "The linked environment refused the call.",
          });
    }
    return Option.some(text);
  });

  const decodeResult = <S extends Schema.Decoder<unknown>>(success: S, text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(success))(text).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message:
              "The linked environment's answer did not match this version. Update both environments.",
          }),
      ),
    );

  const recorded = <A>(
    effect: Effect.Effect<A, OrchestratorMcpFailure | HttpClientError.HttpClientError>,
    input: { readonly environmentId: EnvironmentId },
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        links.recordOutcome(input.environmentId, { error: error.message }),
      ),
      Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
      // Recorded above with the transport's own message; the agent hears it plainly.
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            }),
          ),
      }),
    );

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(function* (input) {
    const text = yield* request(input);
    if (Option.isNone(text)) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Tool '${input.tool}' not found`,
      });
    }
    return yield* decodeResult(input.success, text.value);
  }, recorded);

  const callIfAvailable: PeerMcpClient["Service"]["callIfAvailable"] = Effect.fn(
    "PeerMcpClient.callIfAvailable",
  )(function* (input) {
    const text = yield* request(input);
    if (Option.isNone(text)) return Option.none();
    return Option.some(yield* decodeResult(input.success, text.value));
  }, recorded);

  return PeerMcpClient.of({ call, callIfAvailable });
});

export const layer = Layer.effect(PeerMcpClient, make);
